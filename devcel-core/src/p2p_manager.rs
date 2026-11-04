use crate::discovery::{normalize_project_path, ServiceInfo, ServiceStatus};
use crate::p2p_errors::{ConnectionInfo, P2PError, P2PState};
use crate::registry::FileBasedRegistry;
use crate::Project;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{interval, Duration};

/// Calculate a deterministic port based on project path
/// This ensures the same project always tries the same port first
fn calculate_project_port(project_path: &str) -> u16 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    project_path.hash(&mut hasher);
    let hash = hasher.finish();

    // Use port range 50000-60000 for P2P services
    const PORT_RANGE_START: u16 = 50000;
    const PORT_RANGE_SIZE: u16 = 10000;

    PORT_RANGE_START + (hash % PORT_RANGE_SIZE as u64) as u16
}

/// P2P connection manager
/// Each application runs as a server or client
pub struct P2PManager {
    /// File-based service registry
    registry: Arc<StdMutex<FileBasedRegistry>>,
    /// Current project
    project: Arc<Mutex<Option<Project>>>,
    /// This instance's service information
    self_info: Arc<RwLock<Option<ServiceInfo>>>,
    /// Client connection when connected to a server
    client_connection: Arc<RwLock<Option<Box<dyn DevcelClient>>>>,
    /// Server instance when acting as the server
    server: Option<Box<dyn DevcelServer>>,
    /// Exclusive OS-held ownership, released only after stop + unregister.
    server_guard: Option<std::fs::File>,
    preload_server_tables: bool,
    heartbeat_epoch: Arc<std::sync::atomic::AtomicU64>,
    /// Heartbeat monitoring task handle
    monitor_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
    /// Registry heartbeat task handle (server mode)
    heartbeat_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
    /// Connection start time for calculating promotion priority
    connected_at: Option<std::time::SystemTime>,
    /// Operation handler (Local or Remote based on mode)
    operation_handler: Arc<RwLock<Option<Arc<dyn crate::operation_handler::OperationHandler>>>>,
    /// Server disconnection event sender
    server_disconnected_tx: Arc<RwLock<Option<tokio::sync::mpsc::Sender<()>>>>,
    /// Reconnection configuration
    reconnect_config: Arc<RwLock<ReconnectConfig>>,
    /// Connection information for debugging
    #[allow(dead_code)]
    connection_info: Arc<RwLock<ConnectionInfo>>,
    /// Current P2P state
    state: Arc<RwLock<P2PState>>,
    /// Connection state listeners
    listeners: Arc<RwLock<Vec<Arc<dyn ConnectionStateListener>>>>,
}

/// Configuration for automatic reconnection
#[derive(Clone)]
pub struct ReconnectConfig {
    pub enabled: bool,
    pub max_attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_attempts: 10,
            base_delay_ms: 1000,
            max_delay_ms: 30000,
        }
    }
}

/// Connection state listener trait for P2P events
#[async_trait::async_trait]
pub trait ConnectionStateListener: Send + Sync {
    /// Called when connection is established
    async fn on_connected(&self, mode: ConnectionMode, addr: SocketAddr);

    /// Called when connection is lost
    async fn on_disconnected(&self, reason: P2PError);

    /// Called when reconnection attempt starts
    async fn on_reconnecting(&self, attempt: u32, addr: SocketAddr);

    /// Called when connection state changes
    async fn on_state_changed(&self, old_state: P2PState, new_state: P2PState);
}

/// Devcel client trait
#[async_trait::async_trait]
pub trait DevcelClient: Send + Sync {
    async fn connect(&mut self, addr: SocketAddr) -> Result<(), crate::AppError>;
    async fn disconnect(&mut self);
    fn is_connected(&self) -> bool;
    async fn ping(&self) -> Result<(), crate::AppError>;
    fn get_server_addr(&self) -> Option<SocketAddr>;

    /// Get the connected local address on this side
    /// Used to identify the client itself in the registry
    fn get_local_addr(&self) -> Option<SocketAddr> {
        None
    }
    async fn send_operation(
        &self,
        operation: crate::operations::DevcelOperation,
    ) -> Result<crate::operations::DevcelResponse, crate::AppError>;

    /// Get a mutable reference as Any for downcasting
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
}

/// Devcel server trait
#[async_trait::async_trait]
pub trait DevcelServer: Send + Sync {
    async fn start(&mut self, addr: SocketAddr) -> Result<(), crate::AppError>;
    async fn stop(&mut self);
    fn is_running(&self) -> bool;
    fn get_listening_addr(&self) -> Option<SocketAddr>;

    /// Number of live client connections accepted by this server.
    async fn connected_client_count(&self) -> usize;

    /// Broadcast a server-committed snapshot to all clients
    /// (Used to propagate GUI edits on the server instance to clients)
    async fn broadcast_to_clients(&self);
}

impl Default for P2PManager {
    fn default() -> Self {
        Self::try_new().expect("Failed to create file-based registry")
    }
}

