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
    if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
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
#[derive(Default)]
pub struct BackendState {
    pub process: Mutex<Option<Child>>,
    /// The frozen Apprise sidecar process. Started once at launch and kept
    /// alive across Node backend restarts. `None` when no apprise-api binary
    /// is bundled (e.g. dev builds) or the sidecar failed to start.
    pub apprise: Mutex<Option<Child>>,
    /// URL the Apprise sidecar is listening on (e.g. `http://127.0.0.1:8123`).
    /// Injected into the Node backend as APPRISE_URL so the notification
    /// service targets the bundled sidecar. `None` when no sidecar is running.
    pub apprise_url: Mutex<Option<String>>,
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

/// Ask the OS for a free TCP port on loopback by binding to port 0 and reading
/// back the assigned port. There is an inherent (small) race between releasing
/// the listener here and the sidecar binding it, but on a single-user desktop
/// that is acceptable and far safer than a hardcoded port that may collide.
fn find_free_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to find a free port for Apprise sidecar: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read Apprise sidecar port: {}", e))?
        .port();
    Ok(port)
}

/// Start the frozen Apprise sidecar, if the binary is bundled.
///
/// Returns `Ok(Some(url))` with the loopback URL the sidecar is listening on,
/// or `Ok(None)` when no apprise-api binary is present (dev builds / platforms
/// where the sidecar wasn't built). A missing sidecar is NOT an error — the
/// desktop app simply runs without bundled Apprise (users can still point at a
/// remote Apprise API via the `appriseApiServerUrl` global setting).
pub fn start_apprise<R: Runtime>(app: &AppHandle<R>) -> Result<Option<(Child, String)>, String> {
    let data_path = config::get_data_path()?;
    let logs_path = config::get_logs_path()?;
    std::fs::create_dir_all(&logs_path)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;

    let resource_path = strip_extended_length_prefix(
        app.path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?,
    );

    let apprise_path = resource_path.join("binaries").join(if cfg!(windows) {
        "apprise-api.exe"
    } else {
        "apprise-api"
    });

    if !apprise_path.exists() {
        log_to_file(
            &logs_path,
            &format!(
                "Apprise sidecar not bundled at {:?} — notifications via bundled Apprise disabled",
                apprise_path
            ),
        );
        return Ok(None);
    }

    let port = find_free_loopback_port()?;
    let url = format!("http://127.0.0.1:{}", port);
    let config_dir = data_path.join("apprise-config");
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create apprise-config directory: {}", e))?;

    // Stdout/stderr to a dedicated log so sidecar issues are diagnosable.
    let apprise_log_path = logs_path.join("apprise.log");
    let apprise_log = File::create(&apprise_log_path)
        .map_err(|e| format!("Failed to create apprise log: {}", e))?;
    let apprise_log_err = apprise_log
        .try_clone()
        .map_err(|e| format!("Failed to clone apprise log handle: {}", e))?;

    log_to_file(
        &logs_path,
        &format!("Starting Apprise sidecar: {:?}", apprise_path),
    );
    log_to_file(&logs_path, &format!("Apprise URL: {}", url));

    let mut cmd = std::process::Command::new(&apprise_path);
    cmd.stdout(Stdio::from(apprise_log))
        .stderr(Stdio::from(apprise_log_err))
        // Loopback only — never expose the notification sender to the LAN.
        .env("APPRISE_HOST", "127.0.0.1")
        .env("APPRISE_PORT", port.to_string())
        .env(
            "APPRISE_CONFIG_DIR",
            config_dir.to_string_lossy().to_string(),
        );

    // On Windows, hide the console window for the sidecar too.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| {
        let msg = format!("Failed to start Apprise sidecar: {}", e);
        log_to_file(&logs_path, &msg);
        msg
    })?;

    log_to_file(
        &logs_path,
        &format!("Apprise sidecar started with PID: {}", child.id()),
    );

    Ok(Some((child, url)))
}

