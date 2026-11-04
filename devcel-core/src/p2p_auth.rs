//! Owner-only, rotating local session capabilities. No project file contains a key.
//! A process running as the same OS user is outside this isolation boundary.
use crate::private_files as private;
use std::{
    fs,
    io::{self, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PREFIX: &[u8; 16] = b"DEVCEL-P2P-AUTH1";
const ACK: &[u8; 8] = b"DVCLA001";
pub(crate) const DEADLINE: std::time::Duration = std::time::Duration::from_secs(3);

fn random_bytes() -> io::Result<[u8; 32]> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| denied())?;
    Ok(bytes)
}
fn proof(secret: &[u8; 32], role: &[u8], client: &[u8; 32], server: &[u8; 32]) -> ring::hmac::Tag {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
    let mut context = ring::hmac::Context::with_key(&key);
    context.update(PREFIX);
    context.update(role);
    context.update(client);
    context.update(server);
    context.sign()
}
fn verify_proof(
    secret: &[u8; 32],
    role: &[u8],
    client: &[u8; 32],
    server: &[u8; 32],
    received: &[u8],
) -> io::Result<()> {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
    let mut transcript = Vec::with_capacity(PREFIX.len() + role.len() + 64);
    transcript.extend_from_slice(PREFIX);
    transcript.extend_from_slice(role);
    transcript.extend_from_slice(client);
    transcript.extend_from_slice(server);
    ring::hmac::verify(&key, &transcript, received).map_err(|_| denied())
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Local session authentication unavailable or rejected",
    )
}

fn root() -> io::Result<PathBuf> {
    // An isolated test/app launcher may choose a directory, never weaker access.
    if let Some(path) = std::env::var_os("DEVCEL_P2P_SESSION_DIR") {
        let path = PathBuf::from(path);
        return if path.is_absolute() {
            Ok(path)
        } else {
            Err(denied())
        };
    }
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(denied)?;
    #[cfg(unix)]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(denied)?;
    if !base.is_absolute() || !base.is_dir() {
        return Err(denied());
    }
    Ok(base.join("devcel-local-sessions-v1"))
}

fn check_kind(path: &Path, directory: bool) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink()
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err(denied());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(denied());
        } // reparse points/junctions
    }
    private::verify(path, directory)
}

fn prepare_root(path: &Path) -> io::Result<()> {
    match private::create_directory(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    check_kind(path, true)
}

pub(crate) fn discovery_directory() -> io::Result<PathBuf> {
    let root = root()?;
    prepare_root(&root)?;
    let directory = root.join("discovery");
    prepare_root(&directory)?;
    Ok(directory)
}

pub(crate) fn verify_private_file(path: &Path) -> io::Result<()> {
    check_kind(path.parent().ok_or_else(denied)?, true)?;
    check_kind(path, false)
}

pub(crate) fn create_private_file(path: &Path) -> io::Result<fs::File> {
    check_kind(path.parent().ok_or_else(denied)?, true)?;
    private::create_file(path)
}

pub(crate) fn open_private_lock(path: &Path) -> io::Result<fs::File> {
    match create_private_file(path) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            verify_private_file(path)?;
            fs::OpenOptions::new().read(true).write(true).open(path)
        }
        Err(error) => Err(error),
    }
}

// Deliberately no Debug/Serialize: capabilities must never enter diagnostics.
pub struct SessionCapability {
    file: PathBuf,
    secret: [u8; 32],
}
impl SessionCapability {
    /// Authenticate custom local servers using the same owner-only contract.
    /// The caller must retain this object for the lifetime of the bound listener.
    pub fn for_listener(listener: &tokio::net::TcpListener) -> io::Result<Self> {
        let address = listener.local_addr()?;
        if !address.ip().is_loopback() {
            return Err(denied());
        }
        Self::create(address.port())
    }
    pub(crate) fn create(port: u16) -> io::Result<Self> {
        Self::create_at(&root()?, port)
    }
    pub(crate) fn create_at(root: &Path, port: u16) -> io::Result<Self> {
        prepare_root(root)?;
        let file = root.join(format!("{port}.cap"));
        // Called only AFTER exclusive bind: an existing record can only be stale.
        if fs::symlink_metadata(&file).is_ok() {
            check_kind(&file, false)?;
            fs::remove_file(&file)?;
        }
        let secret = random_bytes()?;
        let mut handle = private::create_file(&file)?;
        handle.write_all(&secret)?;
        handle.sync_all()?;
        drop(handle);
        check_kind(&file, false)?;
        Ok(Self { file, secret })
    }
    pub(crate) fn revoke(&self) {
        if check_kind(&self.file, false).is_ok()
            && fs::read(&self.file).is_ok_and(|bytes| bytes == self.secret)
        {
            let _ = fs::remove_file(&self.file);
        }
    }
    pub async fn authenticate(&self, stream: &mut tokio::net::TcpStream) -> io::Result<()> {
        tokio::time::timeout(DEADLINE, async {
            let mut prefix = [0u8; 16];
            let mut client = [0u8; 32];
            stream.read_exact(&mut prefix).await?;
            stream.read_exact(&mut client).await?;
            if prefix != *PREFIX {
                return Err(denied());
            }
            let server = random_bytes()?;
            stream.write_all(&server).await?;
            stream
                .write_all(proof(&self.secret, b"server", &client, &server).as_ref())
                .await?;
            stream.flush().await?;
            let mut received = [0u8; 32];
            stream.read_exact(&mut received).await?;
            verify_proof(&self.secret, b"client", &client, &server, &received)?;
            stream.write_all(ACK).await?;
            stream.flush().await
        })
        .await
        .map_err(|_| denied())?
    }
}
impl Drop for SessionCapability {
    fn drop(&mut self) {
        self.revoke();
        self.secret.fill(0);
    }
}

