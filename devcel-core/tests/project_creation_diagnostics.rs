use devcel_core::{AppError, Project};
fn diagnostic(result: devcel_core::Result<Project>) -> serde_json::Value {
    match result {
        Err(error) => serde_json::to_value(AppError::from(error)).unwrap(),
        Ok(_) => panic!("expected a project validation failure"),
    }
}
#[test]
fn create_and_open_project_failures_are_localized_and_preserve_existing_files() {
    assert_eq!(
        diagnostic(Project::create_project("Example", "", "", "#abcdef"))["diagnostics"][0]["code"],
        "error.projectPathRequired"
    );
    let root = tempfile::tempdir().unwrap();
    let project = Project::create_project(
        "Example",
        root.path().to_str().unwrap(),
        "original description",
        "#abcdef",
    )
    .unwrap();
    let path = project.get_project_path();
    let before = std::fs::read(&path).unwrap();
    let duplicate = diagnostic(Project::create_project(
        "Example",
        root.path().to_str().unwrap(),
        "replacement description",
        "#123456",
    ));
    assert_eq!(
        duplicate["diagnostics"][0]["code"],
        "error.projectAlreadyExists"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "duplicate creation must never overwrite an existing project"
    );
    let missing = root.path().join("missing.devcelproj.toml");
    let value = diagnostic(Project::open_project(missing.to_str().unwrap()));
    assert_eq!(value["diagnostics"][0]["code"], "error.projectMissing");
    assert_eq!(
        value["diagnostics"][0]["params"]["path"],
        missing.to_string_lossy().as_ref()
    );
    assert!(!missing.exists());
}
#[test]
fn filesystem_failure_keeps_localized_category_and_literal_technical_detail() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("not-a-directory");
    std::fs::write(&file, b"existing bytes").unwrap();
    let error = diagnostic(Project::create_project(
        "Example",
        file.to_str().unwrap(),
        "",
        "#abcdef",
    ));
    assert_eq!(error["code"], "error.io");
    assert!(error["params"]["details"]
        .as_str()
        .is_some_and(|text| !text.is_empty()));
    assert_eq!(std::fs::read(file).unwrap(), b"existing bytes");
}
