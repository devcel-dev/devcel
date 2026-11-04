//! Containment for document paths; external project selection is a separate API.
use crate::{DevcelError, Result};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) fn resolve(root: &Path, requested: &Path) -> Result<PathBuf> {
    let denied = || {
        DevcelError::InvalidOperation("Document path escapes the project Tables directory".into())
    };
    if requested
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(denied());
    }
    // Tables is the authority boundary, not a redirectable alias. Following a
    // link here would redefine the root and authorize an unrelated directory.
    let metadata = fs::symlink_metadata(root)?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || reparse {
        return Err(denied());
    }
    let root_path = root.to_path_buf();
    let root = fs::canonicalize(root)?;
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root_path.join(requested)
    };
    // Resolve the nearest existing ancestor so new files receive the same checks
    // as reads. canonicalize follows links/junctions, including dangling failures.
    let mut ancestor = candidate.as_path();
    let mut suffix = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(ancestor.file_name().ok_or_else(denied)?.to_owned());
                ancestor = ancestor.parent().ok_or_else(denied)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut resolved = fs::canonicalize(ancestor)?;
    if !resolved.starts_with(&root) {
        return Err(denied());
    }
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn tables_root_link_cannot_redefine_document_boundary() {
        use crate::{
            operation_handler::{LocalOperationHandler, OperationHandler},
            operations::{DevcelOperation, DevcelResponse},
        };
        let temp = tempfile::tempdir().unwrap();
        let mut project = crate::Project::create_project(
            "Boundary",
            temp.path().to_str().unwrap(),
            "",
            "#123456",
        )
        .unwrap();
        let tables = project.path.parent().unwrap().join("Tables");
        let saved = tables.with_file_name("OriginalTables");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let sentinel = outside.join("sentinel.md");
        fs::write(&sentinel, "outside sentinel").unwrap();
        fs::rename(&tables, &saved).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&tables)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &tables).unwrap();
        // This first assertion reproduces the bypass without performing any write.
        assert!(project
            .resolve_table_path(Path::new("sentinel.md"))
            .is_err());
        assert!(project
            .delete_markdown(PathBuf::from("sentinel.md"))
            .is_err());
        assert!(project
            .move_markdown_file("sentinel.md", "moved.md")
            .is_err());
        assert!(project.create_directory(PathBuf::from("new")).is_err());
        let handler =
            LocalOperationHandler::new(std::sync::Arc::new(tokio::sync::Mutex::new(Some(project))));
        for operation in [
            DevcelOperation::ReadMarkdownFile {
                file_path: "sentinel.md".into(),
            },
            DevcelOperation::WriteMarkdownFile {
                file_path: "sentinel.md".into(),
                content: "must not write".into(),
            },
        ] {
            assert!(matches!(
                handler.handle_operation(operation).await,
                DevcelResponse::Error(_)
            ));
        }
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "outside sentinel");
        assert!(!outside.join("moved.md").exists());
        assert!(!outside.join("new").exists());
        fs::remove_dir(&tables)
            .or_else(|_| fs::remove_file(&tables))
            .unwrap();
        fs::rename(saved, tables).unwrap();
    }
    #[tokio::test]
    async fn explicit_interface_reload_ignores_external_links_and_cycles() {
        use crate::{
            operation_handler::{LocalOperationHandler, OperationHandler},
            operations::{DevcelOperation, DevcelResponse},
        };
        let temp = tempfile::tempdir().unwrap();
        let project = crate::Project::create_project(
            "Boundary",
            temp.path().to_str().unwrap(),
            "",
            "#123456",
        )
        .unwrap();
        let tables = project.path.parent().unwrap().join("Tables");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let sentinel = outside.join("sentinel.interface.toml");
        fs::write(&sentinel, "invalid external interface must never be parsed").unwrap();
        for (name, target) in [("external", outside.as_path()), ("cycle", tables.as_path())] {
            #[cfg(windows)]
            assert!(std::process::Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(tables.join(name))
                .arg(target)
                .output()
                .unwrap()
                .status
                .success());
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, tables.join(name)).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&sentinel, tables.join("external.interface.toml")).unwrap();
        let shared = std::sync::Arc::new(tokio::sync::Mutex::new(Some(project)));
        let handler = LocalOperationHandler::new(shared.clone());
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            handler.handle_operation(DevcelOperation::ReloadInterfaces),
        )
        .await
        .unwrap();
        assert!(matches!(result, DevcelResponse::Ok(_)), "{result:?}");
        assert!(shared
            .lock()
            .await
            .as_ref()
            .unwrap()
            .interface_registry
            .get_all_interfaces()
            .is_empty());
        assert_eq!(
            fs::read_to_string(&sentinel).unwrap(),
            "invalid external interface must never be parsed"
        );
        // A linked Tables root itself is rejected rather than silently adopted.
        fs::remove_dir(tables.join("external"))
            .or_else(|_| fs::remove_file(tables.join("external")))
            .unwrap();
        fs::remove_dir(tables.join("cycle"))
            .or_else(|_| fs::remove_file(tables.join("cycle")))
            .unwrap();
        let saved_tables = tables.with_file_name("SavedTables");
        fs::rename(&tables, &saved_tables).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&tables)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &tables).unwrap();
        assert!(matches!(
            handler
                .handle_operation(DevcelOperation::ReloadInterfaces)
                .await,
            DevcelResponse::Error(_)
        ));
        assert_eq!(
            fs::read_to_string(&sentinel).unwrap(),
            "invalid external interface must never be parsed"
        );
        fs::remove_dir(&tables)
            .or_else(|_| fs::remove_file(&tables))
            .unwrap();
        fs::rename(saved_tables, tables).unwrap();
    }
    #[test]
    fn reads_and_new_documents_stay_inside_tables() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Tables");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("read.md"), "text").unwrap();
        assert_eq!(
            resolve(&root, Path::new("read.md")).unwrap(),
            root.join("read.md")
        );
        assert_eq!(
            resolve(&root, Path::new("new/deep.md")).unwrap(),
            root.join("new/deep.md")
        );
        assert!(resolve(&root, Path::new("../outside.md")).is_err());
        assert!(resolve(&root, &temp.path().join("outside.md")).is_err());
    }
    #[test]
    fn project_mutations_reject_outside_paths_and_root_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let mut project = crate::Project::create_project(
            "Boundary",
            temp.path().to_str().unwrap(),
            "",
            "#123456",
        )
        .unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel.md"), "unchanged").unwrap();
        assert!(project.delete_directory(outside.clone()).is_err());
        assert!(project.create_directory(outside.join("new")).is_err());
        assert!(project
            .resolve_table_path(&outside.join("sentinel.md"))
            .is_err());
        assert!(project.delete_directory(PathBuf::new()).is_err());
        assert!(project.rename_directory(PathBuf::new(), "Renamed").is_err());
        assert!(project
            .move_directory(PathBuf::new(), PathBuf::from("Moved"))
            .is_err());
        assert_eq!(
            fs::read_to_string(outside.join("sentinel.md")).unwrap(),
            "unchanged"
        );
        assert!(!outside.join("new").exists());
    }
    #[tokio::test]
    async fn markdown_and_interface_apis_check_sources_and_destinations() {
        use crate::{
            operation_handler::{LocalOperationHandler, OperationHandler},
            operations::{DevcelOperation, DevcelResponse},
        };
        let temp = tempfile::tempdir().unwrap();
        let mut project = crate::Project::create_project(
            "Boundary",
            temp.path().to_str().unwrap(),
            "",
            "#123456",
        )
        .unwrap();
        let tables = project.path.parent().unwrap().join("Tables");
        fs::write(tables.join("inside.md"), "inside").unwrap();
        let outside = temp.path().join("outside.md");
        let interface = temp.path().join("outside.interface.toml");
        fs::write(&outside, "outside sentinel").unwrap();
        fs::write(
            &interface,
            "not an interface; must be rejected before parsing",
        )
        .unwrap();
        for path in [outside.clone(), PathBuf::from("../../outside.md")] {
            assert!(project.delete_markdown(path.clone()).is_err());
            assert!(project
                .move_markdown_file(path.to_str().unwrap(), "moved.md")
                .is_err());
            assert!(project
                .move_markdown_file("inside.md", path.to_str().unwrap())
                .is_err());
        }
        for path in [
            interface.clone(),
            PathBuf::from("../../outside.interface.toml"),
        ] {
            assert!(project.delete_interface(path).is_err());
        }
        let handler =
            LocalOperationHandler::new(std::sync::Arc::new(tokio::sync::Mutex::new(Some(project))));
        for file_path in [
            outside.to_string_lossy().into_owned(),
            "../../outside.md".into(),
        ] {
            for operation in [
                DevcelOperation::ReadMarkdownFile {
                    file_path: file_path.clone(),
                },
                DevcelOperation::WriteMarkdownFile {
                    file_path,
                    content: "unexpected".into(),
                },
            ] {
                assert!(matches!(
                    handler.handle_operation(operation).await,
                    DevcelResponse::Error(_)
                ));
            }
        }
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside sentinel");
        assert_eq!(
            fs::read_to_string(tables.join("inside.md")).unwrap(),
            "inside"
        );
        assert_eq!(
            fs::read_to_string(interface).unwrap(),
            "not an interface; must be rejected before parsing"
        );
        assert!(!tables.join("moved.md").exists());
    }

    #[cfg(windows)]
    #[test]
    fn junction_ancestor_cannot_redirect_document_operations() {
        let temp = tempfile::tempdir().unwrap();
        let mut project = crate::Project::create_project(
            "Boundary",
            temp.path().to_str().unwrap(),
            "",
            "#123456",
        )
        .unwrap();
        let tables = project.path.parent().unwrap().join("Tables");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel.md"), "unchanged").unwrap();
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(tables.join("linked"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "isolated junction fixture creation failed"
        );
        assert!(project
            .delete_markdown(PathBuf::from("linked/sentinel.md"))
            .is_err());
        assert!(project
            .move_markdown_file("linked/sentinel.md", "moved.md")
            .is_err());
        assert!(project
            .create_directory(PathBuf::from("linked/new"))
            .is_err());
        assert!(project.delete_directory(PathBuf::from("linked")).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("sentinel.md")).unwrap(),
            "unchanged"
        );
        assert!(!outside.join("new").exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_escape_and_dangling_link_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Tables");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        assert!(resolve(&root, Path::new("escape/new.md")).is_err());
        std::os::unix::fs::symlink(temp.path().join("missing"), root.join("dangling")).unwrap();
        assert!(resolve(&root, Path::new("dangling")).is_err());
    }
}
