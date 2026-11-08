//! Thin native commands for the shared rules engine and per-operation dialogs.
use crate::state::ProjectState;
use crate::AppError;
use devcel_core::cell_rules::{FormattingRule, TablePresentation, ValidationReport};
use devcel_core::formula_context::FormulaSnapshotValidity;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Requests have an independent lock: cancelling never waits for a formula's
/// project read guard. The native-generated identity is scoped to the exact
/// window, project session and table, so a late cancellation cannot hit a retry.
struct SnapshotRequest {
    window: String,
    project_session: String,
    table_uuid: String,
    cancellation: Arc<AtomicBool>,
    created: Instant,
    running: bool,
}

static SNAPSHOT_REQUESTS: LazyLock<Mutex<HashMap<String, SnapshotRequest>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TableRuleSnapshotResponse {
    Unchanged {
        snapshot_token: Option<String>,
        retained_bytes: usize,
    },
    Presentation {
        snapshot_token: Option<String>,
        retained_bytes: usize,
        presentation: TablePresentation,
    },
    Snapshot {
        snapshot_token: Option<String>,
        retained_bytes: usize,
        table: Box<devcel_core::TableData>,
        presentation: TablePresentation,
    },
}

#[derive(Clone)]
struct SnapshotEvidence {
    window: String,
    project_session: String,
    table_uuid: String,
    root_revision: String,
    validity: Arc<FormulaSnapshotValidity>,
    source_epoch: u64,
    snapshot_bytes: usize,
    evidence_bytes: usize,
    created: Instant,
}

const SNAPSHOT_TOKEN_CAPACITY: usize = 64;
const SNAPSHOT_TOKEN_BYTE_BUDGET: usize = 8 * 1024 * 1024;
static SNAPSHOT_TOKENS: LazyLock<Mutex<VecDeque<(String, SnapshotEvidence)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

fn snapshot_evidence_matches(
    evidence: &SnapshotEvidence,
    window: &str,
    session: &str,
    uuid: &str,
) -> bool {
    evidence.window == window && evidence.project_session == session && evidence.table_uuid == uuid
}

fn find_snapshot_evidence(
    tokens: &VecDeque<(String, SnapshotEvidence)>,
    token: Option<&str>,
    window: &str,
    session: &str,
    table_uuid: &str,
) -> Option<SnapshotEvidence> {
    let token = token?;
    tokens
        .iter()
        .find(|(id, evidence)| {
            id == token && snapshot_evidence_matches(evidence, window, session, table_uuid)
        })
        .map(|(_, evidence)| evidence.clone())
}

fn unchanged_snapshot_evidence(
    evidence: &SnapshotEvidence,
    current: &FormulaSnapshotValidity,
    epoch: u64,
) -> bool {
    // The live digest includes the scoped root's UUID and canonical revision.
    evidence.source_epoch == epoch && *evidence.validity == *current
}

fn root_snapshot_unchanged(
    known: Option<&SnapshotEvidence>,
    root_revision: &str,
    validated: bool,
) -> bool {
    validated && known.is_some_and(|entry| entry.root_revision == root_revision)
}

fn validate_snapshot_source_evidence(
    before: Option<&FormulaSnapshotValidity>,
    after: Option<&FormulaSnapshotValidity>,
) -> Result<bool, AppError> {
    match (before, after) {
        (Some(before), Some(after)) if before.same_persisted_sources(after) => Ok(true),
        (Some(_), Some(_)) => Err(AppError::code(
            "grid.snapshotChanged",
            serde_json::json!({}),
        )),
        (Some(_), None) => Err(AppError::code(
            "grid.snapshotInvalid",
            serde_json::json!({}),
        )),
        (None, _) => Ok(false),
    }
}

fn evaluated_snapshot_payload(
    table: &devcel_core::TableData,
    presentation: TablePresentation,
    snapshot_token: Option<String>,
    retained_bytes: usize,
    root_same: bool,
    cancellation: &AtomicBool,
) -> Result<TableRuleSnapshotResponse, AppError> {
    check_snapshot_cancelled(cancellation)?;
    let response = if root_same {
        TableRuleSnapshotResponse::Presentation {
            snapshot_token,
            retained_bytes,
            presentation,
        }
    } else {
        TableRuleSnapshotResponse::Snapshot {
            snapshot_token,
            retained_bytes,
            table: Box::new(table.clone()),
            presentation,
        }
    };
    check_snapshot_cancelled(cancellation)?;
    Ok(response)
}

