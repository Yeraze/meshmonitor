// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use meshmonitor_desktop_lib::{config::Config, tray, BackendState, start_backend, stop_backend};
use std::sync::Mutex;
use tauri::Manager;

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
            meshmonitor_desktop_lib::get_config,
            meshmonitor_desktop_lib::save_config,
            meshmonitor_desktop_lib::get_web_url,
            meshmonitor_desktop_lib::restart_backend,
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
