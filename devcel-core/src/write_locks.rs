//! Per-target OS file locks stored only in an owner-private application Temp directory.
//! This is a same-host/common-Temp-namespace protocol, not distributed locking.
//! Target files are removed on release. Every acquirer checks path/object identity
//! after locking, so a waiter on a deleted object retries rather than entering.
//! Only participants using this protocol may remove these files while running;
//! arbitrary external Temp cleanup and distinct user/host Temp namespaces are not
//! coordinated. Old binaries using project sidecars must stop before upgrading.
//! Payload staging and atomic replacement remain beside the data.
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn unsafe_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Unsafe temporary write-lock path",
    )
}
fn regular(path: &Path, directory: bool) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(unsafe_path());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(unsafe_path());
        }
    }
    crate::private_files::verify(path, directory)
}
fn root() -> io::Result<PathBuf> {
    let owner = Sha256::digest(crate::private_files::owner_key()?.as_bytes());
    let path = std::env::temp_dir().join(format!("devcel-write-locks-{owner:x}"));
    match crate::private_files::create_directory(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    regular(&path, true)?;
    Ok(path)
}
fn identity(target: &Path) -> io::Result<Vec<u8>> {
    let canonical = if target.try_exists()? {
        target.canonicalize()?
    } else {
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        parent
            .canonicalize()?
            .join(target.file_name().ok_or_else(unsafe_path)?)
    };
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        // Invariant uppercase also unifies case variants of not-yet-created targets.
        Ok(
            std::ffi::OsString::from(canonical.to_string_lossy().to_uppercase())
                .encode_wide()
                .flat_map(u16::to_le_bytes)
                .collect(),
        )
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(canonical.as_os_str().as_bytes().to_vec())
    }
}
fn path_in(root: &Path, target: &Path) -> io::Result<PathBuf> {
    Ok(root.join(format!("{:x}.lock", Sha256::digest(identity(target)?))))
}
/// Resolve the same stable Temp sentinel in every cooperating process.
pub fn path_for_target(target: &Path) -> io::Result<PathBuf> {
    path_in(&root()?, target)
}
fn open(path: &Path) -> io::Result<File> {
    match crate::private_files::create_file(path) {
        Ok(file) => drop(file),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    regular(path, false)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(7).custom_flags(0x0020_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() != 0 {
        return Err(unsafe_path());
    }
    file.set_modified(std::time::SystemTime::now())?;
    Ok(file)
}
#[cfg(unix)]
fn same_object(file: &File, path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let current = fs::symlink_metadata(path)?;
    let opened = file.metadata()?;
    Ok(current.is_file() && current.dev() == opened.dev() && current.ino() == opened.ino())
}
#[cfg(windows)]
fn same_object(file: &File, path: &Path) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO},
    };
    fn id(file: &File) -> io::Result<(u64, [u8; 16])> {
        let mut info = FILE_ID_INFO::default();
        // SAFETY: the borrowed live handle and aligned output buffer remain
        // valid throughout this synchronous call; no ownership is transferred.
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileIdInfo,
                std::ptr::from_mut(&mut info).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        }
        .map_err(io::Error::other)?;
        Ok((info.VolumeSerialNumber, info.FileId.Identifier))
    }
    regular(path, false)?;
    Ok(id(file)? == id(&File::open(path)?)?)
}
fn transient(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::NotFound {
        return true;
    }
    // Windows can retain a deleted name until another waiter's old handle
    // closes. Do not confuse it with a successful lock or ignore it forever.
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(5 | 32 | 303)) {
        return true;
    }
    false
}
/// Owns an OS lock and removes its temporary target file when safely possible.
/// Shared holders reclaim only after releasing shared access and obtaining
/// exclusive access. Failed cleanup must never turn a committed write into an
/// apparent failed/rolled-back mutation.
pub struct LockGuard {
    file: Option<File>,
    path: PathBuf,
    shared: bool,
}
impl Drop for LockGuard {
    fn drop(&mut self) {
        let Some(file) = self.file.take() else { return };
        let cleanup = (|| -> io::Result<()> {
            if self.shared {
                file.unlock()?;
                match file.try_lock() {
                    Ok(()) => {}
                    Err(std::fs::TryLockError::WouldBlock) => return Ok(()),
                    Err(std::fs::TryLockError::Error(error)) => return Err(error),
                }
            }
            match same_object(&file, &self.path) {
                Ok(true) => fs::remove_file(&self.path),
                Ok(false) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            }
        })();
        // Explicitly unlock before close, including when a spawned child briefly
        // inherited the descriptor before exec. Other waiters revalidate identity.
        let _ = file.unlock();
        if let Err(error) = cleanup {
            tracing::warn!(%error, "Temporary write-lock cleanup failed");
        }
    }
}
fn acquire(path: PathBuf, shared: bool) -> io::Result<LockGuard> {
    // A long legitimate wait must not consume the subsequent identity-retry budget.
    let mut deadline = None;
    loop {
        let result = (|| {
            let file = open(&path)?;
            if shared {
                file.lock_shared()?;
            } else {
                file.lock()?;
            }
            match same_object(&file, &path) {
                Ok(true) => Ok(Some(file)),
                Ok(false) => {
                    file.unlock()?;
                    Ok(None)
                }
                Err(error) => {
                    let _ = file.unlock();
                    Err(error)
                }
            }
        })();
        match result {
            Ok(Some(file)) => {
                return Ok(LockGuard {
                    file: Some(file),
                    path,
                    shared,
                })
            }
            Ok(None) => {}
            Err(error) if transient(&error) => {}
            Err(error) => return Err(error),
        }
        if Instant::now()
            >= *deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(10))
        {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Temporary write-lock identity kept changing",
            ));
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}
/// Deduplicate and acquire the complete read/write set in one global key order.
pub fn lock_files<'a>(
    targets: impl IntoIterator<Item = &'a Path>,
    shared: bool,
) -> io::Result<Vec<(PathBuf, LockGuard)>> {
    let root = root()?;
    let paths = targets
        .into_iter()
        .map(|target| path_in(&root, target))
        .collect::<io::Result<BTreeSet<_>>>()?;
    paths
        .into_iter()
        .map(|path| Ok((path.clone(), acquire(path, shared)?)))
        .collect()
}
pub fn lock_file(target: &Path, shared: bool) -> io::Result<LockGuard> {
    Ok(lock_files([target], shared)?
        .pop()
        .expect("one lock target")
        .1)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_control_file_is_not_the_opened_object() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control");
        let retired = directory.path().join("retired");
        let file = open(&path).unwrap();
        file.lock().unwrap();
        assert!(same_object(&file, &path).unwrap());
        // Simulate the obsolete open handle a waiter can retain after deletion.
        // Equal payload bytes are not evidence of equal filesystem identity.
        fs::rename(&path, &retired).unwrap();
        drop(crate::private_files::create_file(&path).unwrap());
        assert!(!same_object(&file, &path).unwrap());
        fs::remove_file(&path).unwrap();
        assert!(
            matches!(same_object(&file, &path),Err(error) if error.kind()==io::ErrorKind::NotFound)
        );
        file.unlock().unwrap();
    }
}
