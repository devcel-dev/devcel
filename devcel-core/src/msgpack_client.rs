use crate::operation_handler::OperationHandler;
use crate::operations::{DevcelOperation, DevcelResponse};
use crate::p2p_errors::P2PError;
use crate::p2p_manager::DevcelClient;
use crate::p2p_messages::P2PMessage;
use crate::AppError;
use async_trait::async_trait;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};

/// P2P connection metrics
#[derive(Debug, Clone)]
pub struct P2PMetrics {
    pub total_requests: Arc<AtomicU64>,
    pub successful_requests: Arc<AtomicU64>,
    pub failed_requests: Arc<AtomicU64>,
    pub total_response_time_ms: Arc<AtomicU64>,
    pub pending_requests: Arc<AtomicU64>,
}

impl Default for P2PMetrics {
    fn default() -> Self {
        Self {
            total_requests: Arc::new(AtomicU64::new(0)),
            successful_requests: Arc::new(AtomicU64::new(0)),
            failed_requests: Arc::new(AtomicU64::new(0)),
            total_response_time_ms: Arc::new(AtomicU64::new(0)),
            pending_requests: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl P2PMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn average_response_time_ms(&self) -> f64 {
        let successful = self.successful_requests.load(Ordering::Relaxed) as f64;
        if successful > 0.0 {
            self.total_response_time_ms.load(Ordering::Relaxed) as f64 / successful
        } else {
            0.0
        }
    }
}

/// Pending request with timestamp for timeout management
struct PendingRequest {
    tx: oneshot::Sender<Result<DevcelResponse, AppError>>,
    timestamp: Instant,
}

/// Default request timeout (30 seconds)
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Cleanup interval for pending requests (5 seconds)
const CLEANUP_INTERVAL: Duration = Duration::from_secs(5);

/// Heartbeat interval (5 seconds)
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

/// Heartbeat timeout (15 seconds)
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);

/// Type alias for request channel
type RequestChannel = mpsc::Sender<(
    DevcelOperation,
    oneshot::Sender<Result<DevcelResponse, AppError>>,
)>;

/// MessagePack-based client implementation for P2P connections
pub struct MsgPackClient {
    /// The write half of the TCP stream
    write_stream: Option<Arc<Mutex<WriteHalf<TcpStream>>>>,
    /// The server address we're connected to
    server_addr: Option<SocketAddr>,
    /// The local address of the connection (used as our identity in the registry)
    local_addr: Option<SocketAddr>,
    /// Stream reader task handle
    stream_reader: Option<tokio::task::JoinHandle<()>>,
    /// Cleanup task handle
    cleanup_task: Option<tokio::task::JoinHandle<()>>,
    /// Heartbeat task handle
    heartbeat_task: Option<tokio::task::JoinHandle<()>>,
    /// Operation handler for applying received broadcasts
    operation_handler: Option<Arc<dyn OperationHandler>>,
    /// Request sender for sending requests to the stream writer
    request_tx: Option<RequestChannel>,
    /// Next request ID
    next_request_id: Arc<AtomicU64>,
    /// Disconnection notifier (optional)
    disconnect_notifier: Option<mpsc::Sender<P2PError>>,
    /// Pending responses for graceful shutdown
    pending_responses: Option<Arc<Mutex<HashMap<u64, PendingRequest>>>>,
    /// Connection liveness flag (set to false when the reader task ends)
    /// Without this flag, requests sent after the reader exits receive neither
    /// a response nor an error and wait forever
    connection_alive: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Connection metrics
    metrics: P2PMetrics,
}

impl Default for MsgPackClient {
    fn default() -> Self {
        Self {
            write_stream: None,
            server_addr: None,
            local_addr: None,
            stream_reader: None,
            cleanup_task: None,
            heartbeat_task: None,
            operation_handler: None,
            request_tx: None,
            next_request_id: Arc::new(AtomicU64::new(1)),
            disconnect_notifier: None,
            pending_responses: None,
            connection_alive: None,
            metrics: P2PMetrics::new(),
        }
    }
}

impl MsgPackClient {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get current metrics
    pub fn metrics(&self) -> &P2PMetrics {
        &self.metrics
    }

