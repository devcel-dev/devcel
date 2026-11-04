//! Demand loading keeps disk parsing away from the project/UI locks. The project
//! lock is taken only for identity checks and atomic publication. No event or
//! caller callback is awaited while it is held.
use crate::{
    file_save_queue::FileBasedSaveQueueManager,
    table::{Table, TableData},
    AppError, Project,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

type ProjectRef = Arc<AsyncMutex<Option<Project>>>;
type LoadKey = (String, PathBuf);

pub struct TableLoadCoordinator {
    gates: Mutex<HashMap<LoadKey, Weak<AsyncMutex<()>>>>,
    io_slots: Arc<Semaphore>,
}

impl TableLoadCoordinator {
    pub fn new(max_parallel: usize) -> Self {
        Self {
            gates: Mutex::new(HashMap::new()),
            io_slots: Arc::new(Semaphore::new(max_parallel.max(1))),
        }
    }

    pub async fn ensure_loaded(
        &self,
        project_ref: ProjectRef,
        queue: Option<Arc<FileBasedSaveQueueManager>>,
        path: PathBuf,
        expected_session: Option<String>,
    ) -> Result<(), AppError> {
        self.ensure_loaded_with_reader(project_ref, queue, path, expected_session, |path| {
            let text = std::fs::read_to_string(path).map_err(AppError::from)?;
            if text.trim().is_empty() {
                return Err(AppError::code("error.emptyTable", serde_json::json!({})));
            }
            let data = TableData::from_toml(&text).map_err(AppError::from)?;
            crate::table_file_revision::remember_parsed(&text, &data);
            Ok(data)
        })
        .await
    }

    async fn ensure_loaded_with_reader<F>(
        &self,
        project_ref: ProjectRef,
        queue: Option<Arc<FileBasedSaveQueueManager>>,
        path: PathBuf,
        expected_session: Option<String>,
        reader: F,
    ) -> Result<(), AppError>
    where
        F: FnOnce(PathBuf) -> Result<TableData, AppError> + Send + 'static,
    {
        let (session, path) = {
            let guard = project_ref.lock().await;
            let project = guard.as_ref().ok_or("no project open")?;
            if expected_session
                .as_deref()
                .is_some_and(|s| s != project.get_instance_id())
            {
                return Err("project session changed".into());
            }
            let raw_path = project.resolve_table_path(&path).map_err(AppError::from)?;
            let mut path = PathBuf::new();
            for component in raw_path.components() {
                match component {
                    std::path::Component::CurDir => {}
                    std::path::Component::ParentDir => {
                        path.pop();
                    }
                    other => path.push(other.as_os_str()),
                }
            }
            if project.tables_data.contains_key(&path) {
                return Ok(());
            }
            (project.get_instance_id().to_owned(), path)
        };
        let gate = {
            let mut gates = self
                .gates
                .lock()
                .map_err(|_| "table loader lock poisoned")?;
            gates.retain(|_, gate| gate.strong_count() > 0);
            let key = (session.clone(), path.clone());
            if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
                gate
            } else {
                if gates.len() >= 128 {
                    return Err("too many table loads; retry shortly".into());
                }
                let gate = Arc::new(AsyncMutex::new(()));
                gates.insert(key, Arc::downgrade(&gate));
                gate
            }
        };
        let slots = self.io_slots.clone();
        tokio::spawn(async move {
            let _flight = gate.lock_owned().await;
            let slot = slots
                .acquire_owned()
                .await
                .map_err(|_| "table loader stopped")?;
            {
                let guard = project_ref.lock().await;
                let project = guard.as_ref().ok_or("no project open")?;
                if project.get_instance_id() != session {
                    return Err("project session changed".into());
                }
                if project.tables_data.contains_key(&path) {
                    return Ok(());
                }
                if queue
                    .as_ref()
                    .is_some_and(|q| q.has_pending_saves_for_path_sync(&path))
                {
                    return Err("table save is still pending; retry after saving".into());
                }
            }
            let read_path = path.clone();
            // Keep the slot with the worker even if its UI caller is cancelled.
            let (data, stamp) = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
                let _slot = slot;
                let before = file_stamp(&read_path);
                let data = reader(read_path.clone())?;
                let after = file_stamp(&read_path);
                if before != after {
                    return Err(AppError::from("table changed while loading; retry"));
                }
                Ok((data, after))
            })
            .await
            .map_err(AppError::from)??;
            let mut guard = project_ref.lock_owned().await;
            // Interface synchronization may persist a changed schema. Keep that work
            // off the async executor, too. The short publication stage never calls
            // RUNTIME.block_on or takes the outer desktop state mutex.
            tokio::task::spawn_blocking(move || -> Result<(), AppError> {
                let project = guard.as_mut().ok_or("no project open")?;
                if project.get_instance_id() != session {
                    return Err(AppError::from("project session changed"));
                }
                if project.tables_data.contains_key(&path) {
                    return Ok(());
                }
                if queue
                    .as_ref()
                    .is_some_and(|q| q.has_pending_saves_for_path_sync(&path))
                {
                    return Err("table save is still pending; retry after saving".into());
                }
                if file_stamp(&path) != stamp {
                    return Err("table changed while loading; retry".into());
                }
                if project
                    .tables_data
                    .values()
                    .any(|table| table.data.uuid == data.uuid)
                {
                    return Err("table UUID is already loaded from a different path".into());
                }
                let mut table = Table {
                    path: path.clone(),
                    data,
                    is_dirty: false,
                    undo_history: Vec::new(),
                    redo_history: Vec::new(),
                };
                crate::Interface::validate_table_column_ids(
                    &table.data,
                    &project.interface_registry,
                )?;
                // Interfaces are loaded on project open and refreshed by explicit
                // interface changes; loading each table must not rescan all files.
                let updates: Vec<_> = table
                    .data
                    .interface_implementations
                    .iter()
                    .filter_map(|(uuid, implementation)| {
                        project
                            .get_interface(uuid)
                            .filter(|interface| {
                                interface
                                    .table_needs_sync(implementation, &project.interface_registry)
                            })
                            .map(|interface| (interface.clone(), implementation.synced_version_id))
                    })
                    .collect();
                if updates.is_empty() {
                    project.tables_data.insert(path, table);
                    return Ok(());
                }
                let before = table.data.clone();
                for (interface, version) in updates {
                    interface
                        .apply_to_table(&mut table, version, &project.interface_registry)
                        .map_err(AppError::from)?;
                }
                // Synchronization can update only implementation metadata. Persist
                // that revision too before publishing a clean table, otherwise the
                // next edit compares an unsaved in-memory revision against disk.
                if table.is_dirty
                    || crate::cell_rules::revision(&before)
                        != crate::cell_rules::revision(&table.data)
                {
                    crate::edit_controls::validate_transition(&before, &table.data, false)
                        .map_err(AppError::from)?;
                    let formula_context =
                        crate::formula_context::ProjectFormulaContext::new(project, None)
                            .map_err(AppError::from)?;
                    let mut evaluate = |data: &TableData,
                                        column: &crate::column::ColumnSchema,
                                        record: &crate::record::Record,
                                        formula: &str| {
                        formula_context.evaluate_cell_with_override(data, column, record, formula)
                    };
                    crate::cell_rules::validate_transition_with_evaluator(
                        &project.project_data.uuid,
                        &before,
                        &table.data,
                        None,
                        &mut evaluate,
                    )
                    .map_err(AppError::from)?;
                    let expected =
                        HashMap::from([(path.clone(), crate::cell_rules::revision(&before))]);
                    crate::table_mutation::persist_tables(
                        &[(&path, &table.data)],
                        &expected,
                        queue.as_ref(),
                    )
                    .map_err(AppError::from)?;
                    table.is_dirty = false;
                }
                project.tables_data.insert(path.clone(), table);
                Ok(())
            })
            .await
            .map_err(AppError::from)?
        })
        .await
        .map_err(AppError::from)?
    }
}

fn file_stamp(path: &std::path::Path) -> Option<(u64, std::time::SystemTime)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}
