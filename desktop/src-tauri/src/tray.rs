use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};
use tauri_plugin_opener::OpenerExt;

use crate::config::Config;

/// Build and configure the system tray
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    // Create menu items
    let open_item = MenuItem::with_id(app, "open", "Open MeshMonitor", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let logs_item = MenuItem::with_id(app, "logs", "Open Data Folder", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    // Build menu
    let menu = Menu::with_items(app, &[&open_item, &settings_item, &logs_item, &quit_item])?;

    // Build tray icon
    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("MeshMonitor")
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id.as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Left click opens the web UI
                open_web_ui(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Handle tray menu item clicks
fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, item_id: &str) {
    match item_id {
        "open" => {
            open_web_ui(app);
        }
        "settings" => {
            show_settings_window(app);
        }
        "logs" => {
            open_data_folder();
        }
        "quit" => {
            app.exit(0);
        }
        _ => {
            println!("Unknown menu item: {}", item_id);
        }
    }
}

/// Open the web UI in the default browser
fn open_web_ui<R: Runtime>(app: &AppHandle<R>) {
    let config = Config::load().unwrap_or_default();
    let url = format!("http://localhost:{}", config.web_port);

    if let Err(e) = app.opener().open_url(&url, None::<&str>) {
        eprintln!("Failed to open browser: {}", e);
    }
}

/// Show the settings window
fn show_settings_window<R: Runtime>(app: &AppHandle<R>) {
    // Check if settings window already exists
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        // Create new settings window
        match tauri::WebviewWindowBuilder::new(
            app,
            "settings",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("MeshMonitor Settings")
        .inner_size(450.0, 400.0)
        .resizable(false)
        .center()
        .build()
        {
            Ok(window) => {
                let _ = window.show();
            }
            Err(e) => {
                eprintln!("Failed to create settings window: {}", e);
            }
        }
    }
}

/// Open the data folder in file explorer
fn open_data_folder() {
    if let Ok(data_path) = crate::config::get_data_path() {
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("explorer")
                .arg(data_path)
                .spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open").arg(data_path).spawn();
        }
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("xdg-open")
                .arg(data_path)
                .spawn();
        }
    }
}
