//! Thin wrappers over the Win32 calls the app needs, with portable fallbacks.

use std::io;
use std::path::{Path, PathBuf};

#[cfg(windows)]
fn win_error(error: windows::core::Error) -> io::Error {
    let hr = error.code().0 as u32;
    // HRESULT_FROM_WIN32 wraps Win32 codes as 0x8007xxxx; unwrap them so io::ErrorKind is meaningful.
    if hr & 0xFFFF_0000 == 0x8007_0000 {
        io::Error::from_raw_os_error((hr & 0xFFFF) as i32)
    } else {
        io::Error::other(error)
    }
}

/// The `\\?\` form of `path`, so Win32 calls are not cut off at MAX_PATH (std does this itself).
#[cfg(windows)]
fn long_path(path: &Path) -> windows::core::HSTRING {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};
    let full = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let wide: Vec<u16> = full.as_os_str().encode_wide().collect();
    let verbatim = match full.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => [r"\\?\".encode_utf16().collect(), wide].concat(),
            Prefix::UNC(..) => [r"\\?\UNC".encode_utf16().collect(), wide[1..].to_vec()].concat(),
            _ => wide,
        },
        _ => wide,
    };
    windows::core::HSTRING::from_wide(&verbatim)
}

/// Adds FILE_ATTRIBUTE_HIDDEN to an existing file or folder.
#[cfg(windows)]
pub fn set_hidden(path: &Path) -> io::Result<()> {
    use windows::Win32::Storage::FileSystem::{
        GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_FLAGS_AND_ATTRIBUTES,
        INVALID_FILE_ATTRIBUTES,
    };
    let wide = long_path(path);
    unsafe {
        let current = GetFileAttributesW(&wide);
        if current == INVALID_FILE_ATTRIBUTES {
            return Err(io::Error::last_os_error());
        }
        SetFileAttributesW(
            &wide,
            FILE_FLAGS_AND_ATTRIBUTES(current) | FILE_ATTRIBUTE_HIDDEN,
        )
        .map_err(win_error)
    }
}

#[cfg(not(windows))]
pub fn set_hidden(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Bytes available to the current user on the volume holding `path` (or its nearest existing ancestor).
pub fn free_bytes(path: &Path) -> u64 {
    let Some(existing) = path.ancestors().find(|p| p.exists()) else {
        return 0;
    };
    free_bytes_at(existing).unwrap_or(0)
}

#[cfg(windows)]
fn free_bytes_at(path: &Path) -> io::Result<u64> {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut available = 0u64;
    unsafe { GetDiskFreeSpaceExW(&long_path(path), Some(&mut available), None, None) }
        .map_err(win_error)?;
    Ok(available)
}

#[cfg(not(windows))]
fn free_bytes_at(_path: &Path) -> io::Result<u64> {
    Ok(0)
}

/// Moves a file without ever replacing an existing destination (fails with AlreadyExists).
/// Falls back to copy + delete across volumes.
#[cfg(windows)]
pub fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_COPY_ALLOWED, MOVEFILE_WRITE_THROUGH,
    };
    unsafe {
        MoveFileExW(
            &long_path(from),
            &long_path(to),
            MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(win_error)
}

#[cfg(not(windows))]
pub fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::hard_link(from, to)?;
    std::fs::remove_file(from)
}

/// Fails with a sharing violation while another handle would stop `path` from being moved or
/// deleted, e.g. a video open in a player.
#[cfg(windows)]
pub fn ensure_deletable(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        DELETE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    std::fs::OpenOptions::new()
        .access_mode(DELETE.0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .open(path)
        .map(drop)
}

#[cfg(not(windows))]
pub fn ensure_deletable(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn explorer() -> PathBuf {
    std::env::var_os("WINDIR")
        .map(|dir| PathBuf::from(dir).join("explorer.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("explorer.exe"))
}

/// Explorer with `path` selected.
#[cfg(windows)]
pub fn reveal(path: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    // `/select,` needs the exact quoted form; Command's own quoting would break it.
    std::process::Command::new(explorer())
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(drop)
}

/// Opens a file with its default app, or a folder in Explorer.
#[cfg(windows)]
pub fn open(path: &Path) -> io::Result<()> {
    std::process::Command::new(explorer())
        .arg(path)
        .spawn()
        .map(drop)
}

#[cfg(not(windows))]
pub fn reveal(_path: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

#[cfg(not(windows))]
pub fn open(_path: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// Native error box for failures before any window exists.
#[cfg(windows)]
pub fn fatal_dialog(message: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(message),
            &HSTRING::from("Butterfly Record"),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
pub fn fatal_dialog(message: &str) {
    eprintln!("{message}");
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("br-platform-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn long_path_forms() {
        assert_eq!(
            long_path(Path::new(r"C:\a\b.webm")).to_string(),
            r"\\?\C:\a\b.webm"
        );
        assert_eq!(
            long_path(Path::new(r"\\server\share\b.webm")).to_string(),
            r"\\?\UNC\server\share\b.webm"
        );
        assert_eq!(
            long_path(Path::new(r"\\?\C:\a\b.webm")).to_string(),
            r"\\?\C:\a\b.webm"
        );
    }

    #[test]
    fn moves_and_hides_beyond_max_path() {
        let base = scratch("long");
        let mut dir = base.clone();
        while dir.as_os_str().len() < 280 {
            dir.push("a-rather-long-folder-name-for-testing");
        }
        fs::create_dir_all(&dir).unwrap();
        let from = dir.join("tmp-1-1.partial");
        fs::write(&from, b"webm").unwrap();
        let to = dir.join("A recording with a long title.webm");
        move_no_replace(&from, &to).unwrap();
        assert_eq!(fs::read(&to).unwrap(), b"webm");
        fs::write(&from, b"again").unwrap();
        let taken = move_no_replace(&from, &to).unwrap_err();
        assert_eq!(taken.kind(), io::ErrorKind::AlreadyExists);
        set_hidden(&dir).unwrap();
        assert!(free_bytes(&dir) > 0);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn detects_files_open_elsewhere() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = scratch("locked");
        let file = dir.join("clip.webm");
        fs::write(&file, b"webm").unwrap();
        ensure_deletable(&file).unwrap();
        // Like a player that lets others read but not delete.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&file)
            .unwrap();
        let error = ensure_deletable(&file).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(32));
        drop(held);
        ensure_deletable(&file).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
