//! Curves using the same tangent rules as Devcel/Studio/Godot.
//! Build control points on load; sample in O(log n) without allocations.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
pub struct CurveConfig {
    pub start_value: f64,
    pub end_value: f64,
}

#[derive(Debug)]
struct Point {
    x: f64,
    y: f64,
    mode: String,
    in_slope: Option<f64>,
    out_slope: Option<f64>,
    in_len: f64,
    out_len: f64,
}

#[derive(Debug, Clone)]
struct Segment {
    x: [f64; 4],
    y: [f64; 4],
    constant: bool,
}

#[derive(Debug, Clone)]
pub struct Curve {
    segments: Vec<Segment>,
    end_value: f64,
}

impl Curve {
    /// Empty cells use the default 0-to-1 curve, or configured endpoints. Configuration fixes stored endpoint y values.
    pub fn parse(text: &str, config: Option<&CurveConfig>) -> Result<Self, String> {
        if config.is_some_and(|c| !c.start_value.is_finite() || !c.end_value.is_finite()) {
            return Err("curve_config must contain finite numbers".into());
        }
        let data: Value = if text.is_empty() {
            serde_json::json!({"points":[{"x":0,"y":0,"mode":"auto"},{"x":1,"y":1,"mode":"auto"}]})
        } else {
            serde_json::from_str(text).map_err(|e| format!("Invalid curve JSON: {e}"))?
        };
        let source = data
            .get("points")
            .and_then(Value::as_array)
            .filter(|p| p.len() >= 2)
            .ok_or("A curve requires at least two points")?;
        let number = |v: &Value| {
            v.as_f64()
                .filter(|n| n.is_finite())
                .ok_or("Curve values must be finite numbers")
        };
        let mut points = Vec::with_capacity(source.len());
        let mut previous = -1.0;
        for raw in source {
            let x = number(raw.get("x").ok_or("x is required")?)?;
            let y = number(raw.get("y").ok_or("y is required")?)?;
            if !(0.0..=1.0).contains(&x) || x <= previous {
                return Err("Curve x values must be strictly increasing within 0 to 1".into());
            }
            previous = x;
            let mode = raw
                .get("mode")
                .and_then(Value::as_str)
                .ok_or("Tangent mode is required")?;
            if !["constant", "linear", "auto", "autoLength", "free"].contains(&mode) {
                return Err("Invalid tangent mode".into());
            }
            let optional = |key| raw.get(key).map(number).transpose();
            let in_len = optional("inLen")?.unwrap_or(1.0);
            let out_len = optional("outLen")?.unwrap_or(1.0);
            if !(0.0..=3.0).contains(&in_len) || !(0.0..=3.0).contains(&out_len) {
                return Err("Tangent length multipliers must be between 0 and 3".into());
            }
            points.push(Point {
                x,
                y,
                mode: mode.into(),
                in_slope: optional("inSlope")?,
                out_slope: optional("outSlope")?,
                in_len,
                out_len,
            });
        }
        let last = points.len() - 1;
        if points[0].x != 0.0 || points[last].x != 1.0 {
            return Err("The curve's starting x must be 0 and ending x must be 1".into());
        }
        if let Some(c) = config {
            points[0].y = c.start_value;
            points[last].y = c.end_value;
        }
        let auto_slope = |i: usize| {
            let left = &points[i.saturating_sub(1)];
            let right = &points[(i + 1).min(last)];
            (right.y - left.y) / (right.x - left.x).max(1e-9)
        };
        let handle = |i: usize, outgoing: bool| {
            let p = &points[i];
            match p.mode.as_str() {
                "constant" => (0.0, 1.0),
                "linear" => {
                    let other = &points[if outgoing { i + 1 } else { i - 1 }];
                    (
                        (other.y - p.y) / (other.x - p.x).abs().max(1e-9)
                            * if outgoing { 1.0 } else { -1.0 },
                        1.0,
                    )
                }
                _ => {
                    let explicit = if outgoing { p.out_slope } else { p.in_slope };
                    let slope = if p.mode == "free" {
                        explicit.unwrap_or_else(|| auto_slope(i))
                    } else {
                        auto_slope(i)
                    };
                    (slope, if outgoing { p.out_len } else { p.in_len })
                }
            }
        };
        let mut segments = Vec::with_capacity(last);
        for i in 0..last {
            let a = &points[i];
            let b = &points[i + 1];
            let (out_slope, out_len) = handle(i, true);
            let (in_slope, in_len) = handle(i + 1, false);
            let ol = (b.x - a.x) / 3.0 * out_len;
            let il = (b.x - a.x) / 3.0 * in_len;
            let constant = a.mode == "constant";
            let segment = Segment {
                x: [a.x, a.x + ol, b.x - il, b.x],
                y: if constant {
                    [a.y, a.y, b.y, b.y]
                } else {
                    [a.y, a.y + out_slope * ol, b.y - in_slope * il, b.y]
                },
                constant,
            };
            if segment.y.iter().any(|n| !n.is_finite()) {
                return Err("Curve control points exceeded the finite numeric range".into());
            }
            segments.push(segment);
        }
        Ok(Self {
            segments,
            end_value: points[last].y,
        })
    }

    pub fn sample(&self, x: f64) -> f64 {
        if x.is_nan() {
            return 0.0;
        }
        if x <= 0.0 {
            return self.segments[0].y[0];
        }
        if x >= 1.0 {
            return self.end_value;
        }
        // Choose the segment to the right of a node so constant segments switch correctly at their endpoint.
        let i = self.segments.partition_point(|s| s.x[3] <= x);
        let segment = &self.segments[i];
        if segment.constant || x == segment.x[0] {
            return segment.y[0];
        }
        let mut lo = 0.0;
        let mut hi = 1.0;
        for _ in 0..40 {
            let mid = (lo + hi) * 0.5;
            let sample_x = bezier(segment.x, mid);
            // Preserve an exact solution instead of perturbing it with more bisection.
            if sample_x == x {
                return bezier(segment.y, mid);
            }
            if sample_x < x {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        bezier(segment.y, (lo + hi) * 0.5)
    }
}

fn bezier(p: [f64; 4], t: f64) -> f64 {
    let u = 1.0 - t;
    u * u * u * p[0] + 3.0 * u * u * t * p[1] + 3.0 * u * t * t * p[2] + t * t * t * p[3]
}
