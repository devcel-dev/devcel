//! P2P integration smoke test.
//!
//! Starts two P2PManager instances in one process and verifies:
//! 1. The first instance becomes the server
//! 2. The second discovers it through the registry and connects as a client
//! 3. Client-to-server requests and responses (Ping) complete a round trip
//! 4. Server broadcasts reach the client's handler
//! 5. Operations sent by the client are processed by the server and receive a response
//!
//! Run: cargo run -p devcel-core --example p2p_smoke

use devcel_core::msgpack_client::MsgPackClient;
use devcel_core::msgpack_server::MsgPackServer;
use devcel_core::operation_handler::{LocalOperationHandler, OperationHandler};
use devcel_core::operations::{DevcelOperation, DevcelResponse};
use devcel_core::p2p_manager::{ConnectionMode, P2PManager};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Validation handler that applies committed snapshots to a real project and counts successes
struct CountingHandler {
    count: Arc<AtomicUsize>,
    local: LocalOperationHandler,
}

#[async_trait::async_trait]
impl OperationHandler for CountingHandler {
    async fn handle_operation(&self, operation: DevcelOperation) -> DevcelResponse {
        self.local.handle_operation(operation).await
    }

    async fn apply_server_snapshot(&self, snapshot: serde_json::Value) -> DevcelResponse {
        let response = self.local.apply_server_snapshot(snapshot).await;
        if matches!(response, DevcelResponse::Ok(_)) {
            self.count.fetch_add(1, Ordering::SeqCst);
        }
        response
    }
}

