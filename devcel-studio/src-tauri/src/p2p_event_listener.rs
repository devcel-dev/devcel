use async_trait::async_trait;
use devcel_core::p2p_errors::{P2PError, P2PState};
use devcel_core::p2p_manager::{ConnectionMode, ConnectionStateListener};
use std::net::SocketAddr;
use tauri::{AppHandle, Emitter};

/// Tauri app handle wrapper for P2P event notifications
pub struct TauriP2PEventListener {
    app_handle: AppHandle,
}

impl TauriP2PEventListener {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

#[async_trait]
impl ConnectionStateListener for TauriP2PEventListener {
    async fn on_connected(&self, mode: ConnectionMode, addr: SocketAddr) {
        let _ = match mode {
            ConnectionMode::Server { .. } => self.app_handle.emit(
                "p2p-server-started",
                serde_json::json!({
                    "address": addr.to_string()
                }),
            ),
            ConnectionMode::Client { .. } => self.app_handle.emit(
                "p2p-client-connected",
                serde_json::json!({
                    "server": addr.to_string()
                }),
            ),
        };
    }

    async fn on_disconnected(&self, reason: P2PError) {
        let _ = self.app_handle.emit(
            "p2p-disconnected",
            serde_json::json!({
                "reason": reason.into_app_error()
            }),
        );
    }

    async fn on_reconnecting(&self, attempt: u32, addr: SocketAddr) {
        let _ = self.app_handle.emit(
            "p2p-reconnecting",
            serde_json::json!({
                "attempt": attempt,
                "server": addr.to_string()
            }),
        );
    }

    async fn on_state_changed(&self, _old_state: P2PState, new_state: P2PState) {
        let payload = state_payload(&new_state);

        let _ = self.app_handle.emit("p2p-state-changed", payload);
    }
}

/// Stable event field names; error values are AppError objects, never Display text.
fn state_payload(state: &P2PState) -> serde_json::Value {
    let (name, error) = match state {
        P2PState::Disconnected => ("disconnected", None),
        P2PState::Connecting { .. } => ("connecting", None),
        P2PState::Connected(_) => ("connected", None),
        P2PState::Reconnecting { .. } => ("reconnecting", None),
        P2PState::PromotingToServer => ("promoting", None),
        P2PState::Failed(error) => ("failed", Some(error.clone().into_app_error())),
    };
    let mut payload = serde_json::json!({"state":name});
    if let Some(error) = error {
        payload["error"] = serde_json::json!(error);
    }
    payload
}

/// Emit client connection events (for server mode)
#[allow(dead_code)]
pub fn emit_client_connected(app_handle: &AppHandle, client_addr: SocketAddr) {
    let _ = app_handle.emit(
        "p2p-client-connected",
        serde_json::json!({
            "address": client_addr.to_string()
        }),
    );
}

/// Emit client disconnection events (for server mode)
#[allow(dead_code)]
pub fn emit_client_disconnected(app_handle: &AppHandle, client_addr: SocketAddr) {
    let _ = app_handle.emit(
        "p2p-client-disconnected",
        serde_json::json!({
            "address": client_addr.to_string()
        }),
    );
}

/// Emit P2P error events
#[allow(dead_code)]
pub fn emit_p2p_error(app_handle: &AppHandle, error: &crate::AppError) {
    let _ = app_handle.emit(
        "p2p-error",
        serde_json::json!({
            "message": error
        }),
    );
}

#[cfg(test)]
mod localization_tests {
    use super::*;
    #[test]
    fn failed_event_preserves_typed_identity_and_parameters() {
        let payload = state_payload(&P2PState::Failed(P2PError::code(
            "p2p.error.failoverExhausted",
            serde_json::json!({"attempts":4}),
        )));
        assert_eq!(payload["state"], "failed");
        assert_eq!(payload["error"]["kind"], "code");
        assert_eq!(payload["error"]["code"], "p2p.error.failoverExhausted");
        assert_eq!(payload["error"]["params"]["attempts"], 4);
        assert!(!state_payload(&P2PState::Disconnected)
            .as_object()
            .unwrap()
            .contains_key("error"));
    }
}
