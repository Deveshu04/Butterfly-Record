//! Title and summary from a transcript through the chat completions API.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::client::{unexpected, Api};
use super::lang;
use crate::error::{Code, IpcError, IpcResult};

const MODEL: &str = "sarvam-105b";
/// Keeps the prompt well inside the model's context for any script.
const MAX_INPUT_CHARS: usize = 60_000;
const TITLE_MAX_CHARS: usize = 100;
const TIMEOUT: Duration = Duration::from_secs(300);

const INSTRUCTIONS: &str =
    "You write a title and a short summary for a screen recording from its transcript. \
Reply with JSON only, shaped as {\"title\": string, \"summary\": string}. \
The title has at most 80 characters, no quotes and no trailing period. \
The summary is two to four plain sentences describing what the video covers, without markdown.";

#[derive(Debug, Serialize, PartialEq)]
pub struct Summary {
    pub title: String,
    pub summary: String,
}

/// The whole text, or its beginning and end when it is too long.
pub fn fit(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_owned();
    }
    let head = max_chars * 3 / 4;
    let tail = max_chars - head;
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(total - tail).collect();
    format!("{start}\n[...]\n{end}")
}

fn clean_title(title: &str) -> String {
    let title = title
        .trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '“' | '”'))
        .trim();
    let title: String = title.chars().take(TITLE_MAX_CHARS).collect();
    title.trim_end_matches('.').trim().to_owned()
}

/// Reads the model's JSON reply, tolerating code fences or text around the object.
pub fn parse_summary(content: &str) -> Option<Summary> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    let value: Value = serde_json::from_str(content.get(start..=end)?).ok()?;
    let field = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| value.get(*name).and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let title = clean_title(&field(&["title"])?);
    let summary = field(&["summary", "description"])?;
    (!title.is_empty()).then_some(Summary { title, summary })
}

pub async fn summarize(api: &Api, text: &str, language: Option<&str>) -> IpcResult<Summary> {
    let text = text.trim();
    if text.is_empty() {
        return Err(IpcError::invalid("There is no transcript to summarize."));
    }
    let language_line = match language.and_then(lang::name) {
        Some(name) => format!("Write the title and summary in {name}."),
        None => "Write the title and summary in the transcript's language.".to_string(),
    };
    let body = json!({
      "model": MODEL,
      "messages": [
        { "role": "system", "content": format!("{INSTRUCTIONS} {language_line}") },
        { "role": "user", "content": format!("Transcript:\n{}", fit(text, MAX_INPUT_CHARS)) },
      ],
      "temperature": 0.2,
      "max_tokens": 1024,
      "reasoning_effort": null,
      "response_format": {
        "type": "json_schema",
        "json_schema": {
          "name": "video_summary",
          "strict": true,
          "schema": {
            "type": "object",
            "properties": {
              "title": { "type": "string" },
              "summary": { "type": "string" }
            },
            "required": ["title", "summary"],
            "additionalProperties": false
          }
        }
      }
    });
    let reply: Value = api
        .post_json_with("/v1/chat/completions", &body, TIMEOUT)
        .await?;
    let choice = reply
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(unexpected)?;
    let content = choice
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if content.trim().is_empty() {
        let cut_off = choice.get("finish_reason").and_then(Value::as_str) == Some("length");
        return Err(IpcError::new(
            Code::Api,
            if cut_off {
                "The summary was cut off. Try again."
            } else {
                "Sarvam returned an empty summary."
            },
        ));
    }
    parse_summary(content).ok_or_else(unexpected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_replies() {
        assert_eq!(
            parse_summary(r#"{"title":"Quarterly plan.","summary":"We review the plan."}"#),
            Some(Summary {
                title: "Quarterly plan".into(),
                summary: "We review the plan.".into()
            })
        );
        let fenced =
            "```json\n{\"title\": \"\\\"Demo\\\"\", \"description\": \"Shows the app.\"}\n```";
        assert_eq!(
            parse_summary(fenced),
            Some(Summary {
                title: "Demo".into(),
                summary: "Shows the app.".into()
            })
        );
        assert_eq!(parse_summary("no json here"), None);
        assert_eq!(parse_summary(r#"{"title":"","summary":"x"}"#), None);
    }

    #[test]
    fn fits_long_input() {
        assert_eq!(fit("short", 10), "short");
        let long = "a".repeat(30) + &"b".repeat(30);
        let fitted = fit(&long, 20);
        assert!(fitted.starts_with(&"a".repeat(15)));
        assert!(fitted.ends_with(&"b".repeat(5)));
        assert!(fitted.contains("[...]"));
    }
}