    /// Set the operation handler for processing received broadcasts
    pub fn set_operation_handler(&mut self, handler: Arc<dyn OperationHandler>) {
        crate::p2p_diagnostics::trace!("[MsgPackClient-INIT] Setting operation handler");
        self.operation_handler = Some(handler);
        crate::p2p_diagnostics::trace!("[MsgPackClient-INIT] Operation handler set successfully");
    }

    /// Check if an operation handler has been set
    pub fn has_operation_handler(&self) -> bool {
        self.operation_handler.is_some()
    }

    /// Set the disconnection notifier
    pub fn set_disconnect_notifier(&mut self, notifier: mpsc::Sender<P2PError>) {
        self.disconnect_notifier = Some(notifier);
    }

    /// Start the stream reader and writer tasks
    fn start_stream_tasks(
        &mut self,
        read_stream: ReadHalf<TcpStream>,
        write_stream: Arc<Mutex<WriteHalf<TcpStream>>>,
        handler: Arc<dyn OperationHandler>,
    ) {
        let disconnect_notifier = self.disconnect_notifier.clone();
        let metrics = self.metrics.clone();

        // Connection liveness flag (false after reader exit; subsequent sends fail immediately)
        let connection_alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        self.connection_alive = Some(connection_alive.clone());

        // Create request channel
        let (request_tx, mut request_rx) = mpsc::channel::<(
            DevcelOperation,
            oneshot::Sender<Result<DevcelResponse, AppError>>,
        )>(100);
        self.request_tx = Some(request_tx);

        // Pending responses map
        let pending_responses = Arc::new(Mutex::new(HashMap::<u64, PendingRequest>::new()));
        self.pending_responses = Some(pending_responses.clone());
        let pending_responses_clone = pending_responses.clone();
        let pending_responses_cleanup = pending_responses.clone();
        let next_request_id = self.next_request_id.clone();

        // Start writer task
        let metrics_writer = metrics.clone();
        let _writer_handle = tokio::spawn(async move {
            while let Some((operation, response_tx)) = request_rx.recv().await {
                // Generate request ID
                let request_id = next_request_id.fetch_add(1, Ordering::SeqCst);

                // Store response channel with timestamp
                {
                    let mut pending = pending_responses_clone.lock().await;
                    pending.insert(
                        request_id,
                        PendingRequest {
                            tx: response_tx,
                            timestamp: Instant::now(),
                        },
                    );
                    metrics_writer
                        .pending_requests
                        .store(pending.len() as u64, Ordering::Relaxed);
                }

                // Update metrics
                metrics_writer
                    .total_requests
                    .fetch_add(1, Ordering::Relaxed);

                // Create request message
                let message = P2PMessage::request(request_id, operation);

                // Serialize and send
                let data = match rmp_serde::to_vec_named(&message) {
                    Ok(d) => d,
                    Err(e) => {
                        let error = P2PError::SerializationError(e.to_string());
                        crate::p2p_diagnostics::trace!("[P2P Client] {error}");
                        let mut pending = pending_responses_clone.lock().await;
                        if let Some(req) = pending.remove(&request_id) {
                            let _ = req.tx.send(Err(error.into_app_error()));
                        }
                        continue;
                    }
                };

                let mut stream = write_stream.lock().await;
                if let Err(e) = crate::msgpack_framing::write_message(&mut *stream, &data).await {
                    let error = P2PError::StreamError(e.to_string());
                    crate::p2p_diagnostics::trace!("[P2P Client] {error}");
                    let mut pending = pending_responses_clone.lock().await;
                    if let Some(req) = pending.remove(&request_id) {
                        let _ = req.tx.send(Err(error.into_app_error()));
                    }
                    continue;
                }

                if let Err(e) = stream.flush().await {
                    let error = P2PError::StreamError(e.to_string());
                    crate::p2p_diagnostics::trace!("[P2P Client] {error}");
                    let mut pending = pending_responses_clone.lock().await;
                    if let Some(req) = pending.remove(&request_id) {
                        let _ = req.tx.send(Err(error.into_app_error()));
                    }
                }
            }
        });

        // Start reader task
        let metrics_reader = metrics.clone();
        let reader_handle = tokio::spawn(async move {
            let mut read_stream = read_stream;
            crate::p2p_diagnostics::trace!("[P2P Client] Stream reader started");

            let mut terminal_error =
                AppError::code("p2p.error.streamClosed", serde_json::json!({}));
            loop {
                let msg_buf = match crate::msgpack_framing::read_message(&mut read_stream).await {
                    Ok(Some(data)) => data,
                    Ok(None) => break,
                    Err(error) => {
                        crate::p2p_diagnostics::trace!("[P2P Client] Frame read failed: {error}");
                        terminal_error = P2PError::StreamError(error.to_string()).into_app_error();
                        break;
                    }
                };

                // Deserialize P2P message
                match rmp_serde::from_slice::<P2PMessage>(&msg_buf) {
                    Ok(P2PMessage::Response { id, result }) => {
                        // Handle response
                        let mut pending = pending_responses.lock().await;
                        if let Some(req) = pending.remove(&id) {
                            // Calculate response time
                            let response_time_ms = req.timestamp.elapsed().as_millis() as u64;
                            metrics_reader
                                .total_response_time_ms
                                .fetch_add(response_time_ms, Ordering::Relaxed);

                            // Update success/failure metrics
                            match &result {
                                DevcelResponse::Ok(_) => {
                                    metrics_reader
                                        .successful_requests
                                        .fetch_add(1, Ordering::Relaxed);
                                }
                                DevcelResponse::Error(_) => {
                                    metrics_reader
                                        .failed_requests
                                        .fetch_add(1, Ordering::Relaxed);
                                }
                            }

                            let _ = req.tx.send(Ok(result));
                            metrics_reader
                                .pending_requests
                                .store(pending.len() as u64, Ordering::Relaxed);
                        }
                    }
                    Ok(P2PMessage::Broadcast { project_state }) => {
                        crate::p2p_diagnostics::trace!("[P2P Client] Received committed snapshot");
                        if let DevcelResponse::Error(e) =
                            handler.apply_server_snapshot(project_state).await
                        {
                            crate::p2p_diagnostics::trace!(
                                "[P2P Client] Failed to apply committed snapshot: {e}"
                            );
                            terminal_error = e;
                            break;
                        }
                    }
                    Ok(P2PMessage::Request { .. }) => {
                        crate::p2p_diagnostics::trace!(
                            "[P2P Client] Unexpected request envelope received"
                        );
                        break;
                    }
                    Err(e) => {
                        crate::p2p_diagnostics::trace!("[P2P Client] Invalid P2P envelope: {e}");
                        terminal_error =
                            P2PError::SerializationError(e.to_string()).into_app_error();
                        break;
                    }
                }
            }

            // Mark the connection dead so subsequent send_operation calls fail immediately
            connection_alive.store(false, Ordering::Relaxed);

            // Clean up pending responses on disconnect
            let mut pending = pending_responses.lock().await;
            for (_, req) in pending.drain() {
                let _ = req.tx.send(Err(terminal_error.clone()));
            }
            drop(pending);

            // Notify about disconnection if notifier is set
            if let Some(notifier) = disconnect_notifier {
                let _ = notifier.send(P2PError::app(terminal_error)).await;
            }
        });

        self.stream_reader = Some(reader_handle);

        // Start cleanup task for timed-out requests
        let cleanup_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(CLEANUP_INTERVAL);

            loop {
                interval.tick().await;

                let mut pending = pending_responses_cleanup.lock().await;
                let now = Instant::now();

                // Find timed-out requests
                let mut timed_out = Vec::new();
                for (&id, req) in pending.iter() {
                    if now.duration_since(req.timestamp) > REQUEST_TIMEOUT {
                        timed_out.push(id);
                    }
                }

                // Remove and notify timed-out requests
                for id in timed_out {
                    if let Some(req) = pending.remove(&id) {
                        let timeout_secs = REQUEST_TIMEOUT.as_secs();
                        let error = P2PError::RequestTimeout {
                            request_id: id,
                            timeout_secs,
                        };
                        crate::p2p_diagnostics::trace!("[P2P Client] {error}");
                        let _ = req.tx.send(Err(error.into_app_error()));
                    }
                }
            }
        });

