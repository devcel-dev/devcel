//! Constrain the configured/restored size without imposing a larger minimum.
use tauri::Manager;

fn fit(size: (u32, u32), available: (u32, u32)) -> (u32, u32) {
    (
        size.0.min(available.0).max(1),
        size.1.min(available.1).max(1),
    )
}

// set_size takes inner pixels; the work-area budget includes the native frame.
fn inner_for_outer(inner: (u32, u32), outer: (u32, u32), target: (u32, u32)) -> (u32, u32) {
    (
        target
            .0
            .saturating_sub(outer.0.saturating_sub(inner.0))
            .max(1),
        target
            .1
            .saturating_sub(outer.1.saturating_sub(inner.1))
            .max(1),
    )
}

pub(crate) fn fit_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    // Both values are physical pixels, so high-DPI monitors need no guessed scale.
    let area = monitor.work_area();
    if area.size.width == 0 || area.size.height == 0 {
        return Ok(());
    }
    let current = window.outer_size()?;
    let (width, height) = fit(
        (current.width, current.height),
        (area.size.width, area.size.height),
    );
    if (width, height) != (current.width, current.height) {
        let inner = window.inner_size()?;
        let size = inner_for_outer(
            (inner.width, inner.height),
            (current.width, current.height),
            (width, height),
        );
        window.set_size(tauri::PhysicalSize::new(size.0, size.1))?;
    }
    // Re-read the accepted size because platform minimums may constrain resizing.
    let actual = window.outer_size()?;
    let (width, height) = fit(
        (actual.width, actual.height),
        (area.size.width, area.size.height),
    );
    let position = window.outer_position()?;
    let right = i64::from(area.position.x) + i64::from(area.size.width) - i64::from(width);
    let bottom = i64::from(area.position.y) + i64::from(area.size.height) - i64::from(height);
    let x = i64::from(position.x).clamp(i64::from(area.position.x), right);
    let y = i64::from(position.y).clamp(i64::from(area.position.y), bottom);
    if (x, y) != (i64::from(position.x), i64::from(position.y)) {
        window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{fit, inner_for_outer};
    #[test]
    fn subtracts_native_frame_in_physical_pixels() {
        assert_eq!(
            inner_for_outer((960, 720), (976, 759), (800, 560)),
            (784, 521)
        );
        assert_eq!(
            inner_for_outer((1920, 1440), (1952, 1518), (1600, 1100)),
            (1568, 1022)
        );
        assert_eq!(
            inner_for_outer((960, 720), (960, 720), (800, 560)),
            (800, 560)
        );
        assert_eq!(inner_for_outer((1, 1), (20, 40), (5, 5)), (1, 1));
    }
    #[test]
    fn preserves_existing_sizes_and_fits_small_or_scaled_work_areas() {
        assert_eq!(fit((960, 720), (1920, 1040)), (960, 720));
        assert_eq!(fit((700, 450), (1920, 1040)), (700, 450));
        assert_eq!(fit((960, 720), (800, 560)), (800, 560));
        assert_eq!(fit((1920, 1440), (1600, 1100)), (1600, 1100));
    }
}
