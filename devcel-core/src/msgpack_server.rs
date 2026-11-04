use crate::conflict_resolution::ConflictResolver;
use crate::operation_handler::{LocalOperationHandler, OperationHandler};
use crate::operations::{DevcelOperation, DevcelResponse, OperationMetadata};
use crate::p2p_manager::DevcelServer;
use crate::p2p_messages::P2PMessage;
use crate::Project;
use async_trait::async_trait;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, RwLock};

/// Only a valid protocol request acquires demand; registry TCP probes do not.
/// Admission and the transition to closing share one mutex, preventing shutdown
/// from racing a newly admitted importer/editor.
struct ServerActivity {
    leases: usize,
    idle_since: std::time::Instant,
    closing: bool,
}
struct ConnectionLease(Arc<StdMutex<ServerActivity>>);
impl ConnectionLease {
    fn acquire(activity: &Arc<StdMutex<ServerActivity>>) -> Result<Self, std::io::Error> {
        let mut state = activity.lock().unwrap();
        if state.closing {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "Server is stopping",
            ));
        }
        state.leases += 1;
        Ok(Self(activity.clone()))
    }
}
impl Drop for ConnectionLease {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.leases -= 1;
        if state.leases == 0 {
            state.idle_since = std::time::Instant::now();
        }
    }
}

// A single serialized frame may be shared by many replicas. Reserve its bytes
// once until the last bounded per-client queue/writer releases it.
struct Delivery {
    bytes: Vec<u8>,
    _memory: Vec<tokio::sync::OwnedSemaphorePermit>,
}
#[cfg(test)]
fn delivery(
    bytes: Vec<u8>,
    memory: &Arc<tokio::sync::Semaphore>,
) -> std::io::Result<Arc<Delivery>> {
    if bytes.len() > crate::msgpack_framing::MAX_MESSAGE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "P2P outbound message exceeds limit",
        ));
    }
    let permit = memory
        .clone()
        .try_acquire_many_owned(bytes.len() as u32)
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::OutOfMemory,
                "P2P outbound budget exhausted",
            )
        })?;
    Ok(Arc::new(Delivery {
        bytes,
        _memory: vec![permit],
    }))
}
struct BoundedEncoding {
    bytes: Vec<u8>,
    memory: Arc<tokio::sync::Semaphore>,
    permits: Vec<tokio::sync::OwnedSemaphorePermit>,
    reserved: usize,
}
impl std::io::Write for BoundedEncoding {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        const BLOCK: usize = 64 * 1024;
        let needed = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|size| *size <= crate::msgpack_framing::MAX_MESSAGE_BYTES)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "P2P encoded message exceeds limit",
                )
            })?;
        if needed > self.reserved {
            let new_reserved = needed.div_ceil(BLOCK) * BLOCK;
            self.permits.push(
                self.memory
                    .clone()
                    .try_acquire_many_owned((new_reserved - self.reserved) as u32)
                    .map_err(|_| {
                        std::io::Error::new(
                            std::io::ErrorKind::OutOfMemory,
                            "P2P encoding budget exhausted",
                        )
                    })?,
            );
            self.reserved = new_reserved;
        }
        self.bytes.try_reserve_exact(bytes.len()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::OutOfMemory,
                "P2P encoding allocation failed",
            )
        })?;
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encode_delivery(
    message: &P2PMessage,
    memory: &Arc<tokio::sync::Semaphore>,
) -> std::io::Result<Arc<Delivery>> {
    let mut output = BoundedEncoding {
        bytes: Vec::new(),
        memory: memory.clone(),
        permits: Vec::new(),
        reserved: 0,
    };
    serde::Serialize::serialize(
        message,
        &mut rmp_serde::Serializer::new(&mut output).with_struct_map(),
    )
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "P2P encoding rejected"))?;
    Ok(Arc::new(Delivery {
        bytes: output.bytes,
        _memory: output.permits,
    }))
}
struct ClientConnection {
    outgoing: tokio::sync::mpsc::Sender<Arc<Delivery>>,
    closed: tokio::sync::watch::Sender<bool>,
    #[allow(dead_code)]
    address: SocketAddr,
}
struct AbortWriter(tokio::task::JoinHandle<()>);
impl Drop for AbortWriter {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn write_client(
    mut stream: tokio::io::WriteHalf<TcpStream>,
    mut outgoing: tokio::sync::mpsc::Receiver<Arc<Delivery>>,
    mut closed: tokio::sync::watch::Receiver<bool>,
    notify: tokio::sync::watch::Sender<bool>,
) {
    loop {
        let message = tokio::select! {
            biased;
            _ = closed.changed() => break,
            message = outgoing.recv() => match message { Some(message) => message, None => break },
        };
        let result = tokio::select! {
            biased;
            _ = closed.changed() => break,
            result = tokio::time::timeout(Duration::from_secs(5), async {
                crate::msgpack_framing::write_message(&mut stream, &message.bytes).await?;
                stream.flush().await
            }) => result,
        };
        if !matches!(result, Ok(Ok(()))) {
            break;
        }
    }
    let _ = notify.send(true);
    // Dropping the write half is bounded, unlike waiting for a peer to drain.
}
fn enqueue(
    outgoing: &tokio::sync::mpsc::Sender<Arc<Delivery>>,
    closed: &tokio::sync::watch::Sender<bool>,
    message: Arc<Delivery>,
) -> std::io::Result<()> {
    outgoing.try_send(message).map_err(|_| {
        let _ = closed.send(true);
        std::io::Error::new(
            std::io::ErrorKind::ConnectionAborted,
            "P2P consumer must reconnect",
        )
    })
}

/// Client handler context
struct ClientHandlerContext {
    handler: Arc<dyn OperationHandler>,
    client_id: u64,
    clients: Arc<RwLock<HashMap<u64, ClientConnection>>>,
    peer_addr: SocketAddr,
    conflict_resolver: Arc<ConflictResolver>,
    client_sequences: Arc<RwLock<HashMap<u64, u64>>>,
    operation_gate: Arc<Mutex<()>>,
    incoming_memory: Arc<tokio::sync::Semaphore>,
    outgoing_memory: Arc<tokio::sync::Semaphore>,
    started_at: std::time::Instant,
    activity: Arc<StdMutex<ServerActivity>>,
}

/// MessagePack-based server implementation for P2P connections
pub struct MsgPackServer {
    /// The project instance
    project: Arc<Mutex<Option<Project>>>,
    /// Server shutdown handle
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    /// Server listening address
    listening_addr: Option<SocketAddr>,
    /// Connected clients
    clients: Arc<RwLock<HashMap<u64, ClientConnection>>>,
    /// Client ID counter
    next_client_id: Arc<Mutex<u64>>,
    /// Conflict resolver
    conflict_resolver: Arc<ConflictResolver>,
    /// Client sequence numbers
    client_sequences: Arc<RwLock<HashMap<u64, u64>>>,
    operation_gate: Arc<Mutex<()>>,
    incoming_memory: Arc<tokio::sync::Semaphore>,
    outgoing_memory: Arc<tokio::sync::Semaphore>,
    /// Server task handle for proper shutdown
    server_task_handle: Option<tokio::task::JoinHandle<()>>,
    /// Injected operation handler (used instead of the default LocalOperationHandler)
    injected_handler: Option<Arc<dyn OperationHandler>>,
    idle_shutdown: Option<Duration>,
    capability: Option<Arc<crate::p2p_auth::SessionCapability>>,
    #[cfg(test)]
    session_directory: Option<std::path::PathBuf>,
}

impl MsgPackServer {
    pub fn new(project: Arc<Mutex<Option<Project>>>) -> Self {
        Self {
            project,
            shutdown_tx: None,
            listening_addr: None,
            clients: Arc::new(RwLock::new(HashMap::new())),
            next_client_id: Arc::new(Mutex::new(1)),
            conflict_resolver: Arc::new(ConflictResolver::new()),
            client_sequences: Arc::new(RwLock::new(HashMap::new())),
            operation_gate: Arc::new(Mutex::new(())),
            incoming_memory: Arc::new(tokio::sync::Semaphore::new(
                crate::msgpack_framing::MAX_MESSAGE_BYTES,
            )),
            outgoing_memory: Arc::new(tokio::sync::Semaphore::new(512 * 1024 * 1024)),
            server_task_handle: None,
            injected_handler: None,
            idle_shutdown: None,
            capability: None,
            #[cfg(test)]
            session_directory: None,
        }
    }

