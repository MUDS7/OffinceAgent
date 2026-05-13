#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! OfficeAgent 的 Tauri 后端入口。
//!
//! 这里负责注册后端模块、初始化插件和暴露给前端调用的命令。

mod agent;
mod deepseek;
mod document_service;
mod file_system;
mod storage;

/// 启动 Tauri 应用，并把 Rust 侧能力注册为前端可调用的命令。
fn main() {
    tauri::Builder::default()
        // 文件选择、保存对话框等系统 UI 能力。
        .plugin(tauri_plugin_dialog::init())
        // 允许前端通过 Tauri 插件访问受控的文件系统能力。
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if let Err(error) = storage::setup_storage(app) {
                eprintln!("failed to initialize document store: {error}");
            }
            // 启动并托管 Python 文档服务，应用退出时会随 Rust 状态一起清理。
            document_service::setup_document_service(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 基础应用信息。
            agent::get_agent_info,
            // 文档服务状态查询。
            document_service::get_document_service_status,
            document_service::render_docx_document,
            document_service::restart_document_service,
            storage::index_document_structure,
            storage::search_document_full_text,
            storage::save_workspace_file_metadata,
            storage::index_workspace_files,
            storage::load_workspace_snapshot,
            storage::open_workspace_storage,
            storage::get_qdrant_status,
            storage::ensure_qdrant_collection,
            storage::upsert_qdrant_chunk_vectors,
            storage::upsert_qdrant_vectors,
            storage::search_qdrant_vectors,
            storage::search_uploaded_document_chunks,
            // DeepSeek 聊天、文本编辑和意图识别能力。
            deepseek::chat_with_deepseek,
            deepseek::classify_text_selection_intent,
            // 文件读写和目录扫描能力。
            file_system::save_file_to_disk,
            file_system::save_file_bytes,
            file_system::read_file_text,
            file_system::read_file_bytes,
            file_system::list_dir_files
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OfficeAgent");
}
