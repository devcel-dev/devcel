//! Color functions operate on channel numbers only. No encoding is inferred.
use super::{error, Color32, ColorFloat, FormulaError, Result, Value};

pub(super) fn color_channel(name: &str) -> Result<usize> {
    match name.to_ascii_lowercase().as_str() {
        "r" => Ok(0),
        "g" => Ok(1),
        "b" => Ok(2),
        "a" => Ok(3),
        _ => Err(FormulaError::InvalidReference(format!(
            "Color channel not found: {name}; expected r, g, b or a"
        ))),
    }
}

fn number(value: &Value, name: &str) -> Result<f64> {
    match value {
        Value::Number(number) => number.float(),
        _ => Err(error(format!("{name} requires numeric arguments"))),
    }
}

fn channels(value: &Value, name: &str) -> Result<[f64; 4]> {
    match value {
        Value::Color32(color) => Ok(color.channels().map(|channel| f64::from(channel) / 255.0)),
        Value::ColorFloat(color) => Ok(color.channels().map(f64::from)),
        _ => Err(error(format!(
            "{name} requires a typed Color32 or ColorFloat"
        ))),
    }
}

fn float(channels: [f64; 4]) -> Result<Value> {
    ColorFloat::from_f64(channels)
        .map(Value::ColorFloat)
        .map_err(error)
}

pub(super) fn color_function(name: &str, values: &[Value]) -> Result<Value> {
    let count = match name {
        "COLOR32" | "COLORFLOAT" => 3..=4,
        "COLOR_TO_FLOAT" | "COLOR_TO_BYTE" | "SRGB_TO_LINEAR" | "LINEAR_TO_SRGB" => 1..=1,
        "GAMMA_DECODE" | "GAMMA_ENCODE" | "EXPOSURE" => 2..=2,
        "LERP_COLOR" => 3..=3,
        "CLAMP_COLOR" if values.len() == 1 => 1..=1,
        "CLAMP_COLOR" => 3..=3,
        _ => unreachable!(),
    };
    if !count.contains(&values.len()) {
        return Err(FormulaError::ArgumentError(format!(
            "{name}: invalid argument count"
        )));
    }
    if name == "COLOR32" {
        let mut result = [255; 4];
        for (index, value) in values.iter().enumerate() {
            let channel = number(value, name)?;
            if !channel.is_finite() || !(0.0..=255.0).contains(&channel) || channel.fract() != 0.0 {
                return Err(error("COLOR32 channels must be integers from 0 to 255"));
            }
            result[index] = channel as u8;
        }
        return Ok(Value::Color32(Color32::new(result)));
    }
    if name == "COLORFLOAT" {
        let mut result = [1.0; 4];
        for (index, value) in values.iter().enumerate() {
            result[index] = number(value, name)?;
        }
        return float(result);
    }
    let mut result = channels(&values[0], name)?;
    match name {
        "COLOR_TO_FLOAT" => return float(result),
        "COLOR_TO_BYTE" => {
            if result
                .iter()
                .any(|channel| !channel.is_finite() || !(0.0..=1.0).contains(channel))
            {
                return Err(error(
                    "COLOR_TO_BYTE requires RGBA in 0..1; clamp RGB explicitly with CLAMP_COLOR",
                ));
            }
            // Nearest byte, with exact halfway cases rounded upward.
            return Ok(Value::Color32(Color32::new(
                result.map(|channel| (channel * 255.0).round() as u8),
            )));
        }
        "SRGB_TO_LINEAR" => {
            // W3C CSS Color 4 extended sRGB transfer function, including negatives:
            // https://www.w3.org/TR/css-color-4/#color-conversion-code
            for channel in &mut result[..3] {
                *channel = if channel.abs() <= 0.04045 {
                    *channel / 12.92
                } else {
                    ((channel.abs() + 0.055) / 1.055)
                        .powf(2.4)
                        .copysign(*channel)
                };
            }
        }
        "LINEAR_TO_SRGB" => {
            for channel in &mut result[..3] {
                *channel = if channel.abs() <= 0.0031308 {
                    *channel * 12.92
                } else {
                    (1.055 * channel.abs().powf(1.0 / 2.4) - 0.055).copysign(*channel)
                };
            }
        }
        "GAMMA_DECODE" | "GAMMA_ENCODE" => {
            let gamma = number(&values[1], name)?;
            if !gamma.is_finite() || gamma <= 0.0 {
                return Err(error("Gamma must be finite and greater than zero"));
            }
            let exponent = if name == "GAMMA_DECODE" {
                gamma
            } else {
                1.0 / gamma
            };
            for channel in &mut result[..3] {
                *channel = channel.abs().powf(exponent).copysign(*channel);
            }
        }
        "EXPOSURE" => {
            let ev = number(&values[1], name)?;
            let multiplier = 2.0_f64.powf(ev);
            if !ev.is_finite() || !multiplier.is_finite() {
                return Err(error("EXPOSURE requires a finite exposure multiplier"));
            }
            for channel in &mut result[..3] {
                *channel *= multiplier;
            }
        }
        "LERP_COLOR" => {
            if !matches!(
                (&values[0], &values[1]),
                (Value::Color32(_), Value::Color32(_))
                    | (Value::ColorFloat(_), Value::ColorFloat(_))
            ) {
                return Err(error(
                    "LERP_COLOR requires colors of the same precision; convert explicitly first",
                ));
            }
            let other = channels(&values[1], name)?;
            let t = number(&values[2], name)?;
            if !t.is_finite() {
                return Err(error("LERP_COLOR requires a finite interpolation factor"));
            }
            for (channel, other) in result.iter_mut().zip(other) {
                *channel += (other - *channel) * t;
            }
        }
        "CLAMP_COLOR" => {
            let (min, max) = if values.len() == 1 {
                (0.0, 1.0)
            } else {
                (number(&values[1], name)?, number(&values[2], name)?)
            };
            if !min.is_finite() || !max.is_finite() || min > max {
                return Err(error("CLAMP_COLOR requires finite min <= max"));
            }
            for channel in &mut result[..3] {
                *channel = channel.clamp(min, max);
            }
        }
        _ => unreachable!(),
    }
    float(result)
}
