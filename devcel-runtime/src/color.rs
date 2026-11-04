//! Precision-only RGBA values. Components are straight alpha; no implicit color-space conversion.
//! Color32 display defaults to sRGB and ColorFloat display defaults to linear, independently of storage.

/// Four unnormalized RGBA bytes, with stable C ABI layout.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Color32 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Default for Color32 {
    fn default() -> Self {
        Self {
            r: 255,
            g: 255,
            b: 255,
            a: 255,
        }
    }
}

impl Color32 {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let [r, g, b, a]: [u8; 4] = serde_json::from_str(raw)
            .map_err(|_| "Color32 requires four integer RGBA components in 0..255".to_string())?;
        Ok(Self { r, g, b, a })
    }
    pub fn components(self) -> [u8; 4] {
        [self.r, self.g, self.b, self.a]
    }
}

/// Four finite RGBA floats, with stable C ABI layout. RGB is unrestricted; alpha is 0..1.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorFloat {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Default for ColorFloat {
    fn default() -> Self {
        Self {
            r: 1.0,
            g: 1.0,
            b: 1.0,
            a: 1.0,
        }
    }
}

impl ColorFloat {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let values: [f64; 4] = serde_json::from_str(raw)
            .map_err(|_| "ColorFloat requires four finite RGBA components".to_string())?;
        if values.iter().any(|v| !v.is_finite()) || !(0.0..=1.0).contains(&values[3]) {
            return Err("ColorFloat requires finite RGB and alpha in 0..1".into());
        }
        let values = values.map(|value| value as f32);
        if values.iter().any(|value| !value.is_finite()) {
            return Err("ColorFloat channels must fit finite f32".into());
        }
        let [r, g, b, a] = values;
        Ok(Self { r, g, b, a })
    }
    pub fn components(self) -> [f32; 4] {
        [self.r, self.g, self.b, self.a]
    }
}
