use std::path::{Component, Path, PathBuf, Prefix};

use crate::error::{IpcError, IpcResult};

/// Hidden app-data folder inside the library root.
pub const APP_DIR: &str = ".butterfly";
pub const LIBRARY_FOLDER: &str = "Butterfly Record";
pub const MANIFEST: &str = "manifest.json";
pub const SOURCE_PART: &str = "source.part";
pub const JOBS: &str = "jobs.json";

pub const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "m4v", "webm", "mkv", "mp3", "wav", "m4a", "ogg", "opus", "flac", "aac",
];
const CAPTION_EXTENSIONS: &[&str] = &["srt", "vtt", "txt"];

const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

const BASE_NAME_MAX: usize = 120;
const BASE_NAME_FALLBACK: &str = "Recording";

/// `^[0-9A-HJKMNP-TV-Z]{26}$`
pub fn is_ulid(id: &str) -> bool {
    id.len() == 26
    && id.bytes().all(|b| {
      matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
    })
}

pub fn check_id(id: &str) -> IpcResult<()> {
    if is_ulid(id) {
        Ok(())
    } else {
        Err(IpcError::invalid("Invalid library id."))
    }
}

fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    RESERVED_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, no `..`, no trailing dot (Windows strips it), no device names.
pub fn is_valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !name.contains("..")
        && !name.ends_with('.')
        && !is_reserved(name)
}

pub fn check_name(name: &str) -> IpcResult<()> {
    if is_valid_name(name) {
        Ok(())
    } else {
        Err(IpcError::invalid("Invalid file name."))
    }
}

/// A lowercase alphanumeric extension without the dot.
pub fn check_ext(ext: &str) -> IpcResult<String> {
    let ext = ext.strip_prefix('.').unwrap_or(ext);
    if (1..=10).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(ext.to_ascii_lowercase())
    } else {
        Err(IpcError::invalid("Invalid file extension."))
    }
}

/// `check_ext`, limited to the media and caption types the app writes; never executables or scripts.
pub fn check_export_ext(ext: &str) -> IpcResult<String> {
    let ext = check_ext(ext)?;
    if MEDIA_EXTENSIONS.contains(&ext.as_str()) || CAPTION_EXTENSIONS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(IpcError::invalid("Unsupported file type."))
    }
}

/// Same rules as core's `safeFilename`: one path segment Windows accepts.
pub fn safe_base_name(title: &str) -> String {
    let replaced: String = title
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other => other,
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = collapsed.chars().take(BASE_NAME_MAX).collect();
    let mut name = truncated.trim_end_matches(['.', ' ']).to_string();
    if !name.chars().any(char::is_alphanumeric) {
        name = BASE_NAME_FALLBACK.to_string();
    }
    if RESERVED_NAMES
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved))
    {
        name.push_str("-recording");
    }
    name
}

pub fn file_name_with(base: &str, n: u32, ext: &str) -> String {
    if n <= 1 {
        format!("{base}.{ext}")
    } else {
        format!("{base} ({n}).{ext}")
    }
}

/// "name.ext", then "name (2).ext", ... (starting at `start`) until `exists` says the name is free.
pub fn unique_name(
    base: &str,
    ext: &str,
    start: u32,
    exists: impl Fn(&str) -> bool,
) -> (String, u32) {
    let mut n = start.max(1);
    loop {
        let name = file_name_with(base, n, ext);
        if !exists(&name) {
            return (name, n);
        }
        n += 1;
    }
}

pub fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
}

pub fn is_media_path(path: &Path) -> bool {
    extension_of(path).is_some_and(|ext| MEDIA_EXTENSIONS.contains(&ext.as_str()))
}

/// Files `open_path` may hand to their default app; never executables.
pub fn is_openable_file(path: &Path) -> bool {
    extension_of(path).is_some_and(|ext| {
        MEDIA_EXTENSIONS.contains(&ext.as_str()) || CAPTION_EXTENSIONS.contains(&ext.as_str())
    })
}

/// Parses an absolute path that came from the webview. Rejects relative paths, `..`,
/// device namespaces and alternate data streams.
pub fn parse_user_path(raw: &str) -> IpcResult<PathBuf> {
    let invalid = || IpcError::invalid("Invalid path.");
    if raw.is_empty() || raw.len() > 4096 || raw.chars().any(char::is_control) {
        return Err(invalid());
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(invalid());
    }
    let mut after_prefix = raw;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                match prefix.kind() {
                    Prefix::Disk(_) | Prefix::UNC(_, _) => {}
                    _ => return Err(invalid()),
                }
                after_prefix = &raw[prefix.as_os_str().len()..];
            }
            Component::ParentDir => return Err(invalid()),
            _ => {}
        }
    }
    if after_prefix.contains(':') {
        return Err(invalid());
    }
    std::path::absolute(path).map_err(|_| invalid())
}

/// Case-insensitive key used to compare Windows paths.
pub fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// True when `path` is `dir` or below it, comparing case-insensitively by component.
pub fn is_within(path: &Path, dir: &Path) -> bool {
    let path = PathBuf::from(path_key(path));
    let dir = PathBuf::from(path_key(dir));
    path.starts_with(dir)
}

/// The path of `path` relative to `root`, when it is inside it.
pub fn relative_to(path: &Path, root: &Path) -> Option<String> {
    if !is_within(path, root) {
        return None;
    }
    let skip = root.components().count();
    let rest: PathBuf = path.components().skip(skip).collect();
    let rest = rest.to_string_lossy().into_owned();
    (!rest.is_empty()).then_some(rest)
}

