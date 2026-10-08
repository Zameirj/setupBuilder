use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::settings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub product_id: String,
    pub name: String,
    pub version: Option<String>,
    pub priority: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub product_type: Option<String>,
    pub notification: Option<String>,
    pub parent_product_id: Option<String>,
    pub silent_cwp: Option<serde_json::Value>,
    pub package_file: Option<serde_json::Value>,
    pub friendly_name: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductsResponse {
    data: Vec<Product>,
}

#[tauri::command]
pub async fn fetch_products(app: AppHandle) -> Result<Vec<Product>, String> {
    let settings = settings::load(&app);
    if settings.api_key.trim().is_empty() {
        return Err("No API key configured. Open Settings to add one.".into());
    }

    let response = reqwest::Client::new()
        .get(&settings.api_url)
        .header("x-api-key", settings.api_key.trim())
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!("API rejected the API key ({status}). Check Settings."));
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API returned {status}: {}", body.chars().take(300).collect::<String>()));
    }

    let mut body: ProductsResponse = response
        .json()
        .await
        .map_err(|e| format!("Could not parse API response: {e}"))?;

    body.data.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(body.data)
}
