//! Capture OS language preferences before native UTF-8 environment overrides.
use std::sync::OnceLock;

pub(crate) const PARENT_SYSTEM_LANGUAGES_ENV: &str = "DEVCEL_PARENT_SYSTEM_LANGUAGES";
const MAX_SYSTEM_LANGUAGES: usize = 32;
const MAX_LANGUAGE_BYTES: usize = 128;
const MAX_INHERITED_BYTES: usize = 8192;
static SYSTEM_LANGUAGES: OnceLock<Vec<String>> = OnceLock::new();

fn valid_language(language: &str) -> bool {
    !language.is_empty()
        && language.len() <= MAX_LANGUAGE_BYTES
        && language
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || b"-_.@".contains(&character))
}

fn inherited_languages(value: &str) -> Option<Vec<String>> {
    if value.len() > MAX_INHERITED_BYTES {
        return None;
    }
    let languages: Vec<String> = serde_json::from_str(value).ok()?;
    if languages.len() > MAX_SYSTEM_LANGUAGES
        || !languages.iter().all(|value| valid_language(value))
    {
        return None;
    }
    Some(languages)
}

fn capture_candidates(
    inherited: Option<&str>,
    system: impl FnOnce() -> Vec<String>,
) -> Vec<String> {
    inherited.and_then(inherited_languages).unwrap_or_else(|| {
        system()
            .into_iter()
            .filter(|language| valid_language(language))
            .take(MAX_SYSTEM_LANGUAGES)
            .collect()
    })
}

/// Must run before main.rs changes C/environment locales for UTF-8 handling.
/// A settings child inherits the parent's original capture, not its forced LANG.
pub fn capture_system_languages() {
    SYSTEM_LANGUAGES.get_or_init(|| {
        let inherited = std::env::var(PARENT_SYSTEM_LANGUAGES_ENV).ok();
        capture_candidates(inherited.as_deref(), || sys_locale::get_locales().collect())
    });
}

pub(crate) fn captured_system_languages() -> &'static [String] {
    capture_system_languages();
    SYSTEM_LANGUAGES
        .get()
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// The captured list is already bounded and contains only ordinary locale IDs.
/// This string is passed with Command.env; the running process environment stays unchanged.
pub(crate) fn languages_for_child() -> String {
    serde_json::to_string(captured_system_languages()).unwrap_or_else(|_| "[]".into())
}

fn resolve_locale(languages: &[String], locales: &[String]) -> String {
    for language in languages {
        let normalized = language.replace('_', "-");
        let normalized = normalized.split(['.', '@']).next().unwrap_or("");
        if let Some(locale) = locales
            .iter()
            .find(|locale| locale.as_str() != "en-XA" && locale.eq_ignore_ascii_case(normalized))
        {
            return locale.clone();
        }
        let lower = normalized.to_ascii_lowercase();
        let parts: Vec<_> = lower.split('-').collect();
        let base = parts[0];
        // Match the frontend: explicit Chinese script wins over region.
        let alias = match base {
            "zh" if parts.contains(&"hant") => "zh-Hant",
            "zh" if parts.contains(&"hans") => "zh-Hans",
            "zh" if parts.iter().any(|part| ["tw", "hk", "mo"].contains(part)) => "zh-Hant",
            "zh" => "zh-Hans",
            "no" => "nb",
            _ => base,
        };
        if let Some(locale) = locales
            .iter()
            .find(|locale| locale.as_str() != "en-XA" && locale.eq_ignore_ascii_case(alias))
        {
            return locale.clone();
        }
        if let Some(locale) = locales
            .iter()
            .find(|locale| locale.as_str() != "en-XA" && locale.eq_ignore_ascii_case(base))
        {
            return locale.clone();
        }
    }
    if locales.iter().any(|locale| locale == "ja") {
        "ja".into()
    } else {
        locales.first().cloned().unwrap_or_else(|| "ja".into())
    }
}

pub(crate) fn system_locale_for(locales: &[String]) -> String {
    resolve_locale(captured_system_languages(), locales)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn available() -> Vec<String> {
        vec!["ja".into(), "en".into()]
    }

    #[test]
    fn settings_child_keeps_parent_japanese_and_english_before_utf8_override() {
        for (parent, child_environment, expected) in [
            (r#"["ja_JP.UTF-8"]"#, "en_US.UTF-8", "ja"),
            (r#"["en-US"]"#, "ja_JP.UTF-8", "en"),
        ] {
            let captured = capture_candidates(Some(parent), || vec![child_environment.into()]);
            assert_eq!(resolve_locale(&captured, &available()), expected);
            // Passing the capture to another child preserves order and values exactly.
            assert_eq!(
                inherited_languages(&serde_json::to_string(&captured).unwrap()),
                Some(captured)
            );
        }
    }

    #[test]
    fn valid_parent_capture_is_authoritative_including_an_empty_capture() {
        assert_eq!(
            capture_candidates(Some(r#"["fr-FR","ja-JP"]"#), || panic!(
                "OS fallback was recaptured"
            )),
            vec!["fr-FR".to_string(), "ja-JP".to_string()]
        );
        assert!(capture_candidates(Some("[]"), || panic!("OS fallback was recaptured")).is_empty());
    }

    #[test]
    fn malformed_or_oversized_parent_capture_falls_back_to_current_os() {
        let invalid = [
            "not-json".into(),
            "{}".into(),
            "[1]".into(),
            "[\"\"]".into(),
            "[\"ja\\nJP\"]".into(),
            "[\"日本語\"]".into(),
            serde_json::to_string(&vec!["ja"; MAX_SYSTEM_LANGUAGES + 1]).unwrap(),
            serde_json::to_string(&vec!["a".repeat(MAX_LANGUAGE_BYTES + 1)]).unwrap(),
            " ".repeat(MAX_INHERITED_BYTES + 1),
        ];
        for value in invalid {
            let captured = capture_candidates(Some(&value), || vec!["en_US.UTF-8".into()]);
            assert_eq!(resolve_locale(&captured, &available()), "en");
        }
    }

    #[test]
    fn os_capture_is_bounded_before_child_serialization() {
        let captured = capture_candidates(None, || vec!["ja_JP.UTF-8".into(); 100]);
        assert_eq!(captured.len(), MAX_SYSTEM_LANGUAGES);
        assert!(serde_json::to_string(&captured).unwrap().len() <= MAX_INHERITED_BYTES);
    }
}
