use devcel_core::{Project, Record};

fn fixture() -> (tempfile::TempDir, Project, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Labels", directory.path().to_str().unwrap(), "", "#abcdef")
            .unwrap();
    let path = project
        .create_table(std::path::PathBuf::from("Group").join("One.table.toml"))
        .unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.display_name = "Before selection".into();
    table.data.description = "A multiline string\n[[records]]\nnot a section".into();
    table.data.records = vec![Record::new()];
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    project.tables_data.clear();
    (directory, project, path)
}

#[test]
fn labels_are_unloaded_record_free_and_refresh_after_moves_and_changes() {
    let (_directory, mut project, path) = fixture();
    let entries = project.get_table_display_catalog_reader()().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].display_name, "Before selection");
    assert!(project.tables_data.is_empty());
    // Cached names update on size/stamp changes, not only after loading.
    let source = std::fs::read_to_string(&path).unwrap();
    std::fs::write(
        &path,
        source.replace("Before selection", "Renamed before opening"),
    )
    .unwrap();
    assert_eq!(
        project.get_table_display_catalog_reader()().unwrap()[0].display_name,
        "Renamed before opening"
    );
    let moved = path.with_file_name("Moved.table.toml");
    std::fs::rename(&path, &moved).unwrap();
    let entries = project.get_table_display_catalog_reader()().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, moved.to_string_lossy());
    project.load_table(&moved).unwrap();
    project
        .tables_data
        .get_mut(&moved)
        .unwrap()
        .data
        .display_name = "Unsaved authoritative name".into();
    assert_eq!(
        project.get_table_display_catalog_reader()().unwrap()[0].display_name,
        "Unsaved authoritative name"
    );
}

#[test]
fn malformed_siblings_do_not_remove_other_names_or_load_any_records() {
    let (_directory, project, path) = fixture();
    std::fs::write(
        path.with_file_name("Broken.table.toml"),
        "[metadata\ninvalid",
    )
    .unwrap();
    assert_eq!(
        project.get_table_display_catalog_reader()().unwrap().len(),
        1
    );
    assert!(
        project.get_table_catalog().is_err(),
        "strict reference discovery must still fail closed"
    );
    assert!(project.tables_data.is_empty());
    // Metadata discovery does not parse a huge or invalid record payload.
    let text = std::fs::read_to_string(&path).unwrap();
    let prefix = text.rsplit_once("[[records]]").unwrap().0;
    std::fs::write(
        &path,
        format!(
            "{prefix}[[records]]\nvalues = \"{}\"\nthis record is intentionally invalid\n",
            "x".repeat(2_000_000)
        ),
    )
    .unwrap();
    let entries = project.get_table_display_catalog_reader()().unwrap();
    assert_eq!(entries[0].display_name, "Before selection");
    assert!(project.tables_data.is_empty());
}

#[test]
fn metadata_after_records_is_streamed_without_parsing_record_values() {
    let (_directory, project, path) = fixture();
    let source = std::fs::read_to_string(&path).unwrap();
    let (header, rows) = source.rsplit_once("[[records]]").unwrap();
    // Every top-level section except metadata stays ahead; place metadata last.
    let start = header.find("[metadata]").unwrap();
    let tail = &header[start..];
    let end = tail.find("[interface_implementations]").unwrap();
    let metadata = &tail[..end];
    let rearranged = format!(
        "{}{}[[records]]{}\n{}",
        &header[..start],
        &tail[end..],
        rows,
        metadata
    );
    std::fs::write(&path, rearranged).unwrap();
    assert_eq!(
        project.get_table_display_catalog_reader()().unwrap()[0].display_name,
        "Before selection"
    );
}

#[test]
fn quoted_dotted_and_interleaved_metadata_have_the_same_display_identity() {
    let (_directory, project, path) = fixture();
    let original = std::fs::read_to_string(&path).unwrap();
    let start = original.find("[metadata]").unwrap();
    let end = original.find("[interface_implementations]").unwrap();
    let metadata = &original[start..end];
    let permissions = metadata.find("[metadata.edit_permissions]").unwrap();
    let quoted = original
        .replace("[metadata]", "[\"meta\\u0064ata\"]")
        .replace(
            "[metadata.edit_permissions]",
            "[ 'metadata' . \"edit_permissions\" ]",
        );
    let mut dotted = String::new();
    let mut prefix = "metadata.";
    for line in metadata.lines() {
        if line == "[metadata]" {
            continue;
        }
        if line == "[metadata.edit_permissions]" {
            prefix = "metadata.edit_permissions.";
            continue;
        }
        if line.contains(" = ") {
            dotted.push_str(prefix);
        }
        dotted.push_str(line);
        dotted.push('\n');
    }
    let dotted = format!("{}{}{}", &original[..start], dotted, &original[end..]);
    let interleaved = format!(
        "{}{}{}\n{}",
        &original[..start],
        &metadata[..permissions],
        &original[end..],
        &metadata[permissions..]
    );
    for source in [quoted, dotted, interleaved] {
        let parsed: toml::Value = toml::from_str(&source).unwrap();
        assert_eq!(parsed["display_name"].as_str(), Some("Before selection"));
        std::fs::write(&path, source).unwrap();
        let entries = project.get_table_display_catalog_reader()().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].display_name, "Before selection");
        assert!(project.tables_data.is_empty());
    }
}

