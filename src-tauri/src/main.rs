#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    net::{SocketAddr, TcpStream},
    time::Duration,
};

use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use tauri::{AppHandle, Emitter};

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

#[derive(serde::Deserialize, serde::Serialize)]
struct DeepSeekMessage {
    role: String,
    content: String,
}

#[derive(serde::Serialize)]
struct DeepSeekChatRequest {
    model: String,
    messages: Vec<DeepSeekMessage>,
    stream: bool,
}

#[derive(Clone, serde::Serialize)]
struct DeepSeekStreamEvent {
    stream_id: String,
    kind: &'static str,
    content: Option<String>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct DeepSeekStreamChunk {
    choices: Vec<DeepSeekStreamChoice>,
}

#[derive(serde::Deserialize)]
struct DeepSeekStreamChoice {
    delta: DeepSeekStreamDelta,
}

#[derive(serde::Deserialize)]
struct DeepSeekStreamDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
}

const DOCUMENT_SERVICE_ENDPOINT: &str = "http://127.0.0.1:8765";
const DEEPSEEK_CHAT_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_CHAT_STREAM_EVENT: &str = "deepseek-chat-stream";

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

#[tauri::command]
async fn chat_with_deepseek(
    app: AppHandle,
    model: Option<String>,
    messages: Vec<DeepSeekMessage>,
    stream_id: String,
) -> Result<(), String> {
    let api_key = read_deepseek_api_key()?;
    let messages = normalize_deepseek_messages(messages)?;
    let model = normalize_deepseek_model(model.as_deref());
    let payload = DeepSeekChatRequest {
        model: model.clone(),
        messages,
        stream: true,
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("Failed to create DeepSeek HTTP client: {error}"))?;
    let response = client
        .post(DEEPSEEK_CHAT_ENDPOINT)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .header(CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Failed to call DeepSeek API: {error}"))?;
    let status = response.status();

    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to read DeepSeek response: {error}"))?;

        return Err(format!(
            "DeepSeek API returned {status}: {}",
            truncate_error_body(&body)
        ));
    }

    emit_deepseek_stream_event(&app, &stream_id, "start", None, None)?;
    stream_deepseek_response(&app, &stream_id, response).await?;
    emit_deepseek_stream_event(&app, &stream_id, "done", None, None)?;

    Ok(())
}

async fn stream_deepseek_response(
    app: &AppHandle,
    stream_id: &str,
    response: reqwest::Response,
) -> Result<(), String> {
    let mut pending = String::new();
    let mut chunks = response.bytes_stream();

    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|error| format!("Failed to read DeepSeek stream: {error}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = pending.find('\n') {
            let line = pending.drain(..=line_end).collect::<String>();
            if handle_deepseek_sse_line(app, stream_id, line.trim())? {
                return Ok(());
            }
        }
    }

    if !pending.trim().is_empty() {
        let line = pending.trim();
        handle_deepseek_sse_line(app, stream_id, line)?;
    }

    Ok(())
}

fn handle_deepseek_sse_line(app: &AppHandle, stream_id: &str, line: &str) -> Result<bool, String> {
    if line.is_empty() || !line.starts_with("data:") {
        return Ok(false);
    }

    let data = line.trim_start_matches("data:").trim();
    if data == "[DONE]" {
        return Ok(true);
    }

    let chunk = serde_json::from_str::<DeepSeekStreamChunk>(data)
        .map_err(|error| format!("Failed to parse DeepSeek stream chunk: {error}"))?;

    for choice in chunk.choices {
        if let Some(reasoning_content) = choice.delta.reasoning_content {
            emit_deepseek_stream_event(app, stream_id, "delta", Some(reasoning_content), None)?;
        }

        if let Some(content) = choice.delta.content {
            emit_deepseek_stream_event(app, stream_id, "delta", Some(content), None)?;
        }
    }

    Ok(false)
}

fn emit_deepseek_stream_event(
    app: &AppHandle,
    stream_id: &str,
    kind: &'static str,
    content: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    app.emit(
        DEEPSEEK_CHAT_STREAM_EVENT,
        DeepSeekStreamEvent {
            stream_id: stream_id.to_string(),
            kind,
            content,
            error,
        },
    )
    .map_err(|error| format!("Failed to emit DeepSeek stream event: {error}"))
}

fn read_deepseek_api_key() -> Result<String, String> {
    load_dotenv_files();

    env::var("DEEPSEEK_API_KEY")
        .map(|api_key| api_key.trim().to_string())
        .ok()
        .filter(|api_key| !api_key.is_empty())
        .ok_or_else(|| {
            "DEEPSEEK_API_KEY is not set. Add DEEPSEEK_API_KEY=your_key to a .env file.".to_string()
        })
}

fn load_dotenv_files() {
    let _ = dotenvy::dotenv();

    for base_dir in dotenv_base_dirs() {
        let env_path = base_dir.join(".env");
        let local_env_path = base_dir.join(".env.local");

        let _ = dotenvy::from_path(env_path);
        let _ = dotenvy::from_path(local_env_path);
    }
}

fn dotenv_base_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(current_dir) = env::current_dir() {
        dirs.push(current_dir.clone());
        if let Some(parent_dir) = current_dir.parent() {
            dirs.push(parent_dir.to_path_buf());
        }
    }

    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dirs.push(manifest_dir.clone());
    if let Some(parent_dir) = manifest_dir.parent() {
        dirs.push(parent_dir.to_path_buf());
    }

    dirs
}

fn normalize_deepseek_messages(
    messages: Vec<DeepSeekMessage>,
) -> Result<Vec<DeepSeekMessage>, String> {
    let normalized = messages
        .into_iter()
        .filter_map(|message| {
            let role = message.role.trim().to_ascii_lowercase();
            let content = message.content.trim().to_string();

            if content.is_empty() {
                return None;
            }

            let role = match role.as_str() {
                "assistant" | "system" | "user" => role,
                _ => "user".to_string(),
            };

            Some(DeepSeekMessage { role, content })
        })
        .collect::<Vec<_>>();

    if normalized.is_empty() {
        return Err("DeepSeek chat requires at least one non-empty message".to_string());
    }

    Ok(normalized)
}

fn normalize_deepseek_model(model: Option<&str>) -> String {
    match model.unwrap_or("deepseek-v4-flash").trim() {
        "" => "deepseek-v4-flash",
        "deepseek-v3" => "deepseek-chat",
        "deepseek-v4" => "deepseek-v4-flash",
        model => model,
    }
    .to_string()
}

fn truncate_error_body(body: &str) -> String {
    const MAX_ERROR_CHARS: usize = 400;

    let truncated = body.chars().take(MAX_ERROR_CHARS).collect::<String>();
    if body.chars().count() > MAX_ERROR_CHARS {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_agent_info,
            get_document_service_status,
            chat_with_deepseek
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OfficeAgent");
}
