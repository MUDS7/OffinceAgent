use std::path::Path;

const SUPPORTED_EXTENSIONS: &[&str] = &["txt", "md", "csv", "json", "pdf", "xlsx", "xls"];

#[tauri::command]
pub(crate) fn save_file_to_disk(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|error| format!("Failed to save file: {error}"))
}

#[tauri::command]
pub(crate) fn save_file_bytes(path: String, content: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|error| format!("Failed to save file bytes: {error}"))
}

#[tauri::command]
pub(crate) fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|error| format!("Failed to read file: {error}"))
}

#[tauri::command]
pub(crate) fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|error| format!("Failed to read file bytes: {error}"))
}

#[tauri::command]
pub(crate) fn list_dir_files(path: String) -> Result<Vec<String>, String> {
    let mut results = Vec::new();
    walk_supported_files(Path::new(&path), &mut results)
        .map_err(|error| format!("Failed to list directory: {error}"))?;
    results.sort();
    Ok(results)
}

fn walk_supported_files(dir: &Path, results: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            walk_supported_files(&path, results)?;
        } else if is_supported_file(&path) {
            if let Some(path) = path.to_str() {
                results.push(path.to_string());
            }
        }
    }

    Ok(())
}

fn is_supported_file(path: &Path) -> bool {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .is_some_and(|extension| SUPPORTED_EXTENSIONS.contains(&extension.as_str()))
}
