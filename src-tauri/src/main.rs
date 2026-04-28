#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    net::{SocketAddr, TcpStream},
    time::Duration,
};

#[derive(serde::Serialize)]
struct AgentInfo {
    name: &'static str,
    version: &'static str,
    runtime: &'static str,
}

#[derive(serde::Serialize)]
struct ServiceStatus {
    running: bool,
    endpoint: &'static str,
}

const DOCUMENT_SERVICE_ENDPOINT: &str = "http://127.0.0.1:8765";

#[tauri::command]
fn get_agent_info() -> AgentInfo {
    AgentInfo {
        name: "OfficeAgent",
        version: env!("CARGO_PKG_VERSION"),
        runtime: "Tauri + Rust",
    }
}

#[tauri::command]
fn get_document_service_status() -> ServiceStatus {
    let addr = SocketAddr::from(([127, 0, 0, 1], 8765));
    let running = TcpStream::connect_timeout(&addr, Duration::from_millis(350)).is_ok();

    ServiceStatus {
        running,
        endpoint: DOCUMENT_SERVICE_ENDPOINT,
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_agent_info,
            get_document_service_status
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OfficeAgent");
}
