use std::fmt;
use thiserror::Error;

/// P2P specific error types
#[derive(Error, Debug, Clone, PartialEq)]
pub enum P2PError {
    /// Application-owned causes stay structured until the presentation boundary.
    /// This enum is local transport state, not the MessagePack wire protocol.
    #[error("{0:?}")]
    Structured(crate::types::Diagnostic),

    #[error("Connection failed: {reason}")]
    ConnectionFailed {
        reason: String,
        details: Option<ConnectionErrorDetails>,
    },

    #[error("Connection lost: {0}")]
    ConnectionLost(String),

    #[error("Server not found at {address}")]
    ServerNotFound { address: String },

    #[error("Reconnection failed after {attempts} attempts: {reason}")]
    ReconnectionFailed { attempts: u32, reason: String },

    #[error("Already connected as {mode}")]
    AlreadyConnected { mode: String },

    #[error("Invalid operation in {current_mode} mode: {operation}")]
    InvalidModeOperation {
        current_mode: String,
        operation: String,
    },

    #[error("Server promotion failed: {0}")]
    PromotionFailed(String),

    #[error("Registration failed: {0}")]
    RegistrationFailed(String),

    #[error("Operation validation failed: {0}")]
    ValidationFailed(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Network error: {message}")]
    NetworkError {
        message: String,
        kind: Option<String>, // io::ErrorKind as string
        code: Option<i32>,    // OS error code if available
    },

    #[error("Timeout: operation took longer than {timeout_ms}ms")]
    Timeout { timeout_ms: u64 },

    #[error("Transaction error: {0}")]
    TransactionError(String),

    #[error("Conflict resolution failed: {0}")]
    ConflictResolutionError(String),

    #[error("Request timeout: request {request_id} timed out after {timeout_secs} seconds")]
    RequestTimeout { request_id: u64, timeout_secs: u64 },

    #[error("Channel error: {0}")]
    ChannelError(String),

    #[error("Stream error: {0}")]
    StreamError(String),
}

impl P2PError {
    pub fn code(code: impl Into<String>, params: serde_json::Value) -> Self {
        Self::Structured(crate::types::Diagnostic::Code {
            code: code.into(),
            params,
        })
    }
    pub fn app(error: crate::AppError) -> Self {
        Self::Structured(error.into_diagnostic())
    }
    /// Foreign transport/OS/parser detail remains literal data, never matched
    /// against English sentences to infer an application-owned error identity.
    pub fn into_app_error(self) -> crate::AppError {
        use crate::{types::Diagnostic, AppError};
        use serde_json::json;
        match self {
            Self::Structured(Diagnostic::Code { code, params }) => AppError::code(code, params),
            Self::Structured(Diagnostic::Text { text }) => AppError::Text { text },
            Self::ConnectionFailed { reason, details } => AppError::code(
                "p2p.error.connectionFailed",
                json!({
                    "details": reason,
                    "connection": details.map(|details| json!({"attempt":details.attempt,"server":details.server_addr.to_string(),
                        "details":details.error_message,"nextRetryDelayMs":details.next_retry_delay_ms,"remainingAttempts":details.remaining_attempts})),
                }),
            ),
            Self::ConnectionLost(details) => {
                AppError::code("p2p.error.connectionLost", json!({"details":details}))
            }
            Self::ServerNotFound { address } => {
                AppError::code("error.notFound", json!({"details":address}))
            }
            Self::ReconnectionFailed { attempts, reason } => AppError::code(
                "p2p.error.reconnectFailed",
                json!({"attempts":attempts,"details":reason}),
            ),
            Self::AlreadyConnected { mode } => {
                AppError::code("p2p.error.alreadyConnected", json!({"mode":mode}))
            }
            Self::InvalidModeOperation {
                current_mode,
                operation,
            } => AppError::code(
                "p2p.error.inconsistentState",
                json!({"mode":current_mode,"operation":operation}),
            ),
            Self::PromotionFailed(details) => {
                AppError::code("p2p.error.promotionFailed", json!({"details":details}))
            }
            Self::RegistrationFailed(details) => {
                AppError::code("p2p.error.registrationFailed", json!({"details":details}))
            }
            Self::ValidationFailed(details) => {
                AppError::code("error.invalidData", json!({"details":details}))
            }
            Self::SerializationError(details) => {
                AppError::code("error.parse", json!({"details":details}))
            }
            Self::NetworkError {
                message,
                kind,
                code,
            } => AppError::code(
                "error.io",
                json!({"details":message,"ioKind":kind,"osCode":code}),
            ),
            Self::Timeout { timeout_ms } => {
                AppError::code("p2p.error.timeout", json!({"timeoutMs":timeout_ms}))
            }
            Self::TransactionError(details) => {
                AppError::code("error.invalidOperation", json!({"details":details}))
            }
            Self::ConflictResolutionError(details) => {
                AppError::code("p2p.error.conflict", json!({"details":details}))
            }
            Self::RequestTimeout {
                request_id,
                timeout_secs,
            } => AppError::code(
                "p2p.error.timeout",
                json!({"timeoutMs":timeout_secs.saturating_mul(1000),"requestId":request_id}),
            ),
            Self::ChannelError(details) => {
                AppError::code("p2p.error.channel", json!({"details":details}))
            }
            Self::StreamError(details) => {
                AppError::code("p2p.error.stream", json!({"details":details}))
            }
        }
    }
}

impl From<P2PError> for crate::AppError {
    fn from(error: P2PError) -> Self {
        error.into_app_error()
    }
}

impl From<P2PError> for String {
    fn from(err: P2PError) -> Self {
        err.to_string()
    }
}

impl From<std::io::Error> for P2PError {
    fn from(err: std::io::Error) -> Self {
        P2PError::NetworkError {
            message: err.to_string(),
            kind: Some(format!("{:?}", err.kind())),
            code: err.raw_os_error(),
        }
    }
}

/// Result type for P2P operations
pub type P2PResult<T> = Result<T, P2PError>;

/// Detailed connection error information
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionErrorDetails {
    pub attempt: u32,
    pub server_addr: std::net::SocketAddr,
    pub error_message: String,
    pub next_retry_delay_ms: u64,
    pub remaining_attempts: u32,
}

impl fmt::Display for ConnectionErrorDetails {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Reconnection attempt {} failed: {}\n  Server address: {}\n  Next retry in: {}ms\n  Remaining attempts: {}",
            self.attempt,
            self.error_message,
            self.server_addr,
            self.next_retry_delay_ms,
            self.remaining_attempts
        )
    }
}

