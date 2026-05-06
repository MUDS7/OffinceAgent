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

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TextEditAgentRequest {
    file_path: String,
    start: usize,
    end: usize,
    selected_text: String,
    instruction: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextSelectionIntentRequest {
    file_path: String,
    filename: String,
    selected_text: String,
    instruction: String,
}

#[derive(serde::Serialize)]
struct TextSelectionIntentResult {
    intent: &'static str,
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
    #[serde(rename = "reasoning_content")]
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
    messages: Option<Vec<DeepSeekMessage>>,
    text_edit_request: Option<TextEditAgentRequest>,
    stream_id: String,
) -> Result<(), String> {
    let api_key = read_deepseek_api_key()?;
    let messages = match text_edit_request {
        Some(request) => build_text_edit_messages(request)?,
        None => normalize_deepseek_messages(messages.unwrap_or_default())?,
    };
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

#[tauri::command]
async fn classify_text_selection_intent(
    model: Option<String>,
    request: TextSelectionIntentRequest,
) -> Result<TextSelectionIntentResult, String> {
    let api_key = read_deepseek_api_key()?;
    let instruction = request.instruction.trim();

    if instruction.is_empty() {
        return Err("Text selection intent classifier requires instruction".to_string());
    }

    let model = normalize_deepseek_model(model.as_deref());
    let payload = DeepSeekChatRequest {
        model,
        messages: build_text_selection_intent_messages(request)?,
        stream: false,
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("Failed to create DeepSeek HTTP client: {error}"))?;
    let response = client
        .post(DEEPSEEK_CHAT_ENDPOINT)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .header(CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Failed to call DeepSeek intent classifier: {error}"))?;
    let status = response.status();

    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to read DeepSeek intent response: {error}"))?;

        return Err(format!(
            "DeepSeek intent classifier returned {status}: {}",
            truncate_error_body(&body)
        ));
    }

    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read DeepSeek intent response: {error}"))?;
    let content = extract_deepseek_message_content(&body).map_err(|error| {
        format!(
            "Failed to parse DeepSeek intent response: {error}. Body: {}",
            truncate_error_body(&body)
        )
    })?;

    Ok(TextSelectionIntentResult {
        intent: parse_text_selection_intent(&content),
    })
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
        let _reasoning_content = choice.delta.reasoning_content;

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

fn build_text_edit_messages(request: TextEditAgentRequest) -> Result<Vec<DeepSeekMessage>, String> {
    let file_path = request.file_path.trim();
    let instruction = request.instruction.trim();

    if file_path.is_empty() {
        return Err("Text edit agent requires filePath".to_string());
    }

    if request.start > request.end {
        return Err("Text edit agent start cannot be greater than end".to_string());
    }

    if instruction.is_empty() {
        return Err("Text edit agent requires instruction".to_string());
    }

    let content = if request.selected_text.trim().is_empty() {
        format!(
            "你是文本修改助手。\n\n请根据用户要求生成需要新增的文本。\n\n用户要求：\n{instruction}\n\n只返回新增的文本，不要解释。"
        )
    } else {
        format!(
            "你是文本修改助手。\n\n请根据用户要求修改选中文本。\n\n用户要求：\n{instruction}\n\n选中文本：\n<<<\n{}\n>>>\n\n只返回修改后的文本，不要解释。",
            request.selected_text
        )
    };

    Ok(vec![DeepSeekMessage {
        role: "user".to_string(),
        content,
    }])
}

fn build_text_selection_intent_messages(
    request: TextSelectionIntentRequest,
) -> Result<Vec<DeepSeekMessage>, String> {
    let file_path = request.file_path.trim();
    let filename = request.filename.trim();
    let instruction = request.instruction.trim();

    if file_path.is_empty() {
        return Err("Text selection intent classifier requires filePath".to_string());
    }

    if instruction.is_empty() {
        return Err("Text selection intent classifier requires instruction".to_string());
    }

    let selected_text = truncate_intent_selection_context(request.selected_text.trim());
    let content = format!(
        "你是 OfficeAgent 的意图分类器。用户正在文本文件中输入一条针对当前光标或选中文本的请求。\n\n请判断这条请求是：\n- edit：用户明确要求修改、替换、删除、插入、润色、重写、翻译、格式化或生成要写入文件的文本。\n- answer：用户只是提问、解释、总结、分析、询问含义、询问建议或让你判断文本内容，不应该修改文件。\n\n规则：\n1. 只输出一个英文单词：edit 或 answer。\n2. 不要解释。\n3. 如果意图不明确，输出 answer，避免误改文件。\n\n文件路径：{file_path}\n文件名：{filename}\n用户请求：\n<<<\n{instruction}\n>>>\n当前选中文本：\n<<<\n{selected_text}\n>>>"
    );

    Ok(vec![DeepSeekMessage {
        role: "user".to_string(),
        content,
    }])
}

fn extract_deepseek_message_content(body: &str) -> Result<String, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|error| format!("invalid JSON: {error}"))?;

    let choices = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .ok_or_else(|| "missing choices array".to_string())?;

    for choice in choices {
        if let Some(content) = choice
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(value_to_text)
            .map(str::trim)
            .filter(|content| !content.is_empty())
        {
            return Ok(content.to_string());
        }

        if let Some(content) = choice
            .get("message")
            .and_then(|message| message.get("reasoning_content"))
            .and_then(value_to_text)
            .map(str::trim)
            .filter(|content| !content.is_empty())
        {
            return Ok(content.to_string());
        }
    }

    Ok(String::new())
}

fn value_to_text(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::String(text) => Some(text.as_str()),
        _ => None,
    }
}

fn truncate_intent_selection_context(text: &str) -> String {
    const MAX_INTENT_SELECTION_CHARS: usize = 4000;

    let truncated = text
        .chars()
        .take(MAX_INTENT_SELECTION_CHARS)
        .collect::<String>();
    if text.chars().count() > MAX_INTENT_SELECTION_CHARS {
        format!("{truncated}\n...[selection truncated]")
    } else {
        truncated
    }
}

fn parse_text_selection_intent(content: &str) -> &'static str {
    let normalized = content.trim().to_ascii_lowercase();

    if normalized == "edit"
        || normalized.starts_with("edit")
        || normalized.contains("\"edit\"")
        || normalized.contains("'edit'")
        || content.trim().starts_with("编辑")
    {
        return "edit";
    }

    "answer"
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

#[tauri::command]
fn save_file_to_disk(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|error| format!("Failed to save file: {error}"))
}

#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|error| format!("Failed to read file: {error}"))
}

#[tauri::command]
fn list_dir_files(path: String) -> Result<Vec<String>, String> {
    use std::path::Path;

    const SUPPORTED_EXTENSIONS: &[&str] = &["txt", "md", "csv", "json", "pdf"];

    fn walk(dir: &Path, results: &mut Vec<String>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, results)?;
            } else if let Some(ext) = path.extension() {
                let ext_lower = ext.to_string_lossy().to_lowercase();
                if SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str()) {
                    if let Some(s) = path.to_str() {
                        results.push(s.to_string());
                    }
                }
            }
        }
        Ok(())
    }

    let mut results = Vec::new();
    walk(std::path::Path::new(&path), &mut results)
        .map_err(|e| format!("Failed to list directory: {e}"))?;
    results.sort();
    Ok(results)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_agent_info,
            get_document_service_status,
            chat_with_deepseek,
            classify_text_selection_intent,
            save_file_to_disk,
            read_file_text,
            list_dir_files
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OfficeAgent");
}
