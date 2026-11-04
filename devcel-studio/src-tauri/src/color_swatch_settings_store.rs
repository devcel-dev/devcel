//! Read-only precision adapter. User palette persistence belongs to settings tables.
use devcel_core::{AppError, ColorSwatch};

/// Read-only adapter used by the picker; it does not mutate either swatch scope.
pub fn apply(swatch: ColorSwatch, target_type: &str) -> Result<String, AppError> {
    use devcel_core::ValueType;
    match target_type {
        "Color32" => {
            devcel_core::apply_color_swatch(&swatch, &ValueType::Color32).map_err(AppError::from)
        }
        "ColorFloat" => {
            devcel_core::apply_color_swatch(&swatch, &ValueType::ColorFloat).map_err(AppError::from)
        }
        "UiColor" => {
            let value = devcel_core::apply_color_swatch(&swatch, &ValueType::Color32)
                .map_err(AppError::from)?;
            let rgba = devcel_core::Color32::parse(&value)
                .map_err(AppError::technical)?
                .0;
            if rgba[3] != 255 {
                return Err(AppError::code(
                    "color.swatches.opaqueOnly",
                    serde_json::json!({}),
                ));
            }
            Ok(format!("#{:02X}{:02X}{:02X}", rgba[0], rgba[1], rgba[2]))
        }
        _ => Err(AppError::code(
            "color.swatches.typeMismatch",
            serde_json::json!({}),
        )),
    }
}
