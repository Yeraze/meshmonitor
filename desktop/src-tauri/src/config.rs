use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Meshtastic node IP address
    pub meshtastic_ip: String,
    /// Meshtastic TCP port (default: 4403)
    pub meshtastic_port: u16,
    /// Web UI port (default: 8080)
    pub web_port: u16,
    /// Auto-start with Windows
    pub auto_start: bool,
    /// Session secret for authentication
    pub session_secret: String,
    /// First run completed
    pub setup_completed: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            meshtastic_ip: String::from("192.168.1.100"),
            meshtastic_port: 4403,
            web_port: 8080,
            auto_start: false,
            session_secret: generate_secret(),
            setup_completed: false,
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
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))
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

        fs::write(&config_path, content)
            .map_err(|e| format!("Failed to write config: {}", e))
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
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Could not find config directory".to_string())?;
    Ok(config_dir.join("MeshMonitor").join("config.json"))
}

/// Get the data directory path
pub fn get_data_path() -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| "Could not find data directory".to_string())?;
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
    fs::create_dir_all(&logs_dir)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;
    Ok(logs_dir)
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
