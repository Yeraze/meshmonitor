use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Legacy: Meshtastic node IP address. No longer surfaced in the setup UI
    /// (sources are configured in the web UI instead). Retained so existing
    /// installs that previously set a value continue to auto-derive a
    /// Meshtastic TCP source on startup. New installs default to empty.
    #[serde(default)]
    pub meshtastic_ip: String,
    /// Legacy: Meshtastic TCP port (default: 4403). See `meshtastic_ip` note.
    #[serde(default = "default_meshtastic_port")]
    pub meshtastic_port: u16,
    /// Web UI port (default: 8080)
    pub web_port: u16,
    /// Autostart on user login. Persisted from the settings UI but not yet
    /// wired to a platform implementation (no autostart plugin is registered).
    pub auto_start: bool,
    /// Session secret for authentication
    pub session_secret: String,
    /// First run completed
    pub setup_completed: bool,
    /// Enable virtual node server for mobile app connections
    #[serde(default)]
    pub enable_virtual_node: bool,
    /// Allow admin commands via virtual node
    #[serde(default)]
    pub virtual_node_allow_admin: bool,
    /// Additional allowed origins for CORS (comma-separated)
    /// Localhost is always included automatically
    #[serde(default)]
    pub allowed_origins: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            // Empty by default — we don't ship a placeholder IP because the
            // backend uses the presence of MESHTASTIC_NODE_IP to decide whether
            // to enable the env-derived Meshtastic TCP source. Shipping a
            // placeholder (e.g. "192.168.1.100") would force every fresh
            // install — including MeshCore-only desktop users — into a
            // forever ENETUNREACH reconnect loop against an address they
            // never configured. See discussion #2604.
            meshtastic_ip: String::new(),
            meshtastic_port: 4403,
            web_port: 8080,
            auto_start: false,
            session_secret: generate_secret(),
            setup_completed: false,
            enable_virtual_node: false,
            virtual_node_allow_admin: false,
            allowed_origins: None,
        }
    }
}

impl Config {
    /// Load configuration from file, creating default if not exists
    pub fn load() -> Result<Self, String> {
        let config_path = get_config_path()?;

        if config_path.exists() {
            let content = fs::read_to_string(&config_path)
                .map_err(|e| format!("Failed to read config: {}", e))?;

            // Handle empty or whitespace-only config files
            let trimmed = content.trim();
            if trimmed.is_empty() {
                eprintln!("Config file is empty, creating default configuration");
                let config = Config::default();
                config.save()?;
                return Ok(config);
            }

            // Try to parse, fall back to default if corrupted
            match serde_json::from_str(&content) {
                Ok(config) => Ok(config),
                Err(e) => {
                    eprintln!(
                        "Config file is corrupted ({}), creating default configuration",
                        e
                    );
                    let config = Config::default();
                    config.save()?;
                    Ok(config)
                }
            }
        } else {
            let config = Config::default();
            config.save()?;
            Ok(config)
        }
    }

    /// Save configuration to file
    pub fn save(&self) -> Result<(), String> {
        let config_path = get_config_path()?;

        // Ensure parent directory exists
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }

        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        fs::write(&config_path, content).map_err(|e| format!("Failed to write config: {}", e))
    }

    /// Check if first-run setup is needed
    pub fn needs_setup(&self) -> bool {
        !self.setup_completed
    }

    /// Mark setup as completed
    pub fn complete_setup(&mut self) -> Result<(), String> {
        self.setup_completed = true;
        self.save()
    }
}

/// Get the configuration file path
pub fn get_config_path() -> Result<PathBuf, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Could not find config directory".to_string())?;
    Ok(config_dir.join("MeshMonitor").join("config.json"))
}

/// Get the data directory path
pub fn get_data_path() -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir().ok_or_else(|| "Could not find data directory".to_string())?;
    let meshmonitor_data = data_dir.join("MeshMonitor");

    // Ensure directory exists
    fs::create_dir_all(&meshmonitor_data)
        .map_err(|e| format!("Failed to create data directory: {}", e))?;

    Ok(meshmonitor_data)
}

/// Get the database path
pub fn get_database_path() -> Result<PathBuf, String> {
    Ok(get_data_path()?.join("meshmonitor.db"))
}

/// Get the logs directory path
pub fn get_logs_path() -> Result<PathBuf, String> {
    let logs_dir = get_data_path()?.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|e| format!("Failed to create logs directory: {}", e))?;
    Ok(logs_dir)
}

/// Default Meshtastic TCP port for legacy `meshtastic_port` field.
fn default_meshtastic_port() -> u16 {
    4403
}

/// Generate a random session secret
fn generate_secret() -> String {
    uuid::Uuid::new_v4().to_string().replace("-", "")
        + &uuid::Uuid::new_v4().to_string().replace("-", "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = Config::default();
        assert_eq!(config.meshtastic_port, 4403);
        assert_eq!(config.web_port, 8080);
        assert!(!config.setup_completed);
    }

    #[test]
    fn test_generate_secret() {
        let secret = generate_secret();
        assert_eq!(secret.len(), 64); // Two UUIDs without dashes
    }
}
