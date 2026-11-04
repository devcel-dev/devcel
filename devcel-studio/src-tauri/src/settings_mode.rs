//! The settings project owns a separate process, ProjectState, history and windows.
//! Its gateway accepts only focus and typed swatch transactions, never Devcel/P2P commands.
use crate::{app_settings_store, state::ProjectState, AppError};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;

const ENDPOINT_FILE: &str = "settings-editor.endpoint.json";
const START_TIMEOUT: Duration = Duration::from_secs(20);
const SOCKET_TIMEOUT: Duration = Duration::from_millis(750);
const TRANSACTION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_GATEWAY_BYTES: usize = 512 * 1024;
const GATEWAY_PROTOCOL: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ApplicationMode {
    Standard,
    SettingsEditor,
}

impl ApplicationMode {
    pub(crate) fn from_arguments() -> Result<Self, AppError> {
        let arguments: Vec<_> = std::env::args_os().skip(1).collect();
        if arguments
            .iter()
            .any(|argument| argument == "--settings-editor")
        {
            if arguments.len() != 1 {
                return Err(AppError::code(
                    "settings.editorArgumentsInvalid",
                    serde_json::json!({}),
                ));
            }
            Ok(Self::SettingsEditor)
        } else {
            Ok(Self::Standard)
        }
    }
    pub(crate) fn is_settings_editor(self) -> bool {
        self == Self::SettingsEditor
    }
}

#[tauri::command]
pub(crate) async fn get_application_mode(
    app: tauri::AppHandle,
    mode: tauri::State<'_, ApplicationMode>,
) -> Result<ApplicationMode, AppError> {
    let mode = *mode;
    if mode.is_settings_editor() {
        // A webview may bootstrap while native setup is still opening the source.
        // Do not let its first project-session read observe an empty editor.
        let deadline = Instant::now() + START_TIMEOUT;
        while app.try_state::<EditorRuntime>().is_none() {
            if Instant::now() >= deadline {
                return Err(AppError::code(
                    "settings.editorStartupFailed",
                    serde_json::json!({}),
                ));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    Ok(mode)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    protocol: u8,
    port: u16,
    token: String,
}

pub(crate) struct EditorRuntime {
    // The exclusive source-writer lock stays held until the editor process exits.
    _lease: app_settings_store::EditorLease,
    project_root: PathBuf,
    stop: Arc<AtomicBool>,
    endpoint: PathBuf,
    token: String,
}

impl EditorRuntime {
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        // Never remove an endpoint published by a newer editor after a crash.
        if read_endpoint(&self.endpoint).is_ok_and(|endpoint| endpoint.token == self.token) {
            let _ = std::fs::remove_file(&self.endpoint);
        }
    }
}
impl Drop for EditorRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_endpoint(path: &Path) -> Result<Endpoint, AppError> {
    let mut bytes = Vec::new();
    File::open(path)?.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(AppError::code(
            "settings.gatewayInvalid",
            serde_json::json!({}),
        ));
    }
    let endpoint: Endpoint = serde_json::from_slice(&bytes)?;
    if endpoint.protocol != GATEWAY_PROTOCOL
        || endpoint.port == 0
        || uuid::Uuid::parse_str(&endpoint.token).is_err()
    {
        return Err(AppError::code(
            "settings.gatewayInvalid",
            serde_json::json!({}),
        ));
    }
    Ok(endpoint)
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum GatewayOperation {
    Focus {},
    ReplaceUserSwatches {
        expected_revision: String,
        swatches: Vec<devcel_core::ColorSwatch>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayRequest {
    protocol: u8,
    token: String,
    request_id: String,
    payload: GatewayOperation,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
enum GatewayValue {
    Focused {},
    UserSwatches(crate::settings_transactions::UserColorSwatches),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayResponse {
    protocol: u8,
    request_id: String,
    result: Result<GatewayValue, AppError>,
}

/// A socket timeout alone resets on every short read. Enforce a whole-frame
/// deadline too, so a trickling local peer cannot monopolize the gateway.
struct TimedStream<'a> {
    stream: &'a mut TcpStream,
    deadline: Instant,
}
impl TimedStream<'_> {
    fn remaining(&self) -> std::io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Settings gateway deadline elapsed",
                )
            })
    }
}
impl Read for TimedStream<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        self.stream.read(buffer)
    }
}
impl Write for TimedStream<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

