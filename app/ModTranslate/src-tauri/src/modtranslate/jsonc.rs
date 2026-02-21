use serde_json::{Map, Value};

#[derive(Debug, thiserror::Error)]
pub enum JsoncError {
    #[error("Failed to parse JSON ({label}): {source}")]
    Parse { label: String, source: serde_json::Error },
    #[error("Expected an object at top-level ({label})")]
    NotObject { label: String },
}

/// Strips `//` and `/* */` comments, while being aware of JSON strings.
pub fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
                continue;
            }
            match c {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' => {
                match chars.peek().copied() {
                    Some('/') => {
                        chars.next();
                        while let Some(n) = chars.next() {
                            if n == '\n' {
                                out.push('\n');
                                break;
                            }
                        }
                    }
                    Some('*') => {
                        chars.next();
                        let mut prev = '\0';
                        while let Some(n) = chars.next() {
                            if prev == '*' && n == '/' {
                                break;
                            }
                            prev = n;
                        }
                    }
                    _ => out.push(c),
                }
            }
            _ => out.push(c),
        }
    }

    out
}

pub fn parse_jsonc_object(input: &str, label: &str) -> Result<Map<String, Value>, JsoncError> {
    let cleaned = strip_json_comments(input);
    let v: Value = serde_json::from_str(&cleaned).map_err(|e| JsoncError::Parse {
        label: label.to_string(),
        source: e,
    })?;
    match v {
        Value::Object(map) => Ok(map),
        _ => Err(JsoncError::NotObject {
            label: label.to_string(),
        }),
    }
}

pub fn try_parse_jsonc_object(input: &str) -> Option<Map<String, Value>> {
    let cleaned = strip_json_comments(input);
    let v: Value = serde_json::from_str(&cleaned).ok()?;
    match v {
        Value::Object(map) => Some(map),
        _ => None,
    }
}
