use crate::p2p_errors::{ConnectionErrorDetails, P2PError};
use crate::p2p_manager::{DevcelClient, ReconnectConfig};
use std::net::SocketAddr;
use tokio::time::{sleep, Duration};

/// Manages reconnection attempts with exponential backoff
pub struct ReconnectionManager {
    config: ReconnectConfig,
    current_attempt: u32,
    current_delay_ms: u64,
}

impl ReconnectionManager {
    pub fn new(config: ReconnectConfig) -> Self {
        let base_delay = config.base_delay_ms;
        Self {
            config,
            current_attempt: 0,
            current_delay_ms: base_delay,
        }
    }

    pub async fn attempt_reconnection(
        &mut self,
        client: &mut Box<dyn DevcelClient>,
        server_addr: SocketAddr,
    ) -> Result<(), P2PError> {
        self.current_attempt += 1;

        if self.current_attempt > self.config.max_attempts {
            return Err(P2PError::code(
                "p2p.error.failoverExhausted",
                serde_json::json!({"attempts":self.config.max_attempts}),
            ));
        }

        eprintln!(
            "Reconnection attempt {} after {}ms delay",
            self.current_attempt, self.current_delay_ms
        );

        sleep(Duration::from_millis(self.current_delay_ms)).await;

        match client.connect(server_addr).await {
            Ok(_) => {
                eprintln!("Successfully reconnected to server at {server_addr}");
                self.reset();
                Ok(())
            }
            Err(e) => {
                let error_details = ConnectionErrorDetails {
                    attempt: self.current_attempt,
                    server_addr,
                    error_message: e.to_string(),
                    next_retry_delay_ms: self.next_delay(),
                    remaining_attempts: self.config.max_attempts - self.current_attempt,
                };

                eprintln!("Reconnection failed: {error_details}");

                self.current_delay_ms = self.next_delay();
                Err(P2PError::code(
                    "p2p.error.connectionFailed",
                    serde_json::json!({
                        "details":e,"attempt":error_details.attempt,"server":server_addr.to_string(),
                        "nextRetryDelayMs":error_details.next_retry_delay_ms,"remainingAttempts":error_details.remaining_attempts,
                    }),
                ))
            }
        }
    }

    fn next_delay(&self) -> u64 {
        std::cmp::min(self.current_delay_ms * 2, self.config.max_delay_ms)
    }

    fn reset(&mut self) {
        self.current_attempt = 0;
        self.current_delay_ms = self.config.base_delay_ms;
    }

    pub fn is_exhausted(&self) -> bool {
        self.current_attempt >= self.config.max_attempts
    }

    pub fn get_current_attempt(&self) -> u32 {
        self.current_attempt
    }
}
