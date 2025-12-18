pub mod config;
pub mod tray;

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// Strip the Windows extended-length path prefix (\\?\) if present.
/// Node.js doesn't handle this prefix correctly, causing path resolution failures.
#[cfg(windows)]
fn strip_extended_length_prefix(path: PathBuf) -> PathBuf {
    let path_str = path.to_string_lossy();
    if path_str.starts_with(r"\\?\") {
        PathBuf::from(&path_str[4..])
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_extended_length_prefix(path: PathBuf) -> PathBuf {
    path
}

// Re-export Config for use in main.rs commands
pub use config::Config;

/// Global state for the backend process
pub struct BackendState {
    pub process: Mutex<Option<Child>>,
}

/// Write a log message to the MeshMonitor log file
fn log_to_file(logs_path: &std::path::Path, message: &str) {
    let log_file_path = logs_path.join("desktop.log");
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "[{}] {}", timestamp, message);
    }
}

/// Start the MeshMonitor backend server
pub fn start_backend<R: Runtime>(app: &AppHandle<R>) -> Result<Child, String> {
    let config = Config::load()?;

    // Get paths
    let db_path = config::get_database_path()?;
    let logs_path = config::get_logs_path()?;

    // Ensure logs directory exists
    std::fs::create_dir_all(&logs_path)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;

    log_to_file(&logs_path, "=== Starting MeshMonitor backend ===");

    // Get the resource directory where the server files are bundled
    // Strip the \\?\ prefix on Windows as Node.js doesn't handle it correctly
    let resource_path = strip_extended_length_prefix(
        app.path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?,
    );

    let server_path = resource_path.join("dist").join("server").join("server.js");

    // Get the sidecar binary path for Node.js
    let node_path = resource_path
        .join("binaries")
        .join(if cfg!(windows) { "node.exe" } else { "node" });

    // Get the dist directory for current working directory (server.js imports ../services/, ../utils/, etc.)
    let server_dir = resource_path.join("dist");

    // Log all paths for debugging
    log_to_file(&logs_path, &format!("Node path: {:?}", node_path));
    log_to_file(&logs_path, &format!("Server path: {:?}", server_path));
    log_to_file(&logs_path, &format!("Server dir: {:?}", server_dir));
    log_to_file(&logs_path, &format!("Database: {:?}", db_path));
    log_to_file(&logs_path, &format!("Logs: {:?}", logs_path));

    // Check if required files exist
    if !node_path.exists() {
        let msg = format!("ERROR: Node.js binary not found at {:?}", node_path);
        log_to_file(&logs_path, &msg);
        return Err(msg);
    }
    log_to_file(&logs_path, "Node.js binary exists: OK");

    if !server_path.exists() {
        let msg = format!("ERROR: Server.js not found at {:?}", server_path);
        log_to_file(&logs_path, &msg);
        return Err(msg);
    }
    log_to_file(&logs_path, "Server.js exists: OK");

    // Check for package.json (in dist/ directory)
    let package_json_path = server_dir.join("package.json");
    if !package_json_path.exists() {
        let msg = format!("ERROR: package.json not found at {:?}", package_json_path);
        log_to_file(&logs_path, &msg);
        return Err(msg);
    }
    log_to_file(&logs_path, "package.json exists: OK");

    // Check for node_modules (in dist/ directory)
    let node_modules_path = server_dir.join("node_modules");
    if !node_modules_path.exists() {
        let msg = format!("ERROR: node_modules not found at {:?}", node_modules_path);
        log_to_file(&logs_path, &msg);
        return Err(msg);
    }
    log_to_file(&logs_path, "node_modules exists: OK");

    // Check for services directory (sibling to server/)
    let services_path = server_dir.join("services");
    if !services_path.exists() {
        let msg = format!("ERROR: services not found at {:?}", services_path);
        log_to_file(&logs_path, &msg);
        return Err(msg);
    }
    log_to_file(&logs_path, "services directory exists: OK");

    println!("Starting MeshMonitor backend...");
    println!("  Node path: {:?}", node_path);
    println!("  Server path: {:?}", server_path);
    println!("  Server dir: {:?}", server_dir);
    println!("  Database: {:?}", db_path);
    println!("  Logs: {:?}", logs_path);

    // Create stdout/stderr log files
    let stdout_log_path = logs_path.join("server-stdout.log");
    let stderr_log_path = logs_path.join("server-stderr.log");

    let stdout_file = File::create(&stdout_log_path)
        .map_err(|e| format!("Failed to create stdout log: {}", e))?;
    let stderr_file = File::create(&stderr_log_path)
        .map_err(|e| format!("Failed to create stderr log: {}", e))?;

    log_to_file(&logs_path, &format!("Stdout log: {:?}", stdout_log_path));
    log_to_file(&logs_path, &format!("Stderr log: {:?}", stderr_log_path));

    // Build environment variables
    let mut cmd = std::process::Command::new(&node_path);
    cmd.arg(&server_path)
        .current_dir(&server_dir)
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .env("NODE_ENV", "production")
        .env("PORT", config.web_port.to_string())
        .env("MESHTASTIC_NODE_IP", &config.meshtastic_ip)
        .env("MESHTASTIC_TCP_PORT", config.meshtastic_port.to_string())
        .env("DATABASE_PATH", db_path.to_string_lossy().to_string())
        .env("SESSION_SECRET", &config.session_secret)
        .env(
            "ALLOWED_ORIGINS",
            format!("http://localhost:{}", config.web_port),
        );

    log_to_file(&logs_path, "Environment variables set");
    log_to_file(&logs_path, &format!("PORT: {}", config.web_port));
    log_to_file(
        &logs_path,
        &format!("MESHTASTIC_NODE_IP: {}", config.meshtastic_ip),
    );

    // On Windows, hide the console window
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        log_to_file(&logs_path, "Windows: CREATE_NO_WINDOW flag set");
    }

    log_to_file(&logs_path, "Spawning Node.js process...");

    let child = cmd.spawn().map_err(|e| {
        let msg = format!("Failed to start backend: {}", e);
        log_to_file(&logs_path, &msg);
        msg
    })?;

    let pid = child.id();
    log_to_file(&logs_path, &format!("Backend started with PID: {}", pid));
    println!("Backend started with PID: {}", pid);

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

// Note: Tauri commands are defined in main.rs to avoid E0255 duplicate symbol errors
// that occur when #[tauri::command] is used in a library crate with generate_handler![]
