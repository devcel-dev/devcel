//! Configuration edits shared by Studio and the unified/CLI operation surface.
use crate::commands::CommandData;
use crate::{
    ColumnSchema, CurveConfig, DevcelError, Project, Result, SelectConfig, TableRefConfig,
    ValueType,
};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "config", rename_all = "snake_case")]
pub enum Configuration {
    Curve(CurveConfig),
    TableRef(TableRefConfig),
    Select(Option<SelectConfig>),
}

pub struct SetColumnConfigCommand {
    table_uuid: String,
    column_uuid: String,
    configuration: Configuration,
    old: Option<ColumnSchema>,
}

impl SetColumnConfigCommand {
    pub fn new(table_uuid: String, column_uuid: String, configuration: Configuration) -> Self {
        Self {
            table_uuid,
            column_uuid,
            configuration,
            old: None,
        }
    }
}

impl CommandData for SetColumnConfigCommand {
    fn execute(&mut self, project: &mut Project) -> Result<()> {
        self.configuration.validate(project)?;
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| DevcelError::NotFound("Table not found".into()))?;
        let column = table
            .data
            .schema
            .columns
            .iter_mut()
            .find(|c| c.uuid == self.column_uuid)
            .ok_or_else(|| DevcelError::NotFound("Column not found".into()))?;
        if column.interface_origin.is_some() {
            return Err(DevcelError::InvalidOperation(
                "Interface-owned columns must be configured in their interface".into(),
            ));
        }
        self.old = Some(column.clone());
        self.configuration.apply(column);
        table.is_dirty = true;
        Ok(())
    }
    fn undo(&mut self, project: &mut Project) -> Result<()> {
        let old = self.old.as_ref().ok_or_else(|| {
            DevcelError::InvalidOperation("Configuration has not been applied".into())
        })?;
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| DevcelError::NotFound("Table not found".into()))?;
        let column = table
            .data
            .schema
            .columns
            .iter_mut()
            .find(|c| c.uuid == self.column_uuid)
            .ok_or_else(|| DevcelError::NotFound("Column not found".into()))?;
        *column = old.clone();
        table.is_dirty = true;
        Ok(())
    }
    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

impl Configuration {
    fn validate(&self, project: &Project) -> Result<()> {
        match self {
            Configuration::Curve(config) => {
                if !config.start_value.is_finite() || !config.end_value.is_finite() {
                    return Err(DevcelError::Validation(
                        "Curve endpoints must be finite".into(),
                    ));
                }
            }
            Configuration::TableRef(config) => {
                let id = uuid::Uuid::parse_str(&config.interface_uuid)
                    .map_err(|e| DevcelError::Validation(e.to_string()))?;
                if project.get_interface(&id).is_none() {
                    return Err(DevcelError::NotFound("Interface not found".into()));
                }
            }
            Configuration::Select(Some(config)) => {
                config.validate().map_err(DevcelError::Validation)?
            }
            Configuration::Select(None) => {}
        }
        Ok(())
    }
    fn apply(&self, column: &mut ColumnSchema) {
        column.reference_config = None;
        column.table_ref_config = None;
        column.curve_config = None;
        column.select_config = None;
        match self {
            Configuration::Curve(config) => {
                column.data_type = ValueType::Curve;
                column.curve_config = Some(config.clone());
            }
            Configuration::TableRef(config) => {
                column.data_type = ValueType::TableRef;
                column.table_ref_config = Some(config.clone());
            }
            Configuration::Select(config) => {
                column.data_type = ValueType::Select;
                column.select_config = config.clone();
            }
        }
    }
}

pub fn configure_interface_column(
    project: &mut Project,
    interface_uuid: &str,
    column_name: &str,
    config: Configuration,
    save_queue: Option<&std::sync::Arc<crate::file_save_queue::FileBasedSaveQueueManager>>,
) -> Result<()> {
    config.validate(project)?;
    let id = uuid::Uuid::parse_str(interface_uuid)
        .map_err(|e| DevcelError::Validation(e.to_string()))?;
    let interface = project
        .get_interface(&id)
        .ok_or_else(|| DevcelError::NotFound("Interface not found".into()))?;
    let mut column = interface
        .columns
        .iter()
        .find(|c| c.uuid == column_name || c.data_name == column_name)
        .cloned()
        .ok_or_else(|| {
            DevcelError::NotFound(
                "Interface-owned column not found; edit the defining parent interface".into(),
            )
        })?;
    let name = column.data_name.clone();
    let order = interface
        .columns
        .iter()
        .map(|c| c.data_name.clone())
        .collect();
    config.apply(&mut column);
    let changes = vec![
        crate::interface::InterfaceChange::RemoveColumn { column_name: name },
        crate::interface::InterfaceChange::AddColumn { column },
        crate::interface::InterfaceChange::ReorderColumns { order },
    ];
    project.execute_command(
        crate::commands::UpdateInterfaceCommand::new(
            id,
            changes,
            None,
            Some("Column configuration".into()),
        ),
        save_queue,
    )
}
