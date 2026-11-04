//! Integration of failed startup, project switching, and shared registry writes.
use devcel_core::{
    discovery::{ServiceInfo, ServiceStatus},
    msgpack_client::MsgPackClient,
    msgpack_server::MsgPackServer,
    p2p_manager::{ConnectionMode, P2PManager},
    registry::FileBasedRegistry,
    Project,
};
use std::{fs, net::SocketAddr, time::SystemTime};

fn service(project: &str, port: u16) -> ServiceInfo {
    ServiceInfo {
        app_type: "integration".into(),
        project_path: project.into(),
        project_uuid: "fixture".into(),
        address: SocketAddr::from(([127, 0, 0, 1], port)),
        last_seen: SystemTime::now(),
        status: ServiceStatus::Client(SocketAddr::from(([127, 0, 0, 1], 1))),
        connection_order: 0,
    }
}

#[tokio::test]
async fn failed_start_releases_ownership_before_same_manager_opens_another_project() {
    // This integration binary has one test; its HOME change is process-local.
    let root = std::env::temp_dir().join(format!("devcel-managed-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    std::env::set_var("HOME", &root);
    std::env::set_var("APPDATA", &root);
    std::env::set_var("DEVCEL_P2P_SESSION_DIR", root.join("sessions"));
    let a = Project::create_project("A", root.to_str().unwrap(), "", "#123456").unwrap();
    let b = Project::create_project("B", root.to_str().unwrap(), "", "#123456").unwrap();
    let path_a = a.get_project_path();
    let path_b = b.get_project_path();
    let registry = FileBasedRegistry::new().unwrap();
    registry.register_service(service(&path_a, 12345)).unwrap();
    let registry_dir = root.join("sessions/discovery");
    let file = fs::read_dir(&registry_dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|e| e == "json"))
        .unwrap();
    fs::write(file, "invalid registry JSON").unwrap();

    let mut manager = P2PManager::try_new().unwrap();
    manager.set_preload_server_tables(true);
    manager
        .set_client_impl(Box::new(MsgPackClient::new()))
        .await;
    manager.set_server_impl(Box::new(MsgPackServer::new(manager.project_ref())));
    assert!(manager.open_project_p2p(&path_a, "test", 0).await.is_err());
    assert!(!manager.is_server_running());
    assert!(registry
        .try_project_lock(&path_a, "server")
        .unwrap()
        .is_some());
    // Reuse the existing shared reference just as Studio's project switch does.
    *manager.project_ref().lock().await = Some(b);
    assert!(matches!(
        manager.open_project_p2p(&path_b, "test", 0).await.unwrap(),
        ConnectionMode::Server { .. }
    ));
    assert!(registry
        .try_project_lock(&path_b, "server")
        .unwrap()
        .is_none());
    assert!(registry
        .try_project_lock(&path_a, "server")
        .unwrap()
        .is_some());
    manager.disconnect().await.unwrap();
    assert!(registry
        .try_project_lock(&path_b, "server")
        .unwrap()
        .is_some());

    // Concurrent writers cannot drop other peers, even with independent registry objects.
    let mut writers = Vec::new();
    for index in 0..16 {
        let path = path_b.clone();
        writers.push(std::thread::spawn(move || {
            FileBasedRegistry::new()
                .unwrap()
                .register_service(service(&path, 13000 + index))
                .unwrap();
        }));
    }
    for writer in writers {
        writer.join().unwrap();
    }
    let services = registry.get_all_services(&path_b);
    assert_eq!(services.len(), 16);
    let mut orders: Vec<_> = services
        .iter()
        .map(|service| service.connection_order)
        .collect();
    orders.sort();
    orders.dedup();
    assert_eq!(orders.len(), 16);
    // Reader created before those writes observes every newly registered peer.
    assert_eq!(registry.get_all_services(&path_b).len(), 16);

    // A closed listener is not the end of authority ownership: stop/unregister
    // still holds the server lock. A new manager must wait, never fail startup
    // or become a second authority during that deterministic handoff window.
    let retiring =
        Project::create_project("Retiring", root.to_str().unwrap(), "", "#123456").unwrap();
    let retiring_path = retiring.get_project_path();
    let old_owner = registry
        .try_project_lock(&retiring_path, "server")
        .unwrap()
        .unwrap();
    assert!(registry.find_active_server(&retiring_path).is_none());
    let mut successor = P2PManager::try_new().unwrap();
    successor
        .set_client_impl(Box::new(MsgPackClient::new()))
        .await;
    successor.set_server_impl(Box::new(MsgPackServer::new(successor.project_ref())));
    let mode = {
        use std::future::Future;
        use std::task::Poll;
        let opening = successor.open_project_p2p(&retiring_path, "handoff-test", 0);
        tokio::pin!(opening);
        let first_poll = std::future::poll_fn(|cx| Poll::Ready(opening.as_mut().poll(cx))).await;
        assert!(
            first_poll.is_pending(),
            "successor must wait for retiring authority, got {first_poll:?}"
        );
        assert!(registry
            .try_project_lock(&retiring_path, "server")
            .unwrap()
            .is_none());
        drop(old_owner);
        opening.await.unwrap()
    };
    assert!(matches!(mode, ConnectionMode::Server { .. }));
    assert!(registry
        .try_project_lock(&retiring_path, "server")
        .unwrap()
        .is_none());
    successor.disconnect().await.unwrap();
    assert!(registry
        .try_project_lock(&retiring_path, "server")
        .unwrap()
        .is_some());
    fs::remove_dir_all(&root).unwrap();

    // The same harness is deliberately single-threaded: all real child processes
    // get their own explicit session namespace, without user discovery state.
    fs::create_dir(&root).unwrap();
    let evidence = root.join("real-process");
    let python = std::env::var_os("DEVCEL_TEST_PYTHON").unwrap_or_else(|| "python".into());
    let output = std::process::Command::new(python)
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/managed_watch.py"))
        .arg(env!("CARGO_BIN_EXE_devcel"))
        .arg(&evidence)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Managed process contract failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    let receipt: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
    assert_eq!(receipt["ok"], serde_json::json!(true));
    // managed_watch.py adds its inherited-stdin-writer check only on POSIX.
    #[cfg(unix)]
    let expected_checks = 16;
    #[cfg(windows)]
    let expected_checks = 15;
    assert_eq!(receipt["checks"].as_u64(), Some(expected_checks));
    fs::remove_dir_all(&root).unwrap();
}