    /// Only automatically acquired servers enable this. Every live socket,
    /// including Studio/manual clients, keeps the server alive.
    pub fn set_idle_shutdown(&mut self, grace: Duration) {
        self.idle_shutdown = Some(grace);
    }

    /// Set a custom operation handler used for processing client operations.
    /// If not set, a LocalOperationHandler over the project is used.
    pub fn set_operation_handler(&mut self, handler: Arc<dyn OperationHandler>) {
        self.injected_handler = Some(handler);
    }

    async fn handle_client(
        stream: TcpStream,
        ctx: ClientHandlerContext,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        crate::p2p_diagnostics::trace!("[SERVER-HANDLER] Client {} handler started", ctx.client_id);
        crate::p2p_diagnostics::trace!(
            "[SERVER-HANDLER] Client {} address: {}",
            ctx.client_id,
            ctx.peer_addr
        );

        // Separate reading from writing
        // (A single Mutex<TcpStream> would let the read loop hold the lock while waiting,
        // blocking server-to-client broadcasts and other writes until the next incoming message)
        let (mut read_stream, write_half) = tokio::io::split(stream);
        let (outgoing, receiver) = tokio::sync::mpsc::channel(8);
        let (closed, mut closing) = tokio::sync::watch::channel(false);
        let _writer = AbortWriter(tokio::spawn(write_client(
            write_half,
            receiver,
            closing.clone(),
            closed.clone(),
        )));

        // Register client
        crate::p2p_diagnostics::trace!(
            "[SERVER-HANDLER] Registering client {} in client map...",
            ctx.client_id
        );
        {
            let mut clients_guard = ctx.clients.write().await;
            if ctx.activity.lock().unwrap().closing {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionAborted,
                    "Server is stopping",
                )
                .into());
            }
            clients_guard.insert(
                ctx.client_id,
                ClientConnection {
                    outgoing: outgoing.clone(),
                    closed: closed.clone(),
                    address: ctx.peer_addr,
                },
            );
            let client_count = clients_guard.len();
            crate::p2p_diagnostics::trace!(
                "[SERVER-HANDLER] Client {} registered successfully (total clients: {})",
                ctx.client_id,
                client_count
            );
        }

        let result = async {
            let mut message_count = 0u64;
            let mut lease = None;
            loop {
                let received = tokio::select! {
                    biased;
                    _ = closing.changed() => break,
                    result = crate::msgpack_framing::read_message_budgeted(&mut read_stream, &ctx.incoming_memory) => result?,
                };
                let msg_buf = match received { Some(data) => data, None => break };
                let msg_len=msg_buf.len();

                message_count += 1;
                crate::p2p_diagnostics::trace!(
                    "[SERVER-HANDLER] Client {} message #{} received ({} bytes)",
                    ctx.client_id, message_count, msg_len
                );

                // Only request-ID envelopes are part of the current wire contract.
                // Reject malformed/raw messages before executing any operation.
                let (request_id, operation) = match rmp_serde::from_slice::<P2PMessage>(&msg_buf)? {
                    P2PMessage::Request { id, operation } => (id, operation),
                    _ => {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "Server accepts only P2P request envelopes",
                        ).into());
                    }
                };

                if lease.is_none() {
                    lease = Some(ConnectionLease::acquire(&ctx.activity)?);
                }

                if let Err(e) = Self::validate_operation(&operation) {
                    crate::p2p_diagnostics::trace!("Operation validation failed: {e}");
                    let error_message = P2PMessage::response(
                        request_id,
                        DevcelResponse::Error(e),
                    );
                    enqueue(&outgoing, &closed, encode_delivery(&error_message, &ctx.outgoing_memory)?)?;
                    continue;
                }

                // Serialize mutation + snapshot capture + FIFO enqueue. Network IO
                // runs outside this gate, so slow peers cannot hold the project lock.
                let _operation_guard = ctx.operation_gate.lock().await;

