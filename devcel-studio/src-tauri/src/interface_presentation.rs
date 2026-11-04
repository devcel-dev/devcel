//! Typed locale-neutral field labels for current interface history DTOs.
use devcel_core::types::Diagnostic;

pub(crate) fn field_label(field: &str, text: &str) -> Diagnostic {
    let key = match field {
        "identity" => "interface.conflict.identityLabel",
        "name" => "interface.editor.columnName",
        "type" => "interface.editor.dataType",
        "required" => "interface.conflict.requiredLabel",
        "default" => "interface.editor.default",
        "constraints" => "interface.editor.constraints",
        "configuration" => "interface.conflict.configurationLabel",
        "color_swatches" => "color.swatches.title",
        "input_validation" => "interface.conflict.validationLabel",
        "conditional_formatting" => "interface.conflict.formattingLabel",
        "presence" => "interface.conflict.presenceLabel",
        "extends" => "interface.conflict.extendsLabel",
        _ => {
            return Diagnostic::Text {
                text: text.to_owned(),
            }
        }
    };
    Diagnostic::Code {
        code: key.to_owned(),
        params: Default::default(),
    }
}