/// Connection state information for debugging
#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    pub mode: String,
    pub address: Option<String>,
    pub connected_at: Option<std::time::SystemTime>,
    pub last_error: Option<String>,
    pub reconnect_attempts: u32,
}

impl Default for ConnectionInfo {
    fn default() -> Self {
        Self {
            mode: "disconnected".to_string(),
            address: None,
            connected_at: None,
            last_error: None,
            reconnect_attempts: 0,
        }
    }
}

impl ConnectionInfo {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "mode": self.mode,
            "address": self.address,
            "connected_at": self.connected_at.map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
            }),
            "last_error": self.last_error,
            "reconnect_attempts": self.reconnect_attempts,
        })
    }
}

/// P2P connection state machine
#[derive(Debug, Clone, PartialEq)]
pub enum P2PState {
    Disconnected,
    Connecting {
        attempt: u32,
        server_addr: std::net::SocketAddr,
    },
    Connected(crate::p2p_manager::ConnectionMode),
    Reconnecting {
        attempt: u32,
        server_addr: std::net::SocketAddr,
    },
    PromotingToServer,
    Failed(P2PError),
}

impl P2PState {
    pub fn can_transition_to(&self, new_state: &P2PState) -> bool {
        use crate::p2p_manager::ConnectionMode;
        matches!(
            (self, new_state),
            (P2PState::Disconnected, P2PState::Connecting { .. })
                | (P2PState::Connecting { .. }, P2PState::Connecting { .. })
                | (P2PState::Connecting { .. }, P2PState::Connected(_))
                | (P2PState::Connecting { .. }, P2PState::Disconnected)
                | (P2PState::Connecting { .. }, P2PState::Failed(_))
                | (P2PState::Connected(_), P2PState::Reconnecting { .. })
                | (P2PState::Connected(_), P2PState::Disconnected)
                | (P2PState::Reconnecting { .. }, P2PState::Connecting { .. })
                | (P2PState::Reconnecting { .. }, P2PState::Reconnecting { .. })
                | (P2PState::Reconnecting { .. }, P2PState::Connected(_))
                | (P2PState::Reconnecting { .. }, P2PState::Disconnected)
                | (P2PState::Reconnecting { .. }, P2PState::Failed(_))
                | (
                    P2PState::Connected(ConnectionMode::Client { .. }),
                    P2PState::PromotingToServer
                )
                // Failover promotion after server loss, through Reconnecting/Disconnected
                | (P2PState::Reconnecting { .. }, P2PState::PromotingToServer)
                | (P2PState::Disconnected, P2PState::PromotingToServer)
                // Starting the server during promotion passes through the Connecting state
                | (P2PState::PromotingToServer, P2PState::Connecting { .. })
                | (
                    P2PState::PromotingToServer,
                    P2PState::Connected(ConnectionMode::Server { .. })
                )
                | (P2PState::Failed(_), P2PState::Disconnected)
                | (P2PState::Failed(_), P2PState::Connecting { .. })
                | (P2PState::Failed(_), P2PState::PromotingToServer)
                | (P2PState::PromotingToServer, P2PState::Disconnected)
        )
    }
}