                // Handle operations through the operation handler
                // applied_operation is set when a (potentially mutating) operation was
                // actually applied, and is used for the broadcast decision below
                let mut applied_operation: Option<DevcelOperation> = None;
                let response = match &operation {
                    // A batch is applied atomically through the operation handler.
                    DevcelOperation::ExecuteBatch { .. } => {
                        let response = ctx.handler.handle_operation(operation.clone()).await;
                        applied_operation = Some(operation.clone());
                        response
                    }
                    _ => {
                        // Handle regular operations with metadata for conflict resolution

                        // Check if this is an operation with metadata
                        let (actual_operation, metadata) = match &operation {
                            DevcelOperation::OperationWithMetadata {
                                operation,
                                metadata,
                            } => {
                                let mut metadata = metadata.clone();
                                metadata.client_id = ctx.client_id; // peer IDs are server-owned namespaces
                                (operation.as_ref().clone(), Some(metadata))
                            },
                            _ => {
                                // Create metadata for operations without it
                                let sequence = ctx.conflict_resolver.next_sequence(ctx.client_id).await?;
                                let metadata = OperationMetadata::new(ctx.client_id, sequence);
                                (operation.clone(), Some(metadata))
                            }
                        };

                        // Apply conflict resolution if metadata is present
                        let should_apply = if let Some(ref meta) = metadata {
                            match ctx.conflict_resolver.add_operation(actual_operation.clone(), meta.clone()).await {
                                Ok(ready) => ready,
                                Err(error) => {
                                    let response = P2PMessage::response(request_id, DevcelResponse::Error(crate::AppError::technical(error)));
                                    enqueue(&outgoing, &closed, encode_delivery(&response, &ctx.outgoing_memory)?)?;
                                    continue; // quota rejection is explicit; accepted pending entries stay intact
                                }
                            }
                        } else {
                            true
                        };

                        if should_apply {
                            // Execute the canonical operation through its authoritative handler
                            let response = if matches!(actual_operation, DevcelOperation::GetServerInfo) {
                                DevcelResponse::Ok(serde_json::json!({
                                    "server_running": true,
                                    "uptime_seconds": ctx.started_at.elapsed().as_secs(),
                                    "connected_clients": ctx.clients.read().await.len(),
                                    "has_active_project": matches!(ctx.handler.handle_operation(DevcelOperation::GetProjectInfo).await, DevcelResponse::Ok(_)),
                                }))
                            } else {
                                ctx.handler.handle_operation(actual_operation.clone()).await
                            };
                            applied_operation = Some(actual_operation);
                            response
                        } else {
                            DevcelResponse::Ok(serde_json::json!({"status": "queued"}))
                        }
                    }
                };

                // Send server-confirmed values to every replica, including the author.
                // Batch operations produce one snapshot; generated UUIDs are never replayed.
                if let Some(applied) = applied_operation {
                    if !applied.is_read_only() && matches!(response, DevcelResponse::Ok(_)) {
                        Self::broadcast_committed_state(ctx.handler.as_ref(), &ctx.clients, &ctx.outgoing_memory).await;
                    }
                }

                // Send response to requesting client
                let response_message = P2PMessage::response(request_id, response);

                enqueue(&outgoing, &closed, encode_delivery(&response_message, &ctx.outgoing_memory)?)?;

                // Check for any ready operations
                let ready_ops = ctx
                    .conflict_resolver
                    .get_ready_operations(ctx.client_id)
                    .await;
                for (ready_op, _ready_meta) in ready_ops {
                    let mutation = !ready_op.is_read_only();
                    if matches!(
                        ctx.handler.handle_operation(ready_op).await,
                        DevcelResponse::Ok(_)
                    ) && mutation
                    {
                        Self::broadcast_committed_state(ctx.handler.as_ref(), &ctx.clients, &ctx.outgoing_memory).await;
                    }
                }
            }
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        }
        .await;

        // Remove client on disconnect
        crate::p2p_diagnostics::trace!(
            "[SERVER-HANDLER] Removing client {} from client map...",
            ctx.client_id
        );
        {
            let mut clients_guard = ctx.clients.write().await;
            clients_guard.remove(&ctx.client_id);
            let remaining_count = clients_guard.len();
            crate::p2p_diagnostics::trace!(
                "[SERVER-HANDLER] Client {} removed successfully (remaining clients: {})",
                ctx.client_id,
                remaining_count
            );
        }

        crate::p2p_diagnostics::trace!("[SERVER-HANDLER] ========================================");
        crate::p2p_diagnostics::trace!(
            "[SERVER-HANDLER] Client {} cleanup completed",
            ctx.client_id
        );
        crate::p2p_diagnostics::trace!("[SERVER-HANDLER] ========================================");
        ctx.client_sequences.write().await.remove(&ctx.client_id);
        ctx.conflict_resolver.forget_client(ctx.client_id).await;

        result
    }

    /// Broadcast a committed snapshot to every connected replica, including the author.
    async fn broadcast_snapshot(
        project_state: serde_json::Value,
        clients: &Arc<RwLock<HashMap<u64, ClientConnection>>>,
        memory: &Arc<tokio::sync::Semaphore>,
    ) {
        // Create a broadcast message
        let broadcast_message = P2PMessage::broadcast(project_state);

        let message = match encode_delivery(&broadcast_message, memory) {
            Ok(message) => message,
            Err(_) => {
                for client in clients.read().await.values() {
                    let _ = client.closed.send(true);
                }
                return;
            }
        };
        // Every client sees one FIFO. A full queue disconnects the consumer so
        // reconnect obtains a fresh canonical snapshot; snapshots are never skipped.
        for client in clients.read().await.values() {
            let _ = enqueue(&client.outgoing, &client.closed, message.clone());
        }
    }

    async fn broadcast_committed_state(
        handler: &dyn OperationHandler,
        clients: &Arc<RwLock<HashMap<u64, ClientConnection>>>,
        memory: &Arc<tokio::sync::Semaphore>,
    ) {
        match handler
            .handle_operation(DevcelOperation::GetFullProjectState)
            .await
        {
            DevcelResponse::Ok(state) => {
                if let Some(snapshot) = state.get("replication_state") {
                    Self::broadcast_snapshot(snapshot.clone(), clients, memory).await;
                }
            }
            DevcelResponse::Error(error) => {
                crate::p2p_diagnostics::trace!("Cannot capture committed state: {error}")
            }
        }
    }

    fn startup_error(addr: SocketAddr, error: std::io::Error) -> crate::AppError {
        crate::AppError::code(
            "p2p.error.connectionFailed",
            serde_json::json!({
                "details":error.to_string(),"address":addr.to_string(),"ioKind":format!("{:?}",error.kind()),"osCode":error.raw_os_error(),
            }),
        )
    }

    /// Validate incoming operation for security and integrity
    fn validate_operation(operation: &DevcelOperation) -> Result<(), crate::AppError> {
        use DevcelOperation::*;

        match operation {
            // Prevent dangerous operations
            DeleteProject { .. } => Err(crate::AppError::code(
                "p2p.validation.operationDenied",
                serde_json::json!({"operation":"DeleteProject"}),
            )),
            // A project server cannot be redirected to another project by a peer.
            OpenProject { .. } => Err(crate::AppError::code(
                "p2p.validation.operationDenied",
                serde_json::json!({"operation":"OpenProject"}),
            )),
            CreateProject { .. } => Err(crate::AppError::code(
                "p2p.validation.operationDenied",
                serde_json::json!({"operation":"CreateProject"}),
            )),
            // OS association activation belongs to an explicit local UI action.
            OpenInExplorer { .. } => Err(crate::AppError::code(
                "p2p.validation.operationDenied",
                serde_json::json!({"operation":"OpenInExplorer"}),
            )),
            Shutdown => Err(crate::AppError::code(
                "p2p.validation.operationDenied",
                serde_json::json!({"operation":"Shutdown"}),
            )),
            OperationWithMetadata { operation, .. } => Self::validate_operation(operation),
            ExecuteBatch { operations } => {
                if operations.len() > 10000 {
                    return Err(crate::AppError::code(
                        "p2p.validation.batchLimit",
                        serde_json::json!({"max":10000}),
                    ));
                }
                for operation in operations {
                    Self::validate_operation(operation)?;
                }
                Ok(())
            }
            // Validate string parameters
            CreateTable { data_name, .. }
            | CreateDirectory {
                directory_name: data_name,
                ..
            }
            | RenameTable {
                new_display_name: data_name,
                ..
            }
            | RenameDirectory {
                new_name: data_name,
                ..
            } => {
                if data_name.is_empty() || data_name.len() > 255 {
                    return Err(crate::AppError::code(
                        "p2p.validation.nameLength",
                        serde_json::json!({"min":1,"max":255}),
                    ));
                }
                // Check for invalid characters
                if data_name.contains("..") || data_name.contains('/') || data_name.contains('\\') {
                    return Err(crate::AppError::code(
                        "p2p.validation.nameCharacters",
                        serde_json::json!({}),
                    ));
                }
                Ok(())
            }
            // Allow other operations
            _ => Ok(()),
        }
    }
}

