//! Validation shared by command/API entry points. Curves have a monotone x axis;
//! tangent lengths are at most a full segment so inversion by bisection is valid.

pub fn validate_curve(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    let data: serde_json::Value =
        serde_json::from_str(value).map_err(|e| format!("Invalid curve JSON: {e}"))?;
    let points = data
        .get("points")
        .and_then(serde_json::Value::as_array)
        .filter(|p| p.len() >= 2)
        .ok_or("A curve requires at least two points, including its start and end")?;
    let mut previous = -1.0;
    for (i, point) in points.iter().enumerate() {
        let x = point
            .get("x")
            .and_then(serde_json::Value::as_f64)
            .ok_or("Point x must be a finite number")?;
        let y = point
            .get("y")
            .and_then(serde_json::Value::as_f64)
            .ok_or("Point y must be a finite number")?;
        if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || x <= previous {
            return Err(
                "Curve x values must be unique and ascending within the range 0 to 1".into(),
            );
        }
        if (i == 0 && x != 0.0) || (i == points.len() - 1 && x != 1.0) {
            return Err("The curve must start at x=0 and end at x=1".into());
        }
        previous = x;
        let mode = point
            .get("mode")
            .and_then(serde_json::Value::as_str)
            .ok_or("Tangent mode is required")?;
        if !["constant", "linear", "auto", "autoLength", "free"].contains(&mode) {
            return Err("Invalid tangent mode".into());
        }
        for field in ["inSlope", "outSlope", "inLen", "outLen"] {
            if let Some(v) = point.get(field) {
                let n = v
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or("Tangents must be finite numbers")?;
                if field.ends_with("Len") && !(0.0..=3.0).contains(&n) {
                    return Err("Tangent length multipliers must be between 0 and 3".into());
                }
            }
        }
    }
    Ok(())
}

/// Materialize a Curve cell's endpoint settings before formula/LOOKUP evaluation.
/// The formula engine passes canonical stored values, so IF and dependent cells
/// retain the same curve without introducing a second interpolation algorithm.
pub(crate) fn formula_curve_value(
    value: &str,
    config: Option<&crate::types::CurveConfig>,
) -> Result<String, String> {
    let runtime_config = config.map(|config| devcel_runtime::curve::CurveConfig {
        start_value: config.start_value,
        end_value: config.end_value,
    });
    devcel_runtime::curve::Curve::parse(value, runtime_config.as_ref())?;
    let mut data: serde_json::Value = if value.is_empty() {
        serde_json::json!({"points":[{"x":0,"y":0,"mode":"auto"},{"x":1,"y":1,"mode":"auto"}]})
    } else {
        serde_json::from_str(value).map_err(|error| error.to_string())?
    };
    if let Some(config) = config {
        let points = data["points"]
            .as_array_mut()
            .ok_or("Curve points are required")?;
        let last = points.len() - 1;
        points[0]["y"] = serde_json::json!(config.start_value);
        points[last]["y"] = serde_json::json!(config.end_value);
    }
    serde_json::to_string(&data).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_current_explicit_modes_and_empty_curves() {
        for s in [
            "",
            r#"{"points":[{"x":0,"y":1,"mode":"auto"},{"x":1,"y":2,"mode":"auto"}],"label":"曲線"}"#,
            r#"{"points":[{"x":0,"y":0,"mode":"constant"},{"x":0.5,"y":2,"mode":"free","outLen":3},{"x":1,"y":1,"mode":"auto"}]}"#,
        ] {
            assert!(validate_curve(s).is_ok(), "{s}");
        }
    }
    #[test]
    fn rejects_malformed_or_nonmonotonic_curves() {
        for s in [
            "hello",
            r#"{"points":[{"x":0,"y":0},{"x":1,"y":1}]}"#,
            r#"{"points":[null,null]}"#,
            r#"{"points":[{},{}]}"#,
            r#"{"points":[{"x":0,"y":0,"mode":"unknown"},{"x":1,"y":1}]}"#,
            r#"{"points":[{"x":0,"y":0,"outLen":4},{"x":1,"y":1}]}"#,
            r#"{"points":[{"x":0,"y":0},{"x":0,"y":1},{"x":1,"y":1}]}"#,
            r#"{"points":[{"x":0.1,"y":0},{"x":1,"y":1}]}"#,
        ] {
            assert!(validate_curve(s).is_err(), "{s}");
        }
    }
}
