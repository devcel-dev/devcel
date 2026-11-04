//! Importer-owned watch lifetime and automatic local-server acquisition.
//!
//! The MessagePack socket is the lease. No PID file, process-name lookup, or
//! explicit release RPC is required: EOF releases demand even after a crash.
use super::{
    DevcelClient, DevcelOperation, DevcelResponse, FileBasedRegistry, MsgPackClient, PrintHandler,
};
use devcel_core::discovery::normalize_project_path;
use devcel_core::msgpack_server::MsgPackServer;
use devcel_core::p2p_manager::{ConnectionMode, P2PManager};
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);
const RELOAD_GRACE: Duration = Duration::from_secs(5);

fn launch_server(
    project_path: &str,
) -> Result<tokio::sync::oneshot::Receiver<Result<(), String>>, String> {
    // Use this exact bundled executable, never PATH or a shell. Do not inherit
    // any importer pipe: grandchildren keeping a pipe open break editor exit.
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut command = Command::new(executable);
    command
        .args(["--project", project_path, "__serve-managed"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00000200); // NO_WINDOW | NEW_PROCESS_GROUP
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to launch bundled server: {e}"))?;
    let output = child
        .stdout
        .take()
        .ok_or("Missing managed-server startup pipe")?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // This is a dedicated startup pipe, not the importer's output pipe. Read
    // exactly one result, close it, then reap the independently lived child.
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(output)
            .take(65536)
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read managed-server startup result: {e}"))
            .and_then(|_| {
                serde_json::from_str::<serde_json::Value>(&line)
                    .map_err(|e| format!("Managed server exited before startup: {e}"))
            })
            .and_then(|value| {
                if value["ok"] == true {
                    Ok(())
                } else {
                    Err(format!("Managed server startup failed: {}", value["error"]))
                }
            });
        let _ = sender.send(result);
        let _ = child.wait();
    });
    Ok(receiver)
}

async fn connect_existing(project_path: &str) -> Result<Option<MsgPackClient>, String> {
    let Some(server) = FileBasedRegistry::new()?.find_active_server(project_path) else {
        return Ok(None);
    };
    let mut client = MsgPackClient::new();
    client.set_operation_handler(Arc::new(PrintHandler));
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        client
            .connect(server.address)
            .await
            .map_err(|error| error.to_string())?;
        // TCP reachability alone is insufficient (stale address/port reuse).
        // A current request envelope and exact canonical project identity must
        // round-trip before the importer is told it is connected.
        match client
            .send_operation(DevcelOperation::GetProjectInfo)
            .await
            .map_err(|error| error.to_string())?
        {
            DevcelResponse::Ok(info) => {
                let path = info["path"]
                    .as_str()
                    .ok_or("Server did not identify its project")?;
                if normalize_project_path(path) != normalize_project_path(project_path) {
                    return Ok(false);
                }
                Ok(true)
            }
            DevcelResponse::Error(error) => {
                Err(format!("Server rejected project handshake: {error}"))
            }
        }
    })
    .await;
    match result {
        Ok(Ok(true)) => Ok(Some(client)),
        Ok(Ok(false)) => {
            client.disconnect().await;
            // A different, positively identified project at this address means
            // port reuse after a crash. Remove only that unchanged stale record;
            // do not stop or otherwise touch the unrelated live server.
            FileBasedRegistry::new()?.remove_misdirected_server(&server)?;
            Ok(None)
        }
        failure => {
            client.disconnect().await;
            // An idle authority can close between discovery and admission. Its
            // vanished listener is safe to reacquire; a reachable incompatible
            // endpoint must remain a visible failure, never a second authority.
            if FileBasedRegistry::new()?
                .find_active_server(project_path)
                .is_none()
            {
                return Ok(None);
            }
            Err(format!(
                "Existing P2P server is unavailable or incompatible: {failure:?}"
            ))
        }
    }
}