impl Drop for MsgPackServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(capability) = self.capability.as_ref() {
            capability.revoke();
        }
    }
}

#[async_trait]
impl DevcelServer for MsgPackServer {
    async fn start(&mut self, addr: SocketAddr) -> Result<(), crate::AppError> {
        if !addr.ip().is_loopback() {
            return Err(crate::AppError::technical(
                "Local project server requires a loopback address",
            ));
        }

        // On Windows, we must use socket2 to ensure exclusive port binding
        #[cfg(target_os = "windows")]
        let listener = {
            use socket2::{Domain, Socket, Type};

            crate::p2p_diagnostics::trace!(
                "[MsgPackServer] Creating exclusive socket for Windows..."
            );
            let socket = Socket::new(Domain::IPV4, Type::STREAM, None)
                .map_err(|error| Self::startup_error(addr, error))?;

            // CRITICAL: Disable SO_REUSEADDR to prevent multiple binds
            socket
                .set_reuse_address(false)
                .map_err(|error| Self::startup_error(addr, error))?;

            crate::p2p_diagnostics::trace!(
                "[MsgPackServer] Attempting to bind to {addr} (exclusive mode)..."
            );
            match socket.bind(&addr.into()) {
                Ok(_) => {
                    crate::p2p_diagnostics::trace!(
                        "[P2P-VERIFY] Exclusive bind successful for {addr}"
                    );
                    crate::p2p_diagnostics::trace!(
                        "[MsgPackServer] Successfully bound to {addr} (exclusive)"
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                    crate::p2p_diagnostics::trace!(
                        "[P2P-VERIFY] Exclusive bind FAILED for {addr} - AddrInUse"
                    );
                    crate::p2p_diagnostics::trace!(
                        "[MsgPackServer] ERROR: Port {} is already in use!",
                        addr.port()
                    );
                    return Err(Self::startup_error(addr, e));
                }
                Err(e) => {
                    crate::p2p_diagnostics::trace!(
                        "[P2P-VERIFY] Exclusive bind FAILED for {} - {:?}",
                        addr,
                        e.kind()
                    );
                    crate::p2p_diagnostics::trace!(
                        "[MsgPackServer] ERROR: Failed to bind: {} (kind: {:?})",
                        e,
                        e.kind()
                    );
                    return Err(Self::startup_error(addr, e));
                }
            }

            socket
                .listen(128)
                .map_err(|error| Self::startup_error(addr, error))?;

            socket
                .set_nonblocking(true)
                .map_err(|error| Self::startup_error(addr, error))?;

            // Convert to Tokio TcpListener
            let std_listener = socket.into();
            TcpListener::from_std(std_listener).map_err(|error| Self::startup_error(addr, error))?
        };

        #[cfg(not(target_os = "windows"))]
        let listener = {
            crate::p2p_diagnostics::trace!("[MsgPackServer] Attempting to bind to {}...", addr);
            match TcpListener::bind(addr).await {
                Ok(listener) => {
                    crate::p2p_diagnostics::trace!(
                        "[MsgPackServer] Successfully bound to {}",
                        addr
                    );
                    listener
                }
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                    crate::p2p_diagnostics::trace!(
                        "[MsgPackServer] ERROR: Port {} is already in use!",
                        addr.port()
                    );
                    return Err(Self::startup_error(addr, e));
                }
                Err(e) => {
                    crate::p2p_diagnostics::trace!(
                        "[MsgPackServer] ERROR: Failed to bind: {} (kind: {:?})",
                        e,
                        e.kind()
                    );
                    return Err(Self::startup_error(addr, e));
                }
            }
        };

        // Get the actual listening address (in case port was 0)
        let actual_addr = listener
            .local_addr()
            .map_err(|error| Self::startup_error(addr, error))?;

        // Publish a new capability only after we exclusively own this port.
        #[cfg(not(test))]
        let capability = crate::p2p_auth::SessionCapability::create(actual_addr.port());
        #[cfg(test)]
        let capability = match self.session_directory.as_ref() {
            Some(root) => crate::p2p_auth::SessionCapability::create_at(root, actual_addr.port()),
            None => crate::p2p_auth::SessionCapability::create(actual_addr.port()),
        };
        let capability = Arc::new(capability.map_err(|_| {
            crate::AppError::technical("Cannot establish private local session authentication")
        })?);
        self.capability = Some(capability.clone());
        let admission = Arc::new(tokio::sync::Semaphore::new(32));
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        self.shutdown_tx = Some(shutdown_tx);
        self.listening_addr = Some(actual_addr);

        crate::p2p_diagnostics::trace!("[MsgPackServer] Successfully bound to {}", actual_addr);

        // Use the injected handler if one was provided (e.g. a handler that also
        // notifies the GUI), otherwise fall back to a plain local handler
        let handler: Arc<dyn OperationHandler> = match &self.injected_handler {
            Some(h) => h.clone(),
            None => Arc::new(LocalOperationHandler::new(self.project.clone())),
        };
        let clients = self.clients.clone();
        let next_client_id = self.next_client_id.clone();
        let conflict_resolver = self.conflict_resolver.clone();
        let client_sequences = self.client_sequences.clone();
        let operation_gate = self.operation_gate.clone();
        let incoming_memory = self.incoming_memory.clone();
        let outgoing_memory = self.outgoing_memory.clone();
        let started_at = std::time::Instant::now();
        let idle_shutdown = self.idle_shutdown;
        let activity = Arc::new(StdMutex::new(ServerActivity {
            leases: 0,
            idle_since: std::time::Instant::now(),
            closing: false,
        }));

        // Spawn the server task
        self.server_task_handle = Some(tokio::spawn(async move {
            crate::p2p_diagnostics::trace!("[SERVER] ========================================");
            crate::p2p_diagnostics::trace!("[SERVER] Accept loop started on {actual_addr}");
            crate::p2p_diagnostics::trace!("[SERVER] Waiting for client connections...");
            crate::p2p_diagnostics::trace!("[SERVER] ========================================");

            let mut tasks = tokio::task::JoinSet::new();
            let mut accept_count = 0u64;
            let mut idle_check = tokio::time::interval(Duration::from_millis(100));
            loop {
                crate::p2p_diagnostics::trace!(
                    "[SERVER] Waiting for next connection (iteration {accept_count})..."
                );
                accept_count += 1;
                tokio::select! {
                    // Accept new connections
                    result = listener.accept() => {
                        match result {
                            Ok((mut stream, peer_addr)) => {
                                let Ok(admission_permit) = admission.clone().try_acquire_owned() else { continue; };
                                let capability = capability.clone();


                                crate::p2p_diagnostics::trace!("[SERVER] ========================================");
                                crate::p2p_diagnostics::trace!("[SERVER] New connection detected from: {peer_addr}");
                                crate::p2p_diagnostics::trace!("[SERVER] ========================================");
                                crate::p2p_diagnostics::trace!("[SERVER] Step 1: TCP connection accepted from {peer_addr}");
                                let handler_clone = handler.clone();
                                let clients_clone = clients.clone();

                                // Generate client ID
                                let client_id = {
                                    let mut id_guard = next_client_id.lock().await;
                                    let id = *id_guard;
                                    *id_guard += 1;
                                    crate::p2p_diagnostics::trace!("[SERVER] Step 2: Assigned client ID: {id}");
                                    id
                                };

                                crate::p2p_diagnostics::trace!("[SERVER] Step 3: Spawning handler task for client {client_id}...");

                                // Handle client in a separate task
                                let conflict_resolver_clone = conflict_resolver.clone();
                                let client_sequences_clone = client_sequences.clone();
                                let operation_gate = operation_gate.clone();
                                let incoming_memory = incoming_memory.clone();
                                let outgoing_memory = outgoing_memory.clone();
                                let activity = activity.clone();
                                tasks.spawn(async move {
                                    let _admission_permit = admission_permit;
                                    if capability.authenticate(&mut stream).await.is_err() {
                                        return; // no registration, activity lease, operation or broadcast
                                    }
                                    crate::p2p_diagnostics::trace!("[SERVER] Step 4: Starting client {client_id} handler");
                                    let ctx = ClientHandlerContext {
                                        handler: handler_clone,
                                        client_id,
                                        clients: clients_clone,
                                        peer_addr,
                                        conflict_resolver: conflict_resolver_clone,
                                        client_sequences: client_sequences_clone,
                                        operation_gate,
                                        incoming_memory,
                                        outgoing_memory,
                                        started_at,
                                        activity,
                                    };
                                    match Self::handle_client(stream, ctx).await {
                                        Ok(_) => {
                                            crate::p2p_diagnostics::trace!("[SERVER] Client {client_id} handler completed normally");
                                        }
                                        Err(e) => {
                                            crate::p2p_diagnostics::trace!("[SERVER] Error handling client {client_id} ({peer_addr}): {e}");
                                        }
                                    }
                                });
                            }
                            Err(e) => {
                                crate::p2p_diagnostics::trace!("[MsgPackServer] Failed to accept connection: {e}");
                            }
                        }
                    }

                    _ = idle_check.tick(), if idle_shutdown.is_some() => {
                        let mut state = activity.lock().unwrap();
                        if state.leases == 0 && state.idle_since.elapsed() >= idle_shutdown.unwrap() {
                            state.closing = true;
                            break;
                        }
                    }

                    // Reap finished handlers; JoinSet owns and cancels all remaining
                    // authenticated and pre-auth sockets when this server ends.
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                    // Shutdown signal
                    _ = &mut shutdown_rx => {
                        crate::p2p_diagnostics::trace!("[MsgPackServer] Shutting down MessagePack server");
                        break;
                    }
                }
            }
            activity.lock().unwrap().closing = true;
            capability.revoke();
            drop(listener);
            for client in clients.read().await.values() {
                let _ = client.closed.send(true);
            }
            // In-flight authorized operations finish rather than being cancelled
            // mid-commit. Idle readers/writers and handshakes have bounded exits.
            while tasks.join_next().await.is_some() {}
            crate::p2p_diagnostics::trace!("[MsgPackServer] Accept loop terminated");
        }));

        // Give the accept loop a moment to start
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        crate::p2p_diagnostics::trace!(
            "[MsgPackServer] Server is ready to accept connections on {}",
            actual_addr
        );

        // Skip self-connection test as it may interfere with the server
        // The test connection gets accepted but immediately disconnects,
        // which could cause issues with the server's state
        crate::p2p_diagnostics::trace!(
            "[MsgPackServer] Server started successfully on {}",
            actual_addr
        );
        crate::p2p_diagnostics::trace!("[MsgPackServer] Listening for incoming connections...");

        Ok(())
    }