fn fail(msg: &str) -> ! {
    println!("=== SMOKE TEST FAILED: {msg} ===");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    // Create a temporary project
    let base_dir = std::env::temp_dir().join(format!("devcel_p2p_smoke_{}", std::process::id()));
    std::fs::create_dir_all(&base_dir).expect("failed to create temp dir");
    let project_name = "smoke";

    let project = devcel_core::Project::create_project(
        project_name,
        base_dir.to_str().unwrap(),
        "p2p smoke test",
        "#ffffff",
    )
    .expect("failed to create project");
    let project_file = project.get_project_path();
    drop(project);
    println!("[SMOKE] Created temp project at {project_file}");

    // === Instance A: expected to become the server ===
    let mut a = P2PManager::new();
    a.set_client_impl(Box::new(MsgPackClient::new())).await;
    a.set_server_impl(Box::new(MsgPackServer::new(a.project_ref())));

    let mode_a = a
        .open_project_p2p(&project_file, "smoke-a", 0)
        .await
        .unwrap_or_else(|e| fail(&format!("A failed to open project: {e}")));

    match &mode_a {
        ConnectionMode::Server { listening_addr } => {
            println!("[SMOKE] ✓ Instance A became SERVER on {listening_addr}");
        }
        ConnectionMode::Client { .. } => fail("Instance A should have become the server"),
    }

    // === Instance B: expected to become a client ===
    let broadcast_count = Arc::new(AtomicUsize::new(0));
    let mut b = P2PManager::new();
    let mut client_b = MsgPackClient::new();
    client_b.set_operation_handler(Arc::new(CountingHandler {
        count: broadcast_count.clone(),
        local: LocalOperationHandler::new(b.project_ref()),
    }));
    b.set_client_impl(Box::new(client_b)).await;
    b.set_server_impl(Box::new(MsgPackServer::new(b.project_ref())));

    let mode_b = b
        .open_project_p2p(&project_file, "smoke-b", 0)
        .await
        .unwrap_or_else(|e| fail(&format!("B failed to open project: {e}")));

    match &mode_b {
        ConnectionMode::Client { server_addr } => {
            println!("[SMOKE] ✓ Instance B became CLIENT connected to {server_addr}");
        }
        ConnectionMode::Server { .. } => {
            fail("Instance B should have connected as client, but became a server")
        }
    }

    // === Client-to-server request/response ===
    let ping_response = b.execute_operation(DevcelOperation::Ping).await;
    match &ping_response {
        DevcelResponse::Ok(_) => println!("[SMOKE] ✓ Ping request/response roundtrip works"),
        DevcelResponse::Error(e) => fail(&format!("Ping failed: {e}")),
    }

    // Get the project name from the client to verify that it sees the server's project
    let name_response = b.execute_operation(DevcelOperation::GetProjectName).await;
    match &name_response {
        DevcelResponse::Ok(v) => {
            println!("[SMOKE] ✓ GetProjectName via P2P returned: {v}");
        }
        DevcelResponse::Error(e) => fail(&format!("GetProjectName failed: {e}")),
    }

    // === Server broadcast to client ===
    let response = a
        .execute_operation(DevcelOperation::UpdateProjectDescription {
            description: "server committed value".into(),
        })
        .await;
    if !matches!(response, DevcelResponse::Ok(_)) {
        fail("Server edit was not committed");
    }

    // Wait for the broadcast to arrive
    let mut received = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if broadcast_count.load(Ordering::SeqCst) > 0 {
            received = true;
            break;
        }
    }
    if received {
        println!("[SMOKE] ✓ Server-initiated broadcast reached the client handler");
    } else {
        fail("Broadcast from server never reached the client");
    }

    if b.project_ref()
        .lock()
        .await
        .as_ref()
        .unwrap()
        .get_project_description()
        != "server committed value"
    {
        fail("Client did not apply the authoritative server value");
    }

    // === Client-to-server edits and committed snapshots ===
    let response = b
        .execute_operation(DevcelOperation::UpdateProjectDescription {
            description: "client committed value".into(),
        })
        .await;
    if !matches!(response, DevcelResponse::Ok(_)) {
        fail("Client edit failed");
    }
    for manager in [&a, &b] {
        if manager
            .project_ref()
            .lock()
            .await
            .as_ref()
            .unwrap()
            .get_project_description()
            != "client committed value"
        {
            fail("Committed snapshot differs between peers");
        }
    }
    println!("[SMOKE] ✓ Client edit and authoritative snapshots agree");

    // === Failover: server disappears and a client is promoted ===
    println!("[SMOKE] Testing failover: shutting down server A...");
    let mut disconnect_rx = b
        .get_server_disconnection_receiver()
        .await
        .unwrap_or_else(|| fail("Failed to get disconnection receiver"));

    let _ = a.disconnect().await;

    // Wait for server loss detection (health checks: 2 seconds x 3 failures, about 6 seconds plus margin)
    match tokio::time::timeout(Duration::from_secs(20), disconnect_rx.recv()).await {
        Ok(Some(_)) => println!("[SMOKE] ✓ Client B detected server loss"),
        _ => fail("Client B did not detect server loss within 20s"),
    }

    // Run failover using the same call as the Tauri integration layer
    b.handle_disconnection()
        .await
        .unwrap_or_else(|e| fail(&format!("Failover failed: {e}")));

    match b.get_connection_mode().await {
        Some(ConnectionMode::Server { listening_addr }) => {
            println!("[SMOKE] ✓ Client B promoted to SERVER on {listening_addr} after server loss");
        }
        other => fail(&format!("B should have promoted to server, got: {other:?}")),
    }

    // Verify that a new instance D discovers and connects to the promoted B as its server
    let mut d = P2PManager::new();
    d.set_client_impl(Box::new(MsgPackClient::new())).await;
    d.set_server_impl(Box::new(MsgPackServer::new(d.project_ref())));

    let mode_d = d
        .open_project_p2p(&project_file, "smoke-d", 0)
        .await
        .unwrap_or_else(|e| fail(&format!("D failed to open project: {e}")));

    match &mode_d {
        ConnectionMode::Client { server_addr } => {
            println!("[SMOKE] ✓ New instance D connected to the promoted server at {server_addr}");
        }
        ConnectionMode::Server { .. } => {
            fail("Instance D should have connected to the promoted server, but became a server")
        }
    }
    let _ = d.disconnect().await;

    // === Heartbeat validation (optional: --with-heartbeat-test) ===
    // Verify that the server remains discoverable beyond the registry's stale timeout.
    // Without a working heartbeat, an instance started after the timeout cannot
    // discover the server and fails when trying to become the server itself.
    if std::env::args().any(|a| a == "--with-heartbeat-test") {
        let wait = devcel_core::discovery::SERVICE_STALE_TIMEOUT + Duration::from_secs(5);
        println!(
            "[SMOKE] Waiting {wait:?} (stale timeout + margin) to verify heartbeat keeps the server discoverable..."
        );
        tokio::time::sleep(wait).await;

        let mut c = P2PManager::new();
        c.set_client_impl(Box::new(MsgPackClient::new())).await;
        c.set_server_impl(Box::new(MsgPackServer::new(c.project_ref())));

        let mode_c = c
            .open_project_p2p(&project_file, "smoke-c", 0)
            .await
            .unwrap_or_else(|e| fail(&format!("C failed to open project: {e}")));

        match &mode_c {
            ConnectionMode::Client { server_addr } => {
                println!(
                    "[SMOKE] ✓ Instance C (started after stale timeout) still found the server at {server_addr}"
                );
            }
            ConnectionMode::Server { .. } => {
                fail("Instance C became a server — heartbeat did not keep the registry fresh")
            }
        }
        let _ = c.disconnect().await;
    }

    // Clean up
    let _ = b.disconnect().await;
    let _ = a.disconnect().await;
    let _ = std::fs::remove_dir_all(&base_dir);

    println!("=== SMOKE TEST PASSED ===");
}
