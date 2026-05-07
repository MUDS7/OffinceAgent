use std::{
    net::{SocketAddr, TcpStream},
    time::Duration,
};

const DOCUMENT_SERVICE_ENDPOINT: &str = "http://127.0.0.1:8765";

#[derive(serde::Serialize)]
pub(crate) struct ServiceStatus {
    running: bool,
    endpoint: &'static str,
}

#[tauri::command]
pub(crate) fn get_document_service_status() -> ServiceStatus {
    let addr = SocketAddr::from(([127, 0, 0, 1], 8765));
    let running = TcpStream::connect_timeout(&addr, Duration::from_millis(350)).is_ok();

    ServiceStatus {
        running,
        endpoint: DOCUMENT_SERVICE_ENDPOINT,
    }
}