    async fn stop(&mut self) {
        // Send shutdown signal to server loop
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        if let Some(capability) = self.capability.as_ref() {
            capability.revoke();
        }
        for (_, client) in self.clients.write().await.drain() {
            let _ = client.closed.send(true);
        }
        if let Some(handle) = self.server_task_handle.take() {
            // Timeout detaches the graceful cleanup task; it does not abort a
            // valid mutation that is already committing.
            let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        }

        self.capability.take();
        self.listening_addr = None;
    }

    fn is_running(&self) -> bool {
        self.server_task_handle
            .as_ref()
            .is_some_and(|task| !task.is_finished())
    }

    fn get_listening_addr(&self) -> Option<SocketAddr> {
        self.listening_addr
    }

    async fn connected_client_count(&self) -> usize {
        self.clients.read().await.len()
    }

    async fn broadcast_to_clients(&self) {
        let _guard = self.operation_gate.lock().await;
        let local = LocalOperationHandler::new(self.project.clone());
        Self::broadcast_committed_state(&local, &self.clients, &self.outgoing_memory).await;
    }
}

#[cfg(test)]
mod localization_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encoding_reserves_memory_before_growing_output() {
        let memory = Arc::new(tokio::sync::Semaphore::new(64 * 1024));
        let message = P2PMessage::response(
            1,
            DevcelResponse::Ok(json!({"text":"x".repeat(128 * 1024)})),
        );
        assert!(encode_delivery(&message, &memory).is_err());
        assert_eq!(memory.available_permits(), 64 * 1024);
        let message =
            encode_delivery(&P2PMessage::request(2, DevcelOperation::Ping), &memory).unwrap();
        assert_eq!(memory.available_permits(), 0);
        assert!(matches!(
            rmp_serde::from_slice::<P2PMessage>(&message.bytes).unwrap(),
            P2PMessage::Request { id: 2, .. }
        ));
        drop(message);
        assert_eq!(memory.available_permits(), 64 * 1024);
    }

    #[tokio::test]
    async fn restart_rotates_wire_capability_and_new_connection_can_rejoin() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let mut server = MsgPackServer::new(Arc::new(Mutex::new(None)));
        server.session_directory = Some(root.clone());
        server.start("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let address = server.get_listening_addr().unwrap();
        let file = root.join(format!("{}.cap", address.port()));
        let mut old_secret = std::fs::read(&file).unwrap();
        server.stop().await;
        server.start(address).await.unwrap();
        assert!(
            std::fs::read(&file).unwrap() != old_secret,
            "restart must rotate capability"
        );
        let mut stale = TcpStream::connect(address).await.unwrap();
        let mut old_key = [0u8; 32];
        old_key.copy_from_slice(&old_secret);
        assert!(crate::p2p_auth::client_handshake(&mut stale, &old_key)
            .await
            .is_err());
        old_key.fill(0);
        old_secret.fill(0);
        drop(stale);
        let mut current = TcpStream::connect(address).await.unwrap();
        crate::p2p_auth::connect_at(&mut current, address, &root)
            .await
            .unwrap();
        crate::msgpack_framing::write_message(
            &mut current,
            &rmp_serde::to_vec_named(&P2PMessage::request(1, DevcelOperation::Ping)).unwrap(),
        )
        .await
        .unwrap();
        assert!(tokio::time::timeout(
            Duration::from_secs(1),
            crate::msgpack_framing::read_message(&mut current)
        )
        .await
        .unwrap()
        .unwrap()
        .is_some());
        server.stop().await;
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn bounded_delivery_keeps_fifo_and_disconnects_instead_of_skipping() {
        let memory = Arc::new(tokio::sync::Semaphore::new(16));
        let (outgoing, mut receiver) = tokio::sync::mpsc::channel(2);
        let (closed, closing) = tokio::sync::watch::channel(false);
        enqueue(&outgoing, &closed, delivery(vec![1], &memory).unwrap()).unwrap();
        enqueue(&outgoing, &closed, delivery(vec![2], &memory).unwrap()).unwrap();
        assert!(enqueue(&outgoing, &closed, delivery(vec![3], &memory).unwrap()).is_err());
        assert!(*closing.borrow());
        assert_eq!(receiver.recv().await.unwrap().bytes, vec![1]);
        assert_eq!(receiver.recv().await.unwrap().bytes, vec![2]);
        assert_eq!(memory.available_permits(), 16);
    }

    #[tokio::test]
    async fn slow_receiver_does_not_hold_global_operations_or_shutdown() {
        struct Responses;
        #[async_trait]
        impl OperationHandler for Responses {
            async fn handle_operation(&self, operation: DevcelOperation) -> DevcelResponse {
                if matches!(operation, DevcelOperation::GetProjectInfo) {
                    DevcelResponse::Ok(json!({"large":"x".repeat(8 * 1024 * 1024)}))
                } else {
                    DevcelResponse::Ok(json!({"pong":true}))
                }
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let mut server = MsgPackServer::new(Arc::new(Mutex::new(None)));
        server.session_directory = Some(root.clone());
        server.set_operation_handler(Arc::new(Responses));
        server.start("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let address = server.get_listening_addr().unwrap();
        let mut slow = TcpStream::connect(address).await.unwrap();
        crate::p2p_auth::connect_at(&mut slow, address, &root)
            .await
            .unwrap();
        socket2::SockRef::from(&slow)
            .set_recv_buffer_size(1024)
            .unwrap();
        let request =
            rmp_serde::to_vec_named(&P2PMessage::request(1, DevcelOperation::GetProjectInfo))
                .unwrap();
        crate::msgpack_framing::write_message(&mut slow, &request)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut fast = TcpStream::connect(address).await.unwrap();
        crate::p2p_auth::connect_at(&mut fast, address, &root)
            .await
            .unwrap();
        let request =
            rmp_serde::to_vec_named(&P2PMessage::request(2, DevcelOperation::Ping)).unwrap();
        crate::msgpack_framing::write_message(&mut fast, &request)
            .await
            .unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            crate::msgpack_framing::read_message(&mut fast),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(matches!(
            rmp_serde::from_slice::<P2PMessage>(&response).unwrap(),
            P2PMessage::Response {
                id: 2,
                result: DevcelResponse::Ok(_)
            }
        ));
        tokio::time::timeout(Duration::from_secs(1), server.stop())
            .await
            .unwrap();
        assert!(!root.join(format!("{}.cap", address.port())).exists());
    }

    #[tokio::test]
    async fn authenticated_socket_quotas_bind_peer_ids_and_disconnect_releases_pending() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Counter(Arc<AtomicUsize>);
        #[async_trait]
        impl OperationHandler for Counter {
            async fn handle_operation(&self, _: DevcelOperation) -> DevcelResponse {
                self.0.fetch_add(1, Ordering::SeqCst);
                DevcelResponse::Ok(json!({"handled":true}))
            }
        }
        async fn request(
            stream: &mut TcpStream,
            sequence: u64,
            operation: DevcelOperation,
        ) -> DevcelResponse {
            // Every socket deliberately claims the same forged client identity.
            let operation = DevcelOperation::OperationWithMetadata {
                operation: Box::new(operation),
                metadata: OperationMetadata::new(424242, sequence),
            };
            let bytes = rmp_serde::to_vec_named(&P2PMessage::request(sequence, operation)).unwrap();
            crate::msgpack_framing::write_message(stream, &bytes)
                .await
                .unwrap();
            let bytes = tokio::time::timeout(
                Duration::from_secs(3),
                crate::msgpack_framing::read_message(stream),
            )
            .await
            .unwrap()
            .unwrap()
            .unwrap();
            match rmp_serde::from_slice::<P2PMessage>(&bytes).unwrap() {
                P2PMessage::Response { id, result } => {
                    assert_eq!(id, sequence);
                    result
                }
                other => panic!("Unexpected socket response: {other:?}"),
            }
        }
        fn queued(response: DevcelResponse) {
            assert!(matches!(response, DevcelResponse::Ok(value) if value["status"] == "queued"));
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let count = Arc::new(AtomicUsize::new(0));
        let mut server = MsgPackServer::new(Arc::new(Mutex::new(None)));
        server.session_directory = Some(root.clone());
        server.set_operation_handler(Arc::new(Counter(count.clone())));
        server.start("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let address = server.get_listening_addr().unwrap();
        let mut first = TcpStream::connect(address).await.unwrap();
        crate::p2p_auth::connect_at(&mut first, address, &root)
            .await
            .unwrap();
        let mut second = TcpStream::connect(address).await.unwrap();
        crate::p2p_auth::connect_at(&mut second, address, &root)
            .await
            .unwrap();
        for sequence in 2..=129 {
            queued(request(&mut first, sequence, DevcelOperation::Ping).await);
        }
        // The same forged sequence on a second authenticated socket is independent.
        queued(request(&mut second, 2, DevcelOperation::Ping).await);
        assert!(
            matches!(request(&mut first, 130, DevcelOperation::Ping).await, DevcelResponse::Error(error) if error.to_string().contains("count exhausted"))
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(matches!(
            request(&mut first, 1, DevcelOperation::Ping).await,
            DevcelResponse::Ok(_)
        ));
        assert!(matches!(
            request(&mut first, 130, DevcelOperation::Ping).await,
            DevcelResponse::Ok(_)
        ));
        assert_eq!(
            count.load(Ordering::SeqCst),
            130,
            "quota rejection must not evict accepted operations"
        );
        // Fill the shared encoded-byte budget without performing filesystem IO.
        let large = || DevcelOperation::ReadMarkdownFile {
            file_path: "x".repeat(7 * 1024 * 1024),
        };
        for sequence in 132..=135 {
            queued(request(&mut first, sequence, large()).await);
        }
        assert!(
            matches!(request(&mut second, 3, large()).await, DevcelResponse::Error(error) if error.to_string().contains("byte budget exhausted"))
        );
        drop(first);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match request(&mut second, 3, large()).await {
                DevcelResponse::Ok(value) => {
                    assert_eq!(value["status"], "queued");
                    break;
                }
                DevcelResponse::Error(error) => {
                    assert!(error.to_string().contains("byte budget exhausted"))
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "disconnect must reclaim retained payload budget"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            count.load(Ordering::SeqCst),
            130,
            "disconnected pending operations must never execute"
        );
        assert!(matches!(
            request(&mut second, 1, DevcelOperation::Ping).await,
            DevcelResponse::Ok(_)
        ));
        assert!(matches!(
            request(&mut second, 4, DevcelOperation::Ping).await,
            DevcelResponse::Ok(_)
        ));
        assert_eq!(
            count.load(Ordering::SeqCst),
            134,
            "a rejected payload remains retryable after budget recovery"
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn authentication_precedes_registration_and_operation_dispatch() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Counter(Arc<AtomicUsize>);
        #[async_trait]
        impl OperationHandler for Counter {
            async fn handle_operation(&self, _: DevcelOperation) -> DevcelResponse {
                self.0.fetch_add(1, Ordering::SeqCst);
                DevcelResponse::Ok(json!({"pong":true}))
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let count = Arc::new(AtomicUsize::new(0));
        let mut server = MsgPackServer::new(Arc::new(Mutex::new(None)));
        server.session_directory = Some(root.clone());
        server.set_operation_handler(Arc::new(Counter(count.clone())));
        server.start("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let address = server.get_listening_addr().unwrap();
        let mut unauthenticated = TcpStream::connect(address).await.unwrap();
        unauthenticated.write_all(&[0u8; 48]).await.unwrap();
        use tokio::io::AsyncReadExt;
        let mut byte = [0u8; 1];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), unauthenticated.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert_eq!(server.connected_client_count().await, 0);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let mut passive = TcpStream::connect(address).await.unwrap();
        MsgPackServer::broadcast_snapshot(
            json!({"private":"not for unauthenticated peers"}),
            &server.clients,
            &server.outgoing_memory,
        )
        .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(30), passive.read(&mut byte))
                .await
                .is_err()
        );
        let operation = DevcelOperation::WriteMarkdownFile {
            file_path: "untrusted-request-must-never-run.md".repeat(4),
            content: "not executed".into(),
        };
        crate::msgpack_framing::write_message(
            &mut passive,
            &rmp_serde::to_vec_named(&P2PMessage::request(99, operation)).unwrap(),
        )
        .await
        .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(1), passive.read(&mut byte))
            .await
            .unwrap();
        assert!(match closed {
            Ok(0) => true,
            Err(error) => matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ),
            _ => false,
        });
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let mut authenticated = TcpStream::connect(address).await.unwrap();
        crate::p2p_auth::connect_at(&mut authenticated, address, &root)
            .await
            .unwrap();
        let request =
            rmp_serde::to_vec_named(&P2PMessage::request(1, DevcelOperation::Ping)).unwrap();
        crate::msgpack_framing::write_message(&mut authenticated, &request)
            .await
            .unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            crate::msgpack_framing::read_message(&mut authenticated),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(matches!(
            rmp_serde::from_slice::<P2PMessage>(&response).unwrap(),
            P2PMessage::Response {
                id: 1,
                result: DevcelResponse::Ok(_)
            }
        ));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(server.connected_client_count().await, 1);
        server.stop().await;
        assert!(!root.join(format!("{}.cap", address.port())).exists());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), authenticated.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }

    fn assert_error(operation: DevcelOperation, code: &str, params: serde_json::Value) {
        let error = MsgPackServer::validate_operation(&operation).unwrap_err();
        let expected = json!({"kind":"code","code":code,"params":params});
        assert_eq!(serde_json::to_value(&error).unwrap(), expected);
        // The existing response envelope transports the typed cause unchanged.
        let message = P2PMessage::response(42, DevcelResponse::Error(error));
        let bytes = rmp_serde::to_vec_named(&message).unwrap();
        match rmp_serde::from_slice::<P2PMessage>(&bytes).unwrap() {
            P2PMessage::Response {
                id: 42,
                result: DevcelResponse::Error(error),
            } => assert_eq!(serde_json::to_value(error).unwrap(), expected),
            other => panic!("Unexpected response envelope: {other:?}"),
        }
    }

    #[test]
    fn policy_restrictions_keep_the_same_operation_and_batch_limits() {
        assert_error(
            DevcelOperation::DeleteProject {
                project_path: "literal {path} 日本語".into(),
            },
            "p2p.validation.operationDenied",
            json!({"operation":"DeleteProject"}),
        );
        for operation in [
            DevcelOperation::OpenInExplorer {
                path: "https://example.invalid".into(),
            },
            DevcelOperation::ExecuteBatch {
                operations: vec![DevcelOperation::OpenInExplorer {
                    path: "Tables".into(),
                }],
            },
        ] {
            assert_error(
                operation,
                "p2p.validation.operationDenied",
                json!({"operation":"OpenInExplorer"}),
            );
        }
        assert_error(
            DevcelOperation::Shutdown,
            "p2p.validation.operationDenied",
            json!({"operation":"Shutdown"}),
        );
        assert!(
            MsgPackServer::validate_operation(&DevcelOperation::ExecuteBatch {
                operations: vec![DevcelOperation::Ping; 10000],
            })
            .is_ok()
        );
        assert_error(
            DevcelOperation::ExecuteBatch {
                operations: vec![DevcelOperation::Ping; 10001],
            },
            "p2p.validation.batchLimit",
            json!({"max":10000}),
        );
        assert_error(
            DevcelOperation::ExecuteBatch {
                operations: vec![DevcelOperation::Shutdown],
            },
            "p2p.validation.operationDenied",
            json!({"operation":"Shutdown"}),
        );
    }

    #[test]
    fn name_validation_keeps_utf8_byte_limits_and_separator_policy() {
        let operation = |name| DevcelOperation::RenameTable {
            table_uuid: "literal-id".into(),
            new_display_name: name,
        };
        for name in [String::new(), "a".repeat(256), "あ".repeat(86)] {
            assert_error(
                operation(name),
                "p2p.validation.nameLength",
                json!({"min":1,"max":255}),
            );
        }
        for name in ["a".repeat(255), "あ".repeat(85), "{literal}".into()] {
            assert!(MsgPackServer::validate_operation(&operation(name)).is_ok());
        }
        for name in ["a..b", "a/b", "a\\b"] {
            assert_error(
                operation(name.into()),
                "p2p.validation.nameCharacters",
                json!({}),
            );
        }
    }

    #[test]
    fn peers_cannot_replace_the_host_project_even_with_valid_paths() {
        for path in [String::new(), "Tables".into(), "a".repeat(4096)] {
            for operation in [
                DevcelOperation::OpenProject {
                    project_path: path.clone(),
                },
                DevcelOperation::ExecuteBatch {
                    operations: vec![DevcelOperation::OpenProject {
                        project_path: path.clone(),
                    }],
                },
            ] {
                assert_error(
                    operation,
                    "p2p.validation.operationDenied",
                    json!({"operation":"OpenProject"}),
                );
            }
            assert_error(
                DevcelOperation::CreateProject {
                    project_name: "Unrequested".into(),
                    project_path: path,
                    description: String::new(),
                    header_color: "#123456".into(),
                },
                "p2p.validation.operationDenied",
                json!({"operation":"CreateProject"}),
            );
        }
    }
}
