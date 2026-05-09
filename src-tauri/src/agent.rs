/// 返回给前端的应用基础信息。
#[derive(serde::Serialize)]
pub(crate) struct AgentInfo {
    /// 应用名称。
    name: &'static str,
    /// Cargo 包版本，编译时从 `Cargo.toml` 注入。
    version: &'static str,
    /// 当前后端运行时说明。
    runtime: &'static str,
}

#[tauri::command]
/// Tauri 命令：获取 OfficeAgent 的名称、版本和运行时信息。
pub(crate) fn get_agent_info() -> AgentInfo {
    AgentInfo {
        name: "OfficeAgent",
        version: env!("CARGO_PKG_VERSION"),
        runtime: "Tauri + Rust",
    }
}
