// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use meshmonitor_desktop_lib::{start_backend, stop_backend, tray, BackendState, Config};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

// Tauri commands must be defined in the binary crate to avoid E0255 duplicate symbol errors

#[tauri::command]
fn get_config() -> Result<Config, String> {
    Config::load()
}

#[tauri::command]
fn save_config(config: Config) -> Result<(), String> {
    config.save()
}

#[tauri::command]
fn get_web_url() -> Result<String, String> {
    let config = Config::load()?;
    Ok(format!("http://localhost:{}", config.web_port))
}

#[tauri::command]
fn restart_backend(app: AppHandle, state: tauri::State<'_, BackendState>) -> Result<(), String> {
    // Stop existing backend
    stop_backend(&state);

    // Start new backend
    let child = start_backend(&app)?;

    // Store in state
    let mut process = state.process.lock().unwrap();
    *process = Some(child);

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(BackendState {
            process: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Load or create configuration
            let config = Config::load().unwrap_or_default();

            // Check if first-run setup is needed
            if config.needs_setup() {
                // Show setup window
                let window = tauri::WebviewWindowBuilder::new(
                    &handle,
                    "setup",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("MeshMonitor Setup")
                .inner_size(450.0, 400.0)
                .resizable(false)
                .center()
                .build()?;

                window.show()?;
            } else {
                // Start the backend server
                match start_backend(&handle) {
                    Ok(child) => {
                        let state: tauri::State<BackendState> = handle.state();
                        let mut process = state.process.lock().unwrap();
                        *process = Some(child);
                        println!("Backend started successfully");
                    }
                    Err(e) => {
                        eprintln!("Failed to start backend: {}", e);
                        // Show error dialog or settings window
                    }
                }
            }

            // Setup system tray
            tray::setup_tray(&handle)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide window instead of closing on close request (minimize to tray)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_web_url,
            restart_backend,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Stop the backend when the app exits
                let state: tauri::State<BackendState> = app.state();
                stop_backend(&state);
            }
        });
}