fn retain_snapshot_evidence(mut evidence: SnapshotEvidence) -> Result<Option<String>, AppError> {
    // Count payload capacities and container/allocation slack; shared Arc bytes
    // are deliberately charged per token, so accounting stays conservative.
    evidence.evidence_bytes = evidence
        .validity
        .retained_bytes()
        .saturating_add(evidence.window.capacity())
        .saturating_add(evidence.project_session.capacity())
        .saturating_add(evidence.table_uuid.capacity())
        .saturating_add(evidence.root_revision.capacity())
        .saturating_add(std::mem::size_of::<SnapshotEvidence>() + 256);
    if evidence.evidence_bytes > SNAPSHOT_TOKEN_BYTE_BUDGET {
        return Ok(None);
    }
    let mut tokens = SNAPSHOT_TOKENS.lock().map_err(AppError::from)?;
    tokens.retain(|(_, entry)| {
        entry.created.elapsed() < Duration::from_secs(1800)
            && entry.project_session == evidence.project_session
            && !snapshot_evidence_matches(
                entry,
                &evidence.window,
                &evidence.project_session,
                &evidence.table_uuid,
            )
    });
    let mut bytes: usize = tokens.iter().map(|(_, entry)| entry.evidence_bytes).sum();
    while tokens.len() >= SNAPSHOT_TOKEN_CAPACITY
        || bytes.saturating_add(evidence.evidence_bytes) > SNAPSHOT_TOKEN_BYTE_BUDGET
    {
        if let Some((_, entry)) = tokens.pop_front() {
            bytes = bytes.saturating_sub(entry.evidence_bytes);
        } else {
            break;
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    tokens.push_back((token.clone(), evidence));
    Ok(Some(token))
}

const SNAPSHOT_CACHE_NO_RETAIN_WEIGHT: usize = 64 * 1024 * 1024 + 1;

fn retained_string(value: &String) -> usize {
    value.capacity().saturating_mul(2).saturating_add(64)
}

fn retained_optional_string(value: &Option<String>) -> usize {
    value.as_ref().map_or(0, retained_string)
}

fn diagnostic_weight(diagnostic: &devcel_core::types::Diagnostic) -> usize {
    fn value_weight(value: &serde_json::Value, depth: usize) -> usize {
        if depth >= 64 {
            return SNAPSHOT_CACHE_NO_RETAIN_WEIGHT;
        }
        let extra = match value {
            serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
                0
            }
            serde_json::Value::String(value) => retained_string(value),
            serde_json::Value::Array(values) => values.iter().fold(
                values
                    .capacity()
                    .saturating_mul(std::mem::size_of::<serde_json::Value>())
                    .saturating_add(64),
                |bytes, value| bytes.saturating_add(value_weight(value, depth + 1)),
            ),
            serde_json::Value::Object(values) => {
                values
                    .iter()
                    .fold(values.len().saturating_mul(256), |bytes, (key, value)| {
                        bytes
                            .saturating_add(retained_string(key))
                            .saturating_add(value_weight(value, depth + 1))
                    })
            }
        };
        std::mem::size_of::<serde_json::Value>().saturating_add(extra)
    }
    match diagnostic {
        devcel_core::types::Diagnostic::Code { code, params } => retained_string(code)
            .saturating_add(value_weight(params, 0))
            .saturating_add(128),
        devcel_core::types::Diagnostic::Text { text } => retained_string(text).saturating_add(128),
    }
}

/// Conservative structural DTO admission weight, not an allocator/RSS bound.
/// One capacity/count walk; no JSON serialization or extra full payload exists.
/// Unchanged replies reuse the retained weight without walking either object.
fn snapshot_weight(
    table: &devcel_core::TableData,
    presentation: &TablePresentation,
    cancellation: &Arc<AtomicBool>,
) -> Result<usize, AppError> {
    let Some(table_bytes) = devcel_core::formula_context::table_snapshot_retained_bytes(table)
    else {
        return Ok(SNAPSHOT_CACHE_NO_RETAIN_WEIGHT);
    };
    check_snapshot_cancelled(cancellation)?;
    // Rust capacities already account for table heap slack. Four times this
    // structural weight conservatively admits the decoded frontend DTO too.
    let mut bytes = table_bytes
        .saturating_mul(4)
        .saturating_add(std::mem::size_of::<TablePresentation>())
        .saturating_add(retained_string(&presentation.table_uuid))
        .saturating_add(retained_string(&presentation.revision))
        .saturating_add(
            presentation
                .definition_issues
                .capacity()
                .saturating_mul(std::mem::size_of::<devcel_core::types::Diagnostic>()),
        )
        .saturating_add(1024);
    for diagnostic in &presentation.definition_issues {
        bytes = bytes.saturating_add(diagnostic_weight(diagnostic));
    }
    for (record, cells) in &presentation.cells {
        check_snapshot_cancelled(cancellation)?;
        bytes = bytes
            .saturating_add(retained_string(record))
            .saturating_add(256);
        for (column, cell) in cells {
            check_snapshot_cancelled(cancellation)?;
            let devcel_core::cell_rules::CellPresentation {
                raw_value,
                display_value,
                range_bar,
                style,
                issues,
                formula_error,
                hint,
            } = cell;
            bytes = bytes
                .saturating_add(retained_string(column))
                .saturating_add(
                    std::mem::size_of::<devcel_core::cell_rules::CellPresentation>() + 256,
                )
                .saturating_add(retained_string(raw_value))
                .saturating_add(retained_string(display_value))
                .saturating_add(
                    range_bar
                        .as_ref()
                        .map_or(0, |bar| retained_string(&bar.color)),
                )
                .saturating_add(retained_optional_string(&style.background_color))
                .saturating_add(retained_optional_string(&style.text_color))
                .saturating_add(formula_error.as_ref().map_or(0, diagnostic_weight))
                .saturating_add(retained_string(hint))
                .saturating_add(issues.capacity().saturating_mul(std::mem::size_of::<
                    devcel_core::cell_rules::ValidationIssue,
                >()));
            for issue in issues {
                let devcel_core::cell_rules::ValidationIssue {
                    diagnostic,
                    table_uuid,
                    column_uuid,
                    column_name,
                    record_uuid,
                    kind,
                    raw_value,
                    effective_value,
                    rule_key,
                    peers,
                    peer_count: _,
                    mode: _, // Inline enum is already counted by size_of::<ValidationIssue>().
                } = issue;
                bytes = bytes
                    .saturating_add(diagnostic_weight(diagnostic))
                    .saturating_add(retained_optional_string(record_uuid))
                    .saturating_add(
                        peers
                            .capacity()
                            .saturating_mul(std::mem::size_of::<String>()),
                    )
                    .saturating_add(128);
                for value in [
                    table_uuid,
                    column_uuid,
                    column_name,
                    kind,
                    raw_value,
                    effective_value,
                    rule_key,
                ] {
                    bytes = bytes.saturating_add(retained_string(value));
                }
                for peer in peers {
                    bytes = bytes.saturating_add(retained_string(peer));
                }
            }
        }
    }
    check_snapshot_cancelled(cancellation)?;
    Ok(bytes)
}

fn optional_snapshot_validity(
    result: Result<FormulaSnapshotValidity, devcel_core::FormulaError>,
) -> Result<Option<FormulaSnapshotValidity>, AppError> {
    match result {
        Ok(evidence) => Ok(Some(evidence)),
        Err(devcel_core::FormulaError::Cancelled) => Err(cancelled_snapshot()),
        // Evidence admission/resource limits require full evaluation without a
        // token. Actual source errors must not become a successful snapshot.
        Err(devcel_core::FormulaError::ExecutionLimit(_)) => Ok(None),
        Err(error) => Err(AppError::from(error)),
    }
}

/// Once a valid persisted baseline exists, a failed final read cannot silently
/// erase it: that would leave loaded disk bytes unvalidated by finish_snapshot.
/// Initial unavailable evidence still permits full evaluation without a token.
fn confirm_snapshot_sources(
    context: &devcel_core::formula_context::ProjectFormulaContext<'_>,
    has_baseline: bool,
) -> Result<Option<FormulaSnapshotValidity>, AppError> {
    confirm_snapshot_source_result(context.snapshot_sources(), has_baseline)
}

fn confirm_snapshot_source_result(
    result: Result<FormulaSnapshotValidity, devcel_core::FormulaError>,
    has_baseline: bool,
) -> Result<Option<FormulaSnapshotValidity>, AppError> {
    match result {
        Ok(evidence) => Ok(Some(evidence)),
        Err(devcel_core::FormulaError::Cancelled) => Err(cancelled_snapshot()),
        Err(error) if has_baseline => Err(AppError::from(error)),
        Err(devcel_core::FormulaError::ExecutionLimit(_)) => Ok(None),
        Err(error) => Err(AppError::from(error)),
    }
}

struct SnapshotRequestGuard(String);

impl Drop for SnapshotRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = SNAPSHOT_REQUESTS.lock() {
            requests.remove(&self.0);
        }
    }
}