async fn acquire(project_path: &str, ensure_server: bool) -> Result<MsgPackClient, String> {
    if let Some(client) = connect_existing(project_path).await? {
        return Ok(client);
    }
    if !ensure_server {
        return Err("No P2P server found (watch requires a server)".to_string());
    }
    let registry = FileBasedRegistry::new()?;
    // One launcher at a time, with a second discovery after taking the lock.
    // The server also holds its own OS lock for its entire lifetime, so a
    // launcher crash before registration cannot produce two authorities.
    let _launcher = registry.project_lock(project_path, "launcher").await?;
    if let Some(client) = connect_existing(project_path).await? {
        return Ok(client);
    }
    // If an authority is starting/stopping after its launcher disappeared,
    // wait for its lifetime lock instead of spawning a doomed duplicate child.
    loop {
        if let Some(guard) = registry.try_project_lock(project_path, "server")? {
            drop(guard);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Some(client) = connect_existing(project_path).await? {
            return Ok(client);
        }
    }
    let startup = launch_server(project_path)?;
    startup
        .await
        .map_err(|_| "Managed server startup channel closed".to_string())??;
    let mut delay = Duration::from_millis(40);
    loop {
        tokio::time::sleep(delay).await;
        if let Some(client) = connect_existing(project_path).await? {
            return Ok(client);
        }
        delay = (delay * 2).min(Duration::from_millis(500));
    }
}

pub async fn watch(
    project_path: &str,
    ensure_server: bool,
    parent_stdin: bool,
) -> Result<(), String> {
    let (parent_closed_tx, parent_closed) = tokio::sync::oneshot::channel::<()>();
    // A dedicated ordinary thread avoids Tokio's uninterruptible stdin worker
    // delaying runtime shutdown. EOF monitoring starts BEFORE server acquisition.
    if parent_stdin {
        std::thread::spawn(move || {
            let mut input = std::io::stdin().lock();
            let mut buffer = [0u8; 256];
            loop {
                match input.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
            let _ = parent_closed_tx.send(());
        });
    }
    tokio::pin!(parent_closed);
    let acquire = tokio::time::timeout(ACQUIRE_TIMEOUT, acquire(project_path, ensure_server));
    let mut client = tokio::select! {
        biased;
        _ = &mut parent_closed, if parent_stdin => return Ok(()),
        _ = tokio::signal::ctrl_c() => return Ok(()),
        result = acquire => result.map_err(|_| "P2P server acquisition timed out after 10 seconds".to_string())??,
    };
    println!(
        "{}",
        serde_json::json!({"event": "connected", "server": client.get_server_addr().unwrap().to_string()})
    );
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            _ = &mut parent_closed, if parent_stdin => break,
            _ = tokio::signal::ctrl_c() => break,
            _ = interval.tick() => {
                if !client.is_connected() {
                    println!("{}", serde_json::json!({"event": "disconnected"}));
                    break;
                }
            }
        }
    }
    client.disconnect().await;
    Ok(())
}

pub async fn serve(project_path: &str) -> Result<(), devcel_core::AppError> {
    let mut manager = P2PManager::try_new()?;
    manager.set_preload_server_tables(true);
    manager
        .set_client_impl(Box::new(MsgPackClient::new()))
        .await;
    let mut server = MsgPackServer::new(manager.project_ref());
    server.set_idle_shutdown(RELOAD_GRACE);
    manager.set_server_impl(Box::new(server));
    let result = manager
        .open_project_p2p(project_path, "devcel-importer", 0)
        .await;
    match result {
        Ok(ConnectionMode::Server { .. }) => {
            println!("{}", serde_json::json!({"ok": true}));
            // Stay alive for all connected importers AND other editors. Idle
            // shutdown is decided inside the accept loop, atomically with admission.
            while manager.is_server_running() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        Ok(ConnectionMode::Client { .. }) => {
            println!("{}", serde_json::json!({"ok": true}));
            // Another startup won; this process owns no server and must not
            // manufacture demand or shut down the existing authority.
        }
        Err(error) => {
            let _ = manager.disconnect().await;
            return Err(error);
        }
    }
    manager.disconnect().await
}
