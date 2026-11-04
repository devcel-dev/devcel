use std::net::SocketAddr;
use tokio::net::TcpListener;

/// Simplified port management for P2P connections
pub struct PortManager;

impl PortManager {
    /// Find an available port starting from the preferred port
    pub async fn find_available_port(preferred_port: u16) -> Result<u16, String> {
        // If port 0 is specified, let the OS choose (dynamic allocation)
        if preferred_port == 0 {
            return Ok(0);
        }

        let max_attempts = 10;
        for attempt in 0..max_attempts {
            let port = preferred_port + attempt;
            let addr: SocketAddr = format!("127.0.0.1:{port}")
                .parse()
                .map_err(|e| format!("Invalid address: {e}"))?;

            eprintln!(
                "[PortManager] Testing port {} (attempt {})",
                port,
                attempt + 1
            );

            // Simple availability check: try to bind and immediately release
            match Self::test_port_availability(addr).await {
                Ok(true) => {
                    eprintln!("[PortManager] Port {port} is available");
                    return Ok(port);
                }
                Ok(false) => {
                    eprintln!("[PortManager] Port {port} is in use, trying next");
                    continue;
                }
                Err(e) => {
                    eprintln!("[PortManager] Port {port} test failed: {e}, trying next");
                    continue;
                }
            }
        }

        Err(format!(
            "Could not find available port after {max_attempts} attempts starting from {preferred_port}"
        ))
    }

    /// Test if a port is available by attempting to bind to it
    async fn test_port_availability(addr: SocketAddr) -> Result<bool, String> {
        match TcpListener::bind(addr).await {
            Ok(listener) => {
                // Port is available - immediately close to free it
                drop(listener);
                Ok(true)
            }
            Err(e) => match e.kind() {
                std::io::ErrorKind::AddrInUse => Ok(false),
                _ => Err(format!("Port test error: {e}")),
            },
        }
    }

    /// Create socket address with port
    pub fn create_socket_addr(port: u16) -> Result<SocketAddr, String> {
        format!("127.0.0.1:{port}")
            .parse()
            .map_err(|e| format!("Invalid address: {e}"))
    }

    /// Convert unspecified address to localhost
    pub fn normalize_address(addr: SocketAddr) -> SocketAddr {
        if addr.ip().is_unspecified() {
            format!("127.0.0.1:{}", addr.port()).parse().unwrap_or(addr)
        } else {
            addr
        }
    }
}
