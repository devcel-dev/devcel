//! Authoring-only named RGBA presets shared by personal and column palettes.
//! A swatch keeps its own precision when the owning column's type changes.
use crate::{Color32, ColorFloat, DevcelError, Result, ValueType};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MAX_COLOR_SWATCHES: usize = 256;
pub const MAX_COLOR_SWATCH_NAME_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColorSwatch {
    pub id: String,
    pub name: String,
    pub data_type: ValueType,
    /// Canonical RGBA literal. Formulas and preview/display transforms are not presets.
    pub value: String,
}

/// Validate and canonicalize a proposed whole palette before committing it.
/// The destination column's type is intentionally not involved: type changes
/// preserve presets, while applying a preset requires an exact precision match.
pub fn normalize_color_swatches(mut swatches: Vec<ColorSwatch>) -> Result<Vec<ColorSwatch>> {
    if swatches.len() > MAX_COLOR_SWATCHES {
        return Err(DevcelError::Validation(format!(
            "A color palette can contain at most {MAX_COLOR_SWATCHES} swatches"
        )));
    }
    let mut ids = HashSet::new();
    for swatch in &mut swatches {
        let id = uuid::Uuid::parse_str(&swatch.id)
            .map_err(|_| DevcelError::Validation("Color swatch ID must be a UUID".into()))?;
        if !ids.insert(id) {
            return Err(DevcelError::Validation("Duplicate color swatch ID".into()));
        }
        swatch.id = id.to_string();
        swatch.name = swatch.name.trim().to_owned();
        if swatch.name.is_empty()
            || swatch.name.chars().count() > MAX_COLOR_SWATCH_NAME_CHARS
            || swatch.name.chars().any(char::is_control)
        {
            return Err(DevcelError::Validation(format!(
                "Color swatch names require 1..{MAX_COLOR_SWATCH_NAME_CHARS} characters and no control characters"
            )));
        }
        swatch.value = match swatch.data_type {
            ValueType::Color32 => Color32::parse(&swatch.value)
                .map(|color| color.canonical_string())
                .map_err(DevcelError::Validation)?,
            ValueType::ColorFloat => ColorFloat::parse(&swatch.value)
                .map(|color| color.canonical_string())
                .map_err(DevcelError::Validation)?,
            _ => {
                return Err(DevcelError::Validation(
                    "Color swatches require Color32 or ColorFloat".into(),
                ))
            }
        };
    }
    Ok(swatches)
}

/// Strict persisted-data boundary. Loading never repairs or silently drops entries.
pub fn validate_color_swatches(swatches: &[ColorSwatch]) -> Result<()> {
    let normalized = normalize_color_swatches(swatches.to_vec())?;
    if normalized != swatches {
        return Err(DevcelError::Validation(
            "Saved color swatches must have canonical IDs, names and RGBA values".into(),
        ));
    }
    Ok(())
}

/// Select a swatch without interpreting its channels or changing precision.
/// Draft names and IDs may still be incomplete; only persistence validates metadata.
/// Applying a swatch never quantizes, gamma-converts, clamps or premultiplies it.
pub fn apply_color_swatch(swatch: &ColorSwatch, target_type: &ValueType) -> Result<String> {
    let canonical = match swatch.data_type {
        ValueType::Color32 => Color32::parse(&swatch.value)
            .map(|color| color.canonical_string())
            .map_err(DevcelError::Validation)?,
        ValueType::ColorFloat => ColorFloat::parse(&swatch.value)
            .map(|color| color.canonical_string())
            .map_err(DevcelError::Validation)?,
        _ => {
            return Err(DevcelError::Validation(
                "Color swatches require Color32 or ColorFloat".into(),
            ))
        }
    };
    if canonical != swatch.value {
        return Err(DevcelError::Validation(
            "Applied color swatches must have canonical RGBA values".into(),
        ));
    }
    if &swatch.data_type != target_type {
        return Err(DevcelError::Validation(
            "Color swatch precision must match the destination type".into(),
        ));
    }
    Ok(swatch.value.clone())
}
