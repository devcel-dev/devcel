//! Current peer contract: request-ID RPC, committed snapshots and explicit order.
#![cfg(feature = "p2p")]

use async_trait::async_trait;
use devcel_core::{
    discovery::{ServiceInfo, ServiceStatus},
    msgpack_client::MsgPackClient,
    msgpack_framing::{read_message, write_message},
    msgpack_server::MsgPackServer,
    operation_handler::OperationHandler,
    operations::{DevcelOperation, DevcelResponse},
    p2p_manager::{DevcelClient, DevcelServer},
    p2p_messages::P2PMessage,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::timeout;

#[derive(Default)]
struct Handler {
    operations: AtomicUsize,
    snapshots: AtomicUsize,
    applied: Notify,
}

#[async_trait]
impl OperationHandler for Handler {
    async fn handle_operation(&self, operation: DevcelOperation) -> DevcelResponse {
        self.operations.fetch_add(1, Ordering::Relaxed);
        if matches!(operation, DevcelOperation::Ping) {
            DevcelResponse::Error(devcel_core::AppError::InputValidation {
                report: devcel_core::cell_rules::ValidationReport {
                    issues: Vec::new(),
                    acknowledgement: Some("peer-ack".into()),
                },
            })
        } else if matches!(operation, DevcelOperation::GetFullProjectState) {
            DevcelResponse::Ok(json!({"replication_state":{"marker":"committed"}}))
        } else {
            DevcelResponse::Ok(json!({"accepted":true}))
        }
    }

    async fn apply_server_snapshot(&self, snapshot: serde_json::Value) -> DevcelResponse {
        assert_eq!(snapshot, json!({"marker":"committed"}));
        self.snapshots.fetch_add(1, Ordering::Relaxed);
        self.applied.notify_one();
        DevcelResponse::Ok(json!({}))
    }
}

async fn receive(stream: &mut TcpStream) -> Option<P2PMessage> {
    timeout(Duration::from_secs(5), read_message(stream))
        .await
        .unwrap()
        .unwrap()
        .map(|bytes| rmp_serde::from_slice(&bytes).unwrap())
}

async fn authenticated_peer(listener: &TcpListener, client: &mut MsgPackClient) -> TcpStream {
    let capability = devcel_core::p2p_auth::SessionCapability::for_listener(listener).unwrap();
    let accepted = async {
        let (mut peer, _) = listener.accept().await.unwrap();
        capability.authenticate(&mut peer).await.unwrap();
        peer
    };
    let (connected, peer) = tokio::join!(client.connect(listener.local_addr().unwrap()), accepted);
    connected.unwrap();
    peer
}

#[tokio::test]
async fn status_responses_do_not_expose_internal_package_versions() {
    let project = Arc::new(Mutex::new(None));
    let handler = Arc::new(devcel_core::operation_handler::LocalOperationHandler::new(
        project.clone(),
    ));
    for operation in [DevcelOperation::Ping, DevcelOperation::GetServerInfo] {
        let DevcelResponse::Ok(value) = handler.handle_operation(operation).await else {
            panic!("status operation failed");
        };
        assert!(value.get("version").is_none());
    }
    let mut server = MsgPackServer::new(project);
    server.set_operation_handler(handler);
    server.start("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let mut client = MsgPackClient::new();
    client.set_operation_handler(Arc::new(Handler::default()));
    client
        .connect(server.get_listening_addr().unwrap())
        .await
        .unwrap();
    for operation in [DevcelOperation::Ping, DevcelOperation::GetServerInfo] {
        let DevcelResponse::Ok(value) = client.send_operation(operation).await.unwrap() else {
            panic!("remote status operation failed");
        };
        assert!(value.get("version").is_none());
    }
    client.disconnect().await;
    server.stop().await;
}

#[tokio::test]
async fn server_rejects_raw_operations_and_returns_envelopes_and_snapshots() {
    let handler = Arc::new(Handler::default());
    let mut server = MsgPackServer::new(Arc::new(Mutex::new(None)));
    server.set_operation_handler(handler.clone());
    server.start("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let address = server.get_listening_addr().unwrap();

    let mut raw = TcpStream::connect(address).await.unwrap();
    devcel_core::p2p_auth::connect(&mut raw, address)
        .await
        .unwrap();
    write_message(
        &mut raw,
        &rmp_serde::to_vec_named(&DevcelOperation::GetProjectInfo).unwrap(),
    )
    .await
    .unwrap();
    assert!(receive(&mut raw).await.is_none());
    assert_eq!(handler.operations.load(Ordering::Relaxed), 0);

    let mut current = TcpStream::connect(address).await.unwrap();
    devcel_core::p2p_auth::connect(&mut current, address)
        .await
        .unwrap();
    write_message(
        &mut current,
        &rmp_serde::to_vec_named(&P2PMessage::request(42, DevcelOperation::GetProjectInfo))
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(matches!(
        receive(&mut current).await,
        Some(P2PMessage::Response {
            id: 42,
            result: DevcelResponse::Ok(_)
        })
    ));
    write_message(
        &mut current,
        &rmp_serde::to_vec_named(&P2PMessage::request(
            43,
            DevcelOperation::UpdateProjectDescription {
                description: "changed".into(),
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    match receive(&mut current).await {
        Some(P2PMessage::Broadcast { project_state }) => {
            assert_eq!(project_state, json!({"marker":"committed"}))
        }
        other => panic!("Expected committed snapshot before response: {other:?}"),
    }
    assert!(matches!(
        receive(&mut current).await,
        Some(P2PMessage::Response {
            id: 43,
            result: DevcelResponse::Ok(_)
        })
    ));
    write_message(
        &mut current,
        &rmp_serde::to_vec_named(&P2PMessage::request(44, DevcelOperation::Ping)).unwrap(),
    )
    .await
    .unwrap();
    match receive(&mut current).await {
        Some(P2PMessage::Response {
            id: 44,
            result: DevcelResponse::Error(devcel_core::AppError::InputValidation { report }),
        }) => {
            assert_eq!(report.acknowledgement.as_deref(), Some("peer-ack"));
        }
        other => panic!("Typed validation report was lost: {other:?}"),
    }
    server.stop().await;
}

#[tokio::test]
async fn client_rejects_raw_and_operation_broadcasts_without_replaying_them() {
    for old in [
        json!({"op":"SyncProjectState","data":{"project_state":{"type":"operation_broadcast","operation":{"op":"GetProjectInfo"}}}}),
        json!({"msg_type":"Broadcast","operation":{"op":"GetProjectInfo"}}),
        json!({"op":"GetProjectInfo"}),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let handler = Arc::new(Handler::default());
        let mut client = MsgPackClient::new();
        client.set_operation_handler(handler.clone());
        let (tx, mut rx) = mpsc::channel(1);
        client.set_disconnect_notifier(tx);
        let mut peer = authenticated_peer(&listener, &mut client).await;
        write_message(&mut peer, &rmp_serde::to_vec_named(&old).unwrap())
            .await
            .unwrap();
        assert!(timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .is_some());
        assert_eq!(handler.operations.load(Ordering::Relaxed), 0);
        assert_eq!(handler.snapshots.load(Ordering::Relaxed), 0);
        client.disconnect().await;
    }
}

#[tokio::test]
async fn client_applies_only_the_snapshot_receive_path() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let handler = Arc::new(Handler::default());
    let mut client = MsgPackClient::new();
    client.set_operation_handler(handler.clone());
    let mut peer = authenticated_peer(&listener, &mut client).await;
    write_message(
        &mut peer,
        &rmp_serde::to_vec_named(&P2PMessage::broadcast(json!({"marker":"committed"}))).unwrap(),
    )
    .await
    .unwrap();
    timeout(Duration::from_secs(5), handler.applied.notified())
        .await
        .unwrap();
    assert_eq!(handler.snapshots.load(Ordering::Relaxed), 1);
    assert_eq!(handler.operations.load(Ordering::Relaxed), 0);
    client.disconnect().await;
}

#[test]
fn service_info_requires_connection_order() {
    let service = ServiceInfo {
        app_type: "test".into(),
        project_path: "project.devcelproj.toml".into(),
        project_uuid: "test-project".into(),
        address: "127.0.0.1:50000".parse().unwrap(),
        last_seen: SystemTime::now(),
        status: ServiceStatus::Active,
        connection_order: 0,
    };
    let mut value = serde_json::to_value(service).unwrap();
    assert!(serde_json::from_value::<ServiceInfo>(value.clone()).is_ok());
    value.as_object_mut().unwrap().remove("connection_order");
    assert!(serde_json::from_value::<ServiceInfo>(value).is_err());
}

#[tokio::test]
async fn current_chunk_framing_preserves_large_messages_and_rejects_bad_frames() {
    use devcel_core::msgpack_framing::MAX_FRAME_BYTES;
    use tokio::io::AsyncWriteExt;
    let payload = vec![b'x'; MAX_FRAME_BYTES + 1];
    let (mut writer, mut reader) = tokio::io::duplex(64 * 1024);
    let write = tokio::spawn(async move {
        write_message(&mut writer, &payload).await.unwrap();
    });
    let bytes = read_message(&mut reader).await.unwrap().unwrap();
    assert_eq!(bytes.len(), MAX_FRAME_BYTES + 1);
    assert!(bytes.iter().all(|byte| *byte == b'x'));
    write.await.unwrap();
    assert!(read_message(&mut reader).await.unwrap().is_none());

    for frame in [
        vec![0, 0],          // Truncated header.
        vec![0, 0, 0, 2, 1], // Truncated payload.
        vec![0x80, 0, 0, 0], // Empty continuation.
        ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec(),
        vec![0x80, 0, 0, 1, 1], // Missing terminating frame.
    ] {
        let (mut writer, mut reader) = tokio::io::duplex(64);
        writer.write_all(&frame).await.unwrap();
        writer.shutdown().await.unwrap();
        assert!(read_message(&mut reader).await.is_err());
    }
}
