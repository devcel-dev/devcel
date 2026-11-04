// Import standard-library path utilities
// Import standard library for path operations
use std::path::{Path, PathBuf};

// Forward declaration of the project structure
// Forward declaration of Project struct
use crate::project_impl::Project;
use crate::{DevcelError, Result};

/// Markdown mutation APIs accept the same extension as the project browser.
/// Check before any write, deletion, directory creation or rename so a caller
/// cannot use a document operation to replace table/project storage.
pub fn validate_markdown_path(path: &Path) -> Result<()> {
    if path.extension().and_then(|part| part.to_str()) != Some("md") {
        return Err(crate::app_error::authoring_error(
            "Specify an .md file for Markdown operations",
        ));
    }
    Ok(())
}

pub(crate) fn validate_interface_path(path: &Path) -> Result<()> {
    if !path
        .file_name()
        .and_then(|part| part.to_str())
        .is_some_and(|name| name.ends_with(".interface.toml"))
    {
        return Err(crate::app_error::authoring_error(
            "Specify an .interface.toml file for interface operations",
        ));
    }
    Ok(())
}

pub(crate) fn validate_table_path(path: &Path) -> Result<()> {
    if !path
        .file_name()
        .and_then(|part| part.to_str())
        .is_some_and(|name| name.ends_with(".table.toml"))
    {
        return Err(crate::app_error::authoring_error(
            "Specify a .table.toml file for table operations",
        ));
    }
    Ok(())
}

/// Validate a data name
/// Follow C identifier rules: letters, digits, and underscores; begin with a letter or underscore
/// Used to validate database table, column, and record names
pub fn validate_data_name(name: &str) -> Result<()> {
    // Check for an empty string
    // Check for empty string
    if name.is_empty() {
        return Err(crate::app_error::authoring_error(
            "Name cannot be empty.".to_string(),
        ));
    }

    // Check character count to reject excessively long names
    // Length check (prevent extremely long names)
    if name.len() > 255 {
        return Err(crate::app_error::authoring_error(
            "Name is too long (maximum 255 characters).".to_string(),
        ));
    }

    let mut chars = name.chars();

    // Check the first character: it must be a letter or underscore
    // First character check: must be a letter or underscore
    if let Some(first_char) = chars.next() {
        if !first_char.is_ascii_alphabetic() && first_char != '_' {
            return Err(crate::app_error::authoring_error(
                "Name must start with an ASCII letter or underscore (_).".to_string(),
            ));
        }
    }

    // Check remaining characters: they must be letters, digits, or underscores
    // Remaining characters check: must be alphanumeric or underscore
    for ch in chars {
        if !ch.is_ascii_alphanumeric() && ch != '_' {
            return Err(crate::app_error::authoring_error(
                "Name may contain only ASCII letters, digits, and underscores (_).".to_string(),
            ));
        }
    }

    Ok(())
}