#[test]
fn late_metadata_ignores_fake_sections_inside_multiline_strings_and_nested_arrays() {
    let (_directory, project, path) = fixture();
    let original = std::fs::read_to_string(&path).unwrap();
    let start = original.find("[metadata]").unwrap();
    let end = original.find("[interface_implementations]").unwrap();
    let source = format!("{}[unrelated]\nvalue = \"\"\"\n[metadata]\ndisplay_name = 'not the name'\n\"\"\"\narray = [\n[\"metadata\"],\n]\n{}", &original[..start], &original[start..end]);
    let parsed: toml::Value = toml::from_str(&source).unwrap();
    assert_eq!(parsed["display_name"].as_str(), Some("Before selection"));
    std::fs::write(&path, source).unwrap();
    let entries = project.get_table_display_catalog_reader()().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].display_name, "Before selection");
}

#[test]
fn complete_metadata_stops_before_a_large_unrelated_schema() {
    let (_directory, project, path) = fixture();
    let original = std::fs::read_to_string(&path).unwrap();
    let end = original.find("[interface_implementations]").unwrap();
    // Label discovery is intentionally tolerant of unrelated damaged content.
    // A complete metadata subtree is sufficient, with no schema/record parse.
    std::fs::write(
        &path,
        format!(
            "{}[schema]\nnot valid TOML {}",
            &original[..end],
            "x".repeat(2_000_000)
        ),
    )
    .unwrap();
    assert_eq!(
        project.get_table_display_catalog_reader()().unwrap()[0].display_name,
        "Before selection"
    );
    assert!(project.tables_data.is_empty());
}

#[test]
fn regular_recursive_tables_are_discovered_in_both_catalog_modes() {
    let (_directory, mut project, path) = fixture();
    let second = project
        .create_table(
            std::path::PathBuf::from("More")
                .join("Nested")
                .join("Two.table.toml"),
        )
        .unwrap();
    project.tables_data.clear();
    std::fs::write(second.with_file_name("notes.md"), "regular document").unwrap();
    let entries = project.get_project_entries().unwrap();
    for name in ["One.table.toml", "Two.table.toml", "notes.md", "Nested"] {
        assert!(
            entries.iter().any(|entry| entry.name == name),
            "missing {name}"
        );
    }
    for catalog in [
        project.get_table_display_catalog_reader()().unwrap(),
        project.get_table_catalog().unwrap(),
    ] {
        assert_eq!(catalog.len(), 2);
        assert!(catalog
            .iter()
            .any(|entry| entry.path == path.to_string_lossy()));
        assert!(catalog
            .iter()
            .any(|entry| entry.path == second.to_string_lossy()));
    }
}

#[cfg(unix)]
#[test]
fn directory_symlink_cycles_are_skipped_for_labels_and_rejected_by_strict_catalogs() {
    let (_directory, project, path) = fixture();
    let tables = project.path.parent().unwrap().join("Tables");
    let cycle = tables.join("cycle");
    std::os::unix::fs::symlink(&tables, &cycle).unwrap();
    let entries = project.get_project_entries().unwrap();
    assert!(!entries.iter().any(|entry| entry.name == "cycle"));
    assert!(entries.iter().any(|entry| entry.name == "One.table.toml"));
    let display = project.get_table_display_catalog_reader()().unwrap();
    assert_eq!(display.len(), 1);
    assert_eq!(display[0].path, path.to_string_lossy());
    let error = devcel_core::AppError::from(project.get_table_catalog().unwrap_err());
    let wire = serde_json::to_value(error).unwrap();
    assert_eq!(wire["diagnostics"][0]["code"], "error.tableSourceType");
    assert_eq!(
        wire["diagnostics"][0]["params"]["path"],
        cycle.to_string_lossy().as_ref()
    );
}

#[cfg(target_os = "linux")]
#[test]
fn fifo_table_sources_are_never_opened_and_strict_discovery_reports_them() {
    let (_directory, mut project, path) = fixture();
    let fifo = path.with_file_name("Blocked.table.toml");
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        &fifo,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    let interface_fifo = path.with_file_name("Blocked.interface.toml");
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        &interface_fifo,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    let entries = project.get_project_entries().unwrap();
    assert!(!entries
        .iter()
        .any(|entry| entry.name.starts_with("Blocked")));
    let error = devcel_core::AppError::from(
        devcel_core::interface::Interface::load_from_file(&interface_fifo).unwrap_err(),
    );
    assert_eq!(
        serde_json::to_value(error).unwrap()["diagnostics"][0]["code"],
        "error.tableSourceType"
    );
    let error = devcel_core::AppError::from(project.load_table(&fifo).unwrap_err());
    assert_eq!(
        serde_json::to_value(error).unwrap()["diagnostics"][0]["code"],
        "error.tableSourceType"
    );
    assert!(project.tables_data.is_empty());
    assert_eq!(
        project.get_table_display_catalog_reader()().unwrap().len(),
        1
    );
    let error = devcel_core::AppError::from(project.get_table_catalog().unwrap_err());
    assert_eq!(
        serde_json::to_value(error).unwrap()["diagnostics"][0]["code"],
        "error.tableSourceType"
    );
}

