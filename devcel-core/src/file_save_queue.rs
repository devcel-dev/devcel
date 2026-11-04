use crate::SavePriority;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;
use tokio::sync::{mpsc, Mutex};

/// Global listener called after a successful save, receiving the saved file path
pub type SaveListener = Arc<dyn Fn(&Path) + Send + Sync>;

/// Trait for types that can be saved to a file
pub trait SaveableFile: Send + Sync + 'static {
    /// Save to a file
    fn save_to_file(&self, path: &Path) -> crate::Result<()>;

    /// Whether this file has changed
    fn is_dirty(&self) -> bool;

    /// Post-save processing, such as clearing the dirty flag
    fn post_save(&self, path: &Path);
}

/// Save request
struct SaveRequest {
    content: Box<dyn SaveableFile>,
    timestamp: Instant,
    #[allow(dead_code)]
    priority: SavePriority,
    /// Callback for a successful save
    on_success: Option<Box<dyn FnOnce() + Send + 'static>>,
}

/// Per-file save queue
struct FileSaveQueue {
    tx: mpsc::Sender<SaveCommand>,
    handle: tokio::task::JoinHandle<()>,
}

/// Save command
enum SaveCommand {
    Execute(SaveRequest),
    Shutdown,
}

/// Per-file save queue manager
pub struct FileBasedSaveQueueManager {
    /// Save queues keyed by file path
    file_queues: Arc<Mutex<HashMap<PathBuf, FileSaveQueue>>>,
    /// Runtime handle
    runtime: tokio::runtime::Handle,
    /// Global listener for successful saves, used for P2P synchronization notifications, etc.
    save_listener: Arc<StdMutex<Option<SaveListener>>>,
    /// Serialize direct saves and queued writes, and identify stale snapshots.
    direct_saves: Arc<StdMutex<HashMap<PathBuf, Instant>>>,
}