/// A portable single file name is separate from an exported data symbol.
/// Numeric prefixes, spaces, Unicode and punctuation such as '-' are valid;
/// paths, device names and names that cannot support the write lock are not.
pub fn renamed_file_name(new_name: &str, extension: &str) -> Result<String> {
    let base = new_name.strip_suffix(extension).unwrap_or(new_name);
    fn validate(name: &str) -> Result<()> {
        if name.is_empty() || name.trim().is_empty() {
            return Err(crate::app_error::authoring_error("Filename is empty"));
        }
        if name == "."
            || name == ".."
            || name.trim() != name
            || name.ends_with('.')
            || name
                .chars()
                .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
            || !matches!(
                Path::new(name).components().next(),
                Some(std::path::Component::Normal(_))
            )
            || Path::new(name).components().count() != 1
        {
            return Err(crate::app_error::authoring_error(
                "Filenames must not contain path separators, control characters, or trailing spaces or periods",
            ));
        }
        let device = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(
            device.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
        ) || device
            .strip_prefix("COM")
            .or_else(|| device.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        {
            return Err(crate::app_error::authoring_error(
                "Reserved filenames are not allowed",
            ));
        }
        if format!(".{name}.devcel-write.lock").len() > 255 {
            return Err(crate::app_error::authoring_error(
                "Filename is too long (at most 236 bytes including the extension)",
            ));
        }
        Ok(())
    }
    validate(base)?;
    let name = format!("{base}{extension}");
    validate(&name)?;
    Ok(name)
}

/// Convert an absolute path to a project-relative path
/// Express the path relative to the project root directory
pub fn absolute_path_to_project_path(project: &Project, path: &Path) -> Option<String> {
    let path_buf = PathBuf::from(&project.get_project_path());
    let project_root = path_buf.parent()?;
    path.strip_prefix(project_root).ok().map(|rel_path| {
        // Normalize path separators to Unix format for cross-platform compatibility
        rel_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace("\\\\", "/")
    })
}

/// Helper to convert an absolute path to a Tables-relative path
/// Used for managing table files and displaying them in the UI
pub fn absolute_path_to_tables_relative_path(project: &Project, path: &Path) -> Option<String> {
    let path_buf = PathBuf::from(&project.get_project_path());
    let project_root = path_buf.parent()?;
    let tables_dir = project_root.join("Tables");

    // Get the path relative to the Tables directory
    if let Ok(rel_path) = path.strip_prefix(&tables_dir) {
        return Some(
            rel_path
                .to_string_lossy()
                .replace('\\', "/")
                .replace("\\\\", "/"),
        );
    }

    None
}

/// Convert a project-relative path to an absolute path
/// Used for file operations and access
pub fn project_path_to_absolute_path(project: &Project, path: &str) -> Option<PathBuf> {
    let path_buf = PathBuf::from(&project.get_project_path());
    let project_root = path_buf.parent()?;

    // Convert path separators to the OS-native format
    // Convert path separators to OS native format
    let normalized_path = if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.replace('\\', "/")
    };

    let project_path = project_root.join(normalized_path);
    // Return the path only when the file actually exists
    // Return path only if file actually exists
    if project_path.exists() {
        Some(project_path)
    } else {
        None
    }
}

/// Use a recognisable, narrow namespace so an in-progress atomic write cannot
/// appear as a user document in project listings. Generic `.tmp*` remains visible.
pub(crate) fn new_atomic_save_temp(parent: &Path) -> std::io::Result<tempfile::NamedTempFile> {
    tempfile::Builder::new()
        .prefix(crate::internal_artifacts::SAVE_TEMP_PREFIX)
        .suffix(crate::internal_artifacts::SAVE_TEMP_SUFFIX)
        .rand_bytes(crate::internal_artifacts::SAVE_TEMP_RANDOM_BYTES)
        .tempfile_in(parent)
}

/// Replace one file only after the complete payload is durable. An I/O error
/// before the rename leaves the previous bytes intact.
pub(crate) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> crate::Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| {
        crate::app_error::authoring_error("The destination parent folder is missing")
    })?;
    let mut temporary = new_atomic_save_temp(parent)?;
    if let Ok(metadata) = std::fs::metadata(path) {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())?;
    }
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| crate::DevcelError::Io(error.error))?;
    Ok(())
}

/// Atomically move a file or directory without replacing a racing destination.
pub(crate) fn rename_without_replace(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            source,
            rustix::fs::CWD,
            destination,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(|error| DevcelError::Io(error.into()))
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::MoveFileW};
        fn wide_path(path: &Path) -> Result<Vec<u16>> {
            let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
            if wide.contains(&0) {
                return Err(DevcelError::InvalidOperation(
                    "Path contains a NUL character".into(),
                ));
            }
            wide.push(0);
            Ok(wide)
        }
        let source = wide_path(source)?;
        let destination = wide_path(destination)?;
        unsafe { MoveFileW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr())) }.map_err(
            |error| DevcelError::Io(std::io::Error::from_raw_os_error(error.code().0 & 0xffff)),
        )
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (source, destination);
        Err(DevcelError::InvalidOperation(
            "Atomic rename is not supported on this OS".into(),
        ))
    }
}