        self.cleanup_task = Some(cleanup_handle);

        // Start heartbeat task
        let heartbeat_tx = self.request_tx.clone().unwrap();
        let heartbeat_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
            let mut last_heartbeat = Instant::now();

            loop {
                interval.tick().await;

                // Create heartbeat request
                let (response_tx, response_rx) = oneshot::channel();

                // Send ping operation
                if heartbeat_tx
                    .send((DevcelOperation::Ping, response_tx))
                    .await
                    .is_err()
                {
                    crate::p2p_diagnostics::trace!(
                        "[P2P Client] Failed to send heartbeat - channel closed"
                    );
                    break;
                }

                // Wait for response with timeout
                match tokio::time::timeout(HEARTBEAT_TIMEOUT, response_rx).await {
                    Ok(Ok(Ok(DevcelResponse::Ok(_)))) => {
                        last_heartbeat = Instant::now();
                        // Successful heartbeats are logged at debug level to reduce noise
                    }
                    Ok(Ok(Ok(response))) => {
                        crate::p2p_diagnostics::trace!(
                            "[P2P Client] Unexpected heartbeat response: {response:?}"
                        );
                    }
                    Ok(Ok(Err(e))) => {
                        crate::p2p_diagnostics::trace!("[P2P Client] Heartbeat failed: {e}");
                    }
                    Ok(Err(_)) => {
                        crate::p2p_diagnostics::trace!(
                            "[P2P Client] Heartbeat response channel closed"
                        );
                    }
                    Err(_) => {
                        let elapsed = Instant::now().duration_since(last_heartbeat);
                        crate::p2p_diagnostics::trace!(
                            "[P2P Client] Heartbeat timeout - no response for {elapsed:?}"
                        );

                        // If we haven't received a successful heartbeat in too long, consider the connection dead
                        if elapsed > HEARTBEAT_TIMEOUT * 2 {
                            crate::p2p_diagnostics::trace!("[P2P Client] Connection appears to be dead - no heartbeat for {elapsed:?}");
                            // The connection will be detected as closed by the reader task
                        }
                    }
                }
            }

