use devcel_core::project_impl::{ProjectFileData, DEFAULT_PROJECT_HEADER_COLOR};

#[test]
fn new_projects_use_neutral_header() {
    assert_eq!(DEFAULT_PROJECT_HEADER_COLOR, "#242A30");
    assert_eq!(
        ProjectFileData::default().color,
        DEFAULT_PROJECT_HEADER_COLOR
    );
    assert_eq!(ProjectFileData::new().color, DEFAULT_PROJECT_HEADER_COLOR);
}

#[test]
fn persisted_custom_colors_survive_roundtrip() {
    for color in ["#6495ed", "#000000", "#7C3AED", "#FFFFFF"] {
        let mut project = ProjectFileData::new();
        project.color = color.to_string();
        let encoded = toml::to_string(&project).unwrap();
        let decoded: ProjectFileData = toml::from_str(&encoded).unwrap();
        assert_eq!(decoded.color, color);
    }
}
