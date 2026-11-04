//! Keep app commands off the native IPC callback without changing their ordering.
//!
//! One dedicated (non-Tokio) thread runs the existing generated handler, including
//! its argument/ACL handling and response serialization. Synchronous commands keep
//! their project lock, validation, disk commit and status contracts. Existing async
//! commands still delegate to Tauri's runtime; their future lifetime is unchanged.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc, Mutex};

const MAX_PENDING_COMMANDS: usize = 128;
type JobBody = Box<dyn FnOnce() + Send + 'static>;

#[derive(Default)]
struct Progress {
    pending: usize,
    closing: bool,
    after_drain: Option<JobBody>,
}

struct Completion(Arc<Mutex<Progress>>);

impl Drop for Completion {
    fn drop(&mut self) {
        let after_drain = {
            let mut progress = self.0.lock().unwrap_or_else(|e| e.into_inner());
            progress.pending -= 1;
            if progress.pending == 0 {
                progress.after_drain.take()
            } else {
                None
            }
        };
        if let Some(after_drain) = after_drain {
            after_drain();
        }
    }
}

struct Job {
    body: JobBody,
    // Dropped only after the synchronous handler has returned/responded, even if
    // its caller's webview disappeared or the handler panicked.
    completion: Completion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchError {
    Full,
    Closing,
    Disconnected,
}

impl DispatchError {
    fn error(self) -> crate::AppError {
        let (code, details) = match self {
            Self::Full => (
                "error.commandQueueFull",
                "Too many operations are pending. Wait for them to finish, then try again.",
            ),
            Self::Closing => (
                "error.applicationClosing",
                "The app is closing. Please wait for pending saves to finish.",
            ),
            Self::Disconnected => (
                "error.commandWorkerUnavailable",
                "Operations are unavailable. Restart the app, then try again.",
            ),
        };
        crate::AppError::code(code, serde_json::json!({ "details": details }))
    }
}

#[derive(Clone)]
pub(crate) struct CommandDispatcher {
    sender: mpsc::SyncSender<Job>,
    progress: Arc<Mutex<Progress>>,
}

impl CommandDispatcher {
    pub(crate) fn new() -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Job>(MAX_PENDING_COMMANDS);
        std::thread::Builder::new()
            .name("devcel-command-dispatch".into())
            .spawn(move || {
                while let Ok(Job { body, completion }) = receiver.recv() {
                    // An individual command must not kill the lane or discard the
                    // remaining accepted commands. The adapter rejects its panic.
                    if catch_unwind(AssertUnwindSafe(body)).is_err() {
                        eprintln!("Command responder panicked");
                    }
                    drop(completion);
                }
            })?;
        Ok(Self {
            sender,
            progress: Arc::new(Mutex::new(Progress::default())),
        })
    }