impl FileBasedSaveQueueManager {
    /// Create a per-file save queue manager
    pub fn new(runtime: tokio::runtime::Handle) -> Self {
        Self {
            file_queues: Arc::new(Mutex::new(HashMap::new())),
            runtime,
            save_listener: Arc::new(StdMutex::new(None)),
            direct_saves: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Set the global listener for successful saves
    /// Called after the file is written to disk, when it is safe
    /// for other processes to reread that file
    pub fn set_save_listener(&self, listener: Option<SaveListener>) {
        *self.save_listener.lock().unwrap() = listener;
    }

    /// Serialize direct saves with queued writes.
    /// Do not subsequently write pending snapshots older than a successfully saved file;
    /// notify existing listeners after the write completes.
    /// The closure must return its save result and only paths that were successfully saved.
    pub fn save_directly<E>(
        &self,
        save: impl FnOnce() -> (Result<(), E>, Vec<PathBuf>),
    ) -> Result<(), E> {
        self.save_directly_fenced(|| {
            let (result, paths) = save();
            (result, paths.clone(), paths)
        })
    }

    /// Fence stale snapshots independently from successful-save notifications.
    /// A failed tag rollback must retire queued writes without announcing success.
    pub(crate) fn save_directly_fenced<E>(
        &self,
        save: impl FnOnce() -> (Result<(), E>, Vec<PathBuf>, Vec<PathBuf>),
    ) -> Result<(), E> {
        let mut direct_saves = self.direct_saves.lock().unwrap();
        let started_at = Instant::now();
        let (result, invalidated_paths, notify_paths) = save();
        let cutoff = if result.is_err() {
            Instant::now()
        } else {
            started_at
        };
        for path in &invalidated_paths {
            direct_saves.insert(path.clone(), cutoff);
        }
        drop(direct_saves);
        for path in &notify_paths {
            Self::notify_save_listener(&self.save_listener, path);
        }
        result
    }

    /// Serialize a rename with queued writes. Retire old snapshots at both names
    /// so a delayed save cannot recreate the source or overwrite the destination.
    pub fn rename_directly<E>(
        &self,
        source: &Path,
        destination: &Path,
        rename: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        let mut direct_saves = self.direct_saves.lock().unwrap();
        let started_at = Instant::now();
        let result = rename();
        if result.is_ok() {
            direct_saves.insert(source.to_path_buf(), started_at);
            direct_saves.insert(destination.to_path_buf(), started_at);
        }
        drop(direct_saves);
        if result.is_ok() {
            Self::notify_save_listener(&self.save_listener, destination);
        }
        result
    }

    /// Check whether the specified file path has a pending save
    pub async fn has_pending_saves_for_path(&self, path: &Path) -> bool {
        let queues = self.file_queues.lock().await;
        queues.contains_key(path)
    }

    /// Check whether the specified file path has a pending save (synchronous version)
    pub fn has_pending_saves_for_path_sync(&self, path: &Path) -> bool {
        // Use a different approach when already inside a runtime
        if tokio::runtime::Handle::try_current().is_ok() {
            // Already inside a runtime, so try locking directly
            if let Ok(queues) = self.file_queues.try_lock() {
                let has_pending = queues.contains_key(path);
                if has_pending {
                    eprintln!("has_pending_saves_for_path_sync - Path {path:?} has pending saves");
                }
                has_pending
            } else {
                // If the lock is unavailable, assume a save is in progress
                eprintln!(
                    "has_pending_saves_for_path_sync - Could not acquire lock for path {path:?}, assuming pending"
                );
                true
            }
        } else {
            // Call from outside the runtime
            self.runtime
                .block_on(async { self.has_pending_saves_for_path(path).await })
        }
    }

    /// Enqueue a file save
    pub async fn enqueue_file<T: SaveableFile>(
        &self,
        path: PathBuf,
        content: T,
        priority: SavePriority,
    ) {
        self.enqueue_file_with_callback::<T, fn()>(path, content, priority, None)
            .await;
    }

    /// Enqueue a file save with a success callback
    pub async fn enqueue_file_with_callback<T: SaveableFile, F>(
        &self,
        path: PathBuf,
        content: T,
        priority: SavePriority,
        on_success: Option<F>,
    ) where
        F: FnOnce() + Send + 'static,
    {
        let timestamp = Instant::now();
        let mut queues = self.file_queues.lock().await;

        // Create a queue for this file path if needed
        if !queues.contains_key(&path) {
            let (tx, rx) = mpsc::channel::<SaveCommand>(100);
            let queue_path = path.clone();
            let listener = self.save_listener.clone();
            let direct_saves = self.direct_saves.clone();

            // Start the file-specific save task
            let handle = self.runtime.spawn(async move {
                Self::file_save_task(queue_path, rx, listener, direct_saves).await;
            });

            queues.insert(path.clone(), FileSaveQueue { tx, handle });
        }

        // Send the save request
        if let Some(queue) = queues.get(&path) {
            let request = SaveRequest {
                content: Box::new(content),
                timestamp,
                priority,
                on_success: on_success.map(|f| Box::new(f) as Box<dyn FnOnce() + Send + 'static>),
            };

            let _ = queue.tx.send(SaveCommand::Execute(request)).await;
        }
    }

    /// Enqueue a file save (synchronous version)
    pub fn enqueue_file_sync<T: SaveableFile>(
        &self,
        path: PathBuf,
        content: T,
        priority: SavePriority,
    ) {
        self.enqueue_file_sync_with_callback(path, content, priority, None::<fn()>);
    }

    /// Enqueue a file save (synchronous version with a success callback)
    pub fn enqueue_file_sync_with_callback<T: SaveableFile, F>(
        &self,
        path: PathBuf,
        content: T,
        priority: SavePriority,
        on_success: Option<F>,
    ) where
        F: FnOnce() + Send + 'static,
    {
        // Preserve the pre-spawn registration time to detect stale tasks that start after a direct save.
        let timestamp = Instant::now();
        let queues = self.file_queues.clone();
        let runtime = self.runtime.clone();
        let listener = self.save_listener.clone();
        let direct_saves = self.direct_saves.clone();

        let runtime_clone = runtime.clone();
        runtime.spawn(async move {
            let mut queues = queues.lock().await;

            // Create a queue for this file path if needed
            if !queues.contains_key(&path) {
                let (tx, rx) = mpsc::channel::<SaveCommand>(100);
                let queue_path = path.clone();
                let listener = listener.clone();
                let direct_saves = direct_saves.clone();

                // Start the file-specific save task
                let handle = runtime_clone.spawn(async move {
                    Self::file_save_task(queue_path, rx, listener, direct_saves).await;
                });

                queues.insert(path.clone(), FileSaveQueue { tx, handle });
            }

            // Send the save request
            if let Some(queue) = queues.get(&path) {
                let request = SaveRequest {
                    content: Box::new(content),
                    timestamp,
                    priority,
                    on_success: on_success
                        .map(|f| Box::new(f) as Box<dyn FnOnce() + Send + 'static>),
                };

                let _ = queue.tx.send(SaveCommand::Execute(request)).await;
            }
        });
    }

    /// Call the global listener after a successful save
    fn notify_save_listener(listener: &Arc<StdMutex<Option<SaveListener>>>, path: &Path) {
        let listener = listener.lock().unwrap().clone();
        if let Some(listener) = listener {
            listener(path);
        }
    }

    /// Do not overwrite a newer direct save with an older queued snapshot.
    fn save_request(
        path: &Path,
        request: &SaveRequest,
        direct_saves: &StdMutex<HashMap<PathBuf, Instant>>,
    ) -> crate::Result<bool> {
        let direct_saves = direct_saves.lock().unwrap();
        if direct_saves
            .get(path)
            .is_some_and(|saved_at| request.timestamp <= *saved_at)
        {
            return Ok(false);
        }
        request.content.save_to_file(path)?;
        Ok(true)
    }

    /// File-specific save task
    async fn file_save_task(
        path: PathBuf,
        mut rx: mpsc::Receiver<SaveCommand>,
        save_listener: Arc<StdMutex<Option<SaveListener>>>,
        direct_saves: Arc<StdMutex<HashMap<PathBuf, Instant>>>,
    ) {
        let mut _is_saving = false;
        let mut pending_request: Option<SaveRequest> = None;

        loop {
            match rx.recv().await {
                Some(SaveCommand::Execute(request)) => {
                    if _is_saving {
                        // While saving, retain only the latest request, replacing any older one
                        pending_request = Some(request);
                    } else {
                        // Run immediately if no save is in progress
                        _is_saving = true;

                        // Perform the save
                        match Self::save_request(&path, &request, &direct_saves) {
                            Ok(false) => {}
                            Ok(true) => {
                                // Run post-save processing on success
                                request.content.post_save(&path);
                                // Run the callback, if present
                                if let Some(callback) = request.on_success {
                                    callback();
                                }
                                Self::notify_save_listener(&save_listener, &path);
                            }
                            Err(e) => {
                                eprintln!("[FileSaveQueue] {} - Save error: {}", path.display(), e)
                            }
                        }

                        _is_saving = false;

                        // Process any new request received while saving
                        if let Some(pending) = pending_request.take() {
                            _is_saving = true;

                            match Self::save_request(&path, &pending, &direct_saves) {
                                Ok(false) => {}
                                Ok(true) => {
                                    // Run post-save processing on success
                                    pending.content.post_save(&path);
                                    // Run the callback, if present
                                    if let Some(callback) = pending.on_success {
                                        callback();
                                    }
                                    Self::notify_save_listener(&save_listener, &path);
                                }
                                Err(e) => eprintln!(
                                    "[FileSaveQueue] {} - Pending save error: {}",
                                    path.display(),
                                    e
                                ),
                            }

                            _is_saving = false;
                        }
                    }
                }
                Some(SaveCommand::Shutdown) => {
                    // Perform the final save
                    if let Some(pending) = pending_request.take() {
                        let _ = Self::save_request(&path, &pending, &direct_saves);
                    }
                    break;
                }
                None => {
                    break;
                }
            }
        }
    }

    /// Shut down the queue for a specific file
    pub async fn shutdown_file(&self, path: &PathBuf) {
        let mut queues = self.file_queues.lock().await;
        if let Some(queue) = queues.remove(path) {
            let _ = queue.tx.send(SaveCommand::Shutdown).await;
            // Wait for the task to finish
            let _ = queue.handle.await;
        }
    }

    /// Shut down all queues
    pub async fn shutdown_all(&self) {
        let mut queues = self.file_queues.lock().await;
        let all_queues: Vec<(PathBuf, FileSaveQueue)> = queues.drain().collect();

        // Send the shutdown command to every queue
        for (_path, queue) in all_queues {
            let _ = queue.tx.send(SaveCommand::Shutdown).await;
            let _ = queue.handle.await;
        }
    }

    /// Get the number of active queues (for debugging)
    pub async fn active_queue_count(&self) -> usize {
        self.file_queues.lock().await.len()
    }
}

impl Default for FileBasedSaveQueueManager {
    fn default() -> Self {
        Self::new(tokio::runtime::Handle::current())
    }
}

// SaveableFile implementation for tables
impl SaveableFile for crate::table::Table {
    fn save_to_file(&self, path: &Path) -> crate::Result<()> {
        use std::fs;

        let toml_string = crate::table_storage::to_toml(&self.data)?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::write(path, toml_string)?;

        Ok(())
    }

    fn is_dirty(&self) -> bool {
        self.is_dirty
    }

    fn post_save(&self, _path: &Path) {
        // Table dirty flags are managed within the project,
        // so nothing is needed here (handled by Project)
    }
}

// SaveableFile implementation for project files
impl SaveableFile for crate::project_impl::ProjectFileData {
    fn save_to_file(&self, path: &Path) -> crate::Result<()> {
        use std::fs;

        let toml_string = toml::to_string(self).map_err(|error| {
            crate::app_error::diagnostic(
                "error.parse",
                serde_json::json!({"details": error.to_string()}),
            )
        })?;

        fs::write(path, toml_string)?;

        Ok(())
    }

    fn is_dirty(&self) -> bool {
        // Always save project files (they have no dirty flag)
        true
    }

    fn post_save(&self, _path: &Path) {
        // No action needed because project files have no dirty flag
    }
}