            crate::p2p_diagnostics::trace!("[P2P Client] Heartbeat task stopped");
        });

        self.heartbeat_task = Some(heartbeat_task);
    }

    async fn send_operation_with_timeout(
        &self,
        operation: DevcelOperation,
        timeout: Option<Duration>,
    ) -> Result<DevcelResponse, AppError> {
        // Do not send on a connection whose reader has exited
        // (Prevents waiting forever for a response that cannot arrive)
        if let Some(alive) = &self.connection_alive {
            if !alive.load(Ordering::Relaxed) {
                return Err(AppError::code(
                    "p2p.error.streamClosed",
                    serde_json::json!({}),
                ));
            }
        }

        let request_tx = self
            .request_tx
            .as_ref()
            .ok_or_else(|| AppError::code("p2p.notConnected", serde_json::json!({})))?;

        // Create response channel
        let (response_tx, response_rx) = oneshot::channel();

        // Send request to writer task
        request_tx
            .send((operation, response_tx))
            .await
            .map_err(|_| {
                let error = P2PError::code(
                    "p2p.error.channel",
                    serde_json::json!({"details":"","reason":"requestWriterClosed"}),
                );
                crate::p2p_diagnostics::trace!("[P2P Client] {error}");
                error.into_app_error()
            })?;

        // Wait for response with optional timeout
        match timeout {
            Some(duration) => match tokio::time::timeout(duration, response_rx).await {
                Ok(Ok(response)) => response,
                Ok(Err(_)) => {
                    let error = P2PError::code(
                        "p2p.error.channel",
                        serde_json::json!({"details":"","reason":"responseChannelClosed"}),
                    );
                    crate::p2p_diagnostics::trace!("[P2P Client] {error}");
                    Err(error.into_app_error())
                }
                Err(_) => {
                    let error = P2PError::Timeout {
                        timeout_ms: duration.as_millis() as u64,
                    };
                    crate::p2p_diagnostics::trace!("[P2P Client] {error}");
                    Err(error.into_app_error())
                }
            },
            None => response_rx.await.map_err(|_| {
                let error = P2PError::code(
                    "p2p.error.channel",
                    serde_json::json!({"details":"","reason":"responseChannelClosed"}),
                );
                crate::p2p_diagnostics::trace!("[P2P Client] {error}");
                error.into_app_error()
            })?,
        }
    }

    async fn send_operation(&self, operation: DevcelOperation) -> Result<DevcelResponse, AppError> {
        self.send_operation_with_timeout(operation, None).await
    }
}

