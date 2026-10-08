//! Canonical app language codes and the per-API subsets. Odia is `od-IN` everywhere except dubbing (`or-IN`).

const LANGUAGES: &[(&str, &str)] = &[
    ("en-IN", "English"),
    ("hi-IN", "Hindi"),
    ("bn-IN", "Bengali"),
    ("gu-IN", "Gujarati"),
    ("kn-IN", "Kannada"),
    ("ml-IN", "Malayalam"),
    ("mr-IN", "Marathi"),
    ("od-IN", "Odia"),
    ("pa-IN", "Punjabi"),
    ("ta-IN", "Tamil"),
    ("te-IN", "Telugu"),
    ("as-IN", "Assamese"),
    ("ur-IN", "Urdu"),
    ("ne-IN", "Nepali"),
    ("kok-IN", "Konkani"),
    ("ks-IN", "Kashmiri"),
    ("sd-IN", "Sindhi"),
    ("sa-IN", "Sanskrit"),
    ("sat-IN", "Santali"),
    ("mni-IN", "Manipuri"),
    ("brx-IN", "Bodo"),
    ("mai-IN", "Maithili"),
    ("doi-IN", "Dogri"),
];

/// Mayura, Bulbul v3 and text-lid cover these eleven.
const CORE: &[&str] = &[
    "en-IN", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN",
    "te-IN",
];

const DUBBING_EXTRA: &str = "as-IN";

pub fn name(code: &str) -> Option<&'static str> {
    LANGUAGES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, name)| *name)
}

/// Saaras and sarvam-translate: all 23.
pub fn is_known(code: &str) -> bool {
    name(code).is_some()
}

pub fn is_core(code: &str) -> bool {
    CORE.contains(&code)
}

pub fn is_dubbing(code: &str) -> bool {
    is_core(code) || code == DUBBING_EXTRA
}

/// App code to the Dubbing API's code.
pub fn to_dubbing(code: &str) -> Option<&str> {
    match code {
        "od-IN" => Some("or-IN"),
        code if is_dubbing(code) => Some(code),
        _ => None,
    }
}

/// Dubbing API code back to the app's canonical code.
pub fn from_dubbing(code: &str) -> String {
    match code {
        "or-IN" => "od-IN".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn odia_maps_for_dubbing() {
        assert_eq!(to_dubbing("od-IN"), Some("or-IN"));
        assert_eq!(to_dubbing("hi-IN"), Some("hi-IN"));
        assert_eq!(to_dubbing("as-IN"), Some("as-IN"));
        assert_eq!(to_dubbing("ur-IN"), None);
        assert_eq!(to_dubbing("or-IN"), None);
        assert_eq!(from_dubbing("or-IN"), "od-IN");
        assert_eq!(from_dubbing("ta-IN"), "ta-IN");
    }

    #[test]
    fn subsets() {
        assert_eq!(LANGUAGES.len(), 23);
        assert!(is_known("sat-IN"));
        assert!(!is_core("sat-IN"));
        assert!(is_core("od-IN"));
        assert!(!is_known("unknown"));
    }
}
