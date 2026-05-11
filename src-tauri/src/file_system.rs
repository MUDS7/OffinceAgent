use std::path::Path;

/// 前端资料库/文件树允许递归展示的文件扩展名。
const SUPPORTED_EXTENSIONS: &[&str] = &["txt", "md", "csv", "json", "pdf", "xlsx", "xls", "docx"];

#[tauri::command]
/// Tauri 命令：把 UTF-8 文本内容写入指定磁盘路径。
pub(crate) fn save_file_to_disk(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|error| format!("Failed to save file: {error}"))
}

#[tauri::command]
/// Tauri 命令：把二进制内容写入指定磁盘路径。
pub(crate) fn save_file_bytes(path: String, content: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|error| format!("Failed to save file bytes: {error}"))
}

#[tauri::command]
/// Tauri 命令：按 UTF-8 文本读取文件。
pub(crate) fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|error| format!("Failed to read file: {error}"))
}

#[tauri::command]
/// Tauri 命令：以字节数组读取文件，供 PDF、Excel 等二进制格式使用。
pub(crate) fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|error| format!("Failed to read file bytes: {error}"))
}

#[tauri::command]
/// Tauri 命令：递归列出目录下受支持的文件，并按路径排序。
pub(crate) fn list_dir_files(path: String) -> Result<Vec<String>, String> {
    let mut results = Vec::new();
    walk_supported_files(Path::new(&path), &mut results)
        .map_err(|error| format!("Failed to list directory: {error}"))?;
    results.sort();
    Ok(results)
}

/// 深度优先遍历目录，把符合扩展名白名单的文件路径加入结果集。
fn walk_supported_files(dir: &Path, results: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            // 子目录继续递归，保持调用方只需要处理一个扁平路径列表。
            walk_supported_files(&path, results)?;
        } else if is_supported_file(&path) {
            if let Some(path) = path.to_str() {
                results.push(path.to_string());
            }
        }
    }

    Ok(())
}

/// 判断文件扩展名是否在前端当前支持的导入/预览范围内。
fn is_supported_file(path: &Path) -> bool {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .is_some_and(|extension| SUPPORTED_EXTENSIONS.contains(&extension.as_str()))
}
