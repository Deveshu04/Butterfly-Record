//! Opaque settings JSON in `%APPDATA%\<identifier>\settings.json`; Rust reads only the fields it acts on.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use crate::app::{self, ThemePref};
use crate::error::{blocking, IpcError, IpcResult};
use crate::fsio::write_atomic;

/// Relocates settings.json, library.json and imports.json so automated runs never touch a real
/// install's config.
pub const CONFIG_DIR_ENV: &str = "BUTTERFLY_RECORD_CONFIG_DIR";

pub fn config_dir_override() -> Option<PathBuf> {
    std::env::var_os(CONFIG_DIR_ENV)
        .filter(|value| !value.is_empty())
        .and_then(|value| std::path::absolute(PathBuf::from(value)).ok())
}

#[derive(Clone)]
pub struct Settings(Arc<SettingsInner>);

struct SettingsInner {
    path: PathBuf,
    write: tokio::sync::Mutex<()>,
}

impl Settings {
    pub fn new(path: PathBuf) -> Self {
        Self(Arc::new(SettingsInner {
            path,
            write: tokio::sync::Mutex::new(()),
        }))
    }

    /// The stored object, or `{}` when absent or unreadable.
    pub fn read(&self) -> Value {
        match fs::read(&self.0.path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) if value.is_object() => value,
                _ => {
                    log::warn!("settings.json is not a JSON object; using defaults");
                    Value::Object(Map::new())
                }
            },
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    log::warn!("could not read settings.json: {error}");
                }
                Value::Object(Map::new())
            }
        }
    }
}

pub fn close_to_tray(settings: &Value) -> bool {
    settings
        .get("closeToTray")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub fn theme(settings: &Value) -> ThemePref {
    match settings.get("theme").and_then(Value::as_str) {
        Some("light") => ThemePref::Light,
        Some("dark") => ThemePref::Dark,
        _ => ThemePref::System,
    }
}

#[tauri::command]
pub async fn settings_get(settings: State<'_, Settings>) -> IpcResult<Value> {
    let settings = settings.inner().clone();
    blocking(move || Ok(settings.read())).await
}

#[tauri::command]
pub async fn settings_set(
    app: AppHandle,
    settings: State<'_, Settings>,
    value: Value,
) -> IpcResult<()> {
    if !value.is_object() {
        return Err(IpcError::invalid("Settings must be an object."));
    }
    let settings = settings.inner().clone();
    let bytes = serde_json::to_vec_pretty(&value)?;
    let _serial = settings.0.write.lock().await;
    let path = settings.0.path.clone();
    blocking(move || {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        Ok(write_atomic(&path, &bytes)?)
    })
    .await?;
    app::apply_settings(&app, close_to_tray(&value), theme(&value));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_known_fields_with_defaults() {
        assert!(close_to_tray(&json!({})));
        assert!(!close_to_tray(&json!({ "closeToTray": false })));
        assert_eq!(theme(&json!({ "theme": "dark" })), ThemePref::Dark);
        assert_eq!(theme(&json!({ "theme": "neon" })), ThemePref::System);
    }
}
