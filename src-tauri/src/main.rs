#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod deepseek;
mod document_service;
mod file_system;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            document_service::setup_document_service(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent::get_agent_info,
            document_service::get_document_service_status,
            deepseek::chat_with_deepseek,
            deepseek::classify_text_selection_intent,
            file_system::save_file_to_disk,
            file_system::save_file_bytes,
            file_system::read_file_text,
            file_system::read_file_bytes,
            file_system::list_dir_files
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OfficeAgent");
}
