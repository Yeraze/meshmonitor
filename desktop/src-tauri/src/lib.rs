pub mod config;
pub mod tray;

use config::Config;
use std::process::Child;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// Global state for the backend process
pub struct BackendState {
    pub process: Mutex<Option<Child>>,
}

/// Start the MeshMonitor backend server
pub fn start_backend<R: Runtime>(app: &AppHandle<R>) -> Result<Child, String> {
    let config = Config::load()?;

    // Get paths
    let db_path = config::get_database_path()?;
    let logs_path = config::get_logs_path()?;

    // Get the resource directory where the server files are bundled
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    let server_path = resource_path.join("server").join("server.js");

    // Get the sidecar binary path for Node.js
    let node_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?
        .join("binaries")
        .join(if cfg!(windows) { "node.exe" } else { "node" });

    println!("Starting MeshMonitor backend...");
    println!("  Node path: {:?}", node_path);
    println!("  Server path: {:?}", server_path);
    println!("  Database: {:?}", db_path);
    println!("  Logs: {:?}", logs_path);

    // Build environment variables
    let mut cmd = std::process::Command::new(&node_path);
    cmd.arg(&server_path)
        .env("NODE_ENV", "production")
        .env("PORT", config.web_port.to_string())
        .env("MESHTASTIC_NODE_IP", &config.meshtastic_ip)
        .env("MESHTASTIC_TCP_PORT", config.meshtastic_port.to_string())
        .env("DATABASE_PATH", db_path.to_string_lossy().to_string())
        .env("SESSION_SECRET", &config.session_secret)
        .env("ALLOWED_ORIGINS", format!("http://localhost:{}", config.web_port));

    // On Windows, hide the console window
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to start backend: {}", e))?;

    println!("Backend started with PID: {}", child.id());
    Ok(child)
}

/// Stop the backend server
pub fn stop_backend(state: &BackendState) {
    let mut process = state.process.lock().unwrap();
    if let Some(mut child) = process.take() {
        println!("Stopping backend...");
        let _ = child.kill();
        let _ = child.wait();
        println!("Backend stopped");
    }
}

/// Tauri commands exposed to the frontend

#[tauri::command]
pub fn get_config() -> Result<Config, String> {
    Config::load()
}

#[tauri::command]
pub fn save_config(config: Config) -> Result<(), String> {
    config.save()
}

#[tauri::command]
pub fn get_web_url() -> Result<String, String> {
    let config = Config::load()?;
    Ok(format!("http://localhost:{}", config.web_port))
}

#[tauri::command]
pub fn restart_backend<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, BackendState>) -> Result<(), String> {
    // Stop existing backend
    stop_backend(&state);

    // Start new backend
    let child = start_backend(&app)?;

    // Store in state
    let mut process = state.process.lock().unwrap();
    *process = Some(child);

    Ok(())
}
