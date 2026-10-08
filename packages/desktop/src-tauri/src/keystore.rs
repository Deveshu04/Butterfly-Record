//! The Sarvam API key in Windows Credential Manager. The key is written from JS once and never read back by it.

use serde::Serialize;

use crate::error::{blocking, Code, IpcError, IpcResult};

const TARGET: &str = "Butterfly Record/sarvam";
const SERVICE: &str = "Butterfly Record";
const USER: &str = "sarvam";

fn entry() -> IpcResult<keyring::Entry> {
    keyring::Entry::new_with_target(TARGET, SERVICE, USER).map_err(store_error)
}

fn store_error(error: keyring::Error) -> IpcError {
    IpcError::new(
        Code::Io,
        format!("Windows Credential Manager failed: {error}"),
    )
}

/// The stored key, if any. Blocking.
pub fn load() -> IpcResult<Option<String>> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(store_error(error)),
    }
}

/// The stored key or a `no_key` error.
pub async fn require() -> IpcResult<String> {
    blocking(load)
        .await?
        .ok_or_else(|| IpcError::new(Code::NoKey, "Add your Sarvam API key in Settings."))
}

fn validate(key: &str) -> IpcResult<&str> {
    let key = key.trim();
    if key.is_empty() || key.len() > 512 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(IpcError::invalid(
            "That does not look like a Sarvam API key.",
        ));
    }
    Ok(key)
}

#[derive(Serialize)]
pub struct KeyStatus {
    present: bool,
}

#[tauri::command]
pub async fn sarvam_key_status() -> IpcResult<KeyStatus> {
    let present = blocking(load).await?.is_some();
    Ok(KeyStatus { present })
}

#[tauri::command]
pub async fn sarvam_key_set(key: String) -> IpcResult<()> {
    let key = validate(&key)?.to_owned();
    blocking(move || entry()?.set_password(&key).map_err(store_error)).await
}

#[tauri::command]
pub async fn sarvam_key_clear() -> IpcResult<()> {
    blocking(|| match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(store_error(error)),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_keys() {
        assert_eq!(validate("  sk_abc123  ").unwrap(), "sk_abc123");
        assert!(validate("").is_err());
        assert!(validate("has space").is_err());
        assert!(validate(&"k".repeat(600)).is_err());
    }
}
