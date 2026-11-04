use devcel_core::{DevcelError, Project};

fn main() -> Result<(), DevcelError> {
    println!("Testing devcel-core compilation...");

    // Test creating a project
    let project = Project::create_project(
        "Test Project",
        "/tmp/test.devcelproj.toml",
        "Test Description",
        "#FF0000",
    )?;

    println!("Project created: {}", project.get_project_name());

    Ok(())
}
