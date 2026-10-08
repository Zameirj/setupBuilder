use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::settings;

/// Latest release as reported by the update endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Accepts either a JSON object `{ "version": "1.0.2", "downloadUrl": "...", "notes": "..." }`,
/// a JSON string `"1.0.2"`, or a plain-text body `1.0.2`.
fn parse_update(body: &str) -> Result<UpdateInfo, String> {
    let text = body.trim().trim_start_matches('\u{feff}');
    let info = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(_)) => {
            serde_json::from_str::<UpdateInfo>(text).map_err(|e| format!("Unexpected update response: {e}"))?
        }
        Ok(serde_json::Value::String(v)) => UpdateInfo { version: v, download_url: None, notes: None },
        _ => UpdateInfo { version: text.to_string(), download_url: None, notes: None },
    };
    let version = info.version.trim().to_string();
    if version.is_empty() || version.len() > 64 || version.contains(char::is_whitespace) {
        return Err(format!("Update response is not a version: {}", text.chars().take(80).collect::<String>()));
    }
    Ok(UpdateInfo { version, ..info })
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle, url: String, send_api_key: bool) -> Result<UpdateInfo, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("Update URL must be http(s): {url}"));
    }
    let mut request = reqwest::Client::new()
        .get(&url)
        .header("accept", "application/json, text/plain");
    if send_api_key {
        let key = settings::load(&app).api_key;
        if !key.trim().is_empty() {
            request = request.header("x-api-key", key.trim());
        }
    }
    let response = request.send().await.map_err(|e| format!("Update check failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Update check returned {status}"));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    parse_update(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_text() {
        assert_eq!(parse_update("1.0.2\n").unwrap().version, "1.0.2");
    }

    #[test]
    fn parses_json_string() {
        assert_eq!(parse_update("\"1.0.2\"").unwrap().version, "1.0.2");
    }

    #[test]
    fn parses_json_object() {
        let info = parse_update(r#"{"version":"1.0.2","downloadUrl":"https://x/y.exe","notes":"Fixes"}"#).unwrap();
        assert_eq!(info.version, "1.0.2");
        assert_eq!(info.download_url.as_deref(), Some("https://x/y.exe"));
        assert_eq!(info.notes.as_deref(), Some("Fixes"));
    }

    #[test]
    fn rejects_html_or_garbage() {
        assert!(parse_update("<html><body>Not found</body></html>").is_err());
        assert!(parse_update("").is_err());
        assert!(parse_update(r#"{"latest":"1.0.2"}"#).is_err());
    }
}
