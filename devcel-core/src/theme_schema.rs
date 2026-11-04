//! Canonical fields for one-record-per-theme settings.
pub const COLOR_FIELDS: [(&str, &str, &str); 20] = [
    (
        "background",
        "background",
        "1b1f1af7-c6ae-5bc2-9e1d-2855cdc97a1b",
    ),
    (
        "foreground",
        "foreground",
        "a8bd63c3-3888-5833-9a57-1434c1096806",
    ),
    ("muted", "muted", "9ff539eb-9e0d-53cb-993b-30d2727b4559"),
    (
        "muted-foreground",
        "muted_foreground",
        "009f6ee6-dc83-5af9-b4e2-89114d6fc666",
    ),
    ("popover", "popover", "35f03ac7-3ea6-5d47-b5f7-7f0ecf86eefd"),
    (
        "popover-foreground",
        "popover_foreground",
        "be7fda2a-161f-59e7-98c0-23b4b67458b2",
    ),
    ("border", "border", "ecd0ef4a-fc07-5997-9346-2cf62cf5a348"),
    ("input", "input", "b5d41c6f-ecb9-50a8-92bf-a4d3f4d3cb4c"),
    ("card", "card", "a1b7723a-e2d2-5233-8305-e6dc044e0608"),
    (
        "card-foreground",
        "card_foreground",
        "061f87f8-8ba3-5701-9d7e-2fa3b191baa4",
    ),
    ("primary", "primary", "0edca35d-2f0b-5d2a-9b45-419b7afdc5fb"),
    (
        "primary-ink",
        "primary_ink",
        "08e88c1b-661e-54eb-86c2-7f565b54f503",
    ),
    (
        "primary-foreground",
        "primary_foreground",
        "57e5bc76-27eb-5481-b405-99ad70156f11",
    ),
    (
        "secondary",
        "secondary",
        "1987a91a-246b-5323-ace3-21af0b77600e",
    ),
    (
        "secondary-foreground",
        "secondary_foreground",
        "3e043369-94e3-5512-b13a-f5ac17c0d622",
    ),
    ("accent", "accent", "bf7bcdc0-93b3-5f7d-a433-2f91e7ebd4e6"),
    (
        "accent-foreground",
        "accent_foreground",
        "58716bb8-11fb-5d01-9450-e475b20745dc",
    ),
    (
        "destructive",
        "destructive",
        "5149fe49-026f-5901-8ed0-d8356776b5df",
    ),
    (
        "destructive-foreground",
        "destructive_foreground",
        "92156483-9599-5371-b87d-d3abd5ecb2c6",
    ),
    ("ring", "ring", "ef0d4990-bc23-5b50-be26-c48e34a73462"),
];
pub const DARK_FIELD_UUID: &str = "dc35e803-3a3a-5c76-b8d1-d147de5b568a";

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_theme_requires_explicit_boolean_appearance() {
        let mut value = serde_json::json!({"key":"Dusk","labelKey":"theme.dusk","tokens":{}});
        assert!(serde_json::from_value::<crate::app_catalog::Theme>(value.clone()).is_err());
        value["isDark"] = serde_json::json!("true");
        assert!(serde_json::from_value::<crate::app_catalog::Theme>(value.clone()).is_err());
        value["isDark"] = serde_json::json!(true);
        assert!(
            serde_json::from_value::<crate::app_catalog::Theme>(value)
                .unwrap()
                .is_dark
        );
    }
}
