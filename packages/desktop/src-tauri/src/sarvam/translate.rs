//! Text translation for subtitles: short lines are grouped into one request when the reply keeps the line count.

use futures_util::{stream, StreamExt, TryStreamExt};
use serde::Deserialize;
use serde_json::{json, Value};

use super::client::unexpected;
use super::jobs::Ctx;
use super::lang;
use crate::error::{Code, IpcError, IpcResult};

const CONCURRENCY: usize = 4;
const MAX_GROUP_ITEMS: usize = 50;
const MAX_TEXTS: usize = 20_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateRequest {
    pub task: String,
    pub texts: Vec<String>,
    pub source: String,
    pub target: String,
    pub model: String,
}

/// Characters per request for each model.
pub fn limit_for(model: &str) -> Option<usize> {
    match model {
        "sarvam-translate:v1" => Some(2000),
        "mayura:v1" => Some(1000),
        _ => None,
    }
}

/// Resolves the API source code and the per-request limit.
fn check(request: &TranslateRequest) -> IpcResult<(String, usize)> {
    let limit =
        limit_for(&request.model).ok_or_else(|| IpcError::invalid("Unknown translation model."))?;
    if request.texts.len() > MAX_TEXTS {
        return Err(IpcError::invalid("Too many lines to translate at once."));
    }
    let mayura = request.model == "mayura:v1";
    let supported = |code: &str| {
        if mayura {
            lang::is_core(code)
        } else {
            lang::is_known(code)
        }
    };
    if !supported(&request.target) {
        return Err(IpcError::new(
            Code::Unsupported,
            "This model cannot translate into that language.",
        ));
    }
    let source = match request.source.as_str() {
        "unknown" | "auto" if mayura => "auto".to_string(),
        "unknown" | "auto" => {
            return Err(IpcError::invalid(
                "Choose the transcript's language before translating.",
            ))
        }
        code if supported(code) => code.to_string(),
        _ => {
            return Err(IpcError::new(
                Code::Unsupported,
                "This model cannot translate from that language.",
            ))
        }
    };
    Ok((source, limit))
}

#[derive(Debug, PartialEq)]
pub enum Unit {
    /// Indices of consecutive short texts sent as one newline-joined request.
    Group(Vec<usize>),
    /// One text over the limit, split into pieces.
    Long(usize, Vec<String>),
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// Groups texts so each request stays within `limit` characters. Blank texts are skipped.
pub fn plan(texts: &[String], limit: usize) -> Vec<Unit> {
    let mut units = Vec::new();
    let mut group: Vec<usize> = Vec::new();
    let mut group_len = 0;
    let flush = |group: &mut Vec<usize>, group_len: &mut usize, units: &mut Vec<Unit>| {
        if !group.is_empty() {
            units.push(Unit::Group(std::mem::take(group)));
            *group_len = 0;
        }
    };
    for (i, raw) in texts.iter().enumerate() {
        let text = raw.trim();
        if text.is_empty() {
            continue;
        }
        let len = char_len(text);
        if len > limit {
            flush(&mut group, &mut group_len, &mut units);
            units.push(Unit::Long(i, split_text(text, limit)));
            continue;
        }
        // A text with its own line breaks would make the reply's line count ambiguous.
        if text.contains('\n') {
            flush(&mut group, &mut group_len, &mut units);
            units.push(Unit::Group(vec![i]));
            continue;
        }
        let joined = if group.is_empty() {
            len
        } else {
            group_len + 1 + len
        };
        if joined > limit || group.len() >= MAX_GROUP_ITEMS {
            flush(&mut group, &mut group_len, &mut units);
            group_len = len;
        } else {
            group_len = joined;
        }
        group.push(i);
    }
    flush(&mut group, &mut group_len, &mut units);
    units
}

fn is_sentence_end(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '\n' | '।' | '॥' | '؟' | '۔')
}

/// Splits text into pieces of at most `limit` characters, preferring sentence ends, then spaces.
pub fn split_text(text: &str, limit: usize) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        current.push(c);
        if is_sentence_end(c) {
            sentences.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        sentences.push(current);
    }

    let mut pieces = Vec::new();
    let mut piece = String::new();
    for sentence in sentences {
        for part in hard_split(&sentence, limit) {
            if char_len(&piece) + char_len(&part) > limit && !piece.trim().is_empty() {
                pieces.push(piece.trim().to_owned());
                piece.clear();
            }
            piece.push_str(&part);
        }
    }
    if !piece.trim().is_empty() {
        pieces.push(piece.trim().to_owned());
    }
    pieces
}

/// Cuts one sentence longer than `limit` at the last space before the limit (or at the limit).
fn hard_split(sentence: &str, limit: usize) -> Vec<String> {
    let chars: Vec<char> = sentence.chars().collect();
    if chars.len() <= limit {
        return vec![sentence.to_owned()];
    }
    let mut parts = Vec::new();
    let mut start = 0;
    while chars.len() - start > limit {
        let window = &chars[start..start + limit];
        let cut = window
            .iter()
            .rposition(|c| c.is_whitespace())
            .filter(|&at| at > 0)
            .map_or(limit, |at| at + 1);
        parts.push(chars[start..start + cut].iter().collect());
        start += cut;
    }
    parts.push(chars[start..].iter().collect());
    parts
}

struct Call<'a> {
    ctx: &'a Ctx<'a>,
    source: &'a str,
    target: &'a str,
    model: &'a str,
}

