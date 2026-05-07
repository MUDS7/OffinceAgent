#[derive(serde::Serialize)]
pub(crate) struct AgentInfo {
    name: &'static str,
    version: &'static str,
    runtime: &'static str,
}

#[tauri::command]
pub(crate) fn get_agent_info() -> AgentInfo {
    AgentInfo {
        name: "OfficeAgent",
        version: env!("CARGO_PKG_VERSION"),
        runtime: "Tauri + Rust",
    }
}
