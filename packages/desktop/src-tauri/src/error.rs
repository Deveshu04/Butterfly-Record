use serde::Serialize;

pub type IpcResult<T> = Result<T, IpcError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    NotFound,
    InvalidArgument,
    Io,
    DiskFull,
    Forbidden,
    Busy,
    NoKey,
    InvalidKey,
    Quota,
    RateLimited,
    TooLarge,
    Unsupported,
    Network,
    Cancelled,
    Api,
}

/// The `Err` value of every command. Serialized as an object so the frontend can branch on `code`.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct IpcError {
    pub code: Code,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl IpcError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            status: None,
            request_id: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(Code::InvalidArgument, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(Code::NotFound, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(Code::Forbidden, message)
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(Code::Busy, message)
    }

    pub fn cancelled() -> Self {
        Self::new(Code::Cancelled, "Cancelled.")
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn with_request_id(mut self, request_id: Option<String>) -> Self {
        self.request_id = request_id;
        self
    }
}

// ERROR_HANDLE_DISK_FULL and ERROR_DISK_FULL; older code paths report these without a mapped kind.
const WIN_DISK_FULL: [i32; 2] = [39, 112];
// ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION.
const WIN_IN_USE: [i32; 2] = [32, 33];
const WIN_FILENAME_EXCED_RANGE: i32 = 206;

impl From<std::io::Error> for IpcError {
    fn from(error: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let raw = error.raw_os_error();
        let disk_full = error.kind() == ErrorKind::StorageFull
            || raw.is_some_and(|code| WIN_DISK_FULL.contains(&code));
        if disk_full {
            return Self::new(Code::DiskFull, "The disk is full.");
        }
        if raw.is_some_and(|code| WIN_IN_USE.contains(&code)) {
            return Self::busy("The file is open in another app. Close it and try again.");
        }
        if raw == Some(WIN_FILENAME_EXCED_RANGE) {
            return Self::invalid(
                "The path is too long for Windows. Choose a shorter folder or title.",
            );
        }
        let code = match error.kind() {
            ErrorKind::NotFound => Code::NotFound,
            ErrorKind::PermissionDenied => Code::Forbidden,
            _ => Code::Io,
        };
        Self::new(code, error.to_string())
    }
}

impl From<tauri::Error> for IpcError {
    fn from(error: tauri::Error) -> Self {
        Self::new(Code::Io, error.to_string())
    }
}

impl From<serde_json::Error> for IpcError {
    fn from(error: serde_json::Error) -> Self {
        Self::invalid(error.to_string())
    }
}

/// Runs blocking file-system work off the async runtime's worker threads.
pub async fn blocking<T, F>(work: F) -> IpcResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> IpcResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| IpcError::new(Code::Io, error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_object() {
        let error = IpcError::new(Code::InvalidKey, "Bad key")
            .with_status(403)
            .with_request_id(Some("r1".into()));
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "invalid_key", "message": "Bad key", "status": 403, "requestId": "r1" })
        );
        let bare = serde_json::to_value(IpcError::invalid("x")).unwrap();
        assert_eq!(
            bare,
            serde_json::json!({ "code": "invalid_argument", "message": "x" })
        );
    }

    #[test]
    fn maps_io_errors() {
        let full = IpcError::from(std::io::Error::from_raw_os_error(112));
        assert_eq!(full.code, Code::DiskFull);
        let missing = IpcError::from(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(missing.code, Code::NotFound);
        let denied = IpcError::from(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(denied.code, Code::Forbidden);
        let in_use = IpcError::from(std::io::Error::from_raw_os_error(32));
        assert_eq!(in_use.code, Code::Busy);
        let too_long = IpcError::from(std::io::Error::from_raw_os_error(206));
        assert_eq!(too_long.code, Code::InvalidArgument);
    }
}