fn request_is_authorized(request: &GatewayRequest, token: &str) -> bool {
    request.protocol == GATEWAY_PROTOCOL
        && request.token == token
        && uuid::Uuid::parse_str(&request.request_id).is_ok()
}

fn gateway_io(error: std::io::Error) -> AppError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        AppError::code("settings.gatewayTimeout", serde_json::json!({}))
    } else {
        AppError::from(error)
    }
}

fn read_frame<T: serde::de::DeserializeOwned>(stream: &mut impl Read) -> Result<T, AppError> {
    let mut length = [0; 4];
    stream.read_exact(&mut length).map_err(gateway_io)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_GATEWAY_BYTES {
        return Err(AppError::code(
            "settings.gatewayMessageTooLarge",
            serde_json::json!({}),
        ));
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).map_err(gateway_io)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_frame(stream: &mut impl Write, value: &impl Serialize) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.is_empty() || bytes.len() > MAX_GATEWAY_BYTES {
        return Err(AppError::code(
            "settings.gatewayMessageTooLarge",
            serde_json::json!({}),
        ));
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(gateway_io)?;
    stream.write_all(&bytes).map_err(gateway_io)?;
    Ok(())
}

fn gateway_request(config: &Path, payload: GatewayOperation) -> Result<GatewayValue, AppError> {
    let endpoint = read_endpoint(&config.join(ENDPOINT_FILE))?;
    // Endpoint files can never direct a request off this machine.
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port).into();
    let mut stream = TcpStream::connect_timeout(&address, SOCKET_TIMEOUT).map_err(gateway_io)?;
    let timeout = if matches!(&payload, GatewayOperation::Focus {}) {
        SOCKET_TIMEOUT
    } else {
        TRANSACTION_TIMEOUT
    };
    let mut stream = TimedStream {
        stream: &mut stream,
        deadline: Instant::now() + timeout,
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = GatewayRequest {
        protocol: GATEWAY_PROTOCOL,
        token: endpoint.token,
        request_id: request_id.clone(),
        payload,
    };
    let uncertain = |error: AppError| {
        AppError::code(
            "settings.transactionUncertain",
            serde_json::json!({ "error": error }),
        )
    };
    // There is exactly one send. No disconnect, timeout or response failure falls
    // back to a second writer or a replay with the same request.
    write_frame(&mut stream, &request).map_err(uncertain)?;
    let response: GatewayResponse = read_frame(&mut stream).map_err(uncertain)?;
    if response.protocol != GATEWAY_PROTOCOL || response.request_id != request_id {
        return Err(AppError::code(
            "settings.responseInvalid",
            serde_json::json!({}),
        ));
    }
    response.result
}

fn focus_existing(config: &Path) -> Result<(), AppError> {
    match gateway_request(config, GatewayOperation::Focus {})? {
        GatewayValue::Focused {} => Ok(()),
        _ => Err(AppError::code(
            "settings.responseInvalid",
            serde_json::json!({}),
        )),
    }
}

pub(crate) fn replace_swatches_via_gateway(
    config: &Path,
    expected_revision: String,
    swatches: Vec<devcel_core::ColorSwatch>,
) -> Result<crate::settings_transactions::UserColorSwatches, AppError> {
    match gateway_request(
        config,
        GatewayOperation::ReplaceUserSwatches {
            expected_revision,
            swatches,
        },
    )? {
        GatewayValue::UserSwatches(saved) => Ok(saved),
        _ => Err(AppError::code(
            "settings.responseInvalid",
            serde_json::json!({}),
        )),
    }
}

fn serve_gateway(
    app: tauri::AppHandle,
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    token: String,
) {
    while !stop.load(Ordering::Acquire) {
        let (mut stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(error) => {
                eprintln!("Settings editor gateway failed: {error}");
                break;
            }
        };
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        let request: GatewayRequest = match read_frame(&mut TimedStream {
            stream: &mut stream,
            deadline: Instant::now() + Duration::from_secs(3),
        }) {
            Ok(request) => request,
            Err(_) => continue,
        };
        if !request_is_authorized(&request, &token) || stop.load(Ordering::Acquire) {
            continue;
        }
        let result = match request.payload {
            GatewayOperation::Focus {} => app
                .get_webview_window("main")
                .ok_or_else(|| AppError::code("settings.editorClosing", serde_json::json!({})))
                .and_then(|window| {
                    window
                        .show()
                        .and_then(|_| window.unminimize())
                        .and_then(|_| window.set_focus())
                        .map_err(AppError::technical)
                })
                .map(|_| GatewayValue::Focused {}),
            GatewayOperation::ReplaceUserSwatches {
                expected_revision,
                swatches,
            } => crate::settings_transactions::submit_in_editor(&app, expected_revision, swatches)
                .map(GatewayValue::UserSwatches),
        };
        let response = GatewayResponse {
            protocol: GATEWAY_PROTOCOL,
            request_id: request.request_id,
            result,
        };
        // A disconnected requester does not cancel or replay an admitted commit.
        if let Err(error) = write_frame(
            &mut TimedStream {
                stream: &mut stream,
                deadline: Instant::now() + TRANSACTION_TIMEOUT,
            },
            &response,
        ) {
            eprintln!("Settings gateway response failed: {error}");
        }
    }
}

pub(crate) fn editor_generation(app: &tauri::AppHandle) -> Result<String, AppError> {
    let runtime = app
        .try_state::<EditorRuntime>()
        .ok_or_else(|| AppError::code("settings.editorNotReady", serde_json::json!({})))?;
    if runtime.stop.load(Ordering::Acquire) {
        return Err(AppError::code(
            "settings.editorClosing",
            serde_json::json!({}),
        ));
    }
    Ok(runtime._lease.generation.clone())
}

pub(crate) fn transaction_launch_lock(config: &Path) -> Result<File, AppError> {
    std::fs::create_dir_all(config)?;
    let lock = open_launch_lock(config)?;
    lock.try_lock()
        .map_err(|_| AppError::code("settings.editorBusy", serde_json::json!({})))?;
    Ok(lock)
}

/// Called in setup before any frontend can access the fixed ProjectState.
/// False means a manually launched second editor focused the existing owner.
pub(crate) fn initialize_editor(app: &tauri::AppHandle) -> Result<bool, AppError> {
    if !app.state::<ApplicationMode>().is_settings_editor() {
        return Ok(true);
    }
    let config = crate::settings_profile::directory(app)?;
    let lease = match app_settings_store::acquire_editor(&config) {
        Ok(lease) => lease,
        Err(error) => {
            if focus_existing(&config).is_ok() {
                app.exit(0);
                return Ok(false);
            }
            return Err(error);
        }
    };
    if std::fs::symlink_metadata(
        lease.project_path.parent().ok_or_else(|| {
            AppError::code("settings.stateDirectoryMissing", serde_json::json!({}))
        })?,
    )?
    .file_type()
    .is_symlink()
    {
        return Err(AppError::code(
            "settings.sourceSymlink",
            serde_json::json!({}),
        ));
    }
    let project_root = lease
        .project_path
        .parent()
        .ok_or_else(|| AppError::code("settings.stateDirectoryMissing", serde_json::json!({})))?
        .canonicalize()?;
    reject_symlinks(&project_root)?;
    let project = devcel_core::Project::open_project(&lease.project_path.to_string_lossy())?;
    let state = app.state::<ProjectState>();
    state.set_project_sync(Some(project))?;
    if let Some(queue) = &state.save_queue {
        let handle = app.clone();
        let generation = lease.generation.clone();
        queue.set_save_listener(Some(Arc::new(move |_| {
            // Notification only: never compile/re-lock ProjectState on its save stack.
            crate::app_settings::source_saved(&handle, &generation);
        })));
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let endpoint = Endpoint {
        protocol: GATEWAY_PROTOCOL,
        port: listener.local_addr()?.port(),
        token: uuid::Uuid::new_v4().to_string(),
    };
    let stop = Arc::new(AtomicBool::new(false));
    let runtime = EditorRuntime {
        _lease: lease,
        project_root,
        stop: stop.clone(),
        endpoint: config.join(ENDPOINT_FILE),
        token: endpoint.token.clone(),
    };
    let handle = app.clone();
    let token = endpoint.token.clone();
    std::thread::Builder::new()
        .name("devcel-settings-gateway".into())
        .spawn(move || serve_gateway(handle, listener, stop, token))?;
    app.manage(runtime);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::code("settings.editorWindowMissing", serde_json::json!({})))?;
    window.show().map_err(AppError::technical)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&config)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(&serde_json::to_vec(&endpoint)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(config.join(ENDPOINT_FILE))
        .map_err(AppError::technical)?;
    Ok(true)
}

pub(crate) fn shutdown(app: &tauri::AppHandle) {
    if let Some(runtime) = app.try_state::<EditorRuntime>() {
        runtime.stop();
        if let Some(queue) = &app.state::<ProjectState>().save_queue {
            queue.set_save_listener(None);
        }
    }
}

#[tauri::command]
pub(crate) async fn open_settings_editor(app: tauri::AppHandle) -> Result<(), AppError> {
    if app.state::<ApplicationMode>().is_settings_editor() {
        return Err(AppError::code(
            "settings.editorAlreadyOpen",
            serde_json::json!({}),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || launch_editor(&app))
        .await
        .map_err(AppError::technical)?
}

fn launch_editor(app: &tauri::AppHandle) -> Result<(), AppError> {
    let config = crate::settings_profile::directory(app)?;
    std::fs::create_dir_all(&config)?;
    if focus_existing(&config).is_ok() {
        return Ok(());
    }
    // Serialize launches across normal Studio processes, not merely menu clicks.
    let launch_lock = open_launch_lock(&config)?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        match launch_lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                if focus_existing(&config).is_ok() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(AppError::code(
                    "settings.editorLaunchBusy",
                    serde_json::json!({ "error": AppError::technical(error) }),
                ))
            }
        }
    }
    if focus_existing(&config).is_ok() {
        return Ok(());
    }
    // An update lease blocks creation of the executable process itself, not only
    // its eventual project open. Updaters acquire launch_lock before this lock.
    drop(
        app_settings_store::acquire_update_lock(&config).map_err(|error| {
            if !config.join("profile.json").is_file() {
                eprintln!("Settings editor initialization failed: {error}");
                AppError::code("settings.migrationFailed", serde_json::json!({}))
            } else {
                error
            }
        })?,
    );
    let mut child = std::process::Command::new(std::env::current_exe()?)
        .arg("--settings-editor")
        .env(
            crate::locale_settings::PARENT_SYSTEM_LANGUAGES_ENV,
            crate::locale_settings::languages_for_child(),
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .spawn()?;
    let startup_deadline = Instant::now() + START_TIMEOUT;
    let result = loop {
        if focus_existing(&config).is_ok() {
            break Ok(());
        }
        if let Some(status) = child.try_wait()? {
            break Err(AppError::code(
                "settings.editorExited",
                serde_json::json!({ "details": status.to_string() }),
            ));
        }
        if Instant::now() >= startup_deadline {
            break Err(AppError::code(
                "settings.editorStartupTimeout",
                serde_json::json!({}),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    // Do not kill an editor/draft on a parent timeout or when its parent exits.
    // Reap the process when it eventually closes instead of leaving a zombie.
    let _ = std::thread::Builder::new()
        .name("devcel-settings-child".into())
        .spawn(move || {
            let _ = child.wait();
        });
    result
}

fn reject_symlinks(directory: &Path) -> Result<(), AppError> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(AppError::code(
                "settings.sourceSymlink",
                serde_json::json!({}),
            ));
        }
        if kind.is_dir() {
            reject_symlinks(&entry.path())?;
        }
    }
    Ok(())
}

/// Resolve existing ancestors too, so a missing child of a symlink cannot escape.
fn canonical_candidate(path: &Path) -> Result<PathBuf, AppError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    // Canonicalize before normalizing: a symlink followed by `..` has filesystem
    // semantics that differ from lexical path collapse.
    let mut existing = absolute.as_path();
    let mut missing = Vec::new();
    while !existing.try_exists()? {
        missing.push(
            existing
                .file_name()
                .ok_or_else(|| AppError::code("settings.sourceFileInvalid", serde_json::json!({})))?
                .to_os_string(),
        );
        existing = existing
            .parent()
            .ok_or_else(|| AppError::code("settings.sourceFileInvalid", serde_json::json!({})))?;
    }
    let mut resolved = existing.canonicalize()?;
    for part in missing.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

pub(crate) fn reject_reserved_project_path(
    app: &tauri::AppHandle,
    path: &Path,
) -> Result<(), AppError> {
    let config = crate::settings_profile::directory(app)?;
    let root =
        canonical_candidate(config.parent().ok_or_else(|| {
            AppError::code("settings.stateDirectoryMissing", serde_json::json!({}))
        })?)?;
    if canonical_candidate(path)?.starts_with(root) {
        return Err(AppError::code(
            "settings.openViaOptions",
            serde_json::json!({}),
        ));
    }
    Ok(())
}

fn check_editor_path(root: &Path, path: &str) -> Result<(), AppError> {
    // Relative project-entry paths are always relative to Tables in Devcel core.
    let path = Path::new(path);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join("Tables").join(path)
    };
    let tables = root.join("Tables").canonicalize()?;
    if !canonical_candidate(&candidate)?.starts_with(&tables) {
        return Err(AppError::code(
            "settings.editorPathRestricted",
            serde_json::json!({}),
        ));
    }
    Ok(())
}

fn check_payload_paths(root: &Path, value: &serde_json::Value) -> Result<(), AppError> {
    match value {
        serde_json::Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "path"
                        | "filePath"
                        | "file_path"
                        | "oldPath"
                        | "old_path"
                        | "newPath"
                        | "new_path"
                        | "sourcePath"
                        | "source_path"
                        | "destPath"
                        | "dest_path"
                ) {
                    if let Some(path) = value.as_str() {
                        check_editor_path(root, path)?;
                    }
                } else if key == "paths" {
                    if let Some(paths) = value.as_array() {
                        for path in paths {
                            if let Some(path) = path.as_str() {
                                check_editor_path(root, path)?;
                            }
                        }
                    }
                }
                check_payload_paths(root, value)?;
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                check_payload_paths(root, value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Runs on the command worker before deserialization or any project mutation.
/// App commands default to denied in this mode; adding a command needs an explicit audit.
pub(crate) fn guard_invocation<R: tauri::Runtime>(
    message: &tauri::ipc::InvokeMessage<R>,
) -> Result<(), AppError> {
    let view = message.webview_ref();
    if !view.state::<ApplicationMode>().is_settings_editor() {
        return Ok(());
    }
    let command = message.command();
    if !editor_command_allowed(command) {
        return Err(AppError::code(
            "settings.editorCommandUnavailable",
            serde_json::json!({ "command": command }),
        ));
    }
    if command == "get_application_mode" {
        return Ok(());
    }
    let runtime = view
        .try_state::<EditorRuntime>()
        .ok_or_else(|| AppError::code("settings.editorNotReady", serde_json::json!({})))?;
    // Source discovery must not walk an externally added link outside this project.
    if !matches!(
        command,
        "get_app_settings"
            | "preview_color"
            | "get_user_color_swatches"
            | "set_user_color_swatches"
            | "apply_color_swatch"
    ) {
        reject_symlinks(&runtime.project_root)?;
    }
    let tauri::ipc::InvokeBody::Json(payload) = message.payload() else {
        return Err(AppError::code(
            "settings.editorJsonRequired",
            serde_json::json!({}),
        ));
    };
    if command == "open_in_explorer" {
        let project_path = payload
            .get("projectPath")
            .and_then(|value| value.as_str())
            .ok_or_else(|| AppError::code("settings.sourceFileInvalid", serde_json::json!({})))?;
        if canonical_candidate(Path::new(project_path))?
            != runtime._lease.project_path.canonicalize()?
        {
            return Err(AppError::code(
                "settings.editorRevealRestricted",
                serde_json::json!({}),
            ));
        }
    }
    if command == "file_operation" {
        if let Some(name) = payload
            .get("operation")
            .and_then(|operation| operation.get("new_name"))
            .and_then(|name| name.as_str())
        {
            if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
                return Err(AppError::code(
                    "settings.entryNameInvalid",
                    serde_json::json!({}),
                ));
            }
        }
    }
    check_payload_paths(&runtime.project_root, payload)
}

fn editor_command_allowed(command: &str) -> bool {
    matches!(
        command,
        "get_application_mode"
            | "get_user_color_swatches"
            | "set_user_color_swatches"
            | "apply_color_swatch"
            | "open_in_explorer"
            | "get_app_settings"
            | "preview_color"
            | "has_project"
            | "get_project_name"
            | "get_project_description"
            | "get_project_path"
            | "get_project_session"
            | "get_project_header_color"
            | "save_project"
            | "file_operation"
            | "duplicate_project_entry"
            | "initialize_empty_table"
            | "reload_table"
            | "get_table_history_status"
            | "undo_command"
            | "redo_command"
            | "clear_table_undo_redo_stacks"
            | "get_loaded_tables"
            | "get_table_data_range"
            | "get_table_path_by_uuid"
            | "get_table_data_by_uuids"
            | "check_and_apply_interface_updates"
            | "add_column"
            | "insert_column"
            | "remove_column"
            | "rename_column"
            | "move_column"
            | "prepare_table_rule_snapshot"
            | "cancel_table_rule_snapshot"
            | "get_table_rule_snapshot"
            | "get_table_presentation"
            | "new_formatting_rule"
            | "prepare_record_draft"
            | "create_column_type_session"
            | "get_column_type_session"
            | "resolve_column_type_session"
            | "take_column_type_result"
            | "create_bulk_row_session"
            | "get_bulk_row_session"
            | "resolve_bulk_row_session"
            | "take_bulk_row_result"
            | "apply_table_mutation"
            | "update_table_edit_settings"
            | "update_record_metadata"
            | "update_record_inheritance"
            | "set_column_read_only"
            | "create_table_dialog_session"
            | "get_table_dialog_session"
            | "resolve_table_dialog_session"
            | "take_table_dialog_result"
            | "load_column_editor"
            | "preview_column_editor"
            | "save_column_editor"
            | "set_column_tooltip"
            | "set_column_memo_text"
            | "set_column_default_value"
            | "rename_table_display_name"
            | "rename_table_data_name"
            | "add_record"
            | "insert_record"
            | "delete_record"
            | "set_record_value"
            | "set_cell_formula"
            | "set_record_label"
            | "set_record_memo_text"
            | "set_record_min_version"
            | "set_record_parent_uuid"
            | "add_record_tag"
            | "remove_record_tag"
            | "set_column_color"
            | "get_project_entries"
            | "get_table_list"
            | "get_table_catalog"
            | "get_table_display_catalog"
            | "load_table"
            | "load_tables_batch"
            | "get_table_data"
            | "get_formula_completion_schema"
            | "get_table_data_batch"
            | "search_table_data"
            | "validate_data_name_command"
            | "validate_file_name_command"
            | "set_column_reference_config_command"
            | "set_column_table_ref_config_command"
            | "set_column_curve_config_command"
            | "set_column_select_config_command"
            | "configure_interface_column_command"
            | "get_tables_for_interface"
            | "remove_column_reference_config_command"
            | "get_reference_options_command"
            | "check_reference_integrity_command"
            | "read_markdown_file"
            | "write_markdown_file"
            | "move_markdown_file"
            | "list_interfaces"
            | "get_interface_details"
            | "apply_interface_to_table"
            | "update_interface"
            | "sync_table_with_interface"
            | "validate_interface_implementation"
            | "get_table_interfaces"
            | "get_interface_columns_for_table"
            | "get_interfaces"
            | "remove_interface_from_table"
            | "add_interface_column"
            | "undo_interface_command"
            | "redo_interface_command"
            | "remove_interface_column"
            | "import_interface_history"
            | "preview_interface_removal_impact"
            | "check_interface_name_collisions"
            | "find_duplicate_interface_copies"
    )
}

/// A webview-owned resource releases the editor lock on explicit close or process exit.
struct SettingsUpdateLease {
    _lock: File,
}
impl tauri::Resource for SettingsUpdateLease {}

/// The updater holds this resource across installation/restart. It shares the
/// editor's writer lock and also fences the launch-to-ready startup interval.
#[tauri::command]
pub(crate) fn acquire_settings_update_lease(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<tauri::ResourceId, AppError> {
    if app.state::<ApplicationMode>().is_settings_editor() || webview.label() != "app-updater" {
        return Err(AppError::code(
            "settings.updateWindowOnly",
            serde_json::json!({}),
        ));
    }
    let config = crate::settings_profile::directory(&app)?;
    std::fs::create_dir_all(&config)?;
    let launch_lock = open_launch_lock(&config)?;
    launch_lock
        .try_lock()
        .map_err(|_| AppError::code("settings.editorStartingForUpdate", serde_json::json!({})))?;
    let lock = app_settings_store::acquire_update_lock(&config)?;
    Ok(webview
        .resources_table()
        .add(SettingsUpdateLease { _lock: lock }))
}

fn open_launch_lock(config: &Path) -> Result<File, AppError> {
    Ok(std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config.join("settings-editor.launch.lock"))?)
}