pub async fn connect(stream: &mut tokio::net::TcpStream, addr: SocketAddr) -> io::Result<()> {
    connect_at(stream, addr, &root()?).await
}

pub(crate) async fn connect_at(
    stream: &mut tokio::net::TcpStream,
    addr: SocketAddr,
    root: &Path,
) -> io::Result<()> {
    if !addr.ip().is_loopback() {
        return Err(denied());
    }
    check_kind(root, true)?;
    let file = root.join(format!("{}.cap", addr.port()));
    check_kind(&file, false)?;
    let mut secret = [0u8; 32];
    let mut handle = fs::File::open(file)?;
    if handle.metadata()?.len() != 32 {
        return Err(denied());
    }
    handle.read_exact(&mut secret)?;
    let result = client_handshake(stream, &secret).await;
    secret.fill(0);
    result
}

pub(crate) async fn client_handshake(
    stream: &mut tokio::net::TcpStream,
    secret: &[u8; 32],
) -> io::Result<()> {
    tokio::time::timeout(DEADLINE, async {
        let client = random_bytes()?;
        stream.write_all(PREFIX).await?;
        stream.write_all(&client).await?;
        stream.flush().await?;
        let mut server = [0u8; 32];
        let mut received = [0u8; 32];
        stream.read_exact(&mut server).await?;
        stream.read_exact(&mut received).await?;
        // Verify the listener before sending any client proof or operation.
        verify_proof(secret, b"server", &client, &server, &received)?;
        stream
            .write_all(proof(secret, b"client", &client, &server).as_ref())
            .await?;
        stream.flush().await?;
        let mut ack = [0u8; 8];
        stream.read_exact(&mut ack).await?;
        if ack != *ACK {
            return Err(denied());
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|_| Err(denied()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proofs_are_bound_to_role_and_both_nonces() {
        let key = [7u8; 32];
        let client = [1u8; 32];
        let server = [2u8; 32];
        let tag = proof(&key, b"client", &client, &server);
        assert!(verify_proof(&key, b"client", &client, &server, tag.as_ref()).is_ok());
        assert!(verify_proof(&key, b"server", &client, &server, tag.as_ref()).is_err());
        assert!(verify_proof(&key, b"client", &[3u8; 32], &server, tag.as_ref()).is_err());
        assert!(verify_proof(&key, b"client", &client, &[3u8; 32], tag.as_ref()).is_err());
    }

    #[tokio::test]
    async fn unauthenticated_listener_never_receives_secret_or_client_proof() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let capability = SessionCapability::create_at(&root, address.port()).unwrap();
        let secret = capability.secret;
        let fake = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut hello = [0u8; 48];
            stream.read_exact(&mut hello).await.unwrap();
            assert_eq!(&hello[..16], PREFIX);
            assert!(
                hello[16..] != secret,
                "only a nonce may be sent before server verification"
            );
            stream.write_all(&[0u8; 64]).await.unwrap();
            let mut next = [0u8; 1];
            tokio::time::timeout(DEADLINE, stream.read(&mut next))
                .await
                .unwrap()
                .unwrap()
        });
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        assert!(connect_at(&mut client, address, &root).await.is_err());
        drop(client);
        assert_eq!(
            fake.await.unwrap(),
            0,
            "invalid listener must receive neither proof nor operation"
        );
    }
    #[test]
    fn private_capabilities_rotate_and_old_cleanup_cannot_remove_new_session() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("private-sessions");
        let first = SessionCapability::create_at(&root, 12345).unwrap();
        check_kind(&root, true).unwrap();
        check_kind(&first.file, false).unwrap();
        let second = SessionCapability::create_at(&root, 12345).unwrap();
        assert!(first.secret != second.secret, "capability must rotate");
        drop(first);
        assert!(
            second.file.is_file(),
            "old cleanup must preserve replacement session"
        );
        let file = second.file.clone();
        drop(second);
        assert!(!file.exists());
    }

    #[test]
    fn existing_unprotected_directory_is_rejected_without_repair() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("unprotected");
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(SessionCapability::create_at(&root, 12345).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn handshake_rejects_wrong_secret_and_accepts_current_secret() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("private-sessions");
        let capability = std::sync::Arc::new(SessionCapability::create_at(&root, 12345).unwrap());
        for valid in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server_capability = capability.clone();
            let task = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                server_capability.authenticate(&mut stream).await
            });
            let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
            let key = if valid { capability.secret } else { [0u8; 32] };
            let result = client_handshake(&mut client, &key).await;
            assert_eq!(result.is_ok(), valid);
            drop(client);
            assert_eq!(task.await.unwrap().is_ok(), valid);
        }
    }
}
