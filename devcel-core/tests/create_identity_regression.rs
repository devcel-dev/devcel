use devcel_core::{DevcelError, Project};
use std::{
    collections::HashSet,
    fs,
    sync::{Arc, Barrier},
};

#[test]
fn create_identity_collision_saturation_and_concurrent_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("CreateContract", dir.path().to_str().unwrap(), "", "#fff")
            .unwrap();
    let tables = project.path.parent().unwrap().join("Tables");
    let initial = project.create_table("alpha.table.toml".into()).unwrap();
    let initial_bytes = fs::read(&initial).unwrap();
    let initial_uuid = project.tables_data[&initial].data.uuid.clone();
    let next = project.create_table("alpha.table.toml".into()).unwrap();
    assert_eq!(next.file_name().unwrap(), "alpha_1.table.toml");
    assert_ne!(project.tables_data[&next].data.uuid, initial_uuid);
    assert_eq!(fs::read(&initial).unwrap(), initial_bytes);

    for n in 0..=1000 {
        let path = tables.join(if n == 0 {
            "saturated.table.toml".into()
        } else {
            format!("saturated_{n}.table.toml")
        });
        fs::write(path, format!("SENTINEL-TABLE-{n}")).unwrap();
        let folder = tables.join(if n == 0 {
            "folders".into()
        } else {
            format!("folders_{n}")
        });
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("keep"), format!("SENTINEL-FOLDER-{n}")).unwrap();
    }
    let memory_before = project.tables_data.len();
    assert!(matches!(
        project.create_table("saturated.table.toml".into()),
        Err(DevcelError::Diagnostics(ref diagnostics)) if diagnostics.iter().any(|d| matches!(d, devcel_core::Diagnostic::Code { code, .. } if code == "error.path.nameExhausted"))
    ));
    assert!(matches!(
        project.create_directory("folders".into()),
        Err(DevcelError::Diagnostics(ref diagnostics)) if diagnostics.iter().any(|d| matches!(d, devcel_core::Diagnostic::Code { code, .. } if code == "error.path.nameExhausted"))
    ));
    assert_eq!(project.tables_data.len(), memory_before);
    assert!(!tables.join("saturated_1001.table.toml").exists());
    assert!(!tables.join("folders_1001").exists());
    for n in 0..=1000 {
        let path = tables.join(if n == 0 {
            "saturated.table.toml".into()
        } else {
            format!("saturated_{n}.table.toml")
        });
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            format!("SENTINEL-TABLE-{n}")
        );
        let folder = tables.join(if n == 0 {
            "folders".into()
        } else {
            format!("folders_{n}")
        });
        assert_eq!(
            fs::read_to_string(folder.join("keep")).unwrap(),
            format!("SENTINEL-FOLDER-{n}")
        );
    }

    let barrier = Arc::new(Barrier::new(16));
    let handles: Vec<_> = (0..16)
        .map(|_| {
            let path = project.path.to_str().unwrap().to_owned();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut independent = Project::open_project(&path).unwrap();
                barrier.wait();
                match independent.create_table("concurrent.table.toml".into()) {
                    Ok(path) => {
                        let uuid = independent.tables_data[&path].data.uuid.clone();
                        Ok((path, uuid))
                    }
                    Err(DevcelError::Io(error))
                        if error.kind() == std::io::ErrorKind::AlreadyExists =>
                    {
                        Err(())
                    }
                    Err(error) => panic!("unexpected create failure: {error:?}"),
                }
            })
        })
        .collect();
    let successes: Vec<_> = handles
        .into_iter()
        .filter_map(|h| h.join().unwrap().ok())
        .collect();
    assert!(!successes.is_empty());
    let mut paths = HashSet::new();
    for (path, uuid) in successes {
        assert!(
            paths.insert(path.clone()),
            "two creates acknowledged the same path"
        );
        let saved: devcel_core::TableData =
            toml::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            saved.uuid, uuid,
            "a concurrent writer replaced the successful creator"
        );
    }
    assert_eq!(fs::read(&initial).unwrap(), initial_bytes);
}
