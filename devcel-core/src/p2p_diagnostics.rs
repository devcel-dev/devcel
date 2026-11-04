//! Optional local transport event locations, without authored paths or values.
pub(crate) fn enabled() -> bool {
    std::env::var_os("DEVCEL_P2P_DIAGNOSTICS").is_some_and(|value| value == "1")
}
pub(crate) fn emit(template: &str, module: &str, line: u32) {
    eprintln!("[{module}:{line}] {}", redact(template));
}
fn redact(template: &str) -> String {
    let mut output = String::new();
    let mut placeholder = false;
    for character in template.chars() {
        match character {
            '{' => {
                placeholder = true;
                output.push_str("<redacted>");
            }
            '}' => placeholder = false,
            _ if !placeholder => output.push(character),
            _ => {}
        }
    }
    output
}
macro_rules! trace {
    ($template:literal $($arguments:tt)*) => {
        if $crate::p2p_diagnostics::enabled() {
            // Type-check original arguments without rendering their values.
            let _ = format_args!($template $($arguments)*);
            $crate::p2p_diagnostics::emit($template, module_path!(), line!());
        }
    };
}
pub(crate) use trace;

#[cfg(test)]
mod tests {
    #[test]
    fn diagnostic_templates_never_interpolate_runtime_values() {
        assert_eq!(
            super::redact("Project {normalized_path}, cause {e:?}"),
            "Project <redacted>, cause <redacted>"
        );
        assert_eq!(
            super::redact("Client {} message {}"),
            "Client <redacted> message <redacted>"
        );
    }
}