impl fmt::Display for P2PState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            P2PState::Disconnected => write!(f, "Disconnected"),
            P2PState::Connecting {
                attempt,
                server_addr,
            } => {
                write!(f, "Connecting to {server_addr} (attempt {attempt})")
            }
            P2PState::Connected(mode) => write!(f, "Connected as {mode:?}"),
            P2PState::Reconnecting {
                attempt,
                server_addr,
            } => {
                write!(f, "Reconnecting to {server_addr} (attempt {attempt})")
            }
            P2PState::PromotingToServer => write!(f, "Promoting to server"),
            P2PState::Failed(error) => write!(f, "Failed: {error}"),
        }
    }
}

#[cfg(test)]
mod localization_tests {
    use super::*;
    use crate::AppError;
    use serde_json::json;

    #[test]
    fn semantic_causes_survive_state_and_json_transport_without_display_flattening() {
        let cause = AppError::code(
            "error.settingsSingleton",
            json!({"path":"/literal/{path}/日本語"}),
        );
        let state = P2PState::Failed(P2PError::app(cause.clone()));
        let P2PState::Failed(error) = state else {
            panic!("failed state expected")
        };
        let transported = serde_json::to_value(error.into_app_error()).unwrap();
        assert_eq!(transported, serde_json::to_value(cause).unwrap());
        assert_eq!(transported["params"]["path"], "/literal/{path}/日本語");
    }

    #[test]
    fn foreign_detail_and_timeout_numbers_are_preserved_as_parameters() {
        let error = P2PError::NetworkError {
            message: "foreign OS detail {unchanged}".into(),
            kind: Some("PermissionDenied".into()),
            code: Some(13),
        }
        .into_app_error();
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "error.io");
        assert_eq!(value["params"]["details"], "foreign OS detail {unchanged}");
        assert_eq!(value["params"]["osCode"], 13);
        let value = serde_json::to_value(
            P2PError::RequestTimeout {
                request_id: 42,
                timeout_secs: 3,
            }
            .into_app_error(),
        )
        .unwrap();
        assert_eq!(value["params"]["requestId"], 42);
        assert_eq!(value["params"]["timeoutMs"], 3000);
    }

    #[test]
    fn foreign_text_that_looks_like_an_owned_error_is_not_reclassified() {
        let error =
            P2PError::ConnectionLost("Failover failed after 4 attempts".into()).into_app_error();
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "p2p.error.connectionLost");
        assert_eq!(
            value["params"]["details"],
            "Failover failed after 4 attempts"
        );
    }
}