#[async_trait]
impl DevcelClient for MsgPackClient {
    async fn connect(&mut self, addr: SocketAddr) -> Result<(), AppError> {
        crate::p2p_diagnostics::trace!("[CLIENT] ========================================");
        crate::p2p_diagnostics::trace!("[CLIENT] Starting connection to server at {}", addr);
        crate::p2p_diagnostics::trace!("[CLIENT] ========================================");

        crate::p2p_diagnostics::trace!("[CLIENT] Step 1: Attempting TCP connection to {}...", addr);
        if !addr.ip().is_loopback() {
            return Err(AppError::technical(
                "Local project client requires a loopback address",
            ));
        }
        let mut stream = match TcpStream::connect(addr).await {
            Ok(s) => {
                crate::p2p_diagnostics::trace!("[CLIENT] Step 1: ✓ TCP connection established");
                s
            }
            Err(e) => {
                crate::p2p_diagnostics::trace!("[CLIENT] Step 1: ✗ TCP connection failed: {e}");
                return Err(AppError::code(
                    "p2p.error.connectionFailed",
                    serde_json::json!({"details":e.to_string(),"address":addr.to_string()}),
                ));
            }
        };

        crate::p2p_auth::connect(&mut stream, addr)
            .await
            .map_err(|_| {
                AppError::technical("Local session authentication unavailable or rejected")
            })?;

        let local_addr = stream.local_addr().ok();
        self.local_addr = local_addr;
        crate::p2p_diagnostics::trace!(
            "[CLIENT] Step 2: Connection successful, local addr: {local_addr:?}"
        );

        // Split the stream into read and write halves
        crate::p2p_diagnostics::trace!(
            "[CLIENT] Step 3: Splitting TCP stream into read/write halves..."
        );
        let (read_half, write_half) = tokio::io::split(stream);
        crate::p2p_diagnostics::trace!("[CLIENT] Step 3: ✓ Stream split completed");

        self.write_stream = Some(Arc::new(Mutex::new(write_half)));
        self.server_addr = Some(addr);
        crate::p2p_diagnostics::trace!("[CLIENT] Step 4: Write stream and server address stored");

        // Start stream tasks if handler is set
        if let Some(handler) = self.operation_handler.clone() {
            crate::p2p_diagnostics::trace!("[CLIENT] Step 5: Starting message handler tasks...");
            crate::p2p_diagnostics::trace!(
                "[MsgPackClient-INIT] Operation handler is present, starting stream tasks"
            );
            self.start_stream_tasks(read_half, self.write_stream.clone().unwrap(), handler);
            crate::p2p_diagnostics::trace!("[CLIENT] Step 5: ✓ Message handler tasks started");
            crate::p2p_diagnostics::trace!(
                "[MsgPackClient-INIT] Stream tasks started successfully - client fully initialized"
            );
        } else {
            crate::p2p_diagnostics::trace!(
                "[CLIENT] Step 5: ⚠ No operation handler set, skipping task setup"
            );
            crate::p2p_diagnostics::trace!(
                "[MsgPackClient-INIT] CRITICAL ERROR: No operation handler set!"
            );
            crate::p2p_diagnostics::trace!("[MsgPackClient-INIT] This means set_operation_handler() was not called before connect()");
            crate::p2p_diagnostics::trace!("[MsgPackClient-INIT] Client will NOT be able to receive broadcasts or handle messages properly");
        }

        crate::p2p_diagnostics::trace!("[CLIENT] ========================================");
        crate::p2p_diagnostics::trace!("[CLIENT] Connection established successfully!");
        crate::p2p_diagnostics::trace!("[CLIENT] Ready to send/receive messages");
        crate::p2p_diagnostics::trace!("[CLIENT] ========================================");

        Ok(())
    }