/// A manifest's relative media path: plain components only.
pub fn parse_relative(raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw);
    if raw.is_empty() || raw.contains(':') {
        return None;
    }
    path.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then(|| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulid_validation() {
        assert!(is_ulid("01J9Z8Q4X5M2N3P4R5S6T7V8W9"));
        assert!(!is_ulid("01J9Z8Q4X5M2N3P4R5S6T7V8W"));
        assert!(!is_ulid("01J9Z8Q4X5M2N3P4R5S6T7V8WI"));
        assert!(!is_ulid("01J9Z8Q4X5M2N3P4R5S6T7V8WL"));
        assert!(!is_ulid("01J9Z8Q4X5M2N3P4R5S6T7V8WO"));
        assert!(!is_ulid("01J9Z8Q4X5M2N3P4R5S6T7V8WU"));
        assert!(!is_ulid("01j9z8q4x5m2n3p4r5s6t7v8w9"));
        assert!(!is_ulid("..\\..\\Windows\\System32\\aa"));
    }

    #[test]
    fn name_validation() {
        for good in [
            "manifest.json",
            "transcript.hi-IN.json",
            "poster.jpg",
            "dub.od-IN.wav",
            "tmp-3.partial",
            "a",
            "A_b-c.d",
        ] {
            assert!(is_valid_name(good), "{good}");
        }
        for bad in [
            "",
            ".hidden",
            "-dash",
            "a..b",
            "a/b",
            "a\\b",
            "a:b",
            "name.",
            "con",
            "NUL.txt",
            "com1.json",
            "a b",
            "é.json",
            &"x".repeat(101),
        ] {
            assert!(!is_valid_name(bad), "{bad}");
        }
        assert!(is_valid_name(&"x".repeat(100)));
        assert!(is_valid_name("console.json"));
    }

    #[test]
    fn extension_validation() {
        assert_eq!(check_ext(".WebM").unwrap(), "webm");
        assert_eq!(check_ext("mp4").unwrap(), "mp4");
        assert!(check_ext("").is_err());
        assert!(check_ext("we/bm").is_err());
        assert!(check_ext("a.b").is_err());
        assert_eq!(check_export_ext("SRT").unwrap(), "srt");
        assert_eq!(check_export_ext(".mp4").unwrap(), "mp4");
        for bad in ["exe", "bat", "cmd", "ps1", "lnk", "js", "html", "json"] {
            assert!(check_export_ext(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn base_names_follow_core() {
        assert_eq!(safe_base_name("Meeting: Q3 / plan"), "Meeting- Q3 - plan");
        assert_eq!(safe_base_name("  spaced \t out  "), "spaced out");
        assert_eq!(safe_base_name("ends with dots..."), "ends with dots");
        assert_eq!(safe_base_name("???"), "Recording");
        assert_eq!(safe_base_name("CON"), "CON-recording");
        assert_eq!(safe_base_name("नमस्ते दुनिया"), "नमस्ते दुनिया");
        assert_eq!(safe_base_name(&"a".repeat(200)).chars().count(), 120);
    }

    #[test]
    fn unique_naming() {
        let taken = ["Demo.webm", "Demo (2).webm"];
        let (name, n) = unique_name("Demo", "webm", 1, |candidate| taken.contains(&candidate));
        assert_eq!((name.as_str(), n), ("Demo (3).webm", 3));
        let (name, n) = unique_name("Fresh", "mp4", 1, |_| false);
        assert_eq!((name.as_str(), n), ("Fresh.mp4", 1));
        let (name, n) = unique_name("Fresh", "mp4", 4, |_| false);
        assert_eq!((name.as_str(), n), ("Fresh (4).mp4", 4));
    }

    #[test]
    fn user_paths() {
        assert!(parse_user_path(r"C:\Users\me\Videos\clip.mp4").is_ok());
        assert!(parse_user_path(r"\\server\share\clip.mp4").is_ok());
        assert!(parse_user_path(r"relative\clip.mp4").is_err());
        assert!(parse_user_path(r"C:\Users\me\..\other\clip.mp4").is_err());
        assert!(parse_user_path(r"C:\Users\me\clip.mp4:stream").is_err());
        assert!(parse_user_path(r"\\?\C:\Users\me\clip.mp4").is_err());
        assert!(parse_user_path(r"\\.\PhysicalDrive0").is_err());
        assert!(parse_user_path("").is_err());
    }

    #[test]
    fn containment_is_case_insensitive() {
        let root = Path::new(r"C:\Users\Me\Videos\Butterfly Record");
        assert!(is_within(
            Path::new(r"c:\users\me\videos\butterfly record\a.webm"),
            root
        ));
        assert!(is_within(root, root));
        assert!(!is_within(
            Path::new(r"C:\Users\Me\Videos\Butterfly Recordings\a.webm"),
            root
        ));
        assert_eq!(
            relative_to(
                Path::new(r"C:\Users\Me\Videos\Butterfly Record\.butterfly\X\a.json"),
                root
            )
            .as_deref(),
            Some(r".butterfly\X\a.json")
        );
        assert_eq!(relative_to(Path::new(r"D:\a.webm"), root), None);
    }

    #[test]
    fn relative_media_paths() {
        assert_eq!(
            parse_relative("Demo.webm"),
            Some(PathBuf::from("Demo.webm"))
        );
        assert_eq!(parse_relative(r"..\Demo.webm"), None);
        assert_eq!(parse_relative(r"C:\Demo.webm"), None);
        assert_eq!(parse_relative(""), None);
    }

    #[test]
    fn openable_files() {
        assert!(is_openable_file(Path::new(r"C:\x\a.MP4")));
        assert!(is_openable_file(Path::new(r"C:\x\a.srt")));
        assert!(!is_openable_file(Path::new(r"C:\x\a.exe")));
        assert!(!is_openable_file(Path::new(r"C:\x\a")));
    }
}
