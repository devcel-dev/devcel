//! Typed, straight-alpha RGBA values. Color channels never encode UI decoration.
//! The editing/storage representation is a four-element JSON array in RGBA order.
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Four unsigned 8-bit channels, including alpha. No color-space conversion is
/// implied by constructing or storing this value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Color32(pub [u8; 4]);

impl Default for Color32 {
    fn default() -> Self {
        Self([255, 255, 255, 255])
    }
}

impl Color32 {
    pub const fn new(channels: [u8; 4]) -> Self {
        Self(channels)
    }

    pub const fn channels(&self) -> [u8; 4] {
        self.0
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        serde_json::from_str::<[u8; 4]>(value)
            .map(Self)
            .map_err(|_| "Color32 must be an RGBA JSON array of four integers from 0 to 255".into())
    }

    pub fn canonical_string(&self) -> String {
        // Serializing a fixed-size array of u8 cannot fail.
        serde_json::to_string(&self.0).expect("Color32 channels are JSON numbers")
    }
}

/// Four finite f32 channels. RGB is intentionally unbounded; alpha is 0..=1.
/// Straight alpha preserves RGB even when alpha is zero.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorFloat(pub [f32; 4]);

impl Default for ColorFloat {
    fn default() -> Self {
        Self([1.0, 1.0, 1.0, 1.0])
    }
}

impl ColorFloat {
    pub fn new(channels: [f32; 4]) -> Result<Self, String> {
        if !channels.iter().all(|channel| channel.is_finite()) {
            return Err("ColorFloat channels must be finite f32 values".into());
        }
        if !(0.0..=1.0).contains(&channels[3]) {
            return Err("ColorFloat alpha must be between 0 and 1".into());
        }
        Ok(Self(channels))
    }

    pub const fn channels(&self) -> [f32; 4] {
        self.0
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        // Parse as f64 first so alpha just outside the valid range cannot round
        // into it when converted to f32. Each RGB channel is then stored as f32.
        let channels = serde_json::from_str::<[f64; 4]>(value).map_err(|_| {
            "ColorFloat must be an RGBA JSON array of four finite numbers".to_string()
        })?;
        Self::from_f64(channels)
    }

    pub fn from_f64(channels: [f64; 4]) -> Result<Self, String> {
        if !channels.iter().all(|channel| channel.is_finite())
            || !(0.0..=1.0).contains(&channels[3])
        {
            return Err("ColorFloat requires finite RGB and alpha between 0 and 1".into());
        }
        Self::new(channels.map(|channel| channel as f32))
    }

    pub fn canonical_string(&self) -> String {
        serde_json::to_string(self).expect("validated ColorFloat channels are JSON numbers")
    }
}

impl Serialize for ColorFloat {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Self::new(self.0).map_err(serde::ser::Error::custom)?;
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ColorFloat {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_f64(<[f64; 4]>::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Column/header styling remains a CSS RGB hex value, independent of data types.
pub fn decorative_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}
