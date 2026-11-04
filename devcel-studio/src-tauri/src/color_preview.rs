//! Read-only picker validation and SDR presentation. Never mutates stored values.
use crate::AppError;
use devcel_core::color::{Color32, ColorFloat};
use serde::Serialize;

#[derive(Serialize)]
pub struct ColorPreview {
    canonical: String,
    channels: [f64; 4],
    preview_css: String,
    hex: Option<String>,
}

fn decode(x: f64) -> f64 {
    if x.abs() <= 0.04045 {
        x / 12.92
    } else {
        x.signum() * ((x.abs() + 0.055) / 1.055).powf(2.4)
    }
}
fn encode(x: f64) -> f64 {
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

fn color_value_error(kind: &str, details: String) -> AppError {
    AppError::code(
        "column.conversion.invalidValue",
        serde_json::json!({"type":kind,"details":details}),
    )
}

fn parse_hex(value: &str) -> Result<[u8; 4], AppError> {
    if !matches!(value.len(), 7 | 9)
        || !value.starts_with('#')
        || !value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err(AppError::code(
            "color.preview.hexInvalid",
            serde_json::json!({}),
        ));
    }
    let mut rgba = [255; 4];
    for (index, channel) in rgba.iter_mut().enumerate().take((value.len() - 1) / 2) {
        let start = 1 + index * 2;
        *channel = u8::from_str_radix(&value[start..start + 2], 16).unwrap();
    }
    Ok(rgba)
}

#[tauri::command]
pub fn preview_color(
    color_type: String,
    input: String,
    interpretation: String,
    exposure: f64,
) -> Result<ColorPreview, AppError> {
    if !matches!(interpretation.as_str(), "srgb" | "linear") {
        return Err(AppError::code(
            "color.preview.interpretationInvalid",
            serde_json::json!({}),
        ));
    }
    if !exposure.is_finite() || !(-32.0..=32.0).contains(&exposure) {
        return Err(AppError::code(
            "error.validation.numberRange",
            serde_json::json!({"min":"-32", "max":"32"}),
        ));
    }
    let (canonical, channels, normalized, hex) = match color_type.as_str() {
        "Color32" => {
            let value = if input.trim().is_empty() {
                Color32::default()
            } else if input.trim().starts_with('#') {
                Color32(parse_hex(input.trim())?)
            } else {
                Color32::parse(&input).map_err(|error| color_value_error("Color32", error))?
            };
            let channels = value.0.map(f64::from);
            let hex = format!(
                "#{:02X}{:02X}{:02X}{:02X}",
                value.0[0], value.0[1], value.0[2], value.0[3]
            );
            (
                value.canonical_string(),
                channels,
                channels.map(|x| x / 255.0),
                Some(hex),
            )
        }
        "ColorFloat" => {
            let value = if input.trim().is_empty() {
                ColorFloat::default()
            } else {
                ColorFloat::parse(&input).map_err(|error| color_value_error("ColorFloat", error))?
            };
            let channels = value.0.map(f64::from);
            (value.canonical_string(), channels, channels, None)
        }
        "UiColor" => {
            let input = input.trim();
            let rgba = if input.starts_with('#') {
                parse_hex(input)?
            } else {
                Color32::parse(input)
                    .map_err(|error| color_value_error("Color32", error))?
                    .0
            };
            if rgba[3] != 255 {
                return Err(AppError::code(
                    "color.preview.opaqueRequired",
                    serde_json::json!({}),
                ));
            }
            let canonical = if input.len() == 7 && input.starts_with('#') {
                input.to_owned()
            } else {
                format!("#{:02X}{:02X}{:02X}", rgba[0], rgba[1], rgba[2])
            };
            let channels = rgba.map(f64::from);
            (
                canonical.clone(),
                channels,
                channels.map(|x| x / 255.0),
                Some(canonical),
            )
        }
        _ => {
            return Err(AppError::code(
                "color.preview.typeInvalid",
                serde_json::json!({}),
            ))
        }
    };
    let ui_color = color_type == "UiColor";
    let rgb = [0, 1, 2].map(|index| {
        let linear = if ui_color || interpretation == "srgb" {
            decode(normalized[index])
        } else {
            normalized[index]
        };
        let ev = if ui_color {
            1.0
        } else {
            2.0_f64.powf(exposure)
        };
        (encode((linear.max(0.0) * ev).clamp(0.0, 1.0)) * 255.0).round() as u8
    });
    Ok(ColorPreview {
        canonical,
        channels,
        preview_css: format!(
            "rgba({}, {}, {}, {})",
            rgb[0], rgb[1], rgb[2], normalized[3]
        ),
        hex,
    })
}

#[cfg(test)]
mod color_preview_diagnostic_tests {
    use super::*;
    fn error(result: Result<ColorPreview, AppError>) -> serde_json::Value {
        match result {
            Err(error) => serde_json::to_value(error).unwrap(),
            Ok(_) => panic!("expected an invalid preview"),
        }
    }
    #[test]
    fn invalid_preview_inputs_are_semantic_diagnostics() {
        for (kind, input, interpretation, exposure, code) in [
            (
                "Color32",
                "#zzzzzz",
                "srgb",
                0.0,
                "color.preview.hexInvalid",
            ),
            (
                "Color32",
                "[999,0,0,1]",
                "srgb",
                0.0,
                "column.conversion.invalidValue",
            ),
            (
                "ColorFloat",
                "[0,0,0,9]",
                "linear",
                0.0,
                "column.conversion.invalidValue",
            ),
            (
                "Color32",
                "",
                "unexpected",
                0.0,
                "color.preview.interpretationInvalid",
            ),
            (
                "Color32",
                "",
                "srgb",
                f64::NAN,
                "error.validation.numberRange",
            ),
            (
                "UiColor",
                "#12345600",
                "srgb",
                0.0,
                "color.preview.opaqueRequired",
            ),
            ("Unknown", "", "srgb", 0.0, "color.preview.typeInvalid"),
        ] {
            let result = error(preview_color(
                kind.into(),
                input.into(),
                interpretation.into(),
                exposure,
            ));
            assert_eq!(result["kind"], "code");
            assert_eq!(result["code"], code);
        }
        let parsed = error(preview_color(
            "Color32".into(),
            "invalid".into(),
            "srgb".into(),
            0.0,
        ));
        assert_eq!(parsed["params"]["type"], "Color32");
        assert!(!parsed["params"]["details"].as_str().unwrap().is_empty());
    }
}
