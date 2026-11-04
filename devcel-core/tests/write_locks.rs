//! Native file-lock tests. Child processes and markers are bounded and isolated.
use devcel_core::write_locks::{lock_file, lock_files, path_for_target};
use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
#[test]
fn temp_lock_child() {
    let Some(target) = std::env::var_os("DEVCEL_TEMP_LOCK_TEST_TARGET") else {
        return;
    };
    let target = PathBuf::from(target);
    let marker = PathBuf::from(std::env::var_os("DEVCEL_TEMP_LOCK_TEST_MARKER").unwrap());
    fs::write(marker.with_extension("entered"), b"attempting").unwrap();
    let _guard = lock_file(
        &target,
        std::env::var_os("DEVCEL_TEMP_LOCK_TEST_SHARED").is_some(),
    )
    .unwrap();
    fs::write(&marker, b"acquired").unwrap();
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
}
struct Worker {
    child: Child,
    marker: PathBuf,
}
impl Worker {
    fn start(target: &Path, marker: PathBuf, shared: bool) -> Self {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "temp_lock_child", "--nocapture"])
            .env("DEVCEL_TEMP_LOCK_TEST_TARGET", target)
            .env("DEVCEL_TEMP_LOCK_TEST_MARKER", &marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        if shared {
            command.env("DEVCEL_TEMP_LOCK_TEST_SHARED", "1");
        }
        Self {
            child: command.spawn().unwrap(),
            marker,
        }
    }
    fn wait_for(&mut self, entered: bool) {
        let marker = if entered {
            self.marker.with_extension("entered")
        } else {
            self.marker.clone()
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() {
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "owned test child exited before readiness"
            );
            assert!(Instant::now() < deadline, "owned test child timeout");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn blocked(&mut self) {
        self.wait_for(true);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!self.marker.exists());
        assert!(self.child.try_wait().unwrap().is_none());
    }
    fn release(&mut self) {
        self.child.stdin.take().unwrap().write_all(b"\n").unwrap();
        assert!(self.child.wait().unwrap().success());
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("Project");
    fs::create_dir(&project).unwrap();
    let target = project.join("a.table.toml");
    fs::write(&target, b"original").unwrap();
    (dir, target)
}
fn contended(target: &Path) -> bool {
    if !path_for_target(target).unwrap().exists() {
        return false;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path_for_target(target).unwrap())
        .unwrap();
    match file.try_lock() {
        Err(std::fs::TryLockError::WouldBlock) => true,
        Ok(()) => false,
        Err(error) => panic!("unexpected lock failure: {error:?}"),
    }
}
fn no_project_locks(project: &Path) {
    for entry in fs::read_dir(project).unwrap() {
        let path = entry.unwrap().path();
        assert!(!path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".lock"));
        if path.is_dir() {
            no_project_locks(&path);
        }
    }
}
#[test]
fn readers_share_then_writer_waits_and_handoffs_without_project_residue() {
    let (dir, target) = fixture();
    let first = lock_file(&target, true).unwrap();
    let mut second = Worker::start(&target, dir.path().join("reader"), true);
    second.wait_for(false);
    let mut writer = Worker::start(&target, dir.path().join("writer"), false);
    writer.blocked();
    drop(first);
    writer.blocked();
    second.release();
    writer.wait_for(false);
    writer.release();
    assert_eq!(fs::read(&target).unwrap(), b"original");
    no_project_locks(target.parent().unwrap());
}
#[test]
fn dead_writer_releases_waiter_without_unlinking_sentinel() {
    let (dir, target) = fixture();
    let mut owner = Worker::start(&target, dir.path().join("owner"), false);
    owner.wait_for(false);
    let path = path_for_target(&target).unwrap();
    let before = fs::metadata(&path).unwrap().created().ok();
    let mut waiter = Worker::start(&target, dir.path().join("waiter"), false);
    waiter.blocked();
    owner.child.kill().unwrap();
    owner.child.wait().unwrap();
    waiter.wait_for(false);
    assert!(path.exists());
    assert_eq!(fs::metadata(&path).unwrap().created().ok(), before);
    waiter.release();
    assert!(!path.exists());
    no_project_locks(target.parent().unwrap());
}
#[test]
fn unrelated_files_remain_independent_and_multikey_order_is_stable() {
    let (_dir, target) = fixture();
    let other = target.with_file_name("b.table.toml");
    fs::write(&other, b"other").unwrap();
    let first = lock_file(&target, false).unwrap();
    let second = lock_file(&other, false).unwrap();
    assert!(contended(&target));
    assert!(contended(&other));
    drop((first, second));
    let guards = lock_files([target.as_path(), other.as_path()], false).unwrap();
    let paths = guards.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
    drop(guards);
    let guards = lock_files([other.as_path(), target.as_path(), target.as_path()], false).unwrap();
    assert_eq!(
        guards.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>(),
        paths
    );
    drop(guards);
    no_project_locks(target.parent().unwrap());
}
#[test]
fn replacement_rename_and_canonical_alias_keep_target_identity() {
    let (dir, target) = fixture();
    let guard = lock_file(&target, false).unwrap();
    let path = path_for_target(&target).unwrap();
    assert!(!path.starts_with(target.parent().unwrap()));
    let alias = target
        .parent()
        .unwrap()
        .join("..")
        .join("Project/a.table.toml");
    assert_eq!(path_for_target(&alias).unwrap(), path);
    #[cfg(windows)]
    assert_eq!(
        path_for_target(&PathBuf::from(target.to_string_lossy().to_uppercase())).unwrap(),
        path
    );
    let pending = target.with_file_name("pending");
    fs::write(&pending, b"replacement").unwrap();
    fs::rename(&pending, &target).unwrap();
    assert_eq!(path_for_target(&target).unwrap(), path);
    assert!(contended(&target));
    let root = target.parent().unwrap();
    let backup = dir.path().join("backup");
    let stage = dir.path().join("stage");
    fs::create_dir(&stage).unwrap();
    fs::write(stage.join("a.table.toml"), b"staged").unwrap();
    fs::rename(root, &backup).unwrap();
    fs::rename(&stage, root).unwrap();
    assert_eq!(path_for_target(&target).unwrap(), path);
    assert!(contended(&target));
    drop(guard);
    assert!(!contended(&target));
    no_project_locks(root);
}
#[test]
fn failed_or_unwound_operations_release_lock_without_project_residue() {
    let (_dir, target) = fixture();
    let result = std::panic::catch_unwind(|| {
        let _guard = lock_file(&target, false).unwrap();
        panic!("injected publication unwind");
    });
    assert!(result.is_err());
    assert!(!contended(&target));
    assert_eq!(fs::read(&target).unwrap(), b"original");
    no_project_locks(target.parent().unwrap());
}