impl P2PManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fallible initialization for host ABIs that cannot unwind on registry errors.
    pub fn try_new() -> Result<Self, crate::AppError> {
        let registry = FileBasedRegistry::new().map_err(crate::AppError::technical)?;
        Ok(Self {
            registry: Arc::new(StdMutex::new(registry)),
            project: Arc::new(Mutex::new(None)),
            self_info: Arc::new(RwLock::new(None)),
            client_connection: Arc::new(RwLock::new(None)),
            server: None,
            server_guard: None,
            preload_server_tables: false,
            heartbeat_epoch: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            monitor_handle: Arc::new(RwLock::new(None)),
            heartbeat_handle: Arc::new(RwLock::new(None)),
            connected_at: None,
            operation_handler: Arc::new(RwLock::new(None)),
            server_disconnected_tx: Arc::new(RwLock::new(None)),
            reconnect_config: Arc::new(RwLock::new(ReconnectConfig::default())),
            connection_info: Arc::new(RwLock::new(ConnectionInfo::new())),
            state: Arc::new(RwLock::new(P2PState::Disconnected)),
            listeners: Arc::new(RwLock::new(Vec::new())),
        })
    }

    /// Share the project reference externally
    /// GUI applications pass the Arc for their own project state so changes
    /// received through P2P affect the project displayed by the GUI
    pub fn set_project_ref(&mut self, project: Arc<Mutex<Option<Project>>>) {
        self.project = project;
    }

    /// Headless authorities load every table before publishing their listener.
    pub fn set_preload_server_tables(&mut self, preload: bool) {
        self.preload_server_tables = preload;
    }

    /// Get the project reference managed by this instance
    pub fn project_ref(&self) -> Arc<Mutex<Option<Project>>> {
        self.project.clone()
    }

    /// Set the client implementation
    pub async fn set_client_impl(&mut self, mut client: Box<dyn DevcelClient>) {
        crate::p2p_diagnostics::trace!("[P2P-CLIENT-INIT] Setting client implementation");
        // If it's a MsgPackClient, set the operation handler
        if let Some(msgpack_client) = client
            .as_any_mut()
            .downcast_mut::<crate::msgpack_client::MsgPackClient>()
        {
            if msgpack_client.has_operation_handler() {
                // The caller already configured a custom handler, such as for GUI notifications
                crate::p2p_diagnostics::trace!(
                    "[P2P-CLIENT-INIT] MsgPackClient already has a handler, keeping it"
                );
            } else {
                crate::p2p_diagnostics::trace!(
                    "[P2P-CLIENT-INIT] Detected MsgPackClient, creating operation handler"
                );
                let handler = Arc::new(crate::operation_handler::LocalOperationHandler::new(
                    self.project.clone(),
                ));
                msgpack_client.set_operation_handler(handler);
                crate::p2p_diagnostics::trace!(
                    "[P2P-CLIENT-INIT] Operation handler set on MsgPackClient"
                );
            }
        } else {
            crate::p2p_diagnostics::trace!(
                "[P2P-CLIENT-INIT] WARNING: Client is not MsgPackClient, handler not set!"
            );
        }
        *self.client_connection.write().await = Some(client);
        crate::p2p_diagnostics::trace!(
            "[P2P-CLIENT-INIT] Client implementation stored in P2PManager"
        );
    }

    /// Set the server implementation
    pub fn set_server_impl(&mut self, server: Box<dyn DevcelServer>) {
        self.server = Some(server);
    }

    /// Add a connection state listener
    pub async fn add_listener(&self, listener: Arc<dyn ConnectionStateListener>) {
        self.listeners.write().await.push(listener);
    }

    /// Start periodic state validation
    pub fn start_state_validation(&self) {
        let state = self.state.clone();
        let client_connection = self.client_connection.clone();
        let server = &self.server;

        // Since self.server is not Clone, we need to check if server exists
        let has_server = server.is_some();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));

            loop {
                interval.tick().await;

                let current_state = state.read().await.clone();
                let mut inconsistency_detected = false;

                match &current_state {
                    P2PState::Connected(ConnectionMode::Client { server_addr }) => {
                        let client_guard = client_connection.read().await;
                        if let Some(ref client) = *client_guard {
                            if !client.is_connected() {
                                crate::p2p_diagnostics::trace!("[P2P] State validation: Client state inconsistent - not connected");
                                inconsistency_detected = true;
                            } else if let Some(actual_addr) = client.get_server_addr() {
                                if actual_addr != *server_addr {
                                    crate::p2p_diagnostics::trace!(
                                        "[P2P] State validation: Client connected to wrong server"
                                    );
                                    inconsistency_detected = true;
                                }
                            }
                        } else {
                            crate::p2p_diagnostics::trace!(
                                "[P2P] State validation: Client state but no client connection"
                            );
                            inconsistency_detected = true;
                        }
                    }
                    P2PState::Connected(ConnectionMode::Server { .. }) if !has_server => {
                        crate::p2p_diagnostics::trace!(
                            "[P2P] State validation: Server state but no server instance"
                        );
                        inconsistency_detected = true;
                    }
                    // Note: We can't check server.is_running() here because server is not Clone
                    // This limitation is acceptable for this validation level
                    _ => {
                        // Other states don't require validation
                    }
                }

                if inconsistency_detected {
                    crate::p2p_diagnostics::trace!(
                        "[P2P] State inconsistency detected during periodic validation"
                    );
                    // Log the issue but don't auto-repair in periodic check to avoid conflicts
                }
            }
        });
    }

    /// Remove all listeners
    pub async fn clear_listeners(&self) {
        self.listeners.write().await.clear();
    }

    /// Get current P2P state
    async fn get_state(&self) -> P2PState {
        self.state.read().await.clone()
    }

    /// Set P2P state with validation and consistency checks
    async fn set_state(&self, new_state: P2PState) -> Result<(), P2PError> {
        let mut state_guard = self.state.write().await;
        let current_state = state_guard.clone();

        // Validate state transition
        if !current_state.can_transition_to(&new_state) {
            return Err(P2PError::InvalidModeOperation {
                current_mode: format!("{current_state:?}"),
                operation: format!("transition to {new_state:?}"),
            });
        }

        // Validate state consistency before applying
        if let Err(e) = self.validate_state_consistency(&new_state).await {
            crate::p2p_diagnostics::trace!("[P2P] State consistency validation failed: {e}");
            // Attempt auto-repair if possible
            if let Some(repaired_state) = self.attempt_state_repair(&new_state).await {
                crate::p2p_diagnostics::trace!(
                    "[P2P] Auto-repaired state: {new_state:?} -> {repaired_state:?}"
                );
                *state_guard = repaired_state.clone();
                drop(state_guard);
                self.notify_state_changed(current_state, repaired_state)
                    .await;
                return Ok(());
            }
            return Err(e);
        }

        crate::p2p_diagnostics::trace!("P2P state transition: {current_state} -> {new_state}");
        *state_guard = new_state.clone();
        drop(state_guard);

        // Notify listeners
        self.notify_state_changed(current_state, new_state.clone())
            .await;

        // Additional notifications based on state transitions
        match &new_state {
            P2PState::Connected(mode) => {
                if let Some(addr) = match mode {
                    ConnectionMode::Client { server_addr } => Some(*server_addr),
                    ConnectionMode::Server { listening_addr } => Some(*listening_addr),
                } {
                    self.notify_connected(mode.clone(), addr).await;
                }
            }
            P2PState::Reconnecting {
                attempt,
                server_addr,
            } => {
                self.notify_reconnecting(*attempt, *server_addr).await;
            }
            P2PState::Disconnected => {
                // For disconnection, we need the reason which should be handled separately
            }
            _ => {}
        }

        Ok(())
    }

    /// Validate state consistency with current system state
    async fn validate_state_consistency(&self, new_state: &P2PState) -> Result<(), P2PError> {
        match new_state {
            P2PState::Connected(ConnectionMode::Client { server_addr }) => {
                // Verify client connection exists and is connected
                let client_guard = self.client_connection.read().await;
                if let Some(ref client) = *client_guard {
                    if !client.is_connected() {
                        return Err(P2PError::code(
                            "p2p.error.inconsistentState",
                            serde_json::json!({"reason":"clientDisconnected"}),
                        ));
                    }
                    // Verify connection to correct server
                    if let Some(actual_addr) = client.get_server_addr() {
                        if actual_addr != *server_addr {
                            return Err(P2PError::code(
                                "p2p.error.inconsistentState",
                                serde_json::json!({"reason":"wrongServer"}),
                            ));
                        }
                    }
                } else {
                    return Err(P2PError::code(
                        "p2p.error.inconsistentState",
                        serde_json::json!({"reason":"clientMissing"}),
                    ));
                }
            }
            P2PState::Connected(ConnectionMode::Server { listening_addr }) => {
                // Verify server is running and listening on correct address
                if let Some(ref server) = self.server {
                    if !server.is_running() {
                        return Err(P2PError::code(
                            "p2p.error.inconsistentState",
                            serde_json::json!({"reason":"serverStopped"}),
                        ));
                    }
                    // Verify listening on correct address
                    if let Some(actual_addr) = server.get_listening_addr() {
                        if actual_addr != *listening_addr {
                            return Err(P2PError::code(
                                "p2p.error.inconsistentState",
                                serde_json::json!({"reason":"wrongListenAddress"}),
                            ));
                        }
                    }
                } else {
                    return Err(P2PError::code(
                        "p2p.error.inconsistentState",
                        serde_json::json!({"reason":"serverMissing"}),
                    ));
                }
            }
            P2PState::Disconnected => {
                // Verify no active connections
                let client_guard = self.client_connection.read().await;
                if let Some(ref client) = *client_guard {
                    if client.is_connected() {
                        return Err(P2PError::code(
                            "p2p.error.inconsistentState",
                            serde_json::json!({"reason":"clientStillConnected"}),
                        ));
                    }
                }
                if let Some(ref server) = self.server {
                    if server.is_running() {
                        return Err(P2PError::code(
                            "p2p.error.inconsistentState",
                            serde_json::json!({"reason":"serverStillRunning"}),
                        ));
                    }
                }
            }
            _ => {
                // Other states (Connecting, Reconnecting, etc.) are transitional
                // and don't require strict consistency checks
            }
        }
        Ok(())
    }

    /// Attempt to repair inconsistent state automatically
    async fn attempt_state_repair(&self, target_state: &P2PState) -> Option<P2PState> {
        match target_state {
            P2PState::Connected(ConnectionMode::Client { .. }) => {
                // If client connection is invalid, transition to disconnected
                let client_guard = self.client_connection.read().await;
                if let Some(ref client) = *client_guard {
                    if !client.is_connected() {
                        crate::p2p_diagnostics::trace!("[P2P] Auto-repair: Client not connected, transitioning to Disconnected");
                        return Some(P2PState::Disconnected);
                    }
                }
                None
            }
            P2PState::Connected(ConnectionMode::Server { .. }) => {
                // If server is not running, transition to disconnected
                if let Some(ref server) = self.server {
                    if !server.is_running() {
                        crate::p2p_diagnostics::trace!(
                            "[P2P] Auto-repair: Server not running, transitioning to Disconnected"
                        );
                        return Some(P2PState::Disconnected);
                    }
                }
                None
            }
            P2PState::Disconnected => {
                // Force cleanup of any remaining connections
                tokio::spawn(async {
                    // This will run in background to clean up resources
                    crate::p2p_diagnostics::trace!(
                        "[P2P] Auto-repair: Forcing cleanup for Disconnected state"
                    );
                });
                None
            }
            _ => None,
        }
    }

    /// Notify all listeners about state change
    async fn notify_state_changed(&self, old_state: P2PState, new_state: P2PState) {
        let listeners = self.listeners.read().await.clone();
        for listener in listeners {
            let old = old_state.clone();
            let new = new_state.clone();
            let listener_clone = listener.clone();

            // Spawn to prevent one listener from blocking others
            tokio::spawn(async move {
                if let Err(e) = tokio::time::timeout(
                    Duration::from_secs(5),
                    listener_clone.on_state_changed(old, new),
                )
                .await
                {
                    crate::p2p_diagnostics::trace!(
                        "[P2P Manager] Listener notification timeout: {e:?}"
                    );
                }
            });
        }
    }

    /// Notify all listeners about connection
    async fn notify_connected(&self, mode: ConnectionMode, addr: SocketAddr) {
        let listeners = self.listeners.read().await.clone();
        for listener in listeners {
            let mode_clone = mode.clone();
            let listener_clone = listener.clone();

            tokio::spawn(async move {
                if let Err(e) = tokio::time::timeout(
                    Duration::from_secs(5),
                    listener_clone.on_connected(mode_clone, addr),
                )
                .await
                {
                    crate::p2p_diagnostics::trace!(
                        "[P2P Manager] Listener on_connected timeout: {e:?}"
                    );
                }
            });
        }
    }

    /// Notify all listeners about disconnection
    async fn notify_disconnected(&self, reason: P2PError) {
        let listeners = self.listeners.read().await.clone();
        for listener in listeners {
            let reason_clone = reason.clone();
            let listener_clone = listener.clone();

            tokio::spawn(async move {
                if let Err(e) = tokio::time::timeout(
                    Duration::from_secs(5),
                    listener_clone.on_disconnected(reason_clone),
                )
                .await
                {
                    crate::p2p_diagnostics::trace!(
                        "[P2P Manager] Listener on_disconnected timeout: {e:?}"
                    );
                }
            });
        }
    }

    /// Notify all listeners about reconnection attempt
    async fn notify_reconnecting(&self, attempt: u32, addr: SocketAddr) {
        let listeners = self.listeners.read().await.clone();
        for listener in listeners {
            let listener_clone = listener.clone();

            tokio::spawn(async move {
                if let Err(e) = tokio::time::timeout(
                    Duration::from_secs(5),
                    listener_clone.on_reconnecting(attempt, addr),
                )
                .await
                {
                    crate::p2p_diagnostics::trace!(
                        "[P2P Manager] Listener on_reconnecting timeout: {e:?}"
                    );
                }
            });
        }
    }

    /// Set server disconnection event receiver
    pub async fn get_server_disconnection_receiver(
        &self,
    ) -> Option<tokio::sync::mpsc::Receiver<()>> {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        *self.server_disconnected_tx.write().await = Some(tx);
        Some(rx)
    }

    /// Open a project with P2P support
    pub async fn open_project_p2p(
        &mut self,
        project_path: &str,
        app_type: &str,
        preferred_port: u16,
    ) -> Result<ConnectionMode, crate::AppError> {
        let normalized_path = normalize_project_path(project_path);
        crate::p2p_diagnostics::trace!("[P2P] Opening project in P2P mode: {normalized_path}");
        let coordination = FileBasedRegistry::new().map_err(crate::AppError::technical)?;
        let _election = coordination
            .project_lock(&normalized_path, "election")
            .await
            .map_err(crate::AppError::technical)?;

        // Use project-specific port if no preferred port is specified
        let target_port = if preferred_port == 0 {
            let calculated_port = calculate_project_port(&normalized_path);
            crate::p2p_diagnostics::trace!(
                "[P2P] Using calculated port {calculated_port} for project"
            );
            calculated_port
        } else {
            preferred_port
        };

        // 1. Look for an existing server first
        crate::p2p_diagnostics::trace!("[P2P] Searching for existing servers...");
        if let Some(existing_server) = self
            .find_and_connect_to_server(&normalized_path, app_type)
            .await?
        {
            crate::p2p_diagnostics::trace!(
                "[P2P-VERIFY] Found existing server at {}, connected successfully",
                existing_server.address
            );
            crate::p2p_diagnostics::trace!(
                "[P2P] Connected to existing server at {}",
                existing_server.address
            );
            return Ok(ConnectionMode::Client {
                server_addr: existing_server.address,
            });
        }

        // 2. Become the server if none exists
        crate::p2p_diagnostics::trace!(
            "[P2P-VERIFY] No existing server found (or connection failed), starting as server..."
        );
        crate::p2p_diagnostics::trace!("[P2P] No existing server found, starting as server...");

        // Listener reachability ends before the retiring manager has stopped
        // handlers and unregistered. Keep election ownership while waiting for
        // its lifetime lock; a second port cannot bypass project ownership.
        // The registry's existing bounded asynchronous wait is not a new grace
        // period, and a failed wait must not be retried as a port-bind failure.
        if self.server_guard.is_none() {
            let previous_owner = coordination
                .project_lock(&normalized_path, "server")
                .await
                .map_err(crate::AppError::technical)?;
            drop(previous_owner);
        }

        // Try with target port first, then fall back to dynamic allocation
        let server_addr = match self
            .start_as_server(&normalized_path, app_type, target_port)
            .await
        {
            Ok(addr) => addr,
            Err(e) => {
                // If target port failed, try with dynamic port (0)
                crate::p2p_diagnostics::trace!("[P2P] Target port {target_port} unavailable: {e}");
                crate::p2p_diagnostics::trace!("[P2P] Trying dynamic port allocation...");
                self.start_as_server(&normalized_path, app_type, 0).await?
            }
        };
        crate::p2p_diagnostics::trace!("[P2P] Started as server on {server_addr}");

        Ok(ConnectionMode::Server {
            listening_addr: server_addr,
        })
    }

    /// Find and connect to an existing server
    async fn find_and_connect_to_server(
        &mut self,
        project_path: &str,
        app_type: &str,
    ) -> Result<Option<ServiceInfo>, crate::AppError> {
        // Search the registry
        let server_info = {
            let registry = self.registry.lock().unwrap();
            let info = registry.find_active_server(project_path);
            crate::p2p_diagnostics::trace!("[P2P] Registry search result: {:?}", info.is_some());
            info
        };

        if let Some(server_info) = server_info {
            crate::p2p_diagnostics::trace!(
                "[P2P] Found server at {}, attempting connection...",
                server_info.address
            );
            // Set the state to connecting
            self.set_state(P2PState::Connecting {
                attempt: 1,
                server_addr: server_info.address,
            })
            .await?;

            // Attempt to connect to the server
            crate::p2p_diagnostics::trace!("[P2P] ========================================");
            crate::p2p_diagnostics::trace!("[P2P] CLIENT CONNECTING TO EXISTING SERVER");
            crate::p2p_diagnostics::trace!("[P2P] ========================================");
            crate::p2p_diagnostics::trace!("[P2P] Target server: {}", server_info.address);
            crate::p2p_diagnostics::trace!("[P2P] Initiating client connection...");

            let mut client_guard = self.client_connection.write().await;
            if let Some(ref mut client) = *client_guard {
                crate::p2p_diagnostics::trace!(
                    "[P2P-CLIENT-INIT] Client instance found in P2PManager"
                );

                // Check if handler is set (for MsgPackClient)
                if let Some(_msgpack_client) = client
                    .as_any_mut()
                    .downcast_mut::<crate::msgpack_client::MsgPackClient>(
                ) {
                    crate::p2p_diagnostics::trace!(
                        "[P2P-CLIENT-INIT] Verifying MsgPackClient state before connect()"
                    );
                    // Note: We can't directly check if handler is set, but this log confirms it's a MsgPackClient
                    crate::p2p_diagnostics::trace!("[P2P-CLIENT-INIT] MsgPackClient confirmed, should have handler from set_client_impl()");
                } else {
                    crate::p2p_diagnostics::trace!(
                        "[P2P-CLIENT-INIT] WARNING: Not a MsgPackClient!"
                    );
                }

                crate::p2p_diagnostics::trace!("[P2P] Client instance found, calling connect()...");
                match client.connect(server_info.address).await {
                    Ok(_) => {
                        crate::p2p_diagnostics::trace!(
                            "[P2P] ✓ Successfully connected to server at {}",
                            server_info.address
                        );
                        crate::p2p_diagnostics::trace!("[P2P] Connection type: CLIENT");
                        // Successfully connected to existing server
                        let local_addr = client.get_local_addr();
                        drop(client_guard); // Release lock before calling other async methods

                        // Register this instance as a client
                        // (Records connection order and manages promotion candidates after server loss)
                        if let Some(local_addr) = local_addr {
                            let client_info = ServiceInfo {
                                app_type: app_type.to_string(),
                                project_path: project_path.to_string(),
                                project_uuid: self.get_project_uuid().await.unwrap_or_default(),
                                address: local_addr,
                                last_seen: std::time::SystemTime::now(),
                                status: ServiceStatus::Client(server_info.address),
                                connection_order: 0, // The registry assigns a sequence on first registration
                            };
                            {
                                let registry = self.registry.lock().unwrap();
                                if let Err(e) = registry.register_service(client_info.clone()) {
                                    crate::p2p_diagnostics::trace!(
                                        "[P2P] Failed to register client in registry: {e}"
                                    );
                                }
                            }
                            *self.self_info.write().await = Some(client_info);

                            // Clients also keep updating last_seen through heartbeats
                            self.start_heartbeat().await;
                        }

                        // Set the state to connected
                        let mode = ConnectionMode::Client {
                            server_addr: server_info.address,
                        };
                        self.set_state(P2PState::Connected(mode)).await?;

                        // Record the connection time
                        self.connected_at = Some(std::time::SystemTime::now());

                        // Get the server's project state
                        if let Err(e) = self.sync_project_state_from_server().await {
                            crate::p2p_diagnostics::trace!(
                                "Failed to sync project state from server: {e}"
                            );
                        }

                        // Set up RemoteOperationHandler for client mode
                        let handler =
                            Arc::new(crate::operation_handler::RemoteOperationHandler::new(
                                self.client_connection.clone(),
                            ));
                        *self.operation_handler.write().await = Some(handler);

                        // Start monitoring the server
                        self.start_server_monitoring().await;

                        return Ok(Some(server_info));
                    }
                    Err(e) => {
                        crate::p2p_diagnostics::trace!(
                            "[P2P] ✗ Failed to connect to server at {}: {}",
                            server_info.address,
                            e
                        );
                        crate::p2p_diagnostics::trace!("[P2P] Connection attempt failed");
                        crate::p2p_diagnostics::trace!(
                            "[P2P] ========================================"
                        );
                        // Failed to connect to server
                        // Invalidate server information after a failed connection
                        // State validation reads client_connection. Release its
                        // write guard on failure as well as on the success path.
                        drop(client_guard);
                        // Return to the disconnected state
                        self.set_state(P2PState::Disconnected).await?;
                    }
                }
            } else {
                crate::p2p_diagnostics::trace!("[P2P] ✗ No client connection instance available");
                crate::p2p_diagnostics::trace!("[P2P] ========================================");
            }
        }

        Ok(None)
    }

    /// Synchronize project state from the server
    async fn sync_project_state_from_server(&mut self) -> Result<(), crate::AppError> {
        use crate::operations::{DevcelOperation, DevcelResponse};

        let client_guard = self.client_connection.read().await;
        if let Some(ref client) = *client_guard {
            // Get full project state from server
            match client
                .send_operation(DevcelOperation::GetFullProjectState)
                .await
            {
                Ok(DevcelResponse::Ok(state_value)) => {
                    // New servers send authoritative values, including generated UUIDs
                    // and interface history. Never replay creation commands on replicas.
                    if let Some(snapshot) = state_value.get("replication_state") {
                        let mut guard = self.project.lock().await;
                        let project = guard.as_mut().ok_or_else(|| {
                            crate::AppError::code("grid.loading.noProject", serde_json::json!({}))
                        })?;
                        return crate::replication::apply(project, snapshot.clone())
                            .map_err(crate::AppError::from);
                    }
                    // Parse the project state
                    if let Ok(full_state) =
                        serde_json::from_value::<crate::operations::FullProjectState>(state_value)
                    {
                        crate::p2p_diagnostics::trace!(
                            "Received project state from server: {} tables",
                            full_state.tables.len()
                        );

                        // Apply the state to local project
                        let mut project_guard = self.project.lock().await;
                        if let Some(ref mut project) = *project_guard {
                            // Update project metadata
                            project.project_data.project_name = full_state.project_info.name;
                            project.project_data.project_description =
                                full_state.project_info.description;
                            project.project_data.color = full_state.project_info.header_color;

                            // Load the tables that are loaded on the server
                            for table_uuid in &full_state.loaded_tables {
                                if let Some(table_info) =
                                    full_state.tables.iter().find(|t| &t.uuid == table_uuid)
                                {
                                    let table_path = std::path::PathBuf::from(&table_info.path);
                                    // Load table if not already loaded
                                    if !project.tables_data.contains_key(&table_path) {
                                        match project.load_table(&table_path) {
                                            Ok(_) => crate::p2p_diagnostics::trace!(
                                                "Synchronized table: {}",
                                                table_info.display_name
                                            ),
                                            Err(e) => crate::p2p_diagnostics::trace!(
                                                "Failed to sync table {}: {}",
                                                table_info.display_name,
                                                e
                                            ),
                                        }
                                    }
                                }
                            }

                            crate::p2p_diagnostics::trace!(
                                "Project state synchronized successfully"
                            );
                        }
                    }
                    Ok(())
                }
                Ok(DevcelResponse::Error(error)) => Err(error),
                Err(error) => Err(error),
            }
        } else {
            Err(crate::AppError::code(
                "p2p.notConnected",
                serde_json::json!({}),
            ))
        }
    }

    /// Start as a server
    async fn start_as_server(
        &mut self,
        project_path: &str,
        app_type: &str,
        preferred_port: u16,
    ) -> Result<SocketAddr, crate::AppError> {
        crate::p2p_diagnostics::trace!("[P2P] Starting server for project: {project_path}");
        if self.server_guard.is_some() {
            return Err(crate::AppError::code(
                "p2p.error.alreadyConnected",
                serde_json::json!({}),
            ));
        }
        // Do not store this until startup succeeds. Every error path releases
        // the lock, including malformed project files and registration failure.
        let server_guard = FileBasedRegistry::new()
            .map_err(crate::AppError::technical)?
            .try_project_lock(project_path, "server")
            .map_err(crate::AppError::technical)?
            .ok_or_else(|| {
                crate::AppError::code("p2p.error.alreadyConnected", serde_json::json!({}))
            })?;

        // Open the project, or reuse it if already open through the shared reference.
        // GUI applications open it first; reopening here would destroy the displayed state
        {
            let mut project_guard = self.project.lock().await;
            if project_guard.is_none() {
                let project = Project::open_project(project_path)?;
                *project_guard = Some(project);
            } else if let Some(project) = project_guard.as_ref() {
                if normalize_project_path(&project.get_project_path())
                    != normalize_project_path(project_path)
                {
                    return Err(crate::AppError::code(
                        "p2p.error.projectMismatch",
                        serde_json::json!({"path":project_path}),
                    ));
                }
            }
            if self.preload_server_tables {
                if let Some(project) = project_guard.as_mut() {
                    let entries = project.get_project_entries()?;
                    for entry in entries {
                        if entry.entry_type == crate::ProjectEntryType::Table {
                            let path = project
                                .resolve_table_path(&std::path::PathBuf::from(entry.path))?;
                            project.load_table(&path)?;
                        }
                    }
                }
            }
        }

        let project_uuid = self.get_project_uuid().await?;
        // Try to find an available port, starting from preferred_port
        let mut port_to_try = preferred_port;
        let max_port_attempts = if preferred_port == 0 { 1 } else { 10 }; // Try up to 10 different ports for non-dynamic

        for attempt in 0..max_port_attempts {
            let addr: SocketAddr = format!("127.0.0.1:{port_to_try}")
                .parse()
                .map_err(crate::AppError::technical)?;

            crate::p2p_diagnostics::trace!(
                "[P2P] Attempt {}: Trying port {}...",
                attempt + 1,
                port_to_try
            );
            crate::p2p_diagnostics::trace!("[P2P-VERIFY] Attempting to bind to port {port_to_try}");

            // Skip port check if using dynamic allocation (port 0)
            if port_to_try != 0 {
                // Check if port is already in use by trying to connect to it
                // This is a quick check to avoid the more expensive bind attempt if obviously in use
                // But we don't rely on it for correctness - the bind in server.start() is the authority
                if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok() {
                    crate::p2p_diagnostics::trace!("[P2P-VERIFY] Port {port_to_try} is already in use (TCP connect succeeded), skipping...");
                    crate::p2p_diagnostics::trace!(
                        "[P2P] Port {port_to_try} is already in use (server is listening)"
                    );
                    port_to_try += 1;
                    continue;
                }
            } else {
                crate::p2p_diagnostics::trace!("[P2P] Using dynamic port allocation (port 0)");
            }

            crate::p2p_diagnostics::trace!("[P2P] Attempting to start server on address: {addr}");

            // Transition to Connecting first
            self.set_state(P2PState::Connecting {
                attempt: attempt as u32 + 1,
                server_addr: addr,
            })
            .await?;

            if let Some(ref mut server) = self.server {
                crate::p2p_diagnostics::trace!("[P2P] Starting MessagePack server...");
                match server.start(addr).await {
                    Ok(()) => {
                        crate::p2p_diagnostics::trace!(
                            "[P2P-VERIFY] Successfully started server on port {}",
                            addr.port()
                        );
                        crate::p2p_diagnostics::trace!(
                            "[P2P] MessagePack server started successfully"
                        );

                        // Get the server's actual listening address
                        let actual_addr = server.get_listening_addr().unwrap_or(addr);
                        // Convert 0.0.0.0 to localhost
                        let registry_addr = if actual_addr.ip().is_unspecified() {
                            format!("127.0.0.1:{}", actual_addr.port())
                                .parse()
                                .unwrap_or(actual_addr)
                        } else {
                            actual_addr
                        };
                        crate::p2p_diagnostics::trace!(
                            "[P2P] Server listening on: {actual_addr}, Registry address: {registry_addr}"
                        );

                        // Create service information
                        let service_info = ServiceInfo {
                            app_type: app_type.to_string(),
                            project_path: project_path.to_string(),
                            project_uuid: project_uuid.clone(),
                            address: registry_addr, // Register an address that clients can actually connect to
                            last_seen: std::time::SystemTime::now(),
                            status: ServiceStatus::Active,
                            connection_order: 0, // The server always uses 0
                        };

                        // A failed registration must not leave an undiscoverable
                        // listening socket behind before the fallback attempt.
                        let registration = self
                            .registry
                            .lock()
                            .unwrap()
                            .register_service(service_info.clone());
                        if let Err(error) = registration {
                            server.stop().await;
                            return Err(crate::AppError::technical(error));
                        }

                        *self.self_info.write().await = Some(service_info);

                        // Set the state to connected as a server (Connecting -> Connected)
                        let mode = ConnectionMode::Server {
                            listening_addr: actual_addr,
                        };
                        self.set_state(P2PState::Connected(mode)).await?;

                        // Set up LocalOperationHandler for server mode
                        let handler =
                            Arc::new(crate::operation_handler::LocalOperationHandler::new(
                                self.project.clone(),
                            ));
                        *self.operation_handler.write().await = Some(handler);

                        // Start the heartbeat
                        self.start_heartbeat().await;
                        self.server_guard = Some(server_guard);

                        return Ok(actual_addr);
                    }
                    Err(e) => {
                        crate::p2p_diagnostics::trace!(
                            "[P2P-VERIFY] Failed to start server on port {port_to_try}: {e}"
                        );
                        crate::p2p_diagnostics::trace!(
                            "[P2P] Failed to start server on port {port_to_try}: {e}"
                        );

                        // If it's a dynamic port (0), we can't retry with another port
                        if port_to_try == 0 {
                            return Err(e);
                        }

                        // Try next port
                        port_to_try += 1;
                        continue;
                    }
                }
            } else {
                return Err(crate::AppError::code(
                    "p2p.error.serverUnavailable",
                    serde_json::json!({}),
                ));
            }
        }

        // If we've exhausted all attempts
        Err(crate::AppError::code(
            "p2p.error.portsUnavailable",
            serde_json::json!({
                "attempts":max_port_attempts,"firstPort":preferred_port,"lastPort":preferred_port + max_port_attempts - 1,
            }),
        ))
    }

    /// Get the project UUID
    async fn get_project_uuid(&self) -> Result<String, crate::AppError> {
        let project_guard = self.project.lock().await;
        if let Some(ref project) = *project_guard {
            Ok(project.project_data.uuid.clone())
        } else {
            Err(crate::AppError::code(
                "grid.loading.noProject",
                serde_json::json!({}),
            ))
        }
    }

    /// Start the heartbeat
    /// Periodically update this instance's last_seen in the registry.
    /// Without this, the registry entry becomes stale after 30 seconds,
    /// preventing later instances from discovering this server.
    async fn start_heartbeat(&self) {
        let registry = self.registry.clone();
        let self_info = self.self_info.clone();
        let epoch = self.heartbeat_epoch.clone();
        let generation = epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

        let handle = tokio::spawn(async move {
            let mut interval = interval(crate::discovery::HEARTBEAT_INTERVAL);
            // Limit cleanup, which includes TCP checks, to roughly once every 30 seconds
            let cleanup_every_ticks = (Duration::from_secs(30).as_secs()
                / crate::discovery::HEARTBEAT_INTERVAL.as_secs().max(1))
            .max(1);
            let mut tick_count: u64 = 0;

            loop {
                interval.tick().await;
                tick_count += 1;

                // Update this instance's last_seen and register it again
                let updated_info = {
                    let mut info_guard = self_info.write().await;
                    if let Some(ref mut info) = *info_guard {
                        info.last_seen = std::time::SystemTime::now();
                        Some(info.clone())
                    } else {
                        None
                    }
                };

                // Run registry operations in spawn_blocking because they involve file I/O and TCP checks
                let registry_clone = registry.clone();
                let do_cleanup = tick_count.is_multiple_of(cleanup_every_ticks);
                let epoch = epoch.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let reg = registry_clone.lock().unwrap();
                    // An already queued blocking heartbeat must never resurrect
                    // a registry entry after disconnect/unregister.
                    if epoch.load(std::sync::atomic::Ordering::SeqCst) != generation {
                        return;
                    }
                    if let Some(info) = updated_info {
                        if let Err(e) = reg.register_service(info) {
                            crate::p2p_diagnostics::trace!(
                                "[P2P] Heartbeat: failed to refresh registry entry: {e}"
                            );
                        }
                    }
                    // Clean up stale service information every 30 seconds
                    if do_cleanup {
                        reg.cleanup_stale_services();
                    }
                })
                .await;

                if let Err(e) = result {
                    crate::p2p_diagnostics::trace!("[P2P] Heartbeat task error: {e}");
                }
            }
        });

        // Stop and replace any existing heartbeat task
        if let Some(old) = self.heartbeat_handle.write().await.replace(handle) {
            old.abort();
        }
    }

    /// Switch roles from client to server
    pub async fn promote_to_server(&mut self) -> Result<(), crate::AppError> {
        // Set the state to promoting
        self.set_state(P2PState::PromotingToServer).await?;

        let mut client_guard = self.client_connection.write().await;
        if let Some(ref mut client) = *client_guard {
            client.disconnect().await;
        }
        drop(client_guard);

        // Restart as a server
        let self_info = self.self_info.read().await;
        if let Some(ref info) = *self_info {
            let project_path = info.project_path.clone();
            let app_type = info.app_type.clone();
            drop(self_info);

            let coordination = FileBasedRegistry::new().map_err(crate::AppError::technical)?;
            let _election = coordination
                .project_lock(&project_path, "election")
                .await
                .map_err(crate::AppError::technical)?;
            if self
                .find_and_connect_to_server(&project_path, &app_type)
                .await?
                .is_some()
            {
                return Ok(());
            }

            // Try the project-specific port first, falling back to dynamic allocation
            // (Matches open_project_p2p and improves discoverability for later instances)
            let target_port = calculate_project_port(&project_path);
            if let Err(e) = self
                .start_as_server(&project_path, &app_type, target_port)
                .await
            {
                crate::p2p_diagnostics::trace!(
                    "[P2P] Target port {target_port} unavailable during promotion: {e}"
                );
                self.start_as_server(&project_path, &app_type, 0).await?;
            }
        }

        Ok(())
    }

    /// Start monitoring the server in client mode
    async fn start_server_monitoring(&self) {
        Self::setup_server_monitoring(
            self.client_connection.clone(),
            self.monitor_handle.clone(),
            self.server_disconnected_tx.clone(),
        )
        .await;
    }

    /// Configure reconnection settings
    pub async fn set_reconnect_config(&self, config: ReconnectConfig) {
        *self.reconnect_config.write().await = config;
    }

    /// Failover after server loss
    /// 1. Rediscover a server in the registry and attempt to connect
    ///    (Can follow another promoted instance instead of reconnecting only to the old address)
    /// 2. If no server exists and this instance is the promotion candidate
    ///    (the live client with the lowest connection order), promote it to server
    /// 3. Otherwise, back off and retry
    pub async fn handle_disconnection(&mut self) -> Result<(), P2PError> {
        let current_state = self.get_state().await;

        let server_addr = match current_state {
            P2PState::Connected(ConnectionMode::Client { server_addr }) => server_addr,
            _ => return Ok(()), // Do nothing in other states
        };

        crate::p2p_diagnostics::trace!(
            "[P2P] Server connection lost ({server_addr}), starting failover..."
        );

        // Clean up the old connection
        if let Some(handle) = self.monitor_handle.write().await.take() {
            handle.abort();
        }
        {
            let mut client_guard = self.client_connection.write().await;
            if let Some(ref mut client) = *client_guard {
                client.disconnect().await;
            }
        }

        self.set_state(P2PState::Reconnecting {
            attempt: 0,
            server_addr,
        })
        .await?;

        let config = self.reconnect_config.read().await.clone();
        if !config.enabled {
            self.set_state(P2PState::Disconnected).await?;
            return Ok(());
        }

        // Get this instance's information needed for failover
        let (project_path, app_type, my_address) = {
            let info_guard = self.self_info.read().await;
            match info_guard.as_ref() {
                Some(info) => (
                    info.project_path.clone(),
                    info.app_type.clone(),
                    info.address,
                ),
                None => {
                    let err =
                        P2PError::code("p2p.error.failoverUnavailable", serde_json::json!({}));
                    self.set_state(P2PState::Failed(err.clone())).await?;
                    return Err(err);
                }
            }
        };

        let max_attempts = config.max_attempts.max(1);
        let mut delay_ms = config.base_delay_ms.max(100);

        for attempt in 1..=max_attempts {
            crate::p2p_diagnostics::trace!("[P2P] Failover attempt {attempt}/{max_attempts}");

            // 1. Rediscover and connect to a server through the registry
            //    (Rejoin as a client if another instance has already been promoted and started)
            match self
                .find_and_connect_to_server(&project_path, &app_type)
                .await
            {
                Ok(Some(server)) => {
                    crate::p2p_diagnostics::trace!(
                        "[P2P] Reconnected to server at {} (failover)",
                        server.address
                    );
                    return Ok(());
                }
                Ok(None) => {}
                Err(e) => crate::p2p_diagnostics::trace!("[P2P] Server rediscovery failed: {e}"),
            }

            // 2. If no server exists, promote this instance if it is the candidate
            let next_candidate = {
                let registry = self.registry.lock().unwrap();
                registry.get_next_promotion_candidate(&project_path)
            };
            let am_candidate = match &next_candidate {
                Some(candidate) => candidate.address == my_address,
                // Promotion may be attempted without candidate information, such as when this instance's registration is lost
                None => true,
            };

            if am_candidate {
                // Wait according to connection order to avoid simultaneous client promotions
                let order = next_candidate
                    .as_ref()
                    .map(|c| c.connection_order)
                    .unwrap_or(0);
                tokio::time::sleep(Duration::from_millis(order as u64 * 50)).await;

                // Check once more whether another instance just became the server
                let server_exists = {
                    let registry = self.registry.lock().unwrap();
                    registry.find_active_server(&project_path).is_some()
                };

                if !server_exists {
                    crate::p2p_diagnostics::trace!(
                        "[P2P] This instance is the promotion candidate, promoting to server..."
                    );
                    match self.promote_to_server().await {
                        Ok(_) => {
                            crate::p2p_diagnostics::trace!(
                                "[P2P] Promoted to server after server loss"
                            );
                            return Ok(());
                        }
                        Err(e) => crate::p2p_diagnostics::trace!("[P2P] Promotion failed: {e}"),
                    }
                }
            } else {
                crate::p2p_diagnostics::trace!(
                    "[P2P] Waiting for the promotion candidate to become the new server..."
                );
            }

            // Back off and retry
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            delay_ms = (delay_ms * 2).min(config.max_delay_ms.max(config.base_delay_ms));
        }

        let err = P2PError::code(
            "p2p.error.failoverExhausted",
            serde_json::json!({"attempts":max_attempts}),
        );
        self.set_state(P2PState::Failed(err.clone())).await?;
        Err(err)
    }

    /// Set up server monitoring (simplified version)
    async fn setup_server_monitoring(
        client_connection: Arc<RwLock<Option<Box<dyn DevcelClient>>>>,
        monitor_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
        server_disconnected_tx: Arc<RwLock<Option<tokio::sync::mpsc::Sender<()>>>>,
    ) {
        let handle = tokio::spawn(async move {
            // Treat three failures at 2-second intervals as disconnected (detect server loss in about 6 seconds)
            let mut interval = interval(Duration::from_secs(2));
            let mut consecutive_failures = 0;
            crate::p2p_diagnostics::trace!("[P2P-MONITOR] Server monitoring task started");

            loop {
                interval.tick().await;

                let client_guard = client_connection.read().await;
                if let Some(ref client) = *client_guard {
                    match client.ping().await {
                        Ok(_) => consecutive_failures = 0,
                        Err(e) => {
                            consecutive_failures += 1;
                            crate::p2p_diagnostics::trace!(
                                "Server ping failed (attempt {consecutive_failures}): {e}"
                            );

                            if consecutive_failures >= 3 {
                                crate::p2p_diagnostics::trace!(
                                    "Server appears to be disconnected after {consecutive_failures} failures"
                                );

                                // Trigger server disconnection event
                                if let Some(tx) = server_disconnected_tx.read().await.as_ref() {
                                    let _ = tx.send(()).await;
                                }
                                break;
                            }
                        }
                    }
                }
            }
        });

        *monitor_handle.write().await = Some(handle);
    }

    /// Get the current connection mode
    pub async fn get_connection_mode(&self) -> Option<ConnectionMode> {
        match &*self.state.read().await {
            P2PState::Connected(mode) => Some(mode.clone()),
            _ => None,
        }
    }

    /// Whether this manager's own server accept loop is still running.
    pub fn is_server_running(&self) -> bool {
        self.server
            .as_ref()
            .is_some_and(|server| server.is_running())
    }

    /// Number of actual clients connected to this manager's server.
    pub async fn connected_client_count(&self) -> usize {
        match self.server.as_ref() {
            Some(server) => server.connected_client_count().await,
            None => 0,
        }
    }

    /// Whether connected
    pub async fn is_connected(&self) -> bool {
        matches!(*self.state.read().await, P2PState::Connected(_))
    }

    /// Get the current operation handler
    pub async fn get_operation_handler(
        &self,
    ) -> Option<Arc<dyn crate::operation_handler::OperationHandler>> {
        self.operation_handler.read().await.clone()
    }

    /// Execute an operation based on current mode
    pub async fn execute_operation(
        &self,
        operation: crate::operations::DevcelOperation,
    ) -> crate::operations::DevcelResponse {
        let state = self.state.read().await;

        match &*state {
            P2PState::Connected(ConnectionMode::Client { .. }) => {
                // In client mode, send operation to server
                let client_guard = self.client_connection.read().await;
                if let Some(ref client) = *client_guard {
                    match client.send_operation(operation).await {
                        Ok(response) => response,
                        Err(e) => crate::operations::DevcelResponse::Error(e),
                    }
                } else {
                    crate::operations::DevcelResponse::Error(crate::AppError::code(
                        "p2p.notConnected",
                        serde_json::json!({}),
                    ))
                }
            }
            P2PState::Connected(ConnectionMode::Server { .. }) => {
                // Local server operations must notify its clients too.
                if let Some(handler) = self.operation_handler.read().await.as_ref() {
                    let mutation = !operation.is_read_only();
                    let response = handler.handle_operation(operation).await;
                    if mutation && matches!(response, crate::operations::DevcelResponse::Ok(_)) {
                        if let Some(server) = &self.server {
                            server.broadcast_to_clients().await;
                        }
                    }
                    response
                } else {
                    crate::operations::DevcelResponse::Error(crate::AppError::code(
                        "p2p.error.inconsistentState",
                        serde_json::json!({"reason":"operationHandlerMissing"}),
                    ))
                }
            }
            _ => {
                // Not connected to P2P, execute locally if handler available
                if let Some(handler) = self.operation_handler.read().await.as_ref() {
                    handler.handle_operation(operation).await
                } else {
                    crate::operations::DevcelResponse::Error(crate::AppError::code(
                        "p2p.error.inconsistentState",
                        serde_json::json!({"reason":"operationHandlerMissing"}),
                    ))
                }
            }
        }
    }

    /// Propagate local changes to the P2P network
    /// - Server mode: broadcast to all clients
    /// - Client mode: send to the server, which applies the change and broadcasts to other clients
    /// - Disconnected: do nothing
    pub async fn propagate_local_change(&self, operation: crate::operations::DevcelOperation) {
        let state = self.state.read().await.clone();

        match state {
            P2PState::Connected(ConnectionMode::Server { .. }) => {
                if let Some(ref server) = self.server {
                    server.broadcast_to_clients().await;
                }
            }
            P2PState::Connected(ConnectionMode::Client { .. }) => {
                let client_guard = self.client_connection.read().await;
                if let Some(ref client) = *client_guard {
                    if let Err(e) = client.send_operation(operation).await {
                        crate::p2p_diagnostics::trace!(
                            "[P2P] Failed to propagate local change to server: {e}"
                        );
                    }
                }
            }
            _ => {
                // No propagation needed while disconnected
            }
        }
    }

    /// Find all active servers for a project
    pub fn find_active_servers(&self, project_path: &str) -> Vec<ServiceInfo> {
        let registry = self.registry.lock().unwrap();
        let all_services = registry.get_all_services(project_path);

        // Filter for active servers
        let now = std::time::SystemTime::now();
        let timeout = crate::discovery::SERVICE_STALE_TIMEOUT;

        all_services
            .into_iter()
            .filter(|s| {
                s.status == ServiceStatus::Active
                    && s.last_seen
                        .duration_since(std::time::SystemTime::UNIX_EPOCH)
                        .ok()
                        .and_then(|last| {
                            now.duration_since(std::time::SystemTime::UNIX_EPOCH)
                                .ok()
                                .map(|current| current.saturating_sub(last) < timeout)
                        })
                        .unwrap_or(false)
            })
            .collect()
    }

    /// Disconnect with a reason
    pub async fn disconnect_with_reason(
        &mut self,
        reason: P2PError,
    ) -> Result<(), crate::AppError> {
        crate::p2p_diagnostics::trace!("[P2P] Disconnecting: {reason}");

        // Notify listeners before disconnecting
        self.notify_disconnected(reason).await;
        // Stop the monitoring task
        if let Some(handle) = self.monitor_handle.write().await.take() {
            handle.abort();
        }

        // Stop the registry heartbeat
        self.heartbeat_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(handle) = self.heartbeat_handle.write().await.take() {
            handle.abort();
        }

        // Disconnect the client connection
        let mut client_guard = self.client_connection.write().await;
        if let Some(ref mut client) = *client_guard {
            client.disconnect().await;
        }
        drop(client_guard);

        // Stop the server
        if let Some(ref mut server) = self.server {
            server.stop().await;
        }

        // Remove from the registry
        if let Some(info) = self.self_info.read().await.as_ref() {
            let registry = self.registry.lock().unwrap();
            registry
                .unregister_service(&info.project_path, info.address)
                .map_err(crate::AppError::technical)?;
        }

        // The ownership lock outlives the listening socket and registry entry.
        // A successor cannot reuse our port before unregister has completed.
        self.server_guard = None;
        // Clear state
        *self.self_info.write().await = None;

        // Set the state to disconnected
        self.set_state(P2PState::Disconnected).await?;

        Ok(())
    }

    /// Disconnect with the default reason
    pub async fn disconnect(&mut self) -> Result<(), crate::AppError> {
        self.disconnect_with_reason(P2PError::code(
            "p2p.toast.disconnected",
            serde_json::json!({}),
        ))
        .await
    }
}

/// Connection mode
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionMode {
    /// Running as a server
    Server { listening_addr: SocketAddr },
    /// Connected as a client
    Client { server_addr: SocketAddr },
}

/// Optional file-based locking mechanism
pub mod file_lock {
    use std::fs::{File, OpenOptions};
    use std::io::Write;

    pub struct ProjectLock {
        lock_file: Option<File>,
        lock_path: String,
    }

    impl ProjectLock {
        pub fn acquire(project_path: &str) -> Result<Self, String> {
            let lock_path = format!("{project_path}.lock");

            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(mut file) => {
                    // Write the PID and application information
                    let info = format!("{}\n{}", std::process::id(), "devcel-studio");
                    file.write_all(info.as_bytes())
                        .map_err(|e| format!("Failed to write lock file: {e}"))?;

                    Ok(Self {
                        lock_file: Some(file),
                        lock_path,
                    })
                }
                Err(_) => {
                    // The lock file already exists
                    Err("Project is already opened by another instance".to_string())
                }
            }
        }

        pub fn release(&mut self) {
            self.lock_file = None; // Close the file
            let _ = std::fs::remove_file(&self.lock_path);
        }
    }

    impl Drop for ProjectLock {
        fn drop(&mut self) {
            self.release();
        }
    }
}
