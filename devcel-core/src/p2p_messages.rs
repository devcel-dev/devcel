use crate::operations::{DevcelOperation, DevcelResponse};
use serde::{Deserialize, Serialize};

/// P2P message wrapper that includes message type and request IDs for RPC
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "msg_type")]
pub enum P2PMessage {
    /// Request message with a unique ID
    Request { id: u64, operation: DevcelOperation },
    /// Response message corresponding to a request
    Response { id: u64, result: DevcelResponse },
    /// Server-confirmed project snapshot (no ID, not expecting a response)
    Broadcast { project_state: serde_json::Value },
}

impl P2PMessage {
    /// Create a new request message
    pub fn request(id: u64, operation: DevcelOperation) -> Self {
        Self::Request { id, operation }
    }

    /// Create a new response message
    pub fn response(id: u64, result: DevcelResponse) -> Self {
        Self::Response { id, result }
    }

    /// Create a committed-snapshot broadcast. Operations are never replayed on clients.
    pub fn broadcast(project_state: serde_json::Value) -> Self {
        Self::Broadcast { project_state }
    }
}