impl Call<'_> {
    async fn one(&self, input: &str) -> IpcResult<String> {
        let reply: Value = self
            .ctx
            .api
            .post_json(
                "/translate",
                &json!({
                  "input": input,
                  "source_language_code": self.source,
                  "target_language_code": self.target,
                  "model": self.model,
                }),
            )
            .await?;
        reply
            .get("translated_text")
            .and_then(Value::as_str)
            .map(|text| text.trim().to_owned())
            .ok_or_else(unexpected)
    }

    async fn unit(&self, texts: &[String], unit: Unit) -> IpcResult<Vec<(usize, String)>> {
        match unit {
            Unit::Group(items) if items.len() == 1 => {
                let i = items[0];
                Ok(vec![(i, self.one(texts[i].trim()).await?)])
            }
            Unit::Group(items) => {
                let joined = items
                    .iter()
                    .map(|&i| texts[i].trim())
                    .collect::<Vec<_>>()
                    .join("\n");
                let reply = self.one(&joined).await?;
                let lines: Vec<&str> = reply.lines().collect();
                if lines.len() == items.len() {
                    return Ok(items
                        .into_iter()
                        .zip(lines)
                        .map(|(i, line)| (i, line.trim().to_owned()))
                        .collect());
                }
                let mut out = Vec::with_capacity(items.len());
                for i in items {
                    out.push((i, self.one(texts[i].trim()).await?));
                }
                Ok(out)
            }
            Unit::Long(i, pieces) => {
                let mut translated = Vec::with_capacity(pieces.len());
                for piece in &pieces {
                    translated.push(self.one(piece).await?);
                }
                Ok(vec![(i, translated.join(" "))])
            }
        }
    }
}

pub async fn translate(ctx: &Ctx<'_>, request: &TranslateRequest) -> IpcResult<Vec<String>> {
    let (source, limit) = check(request)?;
    let mut out: Vec<String> = request.texts.iter().map(|t| t.trim().to_owned()).collect();
    if source == request.target {
        return Ok(out);
    }
    let units = plan(&request.texts, limit);
    let total = units.len().max(1);
    let call = Call {
        ctx,
        source: &source,
        target: &request.target,
        model: &request.model,
    };
    ctx.report("translate", Some(0.0), "Translating");
    let mut done = 0;
    let results: Vec<Vec<(usize, String)>> = stream::iter(units)
        .map(|unit| call.unit(&request.texts, unit))
        .buffer_unordered(CONCURRENCY)
        .inspect_ok(|_| {
            done += 1;
            ctx.report("translate", Some(done as f64 / total as f64), "Translating");
        })
        .try_collect()
        .await?;
    for (i, text) in results.into_iter().flatten() {
        out[i] = text;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(items: &[&str]) -> Vec<String> {
        items.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn groups_within_limit() {
        let input = texts(&["aaaa", "bbbb", "", "cccc", "dd"]);
        // "aaaa\nbbbb" is 9 chars; adding "\ncccc" would make 14.
        assert_eq!(
            plan(&input, 10),
            vec![Unit::Group(vec![0, 1]), Unit::Group(vec![3, 4])]
        );
        assert_eq!(plan(&input, 100), vec![Unit::Group(vec![0, 1, 3, 4])]);
    }

    #[test]
    fn isolates_multiline_and_long_texts() {
        let input = texts(&["one", "two\nlines", "three", &"x".repeat(25)]);
        let units = plan(&input, 10);
        assert_eq!(units[0], Unit::Group(vec![0]));
        assert_eq!(units[1], Unit::Group(vec![1]));
        assert_eq!(units[2], Unit::Group(vec![2]));
        match &units[3] {
            Unit::Long(3, pieces) => {
                assert!(pieces.iter().all(|p| p.chars().count() <= 10));
                assert_eq!(pieces.concat(), "x".repeat(25));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn caps_group_size() {
        let input: Vec<String> = (0..120).map(|i| format!("{i}")).collect();
        let units = plan(&input, 2000);
        assert_eq!(units.len(), 3);
        assert!(matches!(&units[0], Unit::Group(items) if items.len() == MAX_GROUP_ITEMS));
    }

    #[test]
    fn splits_at_sentences_then_spaces() {
        let text = "First sentence here. Second one! Third? नमस्ते दुनिया। End";
        let pieces = split_text(text, 25);
        assert!(pieces.iter().all(|p| p.chars().count() <= 25), "{pieces:?}");
        assert_eq!(pieces[0], "First sentence here.");
        let rejoined: String = pieces.join(" ");
        assert_eq!(
            rejoined.split_whitespace().count(),
            text.split_whitespace().count()
        );
        let words = split_text("alpha beta gamma delta epsilon", 12);
        assert_eq!(words, ["alpha beta", "gamma delta", "epsilon"]);
    }

    #[test]
    fn validates_models_and_languages() {
        let request = |model: &str, source: &str, target: &str| TranslateRequest {
            task: "t".into(),
            texts: vec![],
            source: source.into(),
            target: target.into(),
            model: model.into(),
        };
        assert_eq!(
            check(&request("mayura:v1", "unknown", "hi-IN")).unwrap(),
            ("auto".to_string(), 1000)
        );
        assert_eq!(
            check(&request("sarvam-translate:v1", "hi-IN", "sat-IN")).unwrap(),
            ("hi-IN".to_string(), 2000)
        );
        assert!(check(&request("sarvam-translate:v1", "unknown", "hi-IN")).is_err());
        assert_eq!(
            check(&request("mayura:v1", "hi-IN", "sat-IN"))
                .unwrap_err()
                .code,
            Code::Unsupported
        );
        assert!(check(&request("gpt", "hi-IN", "en-IN")).is_err());
    }
}
