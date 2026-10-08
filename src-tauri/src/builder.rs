use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

/// SHA1 of the product id as lowercase hex.
/// Matches crypto-js `SHA1(data).toString()`.
pub fn hash_password(product_id: &str) -> String {
    hex::encode(Sha1::digest(product_id.as_bytes()))
}

#[tauri::command]
pub fn password_for(product_id: String) -> String {
    hash_password(&product_id)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildJob {
    pub product_id: String,
    /// Files and/or folders to compress. A folder's contents are added at the
    /// archive root; a file is added by name.
    pub sources: Vec<String>,
    /// Written to the "version" key of package.json before compressing.
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildProgress {
    pub product_id: String,
    /// "building" | "done" | "error"
    pub status: String,
    pub message: String,
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSummary {
    pub succeeded: usize,
    pub failed: usize,
}

/// Product ids come from the API and become file names, so only allow
/// characters that are safe in a Windows file name.
fn is_safe_file_stem(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn resolve_7zip(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let exe = app
        .path()
        .resolve("resources/7zip/7z.exe", BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let sfx = app
        .path()
        .resolve("resources/7zip/7z.sfx", BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    if !exe.exists() {
        return Err(format!("Bundled 7z.exe not found at {}", exe.display()));
    }
    if !sfx.exists() {
        return Err(format!("Bundled 7z.sfx not found at {}", sfx.display()));
    }
    Ok((exe, sfx))
}

const PACKAGE_JSON: &str = "package.json";

/// Finds the package.json to stamp with the version. Looks at the root of a
/// selected folder, then among selected files, then beside the selected files.
/// The bool is true when the file is not already part of the selection.
fn locate_package_json(sources: &[String]) -> Option<(PathBuf, bool)> {
    let paths: Vec<&Path> = sources.iter().map(Path::new).collect();

    if let Some(p) = paths.iter().filter(|p| p.is_dir()).map(|d| d.join(PACKAGE_JSON)).find(|p| p.is_file()) {
        return Some((p, false));
    }
    if let Some(p) = paths.iter().find(|p| {
        p.is_file()
            && p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(PACKAGE_JSON))
    }) {
        return Some((p.to_path_buf(), false));
    }
    paths
        .iter()
        .filter(|p| p.is_file())
        .filter_map(|p| p.parent())
        .map(|dir| dir.join(PACKAGE_JSON))
        .find(|p| p.is_file())
        .map(|p| (p, true))
}

/// Sets the top-level "version" key, keeping key order and 4-space indentation.
fn update_package_json(path: &Path, version: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let text = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    let mut json: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Invalid JSON in {}: {e}", path.display()))?;
    let obj = json
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    obj.insert("version".into(), serde_json::Value::String(version.to_string()));

    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut ser = serde_json::Serializer::with_formatter(&mut out, formatter);
    serde::Serialize::serialize(&json, &mut ser).map_err(|e| e.to_string())?;
    if text.ends_with('\n') {
        out.extend_from_slice(if text.ends_with("\r\n") { b"\r\n" } else { b"\n" });
    }

    // Write to a temp file then swap, so a failure never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &out).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Cannot update {}: {e}", path.display())
    })
}

fn build_one(seven_zip: &Path, sfx: &Path, job: &BuildJob, output_dir: &Path) -> Result<PathBuf, String> {
    if !is_safe_file_stem(&job.product_id) {
        return Err(format!("Product id '{}' is not a valid file name", job.product_id));
    }
    if job.sources.is_empty() {
        return Err("No files or folder selected".into());
    }
    let mut inputs: Vec<PathBuf> = Vec::with_capacity(job.sources.len());
    for src in &job.sources {
        let path = Path::new(src);
        if !path.is_absolute() {
            return Err(format!("Source path must be absolute: {src}"));
        }
        if path.is_dir() {
            let is_empty = std::fs::read_dir(path)
                .map_err(|e| format!("Cannot read folder {src}: {e}"))?
                .next()
                .is_none();
            if is_empty {
                return Err(format!("Folder is empty: {src}"));
            }
            inputs.push(path.join("*"));
        } else if path.is_file() {
            inputs.push(path.to_path_buf());
        } else {
            return Err(format!("Source does not exist: {src}"));
        }
    }

    let version = job.version.trim();
    if version.is_empty() {
        return Err("Version is empty — enter a version before building".into());
    }
    let (package_json, outside_selection) = locate_package_json(&job.sources)
        .ok_or("package.json not found in the selected folder/files")?;
    update_package_json(&package_json, version)?;
    if outside_selection {
        // Found next to the selected files but not selected itself: include it.
        inputs.push(package_json);
    }

    let output = output_dir.join(format!("{}.exe", job.product_id));
    if output.exists() {
        // 7z would otherwise try to update the existing archive.
        std::fs::remove_file(&output).map_err(|e| format!("Cannot replace existing {}: {e}", output.display()))?;
    }

    let password = hash_password(&job.product_id);
    let mut cmd = Command::new(seven_zip);
    cmd.arg("a")
        .arg("-t7z")
        .arg("-mx=9")
        .arg("-mhe=on")
        .arg("-y")
        .arg("-bso0")
        .arg("-bsp0")
        .arg(format!("-sfx{}", sfx.display()))
        .arg(format!("-p{password}"))
        .arg(&output)
        .args(&inputs);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let result = cmd.output().map_err(|e| format!("Failed to start 7-Zip: {e}"))?;
    // 7-Zip exit codes: 0 = OK, 1 = warning (e.g. locked file skipped), 2+ = error.
    match result.status.code() {
        Some(0) => Ok(output),
        Some(1) => Err(format!(
            "7-Zip finished with warnings: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        )),
        code => {
            let _ = std::fs::remove_file(&output);
            Err(format!(
                "7-Zip failed (exit {:?}): {}",
                code,
                String::from_utf8_lossy(&result.stderr).trim()
            ))
        }
    }
}

#[tauri::command]
pub async fn build_products(app: AppHandle, jobs: Vec<BuildJob>, output_dir: String) -> Result<BuildSummary, String> {
    let out = PathBuf::from(&output_dir);
    if !out.is_dir() {
        return Err(format!("Output folder does not exist: {output_dir}"));
    }
    let (seven_zip, sfx) = resolve_7zip(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut summary = BuildSummary { succeeded: 0, failed: 0 };
        for job in &jobs {
            let _ = app.emit(
                "build-progress",
                BuildProgress {
                    product_id: job.product_id.clone(),
                    status: "building".into(),
                    message: String::new(),
                    output_path: None,
                },
            );

            let progress = match build_one(&seven_zip, &sfx, job, &out) {
                Ok(path) => {
                    summary.succeeded += 1;
                    BuildProgress {
                        product_id: job.product_id.clone(),
                        status: "done".into(),
                        message: format!(
                            "package.json version set to {}. Created {}",
                            job.version.trim(),
                            path.display()
                        ),
                        output_path: Some(path.display().to_string()),
                    }
                }
                Err(message) => {
                    summary.failed += 1;
                    BuildProgress {
                        product_id: job.product_id.clone(),
                        status: "error".into(),
                        message,
                        output_path: None,
                    }
                }
            };
            let _ = app.emit("build-progress", progress);
        }
        summary
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !Path::new(&path).is_dir() {
        return Err(format!("Folder does not exist: {path}"));
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_crypto_js_sha1() {
        assert_eq!(
            hash_password("z991qrgz-ruixq4ka-xpbvcx3r-6pr5fc00"),
            "fed083cb323e7e5005a8a8727dbc55862d94ffb9"
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("setup-builder-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SAMPLE: &str = r#"{
    "code": "vwnefvpw-opyhxbve-7hlb2e6r-v7e7th00",
    "name": "Caseware Working Papers SmartSync (Prot)",
    "version": "025.00.091r2.01",
    "exe": [
        "cwin32.exe"
    ],
    "install": {
        "exe": "setup.exe",
        "args": [
            "/S"
        ]
    }
}"#;

    #[test]
    fn updates_only_version_and_keeps_layout() {
        let dir = temp_dir("update");
        let file = dir.join(PACKAGE_JSON);
        std::fs::write(&file, format!("\u{feff}{SAMPLE}")).unwrap();

        update_package_json(&file, "2025.00.091r2.02").unwrap();

        let expected = SAMPLE.replace("025.00.091r2.01", "2025.00.091r2.02");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), expected);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_package_json_in_folder_or_beside_files() {
        let dir = temp_dir("locate");
        let pkg = dir.join(PACKAGE_JSON);
        let setup = dir.join("setup.exe");
        std::fs::write(&pkg, SAMPLE).unwrap();
        std::fs::write(&setup, "x").unwrap();
        let s = |p: &Path| p.display().to_string();

        assert_eq!(locate_package_json(&[s(&dir)]), Some((pkg.clone(), false)));
        assert_eq!(locate_package_json(&[s(&setup), s(&pkg)]), Some((pkg.clone(), false)));
        assert_eq!(locate_package_json(&[s(&setup)]), Some((pkg.clone(), true)));

        std::fs::remove_file(&pkg).unwrap();
        assert_eq!(locate_package_json(&[s(&dir)]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(is_safe_file_stem("z991qrgz-ruixq4ka-xpbvcx3r-6pr5fc00"));
        assert!(is_safe_file_stem("84626cb1-447c-4af7-be99-3e8e918526e5"));
        assert!(!is_safe_file_stem("..\\evil"));
        assert!(!is_safe_file_stem(""));
    }
}
