#!/usr/bin/env python3
"""Local checks, release-build CI, and Windows/Linux/macOS release packaging (Python 3.11+)."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile

# Imports must not dirty a clean release checkout before its safety check.
# Propagate this to the plain-Python validation commands launched below too.
sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import release_source
import release_privacy
import studio_cli
import importer_versions
import unity_upm
import unity_git_package
from product_version import read_version

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?')


def run(*args, cwd=ROOT, capture=False):
    command = [str(x) for x in args]
    command[0] = shutil.which(command[0]) or command[0]
    return subprocess.run(command, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def validate(tag, root=ROOT):
    if not SEMVER.fullmatch(tag):
        raise ValueError('Use vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease (no build metadata).')
    version = tag[1:]
    if read_version(root) != version:
        raise ValueError('Tag/version mismatch: canonical Tauri version')
    package = json.loads((root/'devcel-studio/package.json').read_bytes())
    lock = json.loads((root/'devcel-studio/package-lock.json').read_bytes())
    if 'version' in package or 'version' in lock or 'version' in lock['packages']['']:
        raise ValueError('Studio npm metadata must not duplicate the product version')
    importer_versions.validate_templates(root)
    return version


def checked_commit(expected, root=ROOT):
    """Resolve an event SHA (including annotated tags) to the checked-out commit."""
    if not re.fullmatch(r'[0-9a-f]{40}', expected):
        raise ValueError('A full Git commit or tag SHA is required.')
    commit = run('git', 'rev-parse', '--verify', expected+'^{commit}', cwd=root, capture=True).strip()
    head = run('git', 'rev-parse', '--verify', 'HEAD', cwd=root, capture=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or commit != head:
        raise ValueError('Checkout does not match the requested release commit.')
    return commit


def release_request(event, ref, version, event_sha, root=ROOT):
    """Validate untrusted dispatch input before emitting any downstream outputs."""
    if event == 'workflow_dispatch':
        if ref != 'refs/heads/main':
            raise ValueError('Manual releases must run from the main branch.')
        tag = 'v'+version
    elif event == 'push' and ref.startswith('refs/tags/'):
        tag = ref.removeprefix('refs/tags/')
    else:
        raise ValueError('Only a version-tag push or a manual main release is supported.')
    validate(tag, root=root)
    commit = checked_commit(event_sha, root=root)
    if event == 'push':
        tagged = run('git', 'rev-parse', '--verify', 'refs/tags/'+tag+'^{commit}', cwd=root, capture=True).strip()
        if tagged != commit:
            raise ValueError('Release tag no longer points to the requested commit.')
    return tag, commit


def emit_release(tag, commit):
    with Path(os.environ['GITHUB_OUTPUT']).open('a', encoding='utf-8', newline='\n') as output:
        output.write(f'tag={tag}\ncommit={commit}\n')
    print(f'Release request: {tag} at {commit}')


def prepare_release():
    tag, commit = release_request(os.environ['GITHUB_EVENT_NAME'], os.environ['GITHUB_REF'],
                                  os.environ.get('RELEASE_VERSION', ''),
                                  os.environ.get('SOURCE_COMMIT') or os.environ['GITHUB_SHA'])
    if os.environ['GITHUB_EVENT_NAME'] == 'push':
        if not run('git', 'ls-tree', commit, '--', unity_git_package.PACKAGE_PATH, capture=True).strip():
            raise ValueError('A new release tag must already contain generated Unity package. Use manual release preparation or stage the complete package before tagging; never move an existing tag.')
        commit = unity_git_package.source_identity(ROOT, commit)
    emit_release(tag, commit)


def prepare_manual_release():
    """Prepare an explicit version on fresh main, without replacing any ref."""
    import release_version

    if os.environ.get('REBUILD_COMMIT'):
        raise ValueError('Expected rebuild commit requires existing-tag rebuild mode.')

    if os.environ['GITHUB_EVENT_NAME'] != 'workflow_dispatch' or os.environ['GITHUB_REF'] != 'refs/heads/main':
        raise ValueError('Only a manual main release may prepare a version.')
    version = os.environ.get('RELEASE_VERSION', '')
    tag = 'v'+version
    if not SEMVER.fullmatch(tag):
        raise ValueError('Use MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease without v.')
    repository = os.environ['GH_REPO']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or repository != os.environ['GITHUB_REPOSITORY']:
        raise ValueError('Release destination must match the workflow repository.')
    base = checked_commit(os.environ['GITHUB_SHA'])
    url = 'https://github.com/'+repository+'.git'

    def remote(*args, capture=False):
        # The built-in workflow token is read by gh from the environment only.
        # No stored credentials, global configuration, force, or tag mutation.
        return run('git', '-c', 'credential.helper=', '-c',
                   'credential.helper=!gh auth git-credential', '-c',
                   'credential.interactive=never', *args, cwd=ROOT, capture=capture)

    def remote_main():
        line = remote('ls-remote', '--refs', url, 'refs/heads/main', capture=True).strip()
        fields = line.split()
        if len(fields) != 2 or fields[1] != 'refs/heads/main' or not re.fullmatch(r'[0-9a-f]{40}', fields[0]):
            raise ValueError('Could not verify the exact remote main commit.')
        return fields[0]

    if remote_main() != base:
        raise ValueError('Remote main moved; start a new release from current main.')
    if remote('ls-remote', '--refs', url, 'refs/tags/'+tag, capture=True).strip():
        raise ValueError('Tag already exists; rerun the existing release jobs, never replace it.')
    if run('git', 'status', '--porcelain', cwd=ROOT, capture=True).strip():
        raise ValueError('Release preparation requires a clean checkout.')
    changed = release_version.bump(version, ROOT)
    if len(changed) != len(set(changed)) or any(
            not isinstance(path, str) or Path(path).is_absolute() or
            '..' in Path(path).parts or path.startswith('-') for path in changed):
        raise ValueError('Version preparation returned unsafe source paths.')
    validate(tag)
    for script, args in (
            ('generate-third-party-notices.py', ('--ensure',)),
            ('release_source.py', ('--check',))):
        run(sys.executable, 'scripts/'+script, *args)
    actual = set(run('git', 'diff', '--name-only', '-z', 'HEAD', cwd=ROOT, capture=True).split('\0'))-{''}
    if actual != set(changed):
        raise ValueError('Prepared diff differs from the explicit version/evidence paths.')
    if remote_main() != base:
        raise ValueError('Remote main moved during preparation; no source commit was pushed.')
    commit = base
    if changed:
        run('git', 'add', '--', *changed, cwd=ROOT)
        staged = set(run('git', 'diff', '--cached', '--name-only', '-z', cwd=ROOT, capture=True).split('\0'))-{''}
        if staged != set(changed):
            raise ValueError('Staged paths differ from the prepared source changes.')
        run('git', '-c', 'user.name=github-actions[bot]', '-c',
            'user.email=41898282+github-actions[bot]@users.noreply.github.com',
            'commit', '-m', 'chore: prepare release '+tag, '--', *changed, cwd=ROOT)
        commit = run('git', 'rev-parse', '--verify', 'HEAD', cwd=ROOT, capture=True).strip()
        checked_commit(commit)
        # A normal push rejects a concurrent main update and branch protection.
        remote('push', url, 'HEAD:refs/heads/main')
    if remote_main() != commit:
        raise ValueError('Remote main does not match the prepared source commit; no tag created.')
    remote('fetch', '--no-tags', url, 'refs/heads/main:refs/remotes/origin/main')
    tag, commit = release_request('workflow_dispatch', 'refs/heads/main', version, commit)
    emit_release(tag, commit)


def create_tag():
    """Preflight the new tag; creation is deferred until package assembly."""
    if os.environ['GITHUB_EVENT_NAME'] != 'workflow_dispatch' or os.environ['GITHUB_REF'] != 'refs/heads/main':
        raise ValueError('Only a manual main release may create a version tag.')
    tag = os.environ['RELEASE_TAG']
    validate(tag)
    commit = checked_commit(os.environ['SOURCE_COMMIT'])
    # Reserve nothing: final tag creation occurs only after all six builds and
    # the combined UPM package are complete. Existing tags are never moved.
    repository = os.environ['GH_REPO']
    if run('git', 'ls-remote', '--refs', 'https://github.com/'+repository+'.git',
           'refs/tags/'+tag, capture=True).strip():
        raise ValueError('Release tag already exists; never replace it.')
    print(f'Validated new release {tag} from {commit}; tag creation deferred until packaging')


def toolchains():
    package = json.loads((ROOT/'devcel-studio/package.json').read_text())
    run('npm', 'install', '--global', 'npm@'+package['volta']['npm'])
    toolchain = tomllib.loads((ROOT/'rust-toolchain.toml').read_text())['toolchain']
    run('rustup', 'toolchain', 'install', toolchain['channel'], '--profile', 'minimal')
    if sys.platform == 'darwin':
        run('rustup', 'target', 'add', '--toolchain', toolchain['channel'],
            'x86_64-apple-darwin', 'aarch64-apple-darwin')


def check():
    """Full local suite, including debug-profile Rust tests and strict Clippy."""
    run(sys.executable, 'scripts/generate-third-party-notices.py', '--ensure')
    run(sys.executable, 'scripts/check-node-pins.py')
    run(sys.executable, 'scripts/test-node-pins.py')
    run(sys.executable, 'scripts/test-ci-release.py')
    run(sys.executable, 'scripts/test-release-recovery.py')
    run(sys.executable, 'scripts/test-release-rebuild.py')
    run(sys.executable, 'scripts/unity_toolchain.py')
    run(sys.executable, 'scripts/test-unity-toolchain.py')
    run(sys.executable, 'scripts/test-release-source.py')
    run(sys.executable, 'scripts/release_source.py', '--check')
    run(sys.executable, 'scripts/test-release-version.py')
    run(sys.executable, 'scripts/bundled_plugin_versions.py', '--check-registration')
    run(sys.executable, 'scripts/test-importer-versions.py')
    run(sys.executable, 'scripts/test-debian-version.py')
    run(sys.executable, 'scripts/test-checkout-line-endings.py')
    run(sys.executable, 'scripts/test-windows-build.py')
    run(sys.executable, 'scripts/test-windows-python.py')
    run(sys.executable, 'scripts/test-windows-entry.py')
    run(sys.executable, 'scripts/test-local-build.py')
    run(sys.executable, 'scripts/check-manual.py')
    run(sys.executable, 'scripts/check-product-name.py')
    run(sys.executable, 'scripts/generate-third-party-notices.py', '--check-locks')
    run('cargo', 'fmt', '--all', '--', '--check')
    run('npm', 'run', 'check:lint', cwd=ROOT/'devcel-studio')
    run('npm', 'run', 'typecheck', cwd=ROOT/'devcel-studio')
    run('npm', 'run', 'lint', cwd=ROOT/'devcel-studio')
    for script in ('sdk:check', 'check:tauri-contracts', 'check:toolbar-layout', 'check:localization-coverage',
                   'check:plugin-contracts', 'check:column-editor-flow', 'check:column-filter-sort',
                   'check:versions', 'check:color-picker', 'check:welcome-backgrounds', 'check:studio-batch'):
        run('npm', 'run', script, cwd=ROOT/'devcel-studio')
    run('npm', 'run', 'build', cwd=ROOT/'devcel-studio')
    run('cargo', 'test', '--locked', '--workspace')
    run('cargo', 'clippy', '--locked', '--workspace', '--all-targets', '--all-features',
        '--', '-D', 'warnings')
    for script in ('test-package-sources.py', 'test_unity_upm.py', 'test_unity_mobile.py', 'test-native-distribution-notices.py',
                   'test-npm-license-tarballs.py', 'test-third-party-notices.py', 'test-windows-portable.py'):
        run(sys.executable, 'scripts/'+script)
    run('node', 'scripts/test-importer-tag-filters.cjs')


def compact_checks():
    """Propagate the first regression failure on every shell, including PowerShell."""
    run(sys.executable, 'scripts/unity_toolchain.py')
    run(sys.executable, 'scripts/test-unity-toolchain.py')
    run(sys.executable, 'scripts/test-release-source.py')
    run(sys.executable, 'scripts/test-ci-release.py')
    run(sys.executable, 'scripts/test-release-recovery.py')
    run(sys.executable, 'scripts/test-release-rebuild.py')
    run(sys.executable, 'scripts/release_source.py', '--check')
    run(sys.executable, 'scripts/test-release-version.py')
    run(sys.executable, 'scripts/bundled_plugin_versions.py', '--check-registration')
    run(sys.executable, 'scripts/test-importer-versions.py')
    run(sys.executable, 'scripts/test-debian-version.py')
    run(sys.executable, 'scripts/test-release-privacy.py')
    run(sys.executable, 'scripts/test-importer-output.py')
    run(sys.executable, 'scripts/test-native-review-evidence.py')


def rust_regression_gates():
    """Bounded, GUI/network-free suites sharing the native release dependency cache."""
    integration = {
        'table_display_catalog': (
            'labels_are_unloaded_record_free_and_refresh_after_moves_and_changes',
            'malformed_siblings_do_not_remove_other_names_or_load_any_records',
            'metadata_after_records_is_streamed_without_parsing_record_values',
            'quoted_dotted_and_interleaved_metadata_have_the_same_display_identity',
            'late_metadata_ignores_fake_sections_inside_multiline_strings_and_nested_arrays',
            'complete_metadata_stops_before_a_large_unrelated_schema',
            'regular_recursive_tables_are_discovered_in_both_catalog_modes',
        ),
        'project_creation_diagnostics': (
            'create_and_open_project_failures_are_localized_and_preserve_existing_files',
            'filesystem_failure_keeps_localized_category_and_literal_technical_detail',
        ),
        'export_error_diagnostics': (
            'codegen_identifiers_have_semantic_codes_and_preserve_names',
            'missing_interface_and_base_interface_ids_stay_typed',
            'formula_cause_remains_nested_and_unreleased_formula_is_not_evaluated',
            'version_projection_reference_error_preserves_output_and_all_identities',
            'source_destination_guard_has_exact_path_and_does_not_replace_source',
            'constraint_summary_is_localizable_and_user_message_remains_literal',
            'inherited_input_failure_is_a_code_not_an_english_text_wrapper',
            'interface_load_wraps_the_typed_parser_cause_and_exact_path',
            'typed_formula_causes_retain_authored_text_and_evaluation_context',
            'invalid_interface_identifier_keeps_parser_details_beneath_localized_summary',
            'unloaded_export_target_preserves_nested_parser_error_and_source_bytes',
            'interface_identity_guard_is_localized_without_mutating_either_definition',
        ),
        'interface_storage_diagnostics': (
            'interface_authoring_retains_semantic_name_and_type_errors',
            'invalid_history_change_keeps_index_version_and_typed_child_without_rewriting',
            'history_integrity_failures_are_typed_and_keep_identifiers',
            'missing_interface_and_column_are_semantic_and_keep_user_values',
            'native_table_decoders_do_not_flatten_storage_contract_errors',
            'invalid_uuid_keeps_parser_detail_as_literal_data',
            'valid_interface_and_table_storage_roundtrip_unchanged',
        ),
        'interface_integration_test': (
            'test_interface_full_workflow',
            'test_interface_version_history',
            'test_interface_validation',
            'test_interface_undo_redo',
            'test_interface_inheritance',
            'test_interface_merge_branches',
            'test_interface_merge_conflict_resolution',
            'test_interface_constraints_validation',
            'test_sequential_change_validation',
            'test_rename_column_preserves_table_values',
            'test_revert_to_version',
            'test_field_level_merge_auto_resolves_orthogonal_changes',
            'test_unknown_interface_column_uuid_is_rejected_without_repair',
            'test_inheritance_change_detected_by_fingerprint',
            'test_type_change_propagates_to_table',
            'test_reconcile_syncs_field_drift',
            'test_remove_interface_deletes_values_no_resurrection',
            'test_formula_routing_for_interface_columns',
            'test_record_canonical_cell_methods',
            'test_reference_config_flows_through_interface',
            'implementation_serialization_preserves_sync_identity_and_fingerprint',
        ),
        'current_contract_regression': (
            'saved_schema_rejects_unsupported_fields_aliases_and_missing_collections',
            'editor_requires_explicit_uuid_target_and_diagnostics_have_one_source',
            'invalid_batch_type_rolls_back_without_defaulting_to_string',
            'public_duplicate_preserves_stable_interface_values_and_parent_links',
            'independent_same_named_columns_require_explicit_identity_resolution',
            'loading_inconsistent_inheritance_does_not_repair_or_save',
            'interface_name_cells_are_rejected_and_normal_namespace_is_preserved',
            'unsupported_operations_are_unknown_and_record_draft_is_read_only',
            'codegen_rejects_a_missing_table_data_name',
            'whole_table_update_requires_the_read_revision_and_retains_undo_redo',
            'interfaces_is_an_ordinary_tables_subdirectory',
            'strict_identity_accepts_legitimate_inherited_column_removal',
            'root_interface_files_are_explicitly_rejected_without_being_moved',
            'unsupported_column_fields_leave_disk_and_loaded_state_unchanged',
            'rename_collision_resolution_follows_branch_identity_not_column_order',
            'columns_missing_from_history_are_rejected_without_repair',
            'interface_description_replays_merges_and_reverts_from_history',
            'committed_snapshot_rejects_untracked_history_and_unknown_column_identity',
            'editing_requires_the_column_revision_while_creation_can_use_null',
            'rejected_input_and_export_keep_typed_diagnostics_without_string_prefixes',
        ),
        'record_inheritance': (
            'multilevel_local_empty_zero_false_and_default_are_distinct',
            'inherited_formulas_use_child_context_and_hidden_parent_remains_source',
            'detach_materializes_formulas_and_undo_restores_inputs',
            'reparent_preserves_default_and_local_overrides',
            'invalid_parent_cycles_are_atomic_and_distinct_from_formula_cycles',
            'clear_command_undo_and_absence_survive_roundtrip',
            'raw_serialization_preserves_absence_without_materialization',
            'deep_chain_resolution_is_iterative_and_memoized',
            'parent_formula_edit_validates_descendants_atomically',
            'column_deletion_and_undo_restore_absence_by_uuid',
            'inherited_lookup_keeps_explicit_target_and_formula_cycle_is_separate',
            'reference_and_curve_inputs_inherit_as_whole_cells',
            'numeric_empty_query_membership_does_not_depend_on_value_provenance',
            'standalone_export_and_presentation_reuse_lazy_parent_indices',
            'minimal_export_preserves_effective_values_and_omits_effective_defaults',
            'checked_batch_clear_restores_inherit_atomically_and_undo_preserves_inputs',
            'release_lint_keeps_hidden_parent_as_input_source',
        ),
        'typed_color_authoring': (
            'rgba_mutation_atomicity_history_storage_and_memos',
            'defaults_exports_versions_and_current_type_contract',
            'interface_defaults_history_revert_and_serialization',
            'interface_type_edit_normalizes_existing_values',
            'messagepack_schema_preserves_color_identity_rgba_and_rejects_unsupported_type',
            'messagepack_mutation_and_committed_broadcast_preserve_typed_colors',
        ),
        'color_swatch_authoring': (
            'column_editor_requires_an_explicit_content_version',
            'named_rgba_inputs_normalize_without_losing_precision_or_transparent_rgb',
            'draft_swatch_selection_validates_only_precision_and_canonical_rgba',
            'column_palette_edits_are_atomic_undoable_and_survive_type_changes_and_reload',
            'swatch_only_interface_history_propagates_and_rename_revert_preserves_identity',
            'interface_palette_lists_are_an_independent_three_way_merge_field',
            'authoring_wire_contains_presets_but_runtime_and_sdk_metadata_are_unchanged',
            'persisted_non_color_columns_and_inactive_interface_history_reject_invalid_presets',
            'inherited_column_palette_cannot_be_overridden_through_table_editor',
        ),
        'memo_interface_regression': (
            'table_duplication_remaps_local_memo_keys_and_preserves_payloads',
            'interface_memo_history_reopens_rebuilds_and_reconciles_without_losing_cell_memos',
        ),
        'column_conversion_diagnostics': (
            'conversion_failures_keep_codes_through_preview_and_save_without_mutation',
            'bounded_conversion_samples_preserve_late_error_codes',
            'successful_conversion_and_empty_values_keep_the_existing_contract',
        ),
        'formula_completion_catalog': (
            'every_completion_builtin_is_dispatched_by_the_real_evaluator',
            'completion_catalog_tracks_all_native_dispatch_names',
        ),
        'table_edit_controls': (
            'defaults_required_fields_and_settings_round_trip_with_stale_revision_rejection',
            'table_protections_reject_structure_cells_row_metadata_and_complete_replace_atomically',
            'read_only_preserves_existing_inputs_allows_formula_defaults_and_settings_undo',
            'unrestricted_edits_keep_settings_guards_and_identity_after_file_move',
            'command_path_lookup_checks_uuid_and_falls_back_after_relocation',
            'current_deletion_control_blocks_undo_of_an_added_row_without_moving_history',
            'locked_cells_allow_default_only_rows_but_reject_creation_overrides',
            'protected_second_table_rolls_back_a_multi_table_transaction_before_any_save',
            'interface_derived_add_remove_and_sync_respect_table_controls_atomically',
            'interface_undo_redo_respects_current_column_controls_before_saving_definition',
            'interface_column_read_only_is_table_local_and_survives_reopen_and_sync',
            'whole_table_and_folder_deletion_cannot_erase_unloaded_protected_tables',
            'typed_document_apis_reject_table_and_project_paths_before_mutation',
            'table_creation_and_relocation_cannot_change_document_type_or_replace_protected_files',
            'changing_a_lock_and_converting_raw_values_requires_separate_saves',
            'authoring_controls_never_enter_runtime_metadata_exports',
            'metadata_edits_round_trip_history_and_uuid_memos',
            'table_description_save_and_undo',
            'interface_display_label_is_independent_of_validated_data_name_and_undoable',
            'settings_display_name_is_independent_validated_and_undoable',
            'legacy_user_settings_get_lossless_structural_protection',
            'plugin_complete_root_identity_payload_roundtrips_update',
            'shortcut_bulk_cells_and_version_validate_before_any_write_and_one_undo_restores_all',
        ),
    }
    integration.update({
        'audit_data_integrity': (
            'stale_metadata_save_and_close_preserve_newer_settings_and_draft',
            'rejected_close_keeps_original_project_session_on_switch',
            'export_suffixes_preserve_every_origin_qualified_value',
            'direct_rename_collision_is_atomic_and_remains_reloadable',
            'merge_cross_fields_reject_invalid_default_but_keep_empty_and_formulas',
            'shortcut_merge_edge_cannot_choose_dominated_older_base',
            'automatic_final_state_sync_preserves_restored_uuid_values_and_memos',
            'shared_ancestor_sync_and_detach_preserve_single_identity_and_values',
            'conflict_history_file_is_retained_even_after_successful_import',
            'last_late_parent_field_disappears_without_touching_local_order',
            'multi_interface_collision_preview_includes_prior_selection_not_shared_identity',
            'legacy_synced_sibling_does_not_retain_removed_ancestor_forever',
            'pending_shared_interfaces_commit_together_and_one_undo_restores_both',
            'truncated_or_deleted_metadata_refuses_save_and_close_without_flushing_tables',
        ),
        'codegen_identifier_safety': (
            'emit_keyword_and_string_safety_compile_fixtures',
            'arbitrary_tags_and_select_strings_survive_language_escaping',
            'project_display_name_cannot_escape_generated_comment',
            'cpp_rejects_reserved_helper_spelling_without_restricting_other_targets',
            'cpp_project_comment_cannot_splice_the_next_source_line',
            'cpp_final_table_type_and_owner_member_names_are_validated',
            'csharp_live_key_handle_and_framework_names_are_guarded',
            'cpp_interface_concepts_require_the_actual_return_types',
        ),
        'formula_collections_integration': (
            'scalar_collection_matrix',
            'scope_and_named_columns',
            'column_name_atoms_preserve_errors_and_diagnostic_locations',
            'reused_engine_observes_schema_and_name_changes',
            'typed_number_operators_preserve_scalar_comparison_rules',
            'failed_evaluation_releases_state',
            'table_chain_version_and_lazy_cycles',
            'uniform_parser_for_scalar_and_collection_expressions',
            'one_grammar_for_cells_bindings_and_interpolation',
            'limits_and_cancel_boundaries',
            'reference_identity_and_output_targets',
            'cancel_during_join_and_resume',
            'snapshot_same_stamp_and_reuse',
            'full_minimal_streaming_and_failure',
            'stable_order_and_exact_numeric_keys',
            'tableref_interface_and_typed_field_validation',
            'engine_only_cancel_during_disk_table',
            'nested_recursive_expression_stack_safety',
            'record_field_order_and_empty_callback_syntax',
            'lookup_preserves_return_type',
            'small_stack_and_nested_dependencies_recover',
            'large_cell_string_allocation_budget',
            'ffi_sized_stacks_and_reuse',
            'source_and_inventory_limits_recover',
            'source_reservation_drop_and_failure_atomicity',
            'cached_source_rebinds_new_root_budget',
            'prebuilt_inventory_cannot_bypass_typed_budget',
            'lazy_strict_mixed_roots_and_start_failure',
            'lazy_strict_dependency_promotion_and_first_read_ledger',
            'unselected_collection_does_not_scan_inventory',
            'automatic_interface_reload_preserves_pending_and_recovers_from_conflict',
            'diagnostic_literal_dependency_identity_and_context_reset',
            'diagnostic_unicode_lambda_spans_and_success_clear',
            'diagnostic_presentation_includes_source_and_cell_identity',
            'diagnostic_escaped_interpolation_and_dependency_source_provenance',
            'diagnostic_limits_cancel_classification_and_reuse',
            'diagnostic_missing_field_and_join_pair_indices',
            'diagnostic_type_boundaries_keep_precise_callback_spans',
            'diagnostic_full_minimal_streaming_errors_include_source_identity',
            'token_buffer_boundaries_preserve_values_and_utf8_spans',
            'scalar_numeric_builtins_preserve_float_kind_between_calls',
            'unknown_collection_fields_refine_independently_of_record_order',
        ),
        'referenced_deletion_regression': (
            'unopened_reference_refuses_atomically_and_preview_agrees',
            'atomic_cross_table_delete_then_undo_redo',
            'self_reference_and_selected_mutual_references_can_be_deleted',
            'default_formula_and_interface_values_are_references',
            'surviving_child_refuses_direct_command',
            'unified_operations_refuse_delete_and_label_keeps_uuid',
            'redo_rechecks_new_surviving_references',
            'replicated_deletion_refuses_before_replacing_state',
            'inherited_reference_preview_includes_child_after_clear',
            'reference_picker_labels_resolve_inherited_formulas_after_clear',
            'externally_added_reference_in_loaded_sibling_prevents_stale_delete',
        ),
    })
    integration.update({
        'connected_client_count': ('connected_client_count_tracks_live_sockets_without_stopping_listener',),
        'current_wire_contract': (
            'server_rejects_raw_operations_and_returns_envelopes_and_snapshots',
            'client_rejects_raw_and_operation_broadcasts_without_replaying_them',
            'client_applies_only_the_snapshot_receive_path', 'service_info_requires_connection_order',
            'current_chunk_framing_preserves_large_messages_and_rejects_bad_frames'),
    })
    integration['write_locks'] = (
        'temp_lock_child',
        'readers_share_then_writer_waits_and_handoffs_without_project_residue',
        'dead_writer_releases_waiter_without_unlinking_sentinel',
        'unrelated_files_remain_independent_and_multikey_order_is_stable',
        'replacement_rename_and_canonical_alias_keep_target_identity',
        'failed_or_unwound_operations_release_lock_without_project_residue',
        'normal_release_reclaims_target_and_waiter_retries_deleted_identity',
        'crash_residue_is_reused_then_reclaimed_without_pid_or_age_guessing',
        'many_targets_and_partial_acquisition_failure_do_not_accumulate_sentinels',
    )
    required = {name: 1 for names in integration.values() for name in names}
    studio_store = {name: 1 for name in (
        'load_save_restart_noop_and_clear_preserve_typed_values',
        'malformed_input_and_persisted_source_are_never_overwritten',
        'concurrent_windows_have_one_writer_and_strict_readers_observe_committed_source',
        'child_process_store_writer',
        'concurrent_processes_use_the_settings_editor_lock_and_revision',
        'apply_requires_exact_precision_and_ui_color_requires_opaque_bytes',
)}
    studio_store.update({'app_settings_store::tests::':11,'store::warning_tests::':1,'settings_resources_store::tests::':13})
    if sys.platform != 'win32':
        required.update({name: 1 for name in (
            'directory_symlink_cycles_are_skipped_for_labels_and_rejected_by_strict_catalogs',
            'linked_tables_root_is_not_followed_even_when_its_target_is_missing',
            'temporary_io_failure_is_retried_without_requiring_a_content_or_mtime_change',
            'dangling_destination_symlink_is_rejected_with_a_semantic_path',
            'explicit_table_open_rejects_directories_and_links_without_changing_data',
            'explicit_interface_open_rejects_links_and_directories_but_preserves_regular_documents',
            'automatic_interface_reload_rejects_foreign_symlinks_and_cycles',
        )})
    if sys.platform == 'linux':
        required['fifo_table_sources_are_never_opened_and_strict_discovery_reports_them'] = 1
    core = {'plugin_resources::tests::': 1,
            'app_catalog::tests::': 3,
            'edit_controls::fixed_settings_tests::': 1,
            'theme_schema::tests::': 1,
            'localization::release_contract_tests::': 1,
            'table_catalog::display_metadata_stream_tests::': 3,
            'table_storage::tests::': 2,
            'replication::typed_storage_tests::': 2,
            'app_settings_migration::tests::': 2,
            'app_error::authoring_contract_tests::': 5,
            'p2p_errors::localization_tests::': 3,
            'msgpack_client::localization_tests::': 3,
            'msgpack_server::localization_tests::': 9,
            'p2p_auth::tests::': 5, 'project_paths::tests::': 6,
            'msgpack_framing::resource_tests::': 2, 'registry::private_discovery_tests::': 2,
            'p2p_diagnostics::tests::': 1, 'conflict_resolution::tests::': 6,
            'write_locks::tests::': 1, 'table_mutation::read_dependency_tests::': 1,
            'project_impl::history_file_tests::': 1}
    native = {'formula_completion_tests::': 1,
              'settings_contract_tests::': 48,
              'settings_profile::tests::': 9,
              'plugin_packages::version_profile_tests::': 10,
              'plugin_catalog::diagnostic_tests::': 1,
              'command_dispatcher::tests::': 3,
              'color_preview::color_preview_diagnostic_tests::': 1,
              'p2p_event_listener::localization_tests::': 1,
              'rule_commands::native_snapshot_regression_tests::native_snapshot_weight_counts_nested_formula_diagnostics_without_flattening': 1}
    native_filters = tuple(native)
    if sys.platform != 'win32':
        native['plugin_packages::version_profile_tests::'] = 11
        native['plugin_packages::version_profile_tests::symlinked_archive_aborts_without_publishing_or_changing_source'] = 1
    cargo = ('cargo', 'test', '--locked', '--release', '--all-features')
    # Multiple libtest filters are ORed. Explicit output is verified below so
    # misspelled filters, disabled features, ignored tests or --no-run fail closed.
    harness = ('--format=pretty', '--color=never', '--test-threads=1')
    return (
        (cargo + ('-p', 'devcel-core') + tuple(
            arg for target in integration for arg in ('--test', target)) + ('--',) + harness,
         required, len(integration)),
        (cargo + ('-p', 'devcel-core', '--lib', '--') + tuple(core) + harness, core, 1),
        (cargo + ('-p', 'devcel-studio', '--lib', '--') + native_filters + harness, native, 1),
        (cargo + ('-p', 'devcel-studio', '--test', 'user_color_swatches_store', '--') + harness, studio_store, 1),
        (cargo + ('-p', 'devcel-cli', '--test', 'managed_server_lifecycle', '--') + harness,
         {'failed_start_releases_ownership_before_same_manager_opens_another_project': 1}, 1),
        (cargo + ('-p', 'devcel-runtime', '--test', 'regressions', '--') + harness,
         {
             'minimal_restores_all_scalar_defaults_and_preserves_explicit_empty': 1,
             'table_ref_is_preserved_as_text': 1,
             'rejects_duplicate_names_and_record_ids': 1,
             'reload_invalid_same_hash_keeps_old_snapshot': 1,
             'invalid_scalars_are_errors_instead_of_silent_zero': 1,
             'integer_boundaries_retain_u64_bits': 1,
             'rejects_missing_required_metadata_and_unsupported_type_names': 1,
             'reload_rejects_missing_metadata_before_same_hash_fast_path': 1,
             'curve_requires_explicit_current_tangent_mode_but_keeps_empty_default': 1,
             'typed_rgba_survives_defaults_native_access_and_validation': 1,
             'invalid_color_same_hash_reload_is_atomic': 1,
             'record_reference_table_requires_uuid_and_current_interface_membership': 1,
             'f32_max_decimal_roundtrip_uses_finite_f32_conversion': 1,
         }, 1),
        (cargo + ('-p', 'devcel-cli', '--bin', 'devcel', '--',
                  'wolf_export::tests::minimal_blank_numeric_boolean_defaults_match_full_values') + harness,
         {'wolf_export::tests::minimal_blank_numeric_boolean_defaults_match_full_values': 1}, 1),
    )


def checked_rust_tests(command, required, harnesses):
    """Require successful execution, not merely compilation or a zero-test exit."""
    try:
        import tempfile
        with tempfile.TemporaryDirectory(prefix='devcel-rust-session-') as directory:
            previous = os.environ.get('DEVCEL_P2P_SESSION_DIR')
            os.environ['DEVCEL_P2P_SESSION_DIR'] = str(Path(directory)/'sessions')
            try:
                output = run(*command, cwd=ROOT, capture=True)
            finally:
                if previous is None:
                    os.environ.pop('DEVCEL_P2P_SESSION_DIR', None)
                else:
                    os.environ['DEVCEL_P2P_SESSION_DIR'] = previous
    except subprocess.CalledProcessError as error:
        if error.stdout:
            print(error.stdout, end='', flush=True)
        raise
    print(output, end='', flush=True)
    passed = re.findall(r'^test (\S+) \.\.\. ok$', output, re.MULTILINE)
    summaries = re.findall(
        r'^test result: ok\. (\d+) passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out;.*$',
        output, re.MULTILINE)
    if (len(re.findall(r'^test result:', output, re.MULTILINE)) != harnesses
            or len(summaries) != harnesses or any(int(count) == 0 for count in summaries)
            or sum(map(int, summaries)) != len(passed)):
        raise ValueError('Rust regression gate did not execute every required test harness.')
    for name, minimum in required.items():
        count = sum(test.startswith(name) if name.endswith('::') else test == name
                    for test in set(passed))
        if count < minimum:
            raise ValueError(f'Rust regression coverage missing: {name} ({count}/{minimum} passed).')


def strict_checks():
    """Fail-closed frontend, Rust lint and executed regression gates for CI."""
    studio = ROOT/'devcel-studio'
    run('npm', 'run', 'check:lint', cwd=studio)
    run('npm', 'run', 'typecheck', cwd=studio)
    run('npm', 'run', 'lint', cwd=studio)
    run('npm', 'run', 'check:studio-batch', cwd=studio)
    # Reuse the release cache instead of adding a separate debug dependency tree.
    run('cargo', 'clippy', '--locked', '--release', '--workspace', '--all-targets',
        '--all-features', '--', '-D', 'warnings')
    for command, required, harnesses in rust_regression_gates():
        checked_rust_tests(command, required, harnesses)


def platform_config():
    if sys.platform == 'win32':
        return 'windows', 'win-x64', None, 'devcel-studio.exe'
    if sys.platform == 'linux':
        return 'linux', 'linux-x64', 'deb', 'devcel-studio'
    if sys.platform == 'darwin':
        arch = {'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}.get(platform.machine())
        if arch:
            # Request app explicitly: dmg-only bundling deletes its intermediate app.
            return 'macos-'+arch, 'osx-'+arch, 'app,dmg', 'devcel-studio'
    raise ValueError('Unsupported native release OS/CPU.')


def frontend_release():
    """Tauri production hook: generate catalogs/SDK and build Vite."""
    studio = ROOT/'devcel-studio'
    # build_native has already built the distributable CLI. Reuse it for generation.
    cli = ROOT/studio_cli.DIRECTORY/('devcel.exe' if sys.platform == 'win32' else 'devcel')
    for command, output in (('localization', 'src/app/i18n/generated'),
                            ('app-catalog', 'src/app/settings/generated')):
        run(cli, '--project', studio/'app-settings', command, 'export', '--out', studio/output)
    run('node', 'scripts/sync-plugin-sdk.js', cwd=studio)
    run('node', 'node_modules/vite/bin/vite.js', 'build', cwd=studio)


def cargo_target():
    target = Path(os.environ.get('CARGO_TARGET_DIR', ROOT/'target'))
    return target if target.is_absolute() else ROOT/target


def clean_native_outputs():
    """Remove generated packages, preserving all Rust compilation artifacts."""
    target = cargo_target()
    if ROOT.resolve().is_relative_to(target.resolve()):
        raise ValueError('Cargo output cannot be the source root or its ancestor')
    release = target/'release'
    if release.is_symlink():
        raise ValueError('Refusing package cleanup through a release-directory symlink')
    for name in ('bundle', 'portable'):
        path = release/name
        if path.is_symlink(): path.unlink()
        elif path.exists(): shutil.rmtree(path)


def build_native():
    system, importer_platform, bundles, executable = platform_config()
    if system.startswith('macos-'):
        studio_cli.configure_macos(ROOT)
    run(sys.executable, 'scripts/generate-third-party-notices.py', '--ensure')
    # Restored caches can contain old packaging outputs even when glob excludes
    # name them: tar recursively archives a selected parent directory.
    clean_native_outputs()
    reports = ROOT/'release-reports'
    if reports.is_symlink(): reports.unlink()
    elif reports.exists(): shutil.rmtree(reports)
    with studio_cli.build_flags(importer_platform):
        run('cargo', 'build', '--locked', '--release', '-p', 'devcel-cli')
    cli_config = studio_cli.stage(ROOT, cargo_target(), importer_platform)
    options = ['--bundles', bundles] if bundles else ['--no-bundle']
    run('npm', 'run', 'tauri', '--', 'build', *options,
        '--config', cli_config, cwd=ROOT/'devcel-studio')
    target = cargo_target()
    if system.startswith('macos-'):
        # Resources must retain the bytes hashed before the outer app is signed.
        app = target/'release/bundle/macos/devcel-studio.app'
        staged = studio_cli.validate(ROOT/studio_cli.DIRECTORY, importer_platform)
        if studio_cli.validate(app/'Contents/Resources/bin', importer_platform) != staged:
            raise ValueError('macOS bundled CLI differs from the staged payload')
        run('codesign', '--verify', '--deep', '--strict', app)
    if system == 'windows':
        # A dedicated directory cannot accidentally ship stale MSI/NSIS files.
        portable = target/'release/portable'
        version = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
        run(sys.executable, 'scripts/package-windows-studio.py',
            '--executable', target/'release'/executable,
            '--out', portable/f'devcel-studio-{version}-windows-x64.zip')
    elif system == 'linux':
        version = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
        run(sys.executable, 'scripts/debian_version.py', '--bundle-dir', target/'release/bundle/deb', '--version', version)
    return system, importer_platform, executable, target


def native_artifact_dir(system, target):
    folder = 'bundle/dmg' if system.startswith('macos-') else ('portable' if system == 'windows' else 'bundle/deb')
    return target/'release'/folder


def studio_binary(system, executable, target):
    # The signed Mach-O differs from the unsigned Cargo output. Compare the DMG
    # to the sealed app produced by this build, not a normalized/stripped binary.
    if system.startswith('macos-'):
        return target/'release/bundle/macos/devcel-studio.app/Contents/MacOS'/executable
    return target/'release'/executable


def verify_native(system, executable, target):
    run(sys.executable, 'scripts/check-native-release-artifacts.py', '--platform', 'macos' if system.startswith('macos-') else system,
        '--bundle-dir', native_artifact_dir(system, target), '--first-party', studio_binary(system, executable, target),
        '--first-party', ROOT/studio_cli.DIRECTORY/('devcel.exe' if system == 'windows' else 'devcel'),
        '--report-dir', ROOT/'release-reports')


def inspect_native():
    # Explicit manual review evidence; never a release publication input.
    system, _, executable, target = build_native()
    out = ROOT/'native-review-artifacts'
    if out.exists(): shutil.rmtree(out)
    out.mkdir()
    shutil.copytree(native_artifact_dir(system, target), out/'bundle')
    shutil.copyfile(studio_binary(system, executable, target), out/executable)
    shutil.copytree(ROOT/studio_cli.DIRECTORY, out/'bundled-cli')
    # Keep evidence even when the fail-closed notice review rejects the payload.
    verify_native(system, executable, target)


def studio_asset_name(system, tag):
    """The public Studio filename, independent of native bundler conventions."""
    if not SEMVER.fullmatch(tag):
        raise ValueError('A valid release tag is required for Studio asset naming.')
    formats = {'linux': ('linux-x64', 'deb'), 'windows': ('windows-x64', 'zip'),
               'macos-x64': ('macos-x64', 'dmg'), 'macos-arm64': ('macos-arm64', 'dmg')}
    if system not in formats:
        raise ValueError('Unsupported Studio release platform: '+system)
    platform, extension = formats[system]
    return f'devcel-studio-{tag[1:]}-{platform}.{extension}'


def package():
    system, importer_platform, executable, target = build_native()
    out = ROOT/'release-assets'
    if out.is_symlink(): out.unlink()
    elif out.exists(): shutil.rmtree(out)
    out.mkdir()
    name = studio_asset_name(system, os.environ['RELEASE_TAG'])
    suffix = Path(name).suffix
    artifacts = [path for path in native_artifact_dir(system, target).rglob('*')
                 if path.is_file() and path.suffix.lower() == suffix]
    if len(artifacts) != 1 or artifacts[0].is_symlink():
        raise ValueError('Expected exactly one Studio package: '+system)
    if system == 'windows' and artifacts[0].name != name:
        raise ValueError('Windows Studio package does not match the release version/platform.')
    # Rename only the publication copy. Native package names and bytes stay intact.
    shutil.copyfile(artifacts[0], out/name)
    run(sys.executable, 'scripts/package-importers.py', '--out', ROOT/'release-importers',
        '--platform', importer_platform, '--source-repository', os.environ['SOURCE_REPOSITORY'],
        '--source-commit', os.environ['SOURCE_COMMIT'])
    archives = sorted((ROOT/'release-importers').glob('*.zip'))
    if len(archives) != 9:
        raise ValueError(f'Expected nine native importer archives, got {len(archives)}')
    for archive in archives: shutil.copyfile(archive, out/archive.name)
    if system == 'linux':
        run(sys.executable, 'scripts/release_source.py', '--out', out/release_source.ASSET,
            '--repository', os.environ['SOURCE_REPOSITORY'], '--commit', os.environ['SOURCE_COMMIT'],
            '--tag', os.environ['RELEASE_TAG'], '--verify-urls')


def collect_assets(downloads, destination, tag, expected_commit=None, expected_repository=None):
    platforms = {'Linux': ('linux', 'linux-x64'), 'Windows': ('windows', 'win-x64'),
                 'macOS-X64': ('macos-x64', 'osx-x64'), 'macOS-ARM64': ('macos-arm64', 'osx-arm64')}
    expected_studio = {label: studio_asset_name(system, tag)
                       for label, (system, _) in platforms.items()}
    roots = [downloads/('release-'+label) for label in platforms]
    if any(not path.is_dir() for path in roots):
        raise ValueError('All four native release artifact sets are required.')
    destination.mkdir(parents=True, exist_ok=True)
    files = []
    for directory in roots:
        entries = sorted(directory.iterdir())
        if not entries: raise ValueError(f'Empty release artifact set: {directory.name}')
        label = directory.name.removeprefix('release-')
        platform = platforms[label][1]
        for engine in ('unity', 'godot', 'unreal', 'rpgmaker', 'wolf', 'gamemaker', 'defold', 'cocos', 'javascript'):
            expected = directory/f'devcel-{engine}-{tag[1:]}-{platform}.zip'
            if list(directory.glob(f'devcel-{engine}-*-{platform}.zip')) != [expected]:
                raise ValueError(f'Missing or duplicate {platform} {engine} importer')
            with zipfile.ZipFile(expected) as archive:
                manifests = []
                for entry in archive.infolist():
                    if entry.filename.endswith('/manifest.json'):
                        if entry.file_size > 1024*1024:
                            raise ValueError('Importer manifest too large')
                        value = json.loads(archive.read(entry))
                        if isinstance(value, dict) and 'binaries' in value:
                            manifests.append(value)
                if len(manifests) != 1:
                    raise ValueError('Importer requires one CLI manifest')
                manifest = manifests[0]
                commit = manifest.get('source_commit', '')
                repository = manifest.get('source_repository', '')
                if expected_repository is None:
                    expected_repository = repository
                if expected_commit is None:
                    expected_commit = commit
                if (manifest.get('schema_version') != 1 or manifest.get('version') != tag[1:] or manifest.get('supportedPlatforms') != [platform]
                        or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', repository)
                        or repository.lower() != expected_repository.lower()
                        or not re.fullmatch(r'[a-f0-9]{40}', commit) or commit != expected_commit
                        or platform not in manifest.get('binaries', {})):
                    raise ValueError('Importer version/source commit/platform mismatch')
        system = directory.name.removeprefix('release-')
        studio = list(directory.glob('devcel-studio-*'+Path(expected_studio[system]).suffix))
        if len(studio) != 1 or studio[0].name != expected_studio[system]:
            raise ValueError(f'Missing, duplicate, or wrong-version/platform Studio package: {platform}')
        forbidden = {'.appimage', '.rpm', '.msi', '.exe'}
        if not platform.startswith('osx-'): forbidden.add('.dmg')
        if any(path.suffix.lower() in forbidden for path in entries):
            raise ValueError('Unsupported release installer')
        if platform == 'linux-x64' and not (directory/release_source.ASSET).is_file():
            raise ValueError('Matching source-access manifest is required.')
        expected_count = 11 if platform == 'linux-x64' else 10
        if len(entries) != expected_count:
            raise ValueError(f'Unexpected release asset count: {platform}')
        for source in entries:
            if not source.is_file() or source.is_symlink(): raise ValueError('Unexpected release entry')
            target = destination/source.name
            if target.exists(): raise ValueError('Duplicate release asset: '+source.name)
            shutil.copyfile(source, target)
            files.append(target)
    # Mobile archives belong to the same immutable release source. They add
    # Player runtimes without replacing the Editor's platform-specific runtime.
    mobile = {system: downloads/f'release-mobile-{system}'/f'unity-mobile-{system}.zip'
              for system in ('android', 'ios', 'webgl')}
    for path in mobile.values():
        if not path.is_file() or path.is_symlink() or list(path.parent.iterdir()) != [path]:
            raise ValueError('Android, iOS and WebGL runtime artifacts are required')
    for source in list(files):
        prefix = f'devcel-unity-{tag[1:]}-'
        if source.name.startswith(prefix) and source.suffix == '.zip':
            platform = source.name[len(prefix):-4]
            files.append(unity_upm.create(source, destination, tag[1:], platform, mobile))
    files += unity_git_package.create(
        {rid: destination/f'devcel-unity-{tag[1:]}-{rid}.zip' for rid in unity_git_package.RIDS},
        mobile, destination, tag[1:], expected_commit, expected_repository,
        'github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com')
    sums = destination/'SHA256SUMS.txt'
    sums.write_text(''.join(hashlib.sha256(path.read_bytes()).hexdigest()+'  '+path.name+'\n'
                            for path in sorted(files)), encoding='utf-8', newline='\n')
    return files+[sums]


def publication_notes(tag, source_notes, product_notes, notes_version):
    """Validate explicit publication input and retain exact source directions."""
    if not SEMVER.fullmatch(tag):
        raise ValueError('A valid release tag is required for release notes.')
    if not product_notes and not notes_version:
        return source_notes
    if notes_version != tag[1:]:
        raise ValueError('Product release notes version does not match the release tag.')
    raw = product_notes.encode('utf-8')
    if not product_notes.strip() or len(raw) > 65536 or '\0' in product_notes:
        raise ValueError('Product release notes must be nonempty UTF-8 text of at most 64 KiB without NUL.')
    release_privacy.check_bytes(raw, 'release-description')
    return product_notes.replace('\r\n', '\n').strip()+'\n\n'+source_notes


def publish(source_root=None, before_create=None, before_publish=None):
    source_root = ROOT if source_root is None else Path(source_root).resolve()
    tag = os.environ['RELEASE_TAG']
    validate(tag, root=source_root)
    commit = checked_commit(os.environ['SOURCE_COMMIT'], root=source_root)
    new_release = (os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
                   not os.environ.get('RECOVERY_RUN_ID') and os.environ.get('REBUILD_EXISTING_TAG') != 'true')
    git_package_available = new_release
    existing_prepared_tag = ''
    existing_git_release = None
    if new_release:
        existing_prepared_tag = run('git', 'ls-remote', '--refs', 'https://github.com/'+os.environ['GH_REPO']+'.git',
                                    'refs/tags/'+tag, capture=True).strip()
    else:
        tagged = run('gh', 'api', 'repos/{owner}/{repo}/commits/refs/tags/'+tag, '--jq', '.sha', capture=True).strip()
        if tagged != commit:
            run('git', 'fetch', '--no-tags', 'https://github.com/'+os.environ['GH_REPO']+'.git', tagged, cwd=source_root)
            if unity_git_package.source_identity(source_root, tagged) != commit:
                raise ValueError('Release tag no longer points to the built source.')
            git_package_available = True
            existing_git_release = tagged
    # Include draft releases and every page. API errors must not mean "absent".
    releases = json.loads(run('gh', 'api', '--paginate', '--slurp',
                             'repos/{owner}/{repo}/releases?per_page=100', capture=True))
    if any(release['tag_name'] == tag for page in releases for release in page):
        raise ValueError('A release already exists for this tag; inspect it before retrying.')
    repository = os.environ['GH_REPO']
    run(sys.executable, ROOT/'scripts/generate-third-party-notices.py', '--ensure', '--repo', source_root)
    files = collect_assets(ROOT/'release-downloads', ROOT/'release-publish', tag, commit, repository)
    if existing_git_release:
        prepared = unity_git_package.stage_release(
            ROOT/'release-publish'/f'org.devcel.unity-{tag[1:]}-git.zip',
            ROOT/'release-publish'/f'org.devcel.unity-{tag[1:]}-git.json', source_root,
            'github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com')
        unity_git_package.verify_release_tree(source_root, existing_git_release, prepared)
    release_privacy.check_bytes((ROOT/'release-publish'/release_source.ASSET).read_bytes(), release_source.ASSET)
    release_privacy.check_bytes((ROOT/'release-publish'/'SHA256SUMS.txt').read_bytes(), 'SHA256SUMS.txt')
    release_source.validate_index(ROOT/'release-publish'/release_source.ASSET, repository, commit, tag, source_root)
    # Read current repository visibility.
    repo = json.loads(run('gh', 'api', 'repos/{owner}/{repo}', capture=True))
    if repo.get('full_name', '').lower() != repository.lower():
        raise ValueError('Source repository identity differs from the release destination.')
    visibility = repo.get('visibility')
    index = release_source.source_index(repository, commit, tag, source_root)
    notes = publication_notes(tag, release_source.source_notes(index, visibility),
                              os.environ.get('PRODUCT_RELEASE_NOTES', ''),
                              os.environ.get('PRODUCT_RELEASE_NOTES_VERSION', ''))
    if before_create is not None:
        before_create()
    if new_release:
        release_commit = unity_git_package.stage_release(
            ROOT/'release-publish'/f'org.devcel.unity-{tag[1:]}-git.zip',
            ROOT/'release-publish'/f'org.devcel.unity-{tag[1:]}-git.json', source_root,
            'github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com')
        remote = 'https://github.com/'+repository+'.git'
        if existing_prepared_tag:
            if existing_prepared_tag != release_commit+'\trefs/tags/'+tag:
                raise ValueError('Existing tag differs from the exact prepared release; no tag was changed.')
        else:
            if run('git', 'ls-remote', '--refs', remote, 'refs/tags/'+tag, capture=True).strip():
                raise ValueError('Release tag was created concurrently; no tag was changed.')
            # Publish main and the immutable tag together; reject concurrent main updates.
            main = run('git', 'ls-remote', '--refs', remote, 'refs/heads/main', capture=True).strip()
            if main != commit+'\trefs/heads/main':
                raise ValueError('Main moved since the source build; refusing to publish stale Unity assets.')
            run('git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
                'push', '--atomic', remote, release_commit+':refs/heads/main',
                release_commit+':refs/tags/'+tag, cwd=source_root)
        if run('gh', 'api', 'repos/{owner}/{repo}/commits/refs/tags/'+tag, '--jq', '.sha', capture=True).strip() != release_commit:
            raise ValueError('Tag publication outcome uncertain; inspect remotely before retrying.')
        main_now = run('git', 'ls-remote', '--refs', remote, 'refs/heads/main', capture=True).strip()
        if main_now != release_commit+'\trefs/heads/main':
            raise ValueError('Main no longer points to the generated package commit; inspect before publishing.')
    if git_package_available:
        notes += '\n\nUnity Git URL: `https://github.com/'+repository+'.git?path=/importers/unity#'+tag+'`\n'
    # Create a draft first so failed uploads cannot expose an incomplete release.
    # Existing tags are mandatory; an existing release causes failure, never overwrite.
    with tempfile.TemporaryDirectory(prefix='devcel-release-notes-', dir=os.environ.get('RUNNER_TEMP')) as directory:
        path = Path(directory)/'release-notes.md'
        path.write_text(notes, encoding='utf-8', newline='\n')
        run('gh', 'release', 'create', tag, '--verify-tag', '--draft', '--title', 'Devcel '+tag[1:],
            '--notes-file', path, *(['--prerelease'] if '-' in tag else []))
    run('gh', 'release', 'upload', tag, *files)
    if before_publish is not None:
        before_publish()
    run('gh', 'release', 'edit', tag, '--draft=false')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['toolchains', 'check', 'compact_checks', 'strict_checks', 'validate', 'prepare_release', 'prepare_manual_release', 'create_tag',
                                          'build_native', 'package', 'publish', 'inspect_native', 'frontend_release', 'clean_native_outputs'])
    parser.add_argument('--tag')
    args = parser.parse_args()
    if args.command == 'validate':
        if not args.tag: parser.error('--tag is required')
        print('Release version:', validate(args.tag))
    else:
        if args.command in ('build_native', 'inspect_native', 'package'):
            release_privacy.configure(ROOT)
        globals()[args.command]()


if __name__ == '__main__':
    main()