    fn dispatch(&self, body: impl FnOnce() + Send + 'static) -> Result<(), DispatchError> {
        {
            let mut progress = self.progress.lock().unwrap_or_else(|e| e.into_inner());
            if progress.closing {
                return Err(DispatchError::Closing);
            }
            // Bound the running command plus all accepted queued commands. No
            // callback ever waits for queue space, a project lock, or disk IO.
            if progress.pending >= MAX_PENDING_COMMANDS {
                return Err(DispatchError::Full);
            }
            progress.pending += 1;
        }
        let job = Job {
            body: Box::new(body),
            completion: Completion(self.progress.clone()),
        };
        self.sender.try_send(job).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => DispatchError::Full,
            mpsc::TrySendError::Disconnected(_) => DispatchError::Disconnected,
        })
    }

    /// First-party typed gateway jobs share ordering and shutdown drain with IPC.
    /// This is Rust-only admission, never an externally supplied command name.
    pub(crate) fn submit_native<T: Send + 'static>(
        &self,
        body: impl FnOnce() -> Result<T, crate::AppError> + Send + 'static,
    ) -> Result<T, crate::AppError> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.dispatch(move || {
            let result = catch_unwind(AssertUnwindSafe(body)).unwrap_or_else(|_| {
                Err(crate::AppError::code(
                    "settings.transactionInterrupted",
                    serde_json::json!({}),
                ))
            });
            let _ = sender.send(result);
        })
        .map_err(DispatchError::error)?;
        receiver.recv().map_err(|_| {
            crate::AppError::code("settings.transactionInterrupted", serde_json::json!({}))
        })?
    }

    /// This one bounded control command only signals a request-local AtomicBool.
    /// It must remain reachable when a queued mutation is waiting for the formula
    /// worker's project guard. The original generated handler still checks the
    /// Invoke's ACL, window and argument identities; no read/write bypasses the lane.
    fn dispatch_command(
        &self,
        command: &str,
        body: impl FnOnce() + Send + 'static,
    ) -> Result<(), DispatchError> {
        if command == "cancel_table_rule_snapshot" {
            body();
            Ok(())
        } else {
            self.dispatch(body)
        }
    }

    /// True means prevent this exit request. New work is rejected while every
    /// accepted synchronous command finishes, then the caller can request exit
    /// again. This deliberately does not intercept Window CloseRequested or
    /// override the frontend's unsaved-changes/Cancel decisions.
    pub(crate) fn defer_exit(&self, after_drain: impl FnOnce() + Send + 'static) -> bool {
        let mut progress = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        // Close admission even when already idle: a concurrent IPC must not be
        // accepted between this check and the event loop's actual termination.
        progress.closing = true;
        if progress.pending == 0 {
            return false;
        }
        if progress.after_drain.is_none() {
            progress.after_drain = Some(Box::new(after_drain));
        }
        true
    }

    pub(crate) fn handler<R, F>(
        &self,
        handler: F,
    ) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
    where
        R: tauri::Runtime,
        F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
    {
        let dispatcher = self.clone();
        let handler = Arc::new(handler);
        move |invoke| {
            let command = invoke.message.command().to_owned();
            let resolver = invoke.resolver.clone();
            let failure_resolver = resolver.clone();
            let handler = handler.clone();
            let dispatch_command = command.clone();
            if let Err(error) = dispatcher.dispatch_command(&dispatch_command, move || {
                if let Err(error) = crate::settings_mode::guard_invocation(&invoke.message) {
                    failure_resolver.reject(error);
                    return;
                }
                // Move the original Invoke, including its resolved ACL and window
                // identity, intact. Tauri has already checked its invoke key/ACL.
                run_handler(
                    &command,
                    || handler(invoke),
                    |error| failure_resolver.reject(error),
                );
            }) {
                resolver.reject(error.error());
            }
            // We now own the response, including unknown/full/disconnected cases.
            true
        }
    }
}

fn run_handler(
    command: &str,
    handler: impl FnOnce() -> bool,
    reject: impl FnOnce(crate::AppError),
) {
    match catch_unwind(AssertUnwindSafe(handler)) {
        Ok(true) => {}
        Ok(false) => reject(crate::AppError::code(
            "error.commandNotFound",
            serde_json::json!({"command": command}),
        )),
        // A handler may panic after writing. Preserve an unknown outcome rather
        // than promising that the operation failed or is safe to replay.
        Err(_) => reject(crate::AppError::code(
            "error.commandInterrupted",
            serde_json::json!({"command": command}),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::run_handler;
    use crate::AppError;
    use std::cell::Cell;

    #[test]
    fn unknown_command_keeps_literal_name_in_a_semantic_error() {
        let name = "未登録 {literal}";
        let rejected = Cell::new(false);
        run_handler(
            name,
            || false,
            |error| {
                rejected.set(true);
                match error {
                    AppError::Code { code, params } => {
                        assert_eq!(code, "error.commandNotFound");
                        assert_eq!(params["command"], name);
                    }
                    other => panic!("expected typed command error, got {other:?}"),
                }
            },
        );
        assert!(rejected.get());
    }

    #[test]
    fn panicked_handler_rejects_once_without_replaying_or_claiming_no_commit() {
        let calls = Cell::new(0);
        let rejected = Cell::new(0);
        run_handler(
            "save_project",
            || {
                calls.set(calls.get() + 1);
                panic!("injected failure after a possible commit");
            },
            |error| {
                rejected.set(rejected.get() + 1);
                match error {
                    AppError::Code { code, params } => {
                        assert_eq!(code, "error.commandInterrupted");
                        assert_eq!(params["command"], "save_project");
                    }
                    other => panic!("expected typed interruption, got {other:?}"),
                }
            },
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(rejected.get(), 1);
    }

    #[test]
    fn successful_handler_does_not_reject() {
        run_handler("read_project", || true, |_| panic!("unexpected rejection"));
    }
}