#[cfg(unix)]
#[test]
fn linked_tables_root_is_not_followed_even_when_its_target_is_missing() {
    let directory = tempfile::tempdir().unwrap();
    let project =
        Project::create_project("Linked", directory.path().to_str().unwrap(), "", "#abcdef")
            .unwrap();
    let tables = project.path.parent().unwrap().join("Tables");
    std::fs::remove_dir(&tables).unwrap(); // only this new test fixture's empty directory
    std::os::unix::fs::symlink(directory.path().join("missing"), &tables).unwrap();
    assert!(project.get_project_entries().unwrap().is_empty());
    assert!(project.get_table_display_catalog_reader()()
        .unwrap()
        .is_empty());
    let error = devcel_core::AppError::from(project.get_table_catalog().unwrap_err());
    assert_eq!(
        serde_json::to_value(error).unwrap()["diagnostics"][0]["code"],
        "error.tableSourceType"
    );
}

#[cfg(unix)]
#[test]
fn temporary_io_failure_is_retried_without_requiring_a_content_or_mtime_change() {
    use std::os::unix::fs::PermissionsExt;
    let (_directory, project, path) = fixture();
    let before = std::fs::metadata(&path).unwrap();
    let permissions = before.permissions();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o0)).unwrap();
    if std::fs::File::open(&path).is_ok() {
        // Privileged test runners bypass Unix read permissions; do not pretend
        // that environment exercised the IO-failure branch.
        std::fs::set_permissions(&path, permissions).unwrap();
        eprintln!("SKIP permission-denial simulation: runner can read mode000 files");
        return;
    }
    assert!(project.get_table_display_catalog_reader()()
        .unwrap()
        .is_empty());
    std::fs::set_permissions(&path, permissions).unwrap();
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!(before.len(), after.len());
    assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    let display = project.get_table_display_catalog_reader()().unwrap();
    assert_eq!(display.len(), 1);
    assert_eq!(display[0].display_name, "Before selection");
}

#[cfg(unix)]
#[test]
fn explicit_table_open_rejects_directories_and_links_without_changing_data() {
    let (_directory, mut project, path) = fixture();
    let original = std::fs::read(&path).unwrap();
    let linked = path.with_file_name("Link.table.toml");
    std::os::unix::fs::symlink(&path, &linked).unwrap();
    let folder = path.with_file_name("Folder.table.toml");
    std::fs::create_dir(&folder).unwrap();
    for unsupported in [linked, folder] {
        let error = devcel_core::AppError::from(project.load_table(&unsupported).unwrap_err());
        let wire = serde_json::to_value(error).unwrap();
        assert_eq!(wire["diagnostics"][0]["code"], "error.tableSourceType");
        assert_eq!(
            wire["diagnostics"][0]["params"]["path"],
            unsupported.to_string_lossy().as_ref()
        );
    }
    assert!(project.tables_data.is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    project.load_table(&path).unwrap();
    assert_eq!(project.tables_data.len(), 1);
}

#[cfg(unix)]
#[test]
fn explicit_interface_open_rejects_links_and_directories_but_preserves_regular_documents() {
    use devcel_core::interface::Interface;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Definition.interface.toml");
    let interface = Interface::new("Definition".into(), Some("Authored description".into()));
    interface.save_to_file(&path).unwrap();
    let original = std::fs::read(&path).unwrap();
    let linked = path.with_file_name("Link.interface.toml");
    std::os::unix::fs::symlink(&path, &linked).unwrap();
    let folder = path.with_file_name("Folder.interface.toml");
    std::fs::create_dir(&folder).unwrap();
    for unsupported in [linked, folder] {
        let error =
            devcel_core::AppError::from(Interface::load_from_file(&unsupported).unwrap_err());
        let wire = serde_json::to_value(error).unwrap();
        assert_eq!(wire["diagnostics"][0]["code"], "error.tableSourceType");
        assert_eq!(
            wire["diagnostics"][0]["params"]["path"],
            unsupported.to_string_lossy().as_ref()
        );
    }
    assert_eq!(std::fs::read(&path).unwrap(), original);
    let loaded = Interface::load_from_file(&path).unwrap();
    assert_eq!(loaded.uuid, interface.uuid);
    assert_eq!(loaded.name, interface.name);
    assert_eq!(loaded.description, interface.description);
}