    async fn disconnect(&mut self) {
        crate::p2p_diagnostics::trace!("[P2P Client] Starting graceful disconnect");

        // 1. Stop accepting new requests by dropping the sender
        if let Some(tx) = self.request_tx.take() {
            drop(tx);
            crate::p2p_diagnostics::trace!("[P2P Client] Stopped accepting new requests");
        }

        // 2. Wait for pending requests to complete (with timeout)
        if let Some(pending_map) = &self.pending_responses {
            let max_wait = Duration::from_secs(5);
            let start = Instant::now();

            loop {
                let pending_count = {
                    let pending = pending_map.lock().await;
                    pending.len()
                };

                if pending_count == 0 {
                    crate::p2p_diagnostics::trace!("[P2P Client] All pending requests completed");
                    break;
                }

                if start.elapsed() >= max_wait {
                    crate::p2p_diagnostics::trace!(
                        "[P2P Client] Timeout waiting for {pending_count} pending requests"
                    );
                    break;
                }

                crate::p2p_diagnostics::trace!(
                    "[P2P Client] Waiting for {pending_count} pending requests..."
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }

        // 3. Stop all tasks
        if let Some(handle) = self.stream_reader.take() {
            handle.abort();
            crate::p2p_diagnostics::trace!("[P2P Client] Stream reader stopped");
        }

        if let Some(handle) = self.cleanup_task.take() {
            handle.abort();
            crate::p2p_diagnostics::trace!("[P2P Client] Cleanup task stopped");
        }

        if let Some(handle) = self.heartbeat_task.take() {
            handle.abort();
            crate::p2p_diagnostics::trace!("[P2P Client] Heartbeat task stopped");
        }

        // 4. Close the stream
        if let Some(stream) = self.write_stream.take() {
            if let Ok(mut write_half) = stream.try_lock() {
                let _ = write_half.shutdown().await;
                crate::p2p_diagnostics::trace!("[P2P Client] Stream closed");
            }
        }

        self.server_addr = None;
        self.local_addr = None;
        self.pending_responses = None;
        self.connection_alive = None;
        crate::p2p_diagnostics::trace!("[P2P Client] Graceful disconnect completed");
    }

    fn is_connected(&self) -> bool {
        let alive = self
            .connection_alive
            .as_ref()
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(false);
        self.write_stream.is_some() && alive
    }

    async fn ping(&self) -> Result<(), AppError> {
        // Always use a timeout for health checks
        // (An indefinite wait would stop monitoring itself if a response were lost)
        let response = self
            .send_operation_with_timeout(DevcelOperation::Ping, Some(Duration::from_secs(5)))
            .await?;

        match response {
            DevcelResponse::Ok(_) => Ok(()),
            DevcelResponse::Error(e) => Err(e),
        }
    }

    fn get_server_addr(&self) -> Option<SocketAddr> {
        self.server_addr
    }

    fn get_local_addr(&self) -> Option<SocketAddr> {
        self.local_addr
    }

    async fn send_operation(&self, operation: DevcelOperation) -> Result<DevcelResponse, AppError> {
        self.send_operation(operation).await
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

/// Remote operation handler that sends operations to a server
pub struct RemoteOperationHandler {
    client: Arc<Mutex<MsgPackClient>>,
}

impl RemoteOperationHandler {
    pub fn new(client: Arc<Mutex<MsgPackClient>>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl OperationHandler for RemoteOperationHandler {
    async fn handle_operation(&self, operation: DevcelOperation) -> DevcelResponse {
        let client = self.client.lock().await;

        match client.send_operation(operation).await {
            Ok(response) => response,
            Err(e) => DevcelResponse::Error(e),
        }
    }
}

#[cfg(test)]
mod localization_tests {
    use super::*;
    use serde_json::json;

    fn assert_code(error: AppError, code: &str, params: serde_json::Value) {
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"kind":"code","code":code,"params":params})
        );
    }

    #[tokio::test]
    async fn request_channel_and_ping_preserve_remote_structured_errors() {
        let cause = AppError::InputValidation {
            report: crate::cell_rules::ValidationReport {
                issues: Vec::new(),
                acknowledgement: Some("literal {ack} 日本語".into()),
            },
        };
        let expected = serde_json::to_value(&cause).unwrap();
        let mut client = MsgPackClient::new();
        let (sender, mut receiver) = mpsc::channel::<(
            DevcelOperation,
            oneshot::Sender<Result<DevcelResponse, AppError>>,
        )>(2);
        client.request_tx = Some(sender);
        let responder = tokio::spawn(async move {
            let (_, response) = receiver.recv().await.unwrap();
            response.send(Err(cause.clone())).unwrap();
            let (_, response) = receiver.recv().await.unwrap();
            response.send(Ok(DevcelResponse::Error(cause))).unwrap();
        });
        let error = client
            .send_operation(DevcelOperation::Ping)
            .await
            .unwrap_err();
        assert_eq!(serde_json::to_value(error).unwrap(), expected);
        let error = DevcelClient::ping(&client).await.unwrap_err();
        assert_eq!(serde_json::to_value(error).unwrap(), expected);
        responder.await.unwrap();
    }

    #[tokio::test]
    async fn closed_local_channels_keep_semantic_identity_without_english_details() {
        let mut client = MsgPackClient::new();
        assert_code(
            client
                .send_operation(DevcelOperation::Ping)
                .await
                .unwrap_err(),
            "p2p.notConnected",
            json!({}),
        );
        let (sender, receiver) = mpsc::channel(1);
        client.request_tx = Some(sender);
        drop(receiver);
        assert_code(
            client
                .send_operation(DevcelOperation::Ping)
                .await
                .unwrap_err(),
            "p2p.error.channel",
            json!({"details":"","reason":"requestWriterClosed"}),
        );
        let (sender, mut receiver) = mpsc::channel(1);
        client.request_tx = Some(sender);
        let responder = tokio::spawn(async move {
            drop(receiver.recv().await.unwrap());
        });
        assert_code(
            client
                .send_operation(DevcelOperation::Ping)
                .await
                .unwrap_err(),
            "p2p.error.channel",
            json!({"details":"","reason":"responseChannelClosed"}),
        );
        responder.await.unwrap();
    }

    #[tokio::test]
    async fn local_timeout_retains_numeric_duration() {
        let mut client = MsgPackClient::new();
        let (sender, _receiver) = mpsc::channel(1);
        client.request_tx = Some(sender);
        assert_code(
            client
                .send_operation_with_timeout(DevcelOperation::Ping, Some(Duration::ZERO))
                .await
                .unwrap_err(),
            "p2p.error.timeout",
            json!({"timeoutMs":0}),
        );
    }
}