/// Native window teardown may not run React effect cleanup.
pub(crate) fn cancel_snapshot_requests_for_window(window: &str) {
    if let Ok(mut tokens) = SNAPSHOT_TOKENS.lock() {
        tokens.retain(|(_, evidence)| evidence.window != window);
    }
    if let Ok(mut requests) = SNAPSHOT_REQUESTS.lock() {
        requests.retain(|_, request| {
            if request.window != window {
                return true;
            }
            request.cancellation.store(true, Ordering::Relaxed);
            request.running
        });
    }
}

fn cancelled_snapshot() -> AppError {
    AppError::code("grid.loading.cancelled", serde_json::json!({}))
}

fn check_snapshot_cancelled(cancellation: &AtomicBool) -> Result<(), AppError> {
    if cancellation.load(Ordering::Relaxed) {
        Err(cancelled_snapshot())
    } else {
        Ok(())
    }
}

fn matches_snapshot_request(
    request: &SnapshotRequest,
    window: &str,
    project_session: &str,
    table_uuid: &str,
) -> bool {
    request.window == window
        && request.project_session == project_session
        && request.table_uuid == table_uuid
}

/// Reserve before starting work, so cancelling while a request is being sent
/// cannot race ahead of registration. Abandoned reservations are bounded.
#[tauri::command]
pub fn prepare_table_rule_snapshot(
    table_uuid: String,
    expected_project_session: String,
    window: tauri::WebviewWindow,
) -> Result<String, AppError> {
    let mut requests = SNAPSHOT_REQUESTS.lock().map_err(AppError::from)?;
    requests.retain(|_, request| {
        request.running || request.created.elapsed() < Duration::from_secs(180)
    });
    if requests.len() >= 128 {
        return Err(AppError::code(
            "grid.loading.queueFull",
            serde_json::json!({}),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    requests.insert(
        id.clone(),
        SnapshotRequest {
            window: window.label().to_owned(),
            project_session: expected_project_session,
            table_uuid,
            cancellation: Arc::new(AtomicBool::new(false)),
            created: Instant::now(),
            running: false,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn cancel_table_rule_snapshot(
    evaluation_id: String,
    table_uuid: String,
    expected_project_session: String,
    window: tauri::WebviewWindow,
) -> Result<bool, AppError> {
    let mut requests = SNAPSHOT_REQUESTS.lock().map_err(AppError::from)?;
    let Some(request) = requests.get(&evaluation_id) else {
        // A finished or already cancelled request is an idempotent no-op.
        return Ok(false);
    };
    if !matches_snapshot_request(
        request,
        window.label(),
        &expected_project_session,
        &table_uuid,
    ) {
        return Err(AppError::code(
            "grid.snapshotChanged",
            serde_json::json!({}),
        ));
    }
    request.cancellation.store(true, Ordering::Relaxed);
    if !request.running {
        requests.remove(&evaluation_id);
    }
    Ok(true)
}

#[tauri::command]
pub async fn get_table_rule_snapshot(
    evaluation_id: String,
    table_uuid: String,
    expected_project_session: String,
    known_snapshot_token: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ProjectState>,
) -> Result<TableRuleSnapshotResponse, AppError> {
    let cancellation = {
        let mut requests = SNAPSHOT_REQUESTS.lock().map_err(AppError::from)?;
        let request = requests
            .get_mut(&evaluation_id)
            .ok_or_else(cancelled_snapshot)?;
        if !matches_snapshot_request(
            request,
            window.label(),
            &expected_project_session,
            &table_uuid,
        ) {
            return Err(AppError::code(
                "grid.snapshotChanged",
                serde_json::json!({}),
            ));
        }
        if request.running {
            return Err(AppError::code(
                "grid.loading.queueFull",
                serde_json::json!({}),
            ));
        }
        request.running = true;
        request.cancellation.clone()
    };
    let request_guard = SnapshotRequestGuard(evaluation_id);
    let window_label = window.label().to_owned();
    let state = state.inner().clone();
    let project_state = state.project.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _request_guard = request_guard;
        check_snapshot_cancelled(&cancellation)?;
        // Keep one authoritative guard for source reconciliation, root revision,
        // dependencies and presentation. Cancellation uses no project lock.
        let mut project_guard = project_state.blocking_lock();
        check_snapshot_cancelled(&cancellation)?;
        let project = project_guard
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        crate::ensure_project_session(project, &expected_project_session)?;
        crate::formula_source_watcher::check_source_error(&expected_project_session)?;
        let (known, baseline) = {
            let mut tokens = SNAPSHOT_TOKENS.lock().map_err(AppError::from)?;
            tokens.retain(|(_, entry)| {
                entry.created.elapsed() < Duration::from_secs(1800)
                    && entry.project_session == expected_project_session
            });
            let known = find_snapshot_evidence(
                &tokens,
                known_snapshot_token.as_deref(),
                &window_label,
                &expected_project_session,
                &table_uuid,
            );
            let baseline = tokens
                .iter()
                .rev()
                .find(|(_, entry)| {
                    entry.window == window_label
                        && entry.project_session == expected_project_session
                })
                .map(|(_, entry)| entry.validity.clone());
            (known, baseline)
        };
        let epoch = crate::formula_source_watcher::source_epoch();
        let mut before_has_live = known.is_some();
        let mut before = {
            let context = devcel_core::formula_context::ProjectFormulaContext::new(project, None)
                .map_err(AppError::from)?;
            context.set_cancellation(Some(cancellation.clone()));
            optional_snapshot_validity(if before_has_live {
                context.snapshot_validity()
            } else {
                context.snapshot_sources()
            })?
        };
        project
            .find_table_by_uuid(&table_uuid)
            .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;
        if known
            .as_ref()
            .zip(before.as_ref())
            .is_some_and(|(entry, evidence)| unchanged_snapshot_evidence(entry, evidence, epoch))
        {
            // Reread complete persisted evidence to close the inventory/read
            // gap. Live tables/interfaces cannot change under this same guard.
            let context = devcel_core::formula_context::ProjectFormulaContext::new(project, None)
                .map_err(AppError::from)?;
            context.set_cancellation(Some(cancellation.clone()));
            let confirmed = confirm_snapshot_sources(&context, true)?;
            crate::formula_source_watcher::check_source_error(&expected_project_session)?;
            check_snapshot_cancelled(&cancellation)?;
            if confirmed
                .as_ref()
                .zip(before.as_ref())
                .is_some_and(|(after, before)| before.same_persisted_sources(after))
                && crate::formula_source_watcher::source_epoch() == epoch
            {
                return Ok(TableRuleSnapshotResponse::Unchanged {
                    snapshot_token: known_snapshot_token,
                    retained_bytes: known.as_ref().unwrap().snapshot_bytes,
                });
            }
            if !confirmed
                .as_ref()
                .zip(before.as_ref())
                .is_some_and(|(after, before)| before.same_persisted_sources(after))
            {
                before = confirmed;
                before_has_live = false;
            }
        }
        crate::formula_source_watcher::check_source_error(&expected_project_session)?;
        check_snapshot_cancelled(&cancellation)?;
        let live_changed = crate::formula_source_watcher::reconcile_for_snapshot(
            project,
            &state,
            baseline.as_deref(),
            before.as_ref(),
        )?;
        check_snapshot_cancelled(&cancellation)?;
        let context = devcel_core::formula_context::ProjectFormulaContext::new(project, None)
            .map_err(AppError::from)?;
        context.set_cancellation(Some(cancellation.clone()));
        let evaluation_basis = match (live_changed, before) {
            (false, Some(before)) => {
                // No table or interface changed during reconciliation. Reuse this
                // guard's initial source ledger; final confirmation covers the
                // entire evaluation, so another pre-evaluation disk walk adds no
                // freshness or live-state authority here.
                if before_has_live {
                    Some(before)
                } else {
                    optional_snapshot_validity(context.snapshot_validity_with_sources(before))?
                }
            }
            (_, before) => {
                let evaluation_sources = confirm_snapshot_sources(&context, before.is_some())?;
                if before
                    .as_ref()
                    .zip(evaluation_sources.as_ref())
                    .is_some_and(|(before, after)| !before.same_persisted_sources(after))
                {
                    return Err(AppError::code(
                        "grid.snapshotChanged",
                        serde_json::json!({}),
                    ));
                }
                match evaluation_sources {
                    Some(sources) => {
                        optional_snapshot_validity(context.snapshot_validity_with_sources(sources))?
                    }
                    None => None,
                }
            }
        };
        let evaluation_epoch = crate::formula_source_watcher::source_epoch();
        let table = project
            .find_table_by_uuid(&table_uuid)
            .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;
        let presentation = context
            .presentation_cancellable(&table.data)
            .map_err(|error| {
                if matches!(error, devcel_core::FormulaError::Cancelled) {
                    cancelled_snapshot()
                } else {
                    AppError::from(error)
                }
            })?;
        // presentation_cancellable preserved its existing finish validation.
        // One final source-only check after accounting covers this whole batch;
        // live state remains immutable after reconciliation under this guard.
        crate::formula_source_watcher::check_source_error(&expected_project_session)?;
        check_snapshot_cancelled(&cancellation)?;
        let retained_bytes = snapshot_weight(&table.data, &presentation, &cancellation)?;
        // Accounting itself may take time on a large table. Confirm source bytes
        // again before issuing evidence or allowing root-reference reuse.
        let confirmed = confirm_snapshot_sources(&context, evaluation_basis.is_some())?;
        let validated =
            validate_snapshot_source_evidence(evaluation_basis.as_ref(), confirmed.as_ref())?;
        crate::formula_source_watcher::check_source_error(&expected_project_session)?;
        check_snapshot_cancelled(&cancellation)?;
        let epoch_stable = crate::formula_source_watcher::source_epoch() == evaluation_epoch;
        let root_same = root_snapshot_unchanged(known.as_ref(), &presentation.revision, validated);
        let snapshot_token = if validated && epoch_stable {
            retain_snapshot_evidence(SnapshotEvidence {
                window: window_label,
                project_session: expected_project_session.clone(),
                table_uuid,
                root_revision: presentation.revision.clone(),
                validity: Arc::new(evaluation_basis.unwrap()),
                source_epoch: evaluation_epoch,
                snapshot_bytes: retained_bytes,
                evidence_bytes: 0,
                created: Instant::now(),
            })?
        } else {
            None
        };
        check_snapshot_cancelled(&cancellation)?;
        let response = evaluated_snapshot_payload(
            &table.data,
            presentation,
            snapshot_token,
            retained_bytes,
            root_same,
            &cancellation,
        )?;
        crate::formula_source_watcher::check_source_error(&expected_project_session)?;
        Ok(response)
    })
    .await
    .map_err(AppError::technical)?
}

#[tauri::command]
pub fn get_table_presentation(
    table_uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<TablePresentation, AppError> {
    state.lock().unwrap().with_project(|project| {
        let project = project
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        crate::ensure_project_session(project, &expected_project_session)?;
        crate::formula_source_watcher::check_source_error(&expected_project_session)?;
        let table = project
            .find_table_by_uuid(table_uuid)
            .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;
        let context = devcel_core::formula_context::ProjectFormulaContext::new(project, None)
            .map_err(AppError::from)?;
        Ok(context.presentation(&table.data))
    })
}

#[tauri::command]
pub fn new_formatting_rule(kind: &str) -> Result<FormattingRule, AppError> {
    devcel_core::cell_rules::new_formatting_rule(kind).map_err(AppError::from)
}

#[tauri::command]
pub fn prepare_record_draft(
    table_uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::table_mutation::RecordDraft, AppError> {
    state.lock().unwrap().with_project(|project| {
        let project = project
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        crate::ensure_project_session(project, &expected_project_session)?;
        devcel_core::table_mutation::prepare_record_draft(project, table_uuid)
            .map_err(AppError::from)
    })
}

#[tauri::command]
pub fn apply_table_mutation(
    request: devcel_core::table_mutation::TableMutation,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::table_mutation::MutationResult, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, save_queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            crate::ensure_project_session(project, &expected_project_session)?;
            devcel_core::table_mutation::apply(project, request, save_queue).map_err(AppError::from)
        })
}

#[tauri::command]
pub fn update_table_edit_settings(
    request: devcel_core::edit_controls::TableEditSettingsRequest,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::table_mutation::MutationResult, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, save_queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            crate::ensure_project_session(project, &expected_project_session)?;
            devcel_core::edit_controls::update_table_edit_settings(project, request, save_queue)
                .map_err(AppError::from)
        })
}

#[tauri::command]
pub fn set_column_read_only(
    request: devcel_core::edit_controls::ColumnReadOnlyRequest,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::table_mutation::MutationResult, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, save_queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            crate::ensure_project_session(project, &expected_project_session)?;
            devcel_core::edit_controls::set_column_read_only(project, request, save_queue)
                .map_err(AppError::from)
        })
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DialogRequest {
    pub kind: String,
    pub table_uuid: String,
    pub title: String,
    pub report: Option<ValidationReport>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DialogResult {
    pub approved: bool,
}

struct DialogSession {
    request: DialogRequest,
    result: Option<DialogResult>,
    creator: String,
    created: Instant,
}

static DIALOGS: LazyLock<Mutex<HashMap<String, DialogSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub fn create_table_dialog_session(
    request: DialogRequest,
    window: tauri::WebviewWindow,
) -> Result<String, AppError> {
    if request.kind != "warning" {
        return Err(AppError::code(
            "rules.dialog.kindInvalid",
            serde_json::json!({}),
        ));
    }
    if serde_json::to_vec(&request).map_err(AppError::from)?.len() > 8 * 1024 * 1024 {
        return Err(AppError::code(
            "rules.dialog.tooLarge",
            serde_json::json!({"max":8}),
        ));
    }
    let mut sessions = DIALOGS.lock().map_err(AppError::from)?;
    sessions.retain(|_, session| session.created.elapsed() < Duration::from_secs(1800));
    if sessions.len() >= 32 {
        return Err(AppError::code(
            "rules.dialog.tooMany",
            serde_json::json!({}),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sessions.insert(
        id.clone(),
        DialogSession {
            request,
            result: None,
            creator: window.label().to_string(),
            created: Instant::now(),
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn get_table_dialog_session(
    session_id: &str,
    window: tauri::WebviewWindow,
) -> Result<DialogRequest, AppError> {
    if window.label() != format!("table-rule-{session_id}") {
        return Err(AppError::code(
            "rules.dialog.windowMismatch",
            serde_json::json!({}),
        ));
    }
    DIALOGS
        .lock()
        .map_err(AppError::from)?
        .get(session_id)
        .map(|session| session.request.clone())
        .ok_or_else(|| AppError::code("rules.dialog.closed", serde_json::json!({})))
}

#[tauri::command]
pub fn resolve_table_dialog_session(
    session_id: &str,
    result: DialogResult,
    window: tauri::WebviewWindow,
) -> Result<(), AppError> {
    if window.label() != format!("table-rule-{session_id}") {
        return Err(AppError::code(
            "rules.dialog.windowMismatch",
            serde_json::json!({}),
        ));
    }
    let mut sessions = DIALOGS.lock().map_err(AppError::from)?;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| AppError::code("rules.dialog.closed", serde_json::json!({})))?;
    if session.result.is_some() {
        return Err(AppError::code(
            "rules.dialog.alreadySubmitted",
            serde_json::json!({}),
        ));
    }
    session.result = Some(result);
    Ok(())
}

#[tauri::command]
pub fn take_table_dialog_result(
    session_id: &str,
    window: tauri::WebviewWindow,
) -> Result<Option<DialogResult>, AppError> {
    let mut sessions = DIALOGS.lock().map_err(AppError::from)?;
    if sessions
        .get(session_id)
        .is_some_and(|s| s.creator != window.label())
    {
        return Err(AppError::code(
            "rules.dialog.windowMismatch",
            serde_json::json!({}),
        ));
    }
    Ok(sessions.remove(session_id).and_then(|s| s.result))
}

#[cfg(test)]
mod native_snapshot_regression_tests {
    use super::*;
    use devcel_core::formula_context::ProjectFormulaContext;
    use devcel_core::{
        ColumnSchema, Project, Record, Table, TableData, TableMetadata, TableSchema, ValueType,
    };
    use std::path::PathBuf;

    struct Fixture {
        _directory: tempfile::TempDir,
        project: Project,
        root: PathBuf,
        dependency: PathBuf,
    }

    fn data(name: &str, value: Option<&str>) -> TableData {
        let column = ColumnSchema {
            data_name: "value".into(),
            display_name: "Value".into(),
            data_type: ValueType::I32,
            ..Default::default()
        };
        let mut record = Record::new();
        if let Some(value) = value {
            record.set_value("value", value.into());
        }
        TableData {
            description: String::new(),
            uuid: uuid::Uuid::new_v4().to_string(),
            display_name: name.into(),
            metadata: TableMetadata {
                schema_version: 1,
                interface_order: Vec::new(),
                initial_transposed: false,
                edit_permissions: Default::default(),
                parent_uuid: String::new(),
                data_name: name.into(),
            },
            interface_implementations: HashMap::new(),
            schema: TableSchema {
                columns: vec![column],
            },
            records: vec![record],
        }
    }

    fn insert(project: &mut Project, data: TableData, loaded: bool) -> PathBuf {
        let path = project
            .path
            .parent()
            .unwrap()
            .join("Tables")
            .join(format!("{}.table.toml", data.metadata.data_name));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, toml::to_string(&data).unwrap()).unwrap();
        if loaded {
            project.tables_data.insert(
                path.clone(),
                Table {
                    path: path.clone(),
                    is_dirty: false,
                    data,
                    undo_history: vec![],
                    redo_history: vec![],
                },
            );
        }
        path
    }

    fn fixture(loaded_dependency: bool) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let mut project = Project::create_project(
            "Snapshot",
            directory.path().to_str().unwrap(),
            "",
            "#123456",
        )
        .unwrap();
        let mut root_data = data("Root", None);
        root_data.schema.columns[0].default_value =
            "=REDUCE(TABLE(\"Dependency\"),0,(a,r)=>a+r.value)".into();
        let root = insert(&mut project, root_data, true);
        let dependency = insert(
            &mut project,
            data("Dependency", Some("10")),
            loaded_dependency,
        );
        Fixture {
            _directory: directory,
            project,
            root,
            dependency,
        }
    }

    fn evidence(fixture: &Fixture) -> SnapshotEvidence {
        SnapshotEvidence {
            window: "native-snapshot-test".into(),
            project_session: fixture.project.get_instance_id().into(),
            table_uuid: fixture.project.tables_data[&fixture.root].data.uuid.clone(),
            root_revision: devcel_core::cell_rules::revision(
                &fixture.project.tables_data[&fixture.root].data,
            ),
            validity: Arc::new(
                ProjectFormulaContext::new(&fixture.project, None)
                    .unwrap()
                    .snapshot_validity()
                    .unwrap(),
            ),
            source_epoch: 7,
            snapshot_bytes: 4096,
            evidence_bytes: 0,
            created: Instant::now(),
        }
    }

    fn displayed(presentation: &TablePresentation) -> &str {
        &presentation
            .cells
            .values()
            .next()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .display_value
    }

    #[test]
    fn native_snapshot_unchanged_and_reply_discriminants() {
        let fixture = fixture(true);
        let known = evidence(&fixture);
        let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
        let current = context.snapshot_validity().unwrap();
        assert!(unchanged_snapshot_evidence(&known, &current, 7));
        assert!(!unchanged_snapshot_evidence(&known, &current, 8));
        let final_sources = context.snapshot_sources().unwrap();
        assert!(validate_snapshot_source_evidence(Some(&current), Some(&final_sources)).unwrap());
        let unchanged = TableRuleSnapshotResponse::Unchanged {
            snapshot_token: Some("opaque".into()),
            retained_bytes: known.snapshot_bytes,
        };
        let value = serde_json::to_value(unchanged).unwrap();
        assert_eq!(value["kind"], "unchanged");
        assert!(value.get("table").is_none() && value.get("presentation").is_none());
        let table = &fixture.project.tables_data[&fixture.root].data;
        let presentation = context.presentation_cancellable(table).unwrap();
        assert_eq!(displayed(&presentation), "10");
        let cancellation = AtomicBool::new(false);
        let only_presentation = evaluated_snapshot_payload(
            table,
            presentation.clone(),
            Some("opaque".into()),
            4096,
            true,
            &cancellation,
        )
        .unwrap();
        let value = serde_json::to_value(only_presentation).unwrap();
        assert_eq!(value["kind"], "presentation");
        assert!(value.get("table").is_none() && value.get("presentation").is_some());
        let full =
            evaluated_snapshot_payload(table, presentation, None, 4096, false, &cancellation)
                .unwrap();
        let value = serde_json::to_value(full).unwrap();
        assert_eq!(value["kind"], "snapshot");
        assert!(value["snapshot_token"].is_null());
        assert_eq!(value["table"]["uuid"], table.uuid);
    }

    #[test]
    fn native_snapshot_weight_counts_nested_formula_diagnostics_without_flattening() {
        let fixture = fixture(true);
        let table = &fixture.project.tables_data[&fixture.root].data;
        let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
        let mut presentation = context.presentation_cancellable(table).unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let before = snapshot_weight(table, &presentation, &cancellation).unwrap();
        let diagnostic = devcel_core::types::Diagnostic::Code {
            code: "error.invalidData".into(),
            params: serde_json::json!({"details": {
                "kind": "text", "text": "literal parser detail ".repeat(4096)
            }}),
        };
        let expected = diagnostic_weight(&diagnostic);
        let cell = presentation
            .cells
            .values_mut()
            .next()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        assert!(cell.formula_error.is_none());
        cell.formula_error = Some(diagnostic.clone());
        let after = snapshot_weight(table, &presentation, &cancellation).unwrap();
        assert_eq!(after.saturating_sub(before), expected);
        assert!(expected > 4096 * 20 * 2);
        assert_eq!(
            serde_json::to_value(
                presentation
                    .cells
                    .values()
                    .next()
                    .unwrap()
                    .values()
                    .next()
                    .unwrap()
                    .formula_error
                    .as_ref()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(diagnostic).unwrap()
        );
    }

    #[test]
    fn native_snapshot_same_root_loaded_dependency_change_reevaluates_presentation() {
        let mut fixture = fixture(true);
        let known = evidence(&fixture);
        fixture
            .project
            .tables_data
            .get_mut(&fixture.dependency)
            .unwrap()
            .data
            .records[0]
            .set_value("value", "20".into());
        let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
        let current = context.snapshot_validity().unwrap();
        assert!(!unchanged_snapshot_evidence(&known, &current, 7));
        assert!(known.validity.same_persisted_sources(&current));
        let root = &fixture.project.tables_data[&fixture.root].data;
        assert_eq!(known.root_revision, devcel_core::cell_rules::revision(root));
        let presentation = context.presentation_cancellable(root).unwrap();
        assert_eq!(displayed(&presentation), "20");
        assert!(root_snapshot_unchanged(
            Some(&known),
            &presentation.revision,
            true
        ));
        assert!(!root_snapshot_unchanged(
            Some(&known),
            &presentation.revision,
            false
        ));
        assert!(!root_snapshot_unchanged(None, &presentation.revision, true));
        assert!(matches!(
            evaluated_snapshot_payload(
                root,
                presentation,
                Some("new".into()),
                4096,
                true,
                &AtomicBool::new(false)
            )
            .unwrap(),
            TableRuleSnapshotResponse::Presentation { .. }
        ));
    }

    #[test]
    fn native_snapshot_root_change_requires_full_authoritative_data() {
        let mut fixture = fixture(true);
        let known = evidence(&fixture);
        fixture
            .project
            .tables_data
            .get_mut(&fixture.root)
            .unwrap()
            .data
            .description = "changed root".into();
        let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
        let current = context.snapshot_validity().unwrap();
        assert!(!unchanged_snapshot_evidence(&known, &current, 7));
        let root = &fixture.project.tables_data[&fixture.root].data;
        let presentation = context.presentation_cancellable(root).unwrap();
        assert!(!root_snapshot_unchanged(
            Some(&known),
            &presentation.revision,
            true
        ));
        match evaluated_snapshot_payload(
            root,
            presentation,
            Some("new".into()),
            4096,
            false,
            &AtomicBool::new(false),
        )
        .unwrap()
        {
            TableRuleSnapshotResponse::Snapshot {
                table,
                presentation,
                ..
            } => {
                assert_eq!(table.description, "changed root");
                assert_eq!(
                    presentation.revision,
                    devcel_core::cell_rules::revision(&table)
                );
            }
            _ => panic!("Changed root lost authoritative full table"),
        }
    }

    #[test]
    fn native_snapshot_unopened_same_stamp_bytes_and_inventory_invalidate() {
        let fixture = fixture(false);
        let known = evidence(&fixture);
        let stamp = std::fs::metadata(&fixture.dependency).unwrap();
        let source = std::fs::read_to_string(&fixture.dependency).unwrap();
        let changed = source.replace("\"10\"", "\"20\"");
        assert_ne!(source, changed);
        assert_eq!(source.len(), changed.len());
        std::fs::write(&fixture.dependency, changed).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&fixture.dependency)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(stamp.modified().unwrap()))
            .unwrap();
        let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
        let current = context.snapshot_validity().unwrap();
        assert!(!unchanged_snapshot_evidence(&known, &current, 7));
        assert!(validate_snapshot_source_evidence(Some(&known.validity), Some(&current)).is_err());
        let root = &fixture.project.tables_data[&fixture.root].data;
        assert_eq!(
            displayed(&context.presentation_cancellable(root).unwrap()),
            "20"
        );
        let baseline = context.snapshot_sources().unwrap();
        std::fs::remove_file(&fixture.dependency).unwrap();
        let deleted = context.snapshot_sources().unwrap();
        assert!(validate_snapshot_source_evidence(Some(&baseline), Some(&deleted)).is_err());
    }

    #[test]
    fn native_snapshot_valid_baseline_cannot_be_erased_by_none_or_source_error() {
        let fixture = fixture(true);
        let current = ProjectFormulaContext::new(&fixture.project, None)
            .unwrap()
            .snapshot_validity()
            .unwrap();
        assert!(validate_snapshot_source_evidence(Some(&current), None).is_err());
        assert!(!validate_snapshot_source_evidence(None, Some(&current)).unwrap());
        assert!(
            optional_snapshot_validity(Err(devcel_core::FormulaError::ExecutionLimit(
                "evidence budget".into()
            )))
            .unwrap()
            .is_none()
        );
        assert!(confirm_snapshot_source_result(
            Err(devcel_core::FormulaError::ExecutionLimit(
                "evidence budget".into()
            )),
            false
        )
        .unwrap()
        .is_none());
        assert!(confirm_snapshot_source_result(
            Err(devcel_core::FormulaError::ExecutionLimit(
                "lost evidence".into()
            )),
            true
        )
        .is_err());
        for has_baseline in [false, true] {
            assert!(confirm_snapshot_source_result(
                Err(devcel_core::FormulaError::DataChanged(
                    "source replaced".into()
                )),
                has_baseline
            )
            .is_err());
            assert!(confirm_snapshot_source_result(
                Err(devcel_core::FormulaError::InvalidReference(
                    "source I/O failed".into()
                )),
                has_baseline
            )
            .is_err());
        }
        assert!(
            optional_snapshot_validity(Err(devcel_core::FormulaError::DataChanged(
                "source replaced".into()
            )))
            .is_err()
        );
        assert!(
            optional_snapshot_validity(Err(devcel_core::FormulaError::InvalidReference(
                "source I/O failed".into()
            )))
            .is_err()
        );
    }

    #[test]
    fn native_snapshot_token_is_window_session_table_and_identity_scoped() {
        let fixture = fixture(true);
        let entry = evidence(&fixture);
        let tokens = VecDeque::from([("native-generated-opaque-id".to_owned(), entry.clone())]);
        let lookup = |token: Option<&str>, window: &str, session: &str, table: &str| {
            find_snapshot_evidence(&tokens, token, window, session, table)
        };
        assert!(lookup(
            Some("native-generated-opaque-id"),
            &entry.window,
            &entry.project_session,
            &entry.table_uuid
        )
        .is_some());
        assert!(lookup(
            Some("different-token"),
            &entry.window,
            &entry.project_session,
            &entry.table_uuid
        )
        .is_none());
        assert!(lookup(
            None,
            &entry.window,
            &entry.project_session,
            &entry.table_uuid
        )
        .is_none());
        assert!(lookup(
            Some("native-generated-opaque-id"),
            "another-window",
            &entry.project_session,
            &entry.table_uuid
        )
        .is_none());
        assert!(lookup(
            Some("native-generated-opaque-id"),
            &entry.window,
            "reopened-session",
            &entry.table_uuid
        )
        .is_none());
        assert!(lookup(
            Some("native-generated-opaque-id"),
            &entry.window,
            &entry.project_session,
            "another-table"
        )
        .is_none());
        assert!(crate::ensure_project_session(&fixture.project, "reopened-session").is_err());
    }

    #[test]
    fn native_snapshot_cancel_has_no_partial_payload_and_request_guard_cannot_hit_retry() {
        let fixture = fixture(true);
        let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
        let root = &fixture.project.tables_data[&fixture.root].data;
        let presentation = context.presentation_cancellable(root).unwrap();
        let cancelled = AtomicBool::new(true);
        assert!(
            evaluated_snapshot_payload(root, presentation.clone(), None, 0, true, &cancelled)
                .is_err()
        );
        assert!(
            evaluated_snapshot_payload(root, presentation, None, 0, false, &cancelled).is_err()
        );
        assert!(
            matches!(check_snapshot_cancelled(&cancelled), Err(AppError::Code { code, .. }) if code == "grid.loading.cancelled")
        );
        assert!(
            matches!(confirm_snapshot_source_result(Err(devcel_core::FormulaError::Cancelled), true), Err(AppError::Code { code, .. }) if code == "grid.loading.cancelled")
        );
        let old_id = uuid::Uuid::new_v4().to_string();
        let retry_id = uuid::Uuid::new_v4().to_string();
        let retry_cancel = Arc::new(AtomicBool::new(false));
        let window = "native-snapshot-request-test";
        let request = |cancel, running| SnapshotRequest {
            window: window.into(),
            project_session: "session".into(),
            table_uuid: "table".into(),
            cancellation: cancel,
            created: Instant::now(),
            running,
        };
        {
            let mut requests = SNAPSHOT_REQUESTS.lock().unwrap();
            requests.insert(
                old_id.clone(),
                request(Arc::new(AtomicBool::new(false)), true),
            );
            requests.insert(retry_id.clone(), request(retry_cancel.clone(), false));
        }
        drop(SnapshotRequestGuard(old_id.clone()));
        {
            let requests = SNAPSHOT_REQUESTS.lock().unwrap();
            assert!(!requests.contains_key(&old_id));
            assert!(requests.contains_key(&retry_id));
            assert!(!retry_cancel.load(Ordering::Relaxed));
            assert!(!matches_snapshot_request(
                &requests[&retry_id],
                "another-window",
                "session",
                "table"
            ));
        }
        cancel_snapshot_requests_for_window(window);
        assert!(retry_cancel.load(Ordering::Relaxed));
        assert!(!SNAPSHOT_REQUESTS.lock().unwrap().contains_key(&retry_id));
    }
}

#[tauri::command]
pub fn update_record_metadata(
    request: devcel_core::edit_controls::RecordMetadataRequest,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::table_mutation::MutationResult, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, save_queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            crate::ensure_project_session(project, &expected_project_session)?;
            devcel_core::edit_controls::update_record_metadata(project, request, save_queue)
                .map_err(AppError::from)
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordInheritanceRequest {
    parent_uuid: Option<String>,
    clear_column_uuid: Option<String>,
}

#[tauri::command]
pub fn update_record_inheritance(
    table_uuid: String,
    expected_revision: String,
    record_uuid: String,
    request: RecordInheritanceRequest,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::table_mutation::MutationResult, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            crate::ensure_project_session(project, &expected_project_session)?;
            project.ensure_table_loaded_by_uuid(&table_uuid)?;
            let table = &project
                .find_table_by_uuid(&table_uuid)
                .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?
                .data;
            if devcel_core::cell_rules::revision(table) != expected_revision {
                return Err(AppError::code("error.staleData", serde_json::json!({})));
            }
            match (request.parent_uuid, request.clear_column_uuid) {
                (Some(parent), None) => project.execute_command(
                    devcel_core::commands::SetRecordParentUuidCommand::new(
                        table_uuid.clone(),
                        record_uuid,
                        parent,
                    ),
                    queue,
                )?,
                (None, Some(column)) => project.execute_command(
                    devcel_core::commands::SetRecordValueCommand::new(
                        table_uuid.clone(),
                        record_uuid,
                        column,
                        String::new(),
                    ),
                    queue,
                )?,
                _ => {
                    return Err(AppError::code(
                        "error.inheritanceRequest",
                        serde_json::json!({}),
                    ))
                }
            }
            let table = project
                .find_table_by_uuid(&table_uuid)
                .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?
                .data
                .clone();
            let context = devcel_core::formula_context::ProjectFormulaContext::new(project, None)?;
            let presentation = context.presentation(&table);
            Ok(devcel_core::table_mutation::MutationResult {
                table,
                presentation,
            })
        })
}

#[cfg(test)]
mod inheritance_request_tests {
    use super::RecordInheritanceRequest;

    #[test]
    fn parent_request_uses_camel_case_fields() {
        let request: RecordInheritanceRequest = serde_json::from_value(serde_json::json!({
            "parentUuid": "parent", "clearColumnUuid": null
        }))
        .unwrap();
        assert_eq!(request.parent_uuid.as_deref(), Some("parent"));
        assert!(request.clear_column_uuid.is_none());
    }

    #[test]
    fn clear_request_uses_camel_case_fields() {
        let request: RecordInheritanceRequest = serde_json::from_value(serde_json::json!({
            "parentUuid": null, "clearColumnUuid": "column"
        }))
        .unwrap();
        assert!(request.parent_uuid.is_none());
        assert_eq!(request.clear_column_uuid.as_deref(), Some("column"));
    }

    #[test]
    fn request_rejects_unknown_fields() {
        assert!(
            serde_json::from_value::<RecordInheritanceRequest>(serde_json::json!({
                "parent_uuid": "parent"
            }))
            .is_err()
        );
    }
}