/// Stop the Apprise sidecar process if running.
pub fn stop_apprise(state: &BackendState) {
    let mut process = state.apprise.lock().unwrap();
    if let Some(mut child) = process.take() {
        println!("Stopping Apprise sidecar...");
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.apprise_url.lock().unwrap() = None;
}

/// Start the MeshMonitor backend server
pub fn start_backend<R: Runtime>(app: &AppHandle<R>) -> Result<Child, String> {
    let config = Config::load()?;

    // Get paths
    let data_path = config::get_data_path()?;
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
    let node_path =
        resource_path
            .join("binaries")
            .join(if cfg!(windows) { "node.exe" } else { "node" });

    // Get the dist directory for current working directory (server.js imports ../services/, ../utils/, etc.)
    let server_dir = resource_path.join("dist");

    // Log all paths for debugging
    log_to_file(&logs_path, &format!("Node path: {:?}", node_path));
    log_to_file(&logs_path, &format!("Server path: {:?}", server_path));
    log_to_file(&logs_path, &format!("Server dir: {:?}", server_dir));
    log_to_file(&logs_path, &format!("Database: {:?}", db_path));
    log_to_file(&logs_path, &format!("Data dir: {:?}", data_path));
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
        .env("DATABASE_PATH", db_path.to_string_lossy().to_string())
        .env("DATA_DIR", data_path.to_string_lossy().to_string())
        .env("SESSION_SECRET", &config.session_secret)
        .env("ALLOWED_ORIGINS", {
            // Always include localhost
            let mut origins = format!("http://localhost:{}", config.web_port);
            // Add user-configured origins if provided
            if let Some(ref extra_origins) = config.allowed_origins {
                let trimmed = extra_origins.trim();
                if !trimmed.is_empty() {
                    origins.push(',');
                    origins.push_str(trimmed);
                }
            }
            origins
        })
        .env(
            "ENABLE_VIRTUAL_NODE",
            if config.enable_virtual_node {
                "true"
            } else {
                "false"
            },
        )
        .env(
            "VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS",
            if config.virtual_node_allow_admin {
                "true"
            } else {
                "false"
            },
        )
        .env("IS_DESKTOP", "true")
        .env("FIRMWARE_CHECK_ENABLED", "false");

    // Point the backend's notification service at the bundled Apprise sidecar
    // if one is running. Resolved from BackendState so it survives Node backend
    // restarts (the sidecar is started once and kept alive). When absent, the
    // backend falls back to the `appriseApiServerUrl` global setting / no Apprise.
    if let Some(apprise_url) = app
        .state::<BackendState>()
        .apprise_url
        .lock()
        .unwrap()
        .clone()
    {
        cmd.env("APPRISE_URL", &apprise_url);
        log_to_file(&logs_path, &format!("APPRISE_URL: {}", apprise_url));
    }

    // Only pass MESHTASTIC_NODE_IP / TCP_PORT if the user has actually
    // configured a Meshtastic node. Setting either env var triggers the
    // backend's auto-created Meshtastic TCP source, which would otherwise
    // pin every MeshCore-only desktop install into a forever ENETUNREACH
    // reconnect loop against a placeholder address. See discussion #2604.
    let meshtastic_ip_configured = !config.meshtastic_ip.trim().is_empty();
    if meshtastic_ip_configured {
        cmd.env("MESHTASTIC_NODE_IP", &config.meshtastic_ip)
            .env("MESHTASTIC_TCP_PORT", config.meshtastic_port.to_string());
    }

    log_to_file(&logs_path, "Environment variables set");
    log_to_file(&logs_path, &format!("PORT: {}", config.web_port));
    if meshtastic_ip_configured {
        log_to_file(
            &logs_path,
            &format!("MESHTASTIC_NODE_IP: {}", config.meshtastic_ip),
        );
    } else {
        log_to_file(
            &logs_path,
            "MESHTASTIC_NODE_IP: <unset> (no Meshtastic node configured)",
        );
    }
    log_to_file(
        &logs_path,
        &format!(
            "ALLOWED_ORIGINS: http://localhost:{}{}",
            config.web_port,
            config
                .allowed_origins
                .as_ref()
                .map(|o| format!(",{}", o))
                .unwrap_or_default()
        ),
    );
    log_to_file(
        &logs_path,
        &format!("ENABLE_VIRTUAL_NODE: {}", config.enable_virtual_node),
    );
    log_to_file(
        &logs_path,
        &format!(
            "VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS: {}",
            config.virtual_node_allow_admin
        ),
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
