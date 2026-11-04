//! Importer subprocesses may inherit unrelated, non-CLOEXEC editor pipes.
//! Closing them before any runtime/thread creation prevents one source from
//! retaining another source's parent-stdin write end (notably Godot on Unix).
#[cfg(unix)]
pub fn close_inherited_descriptors() -> Result<(), String> {
    let entries = std::fs::read_dir("/proc/self/fd")
        .or_else(|_| std::fs::read_dir("/dev/fd"))
        .map_err(|e| format!("Cannot isolate importer process file descriptors: {e}"))?;
    let descriptors: Vec<i32> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter(|fd| *fd > 2)
        .collect();
    // The iterator's own descriptor has now closed. close(2) safely returns
    // EBADF for it; do not wrap raw numbers in OwnedFd (which requires validity).
    unsafe extern "C" {
        fn close(fd: i32) -> i32;
    }
    for fd in descriptors {
        // SAFETY: this is called synchronously before creating any Rust runtime,
        // thread, file, or socket. These are inherited OS descriptors with no
        // Rust owner. POSIX close permits an invalid number (returns EBADF).
        unsafe {
            close(fd);
        }
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn close_inherited_descriptors() -> Result<(), String> {
    Ok(())
}
