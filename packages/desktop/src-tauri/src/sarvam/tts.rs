//! Bulbul v3 text-to-speech, returned as WAV bytes.

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use super::client::{unexpected, Api};
use super::lang;
use crate::error::{Code, IpcError, IpcResult};

const MAX_CHARS: usize = 2500;
const SAMPLE_RATES: &[u32] = &[8000, 16000, 22050, 24000, 32000, 44100, 48000];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsRequest {
    pub text: String,
    pub language: String,
    pub speaker: String,
    pub pace: f64,
    pub sample_rate: u32,
}

impl TtsRequest {
    pub fn validate(&self) -> IpcResult<()> {
        let chars = self.text.trim().chars().count();
        if chars == 0 {
            return Err(IpcError::invalid("There is no text to speak."));
        }
        if chars > MAX_CHARS {
            return Err(IpcError::new(
                Code::TooLarge,
                "Text-to-speech takes at most 2500 characters at a time.",
            ));
        }
        if !lang::is_core(&self.language) {
            return Err(IpcError::new(
                Code::Unsupported,
                "Text-to-speech does not support this language.",
            ));
        }
        let speaker_ok = (1..=32).contains(&self.speaker.len())
            && self
                .speaker
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        if !speaker_ok {
            return Err(IpcError::invalid("Unknown voice."));
        }
        if !(0.5..=2.0).contains(&self.pace) {
            return Err(IpcError::invalid("Pace must be between 0.5 and 2."));
        }
        if !SAMPLE_RATES.contains(&self.sample_rate) {
            return Err(IpcError::invalid("Unsupported sample rate."));
        }
        Ok(())
    }
}

/// Decodes `audios`; several entries are joined before decoding, as the docs do.
pub fn decode_audios(reply: &Value) -> IpcResult<Vec<u8>> {
    let audios: Vec<&str> = reply
        .get("audios")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if audios.is_empty() {
        return Err(unexpected());
    }
    base64::engine::general_purpose::STANDARD
        .decode(audios.concat())
        .map_err(|_| unexpected())
}

pub async fn synthesize(api: &Api, request: &TtsRequest) -> IpcResult<Vec<u8>> {
    let reply: Value = api
        .post_json(
            "/text-to-speech",
            &json!({
              "text": request.text.trim(),
              "language_code": request.language,
              "speaker": request.speaker,
              "model": "bulbul:v3",
              "pace": request.pace,
              "speech_sample_rate": request.sample_rate,
              "output_audio_codec": "wav",
            }),
        )
        .await?;
    decode_audios(&reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> TtsRequest {
        TtsRequest {
            text: "नमस्ते".into(),
            language: "hi-IN".into(),
            speaker: "shubh".into(),
            pace: 1.0,
            sample_rate: 24000,
        }
    }

    #[test]
    fn validates() {
        assert!(request().validate().is_ok());
        let mut long = request();
        long.text = "a".repeat(2501);
        assert_eq!(long.validate().unwrap_err().code, Code::TooLarge);
        let mut assamese = request();
        assamese.language = "as-IN".into();
        assert_eq!(assamese.validate().unwrap_err().code, Code::Unsupported);
        let mut voice = request();
        voice.speaker = "Shubh".into();
        assert!(voice.validate().is_err());
        let mut rate = request();
        rate.sample_rate = 11025;
        assert!(rate.validate().is_err());
    }

    #[test]
    fn decodes_audio() {
        let reply = serde_json::json!({ "request_id": "r", "audios": ["UklGRg=="] });
        assert_eq!(decode_audios(&reply).unwrap(), b"RIFF");
        assert!(decode_audios(&serde_json::json!({ "audios": [] })).is_err());
        assert!(decode_audios(&serde_json::json!({ "audios": ["***"] })).is_err());
    }
}
