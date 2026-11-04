// Hide the console window in Windows release builds.
#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use std::env;
use std::ffi::CString;

/// Main entry point for the Devcel application
/// Force a UTF-8 locale to prevent garbled text
fn main() {
    devcel_studio_lib::locale_settings::capture_system_languages();

    // Set the default UTF-8 locale
    let default_locale = "en_US.UTF-8";

    // Set the system locale using libc's setlocale function
    unsafe {
        let locale = CString::new(default_locale).unwrap();
        libc::setlocale(libc::LC_ALL, locale.as_ptr());
    }

    // Set all locale-related environment variables
    let locale_vars = [
        "LC_ALL",      // Overall locale
        "LANG",        // Default language
        "LC_CTYPE",    // Character classification and conversion
        "LC_NUMERIC",  // Numeric formatting
        "LC_TIME",     // Date and time formatting
        "LC_COLLATE",  // String comparison and sorting
        "LC_MONETARY", // Currency formatting
        "LC_MESSAGES", // Message language
    ];

    // Set a UTF-8 locale for each environment variable
    for var in locale_vars {
        env::set_var(var, default_locale);
    }

    // Set the panic handler
    std::panic::set_hook(Box::new(|panic_info| {
        eprintln!("==== PANIC ====");
        eprintln!("{panic_info}");
    }));

    // Start the Tauri application
    devcel_studio_lib::run()
}
