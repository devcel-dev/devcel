use devcel_core::msgpack_server::MsgPackServer;
use devcel_core::p2p_manager::DevcelServer;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};

async fn wait_for_count(server: &MsgPackServer, expected: usize) {
    timeout(Duration::from_secs(3), async {
        while server.connected_client_count().await != expected {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Connected client count did not reach {expected}"));
}

#[tokio::test]
async fn connected_client_count_tracks_live_sockets_without_stopping_listener() {
    let mut server = MsgPackServer::new(Arc::new(Mutex::new(None)));
    assert_eq!(server.connected_client_count().await, 0);
    server.start("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let address = server.get_listening_addr().unwrap();
    assert_eq!(server.connected_client_count().await, 0);

    let mut unauthenticated = TcpStream::connect(address).await.unwrap();
    tokio::io::AsyncWriteExt::write_all(&mut unauthenticated, &[0u8; 48])
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(server.connected_client_count().await, 0);
    let mut first = TcpStream::connect(address).await.unwrap();
    devcel_core::p2p_auth::connect(&mut first, address)
        .await
        .unwrap();
    wait_for_count(&server, 1).await;
    let mut second = TcpStream::connect(address).await.unwrap();
    devcel_core::p2p_auth::connect(&mut second, address)
        .await
        .unwrap();
    wait_for_count(&server, 2).await;
    drop(first);
    wait_for_count(&server, 1).await;
    drop(second);
    wait_for_count(&server, 0).await;
    assert!(
        server.is_running(),
        "Last disconnect must leave server listening"
    );

    let mut third = TcpStream::connect(address).await.unwrap();
    devcel_core::p2p_auth::connect(&mut third, address)
        .await
        .unwrap();
    wait_for_count(&server, 1).await;
    server.stop().await;
    assert_eq!(server.connected_client_count().await, 0);
    drop(third);
}