#[test]
fn normal_release_reclaims_target_and_waiter_retries_deleted_identity() {
    for attempt in 0..8 {
        let (dir, target) = fixture();
        let owner = lock_file(&target, false).unwrap();
        let path = path_for_target(&target).unwrap();
        let mut waiter =
            Worker::start(&target, dir.path().join(format!("waiter-{attempt}")), false);
        waiter.blocked();
        if attempt == 0 {
            // A legitimate long-held lock must not exhaust the later identity retry budget.
            std::thread::sleep(Duration::from_secs(11));
        }
        drop(owner);
        waiter.wait_for(false);
        assert!(path.exists());
        assert!(contended(&target));
        waiter.release();
        assert!(!path.exists());
        no_project_locks(target.parent().unwrap());
    }
}
#[test]
fn crash_residue_is_reused_then_reclaimed_without_pid_or_age_guessing() {
    let (dir, target) = fixture();
    let path = path_for_target(&target).unwrap();
    let mut owner = Worker::start(&target, dir.path().join("crash-owner"), false);
    owner.wait_for(false);
    owner.child.kill().unwrap();
    owner.child.wait().unwrap();
    assert!(path.exists(), "forced process death cannot run cleanup");
    let next = lock_file(&target, false).unwrap();
    assert!(contended(&target));
    drop(next);
    assert!(!path.exists());
    no_project_locks(target.parent().unwrap());
}
#[test]
fn many_targets_and_partial_acquisition_failure_do_not_accumulate_sentinels() {
    let (dir, target) = fixture();
    let targets: Vec<_> = (0..24)
        .map(|n| target.with_file_name(format!("{n}.table.toml")))
        .collect();
    let paths: Vec<_> = targets
        .iter()
        .map(|p| path_for_target(p).unwrap())
        .collect();
    let locks = lock_files(targets.iter().map(|p| p.as_path()), false).unwrap();
    assert!(paths.iter().all(|p| p.exists()));
    drop(locks);
    assert!(paths.iter().all(|p| !p.exists()));
    // A nonempty control object must fail closed, while earlier acquired targets
    // in sorted order are released by the partially collected guard vector.
    let mut keys: Vec<_> = targets
        .iter()
        .map(|p| (path_for_target(p).unwrap(), p))
        .collect();
    keys.sort();
    let rejected = &keys.last().unwrap().0;
    fs::write(rejected, b"invalid control data").unwrap();
    assert!(lock_files(targets.iter().map(|p| p.as_path()), false).is_err());
    assert!(keys[..keys.len() - 1].iter().all(|(p, _)| !p.exists()));
    assert_eq!(fs::read(rejected).unwrap(), b"invalid control data");
    // Remove only this test's invalid fixture with no participating processes.
    fs::remove_file(rejected).unwrap();
    no_project_locks(dir.path());
}
