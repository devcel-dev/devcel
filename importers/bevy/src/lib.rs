//! Experimental Bevy resource for a Devcel exported JSON bundle.
//!
//! Load explicitly at startup and call `reload_if_changed` at a controlled
//! point when a new export is ready. No editor integration or automatic file
//! watching is provided.
use bevy_ecs::prelude::Resource;
use devcel_runtime::{Database, Snapshot};
use std::{path::Path, sync::Arc};

#[derive(Resource)]
pub struct DevcelData(Database);

impl DevcelData {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        Database::open(path).map(Self)
    }

    /// An immutable view stays valid across a later successful reload.
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.0.load()
    }

    /// Reload explicitly, outside a hot path. Failure retains the prior snapshot.
    pub fn reload_if_changed(&self) -> Result<bool, String> {
        self.0.reload_if_changed()
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use bevy_ecs::prelude::*;

    fn json(hash: &str, hp: i32) -> String {
        format!(r#"{{"manifest":{{"schema_version":1,"content_version":1,"content_hash":"{hash}","data_revision":1,"generated_at":"2026-01-01T00:00:00Z","mode":"full"}},"project_name":"test","tables":[{{"name":"enemies","uuid":"11111111-1111-4111-8111-111111111111","columns":[{{"name":"hp","data_type":"I32"}}],"records":[{{"id":"u1","values":{{"hp":"{hp}"}}}}]}}]}}"#)
    }

    fn hp(snapshot: &Snapshot) -> i64 {
        let table = snapshot.table(snapshot.table_index("enemies").unwrap()).unwrap();
        table.column(table.column_index("hp").unwrap()).unwrap().i64_at(0)
    }

    #[test]
    fn resource_reads_and_retains_snapshot_across_reload() {
        let dir = std::env::temp_dir().join(format!("devcel-bevy-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("master.json");
        std::fs::write(&path, json("one", 10)).unwrap();
        let mut world = World::new();
        world.insert_resource(DevcelData::open(&path).unwrap());
        let before = world.resource::<DevcelData>().snapshot();
        assert_eq!(hp(&before), 10);
        std::fs::write(&path, json("two", 20)).unwrap();
        assert!(world.resource::<DevcelData>().reload_if_changed().unwrap());
        assert_eq!(hp(&before), 10);
        assert_eq!(hp(&world.resource::<DevcelData>().snapshot()), 20);
        std::fs::write(&path, "invalid JSON").unwrap();
        assert!(world.resource::<DevcelData>().reload_if_changed().is_err());
        assert_eq!(hp(&world.resource::<DevcelData>().snapshot()), 20);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
