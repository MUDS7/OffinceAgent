//! DeepSeek 后端适配层。
//!
//! 本模块把前端的聊天、文本编辑和意图分类请求转换为 DeepSeek API 调用，
//! 并将流式响应重新打包成 Tauri 事件。

mod config;
mod messages;
mod stream;
mod types;

use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use tauri::AppHandle;

use self::{
    config::{normalize_deepseek_model, read_deepseek_api_key, truncate_error_body},
    messages::{
        build_text_edit_messages, build_text_selection_intent_messages,
        extract_deepseek_message_content, normalize_deepseek_messages, parse_text_selection_intent,
    },
    stream::{emit_deepseek_stream_event, stream_deepseek_response},
    types::{
        DeepSeekChatRequest, DeepSeekMessage, DeepSeekThinking, TextEditAgentRequest,
        TextSelectionIntentRequest, TextSelectionIntentResult,
    },
};

/// DeepSeek 兼容 OpenAI Chat Completions 的接口地址。
const DEEPSEEK_CHAT_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";

const DEEPSEEK_CANCELLED_MESSAGE: &str = "DeepSeek request cancelled";

static CANCELLED_DEEPSEEK_STREAMS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_deepseek_streams() -> &'static Mutex<HashSet<String>> {
    CANCELLED_DEEPSEEK_STREAMS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(super) fn is_stream_cancelled(stream_id: &str) -> bool {
    cancelled_deepseek_streams()
        .lock()
        .map(|streams| streams.contains(stream_id))
        .unwrap_or(false)
}

fn remember_cancelled_stream(stream_id: &str) -> Result<(), String> {
    let mut streams = cancelled_deepseek_streams()
        .lock()
        .map_err(|error| format!("Failed to lock DeepSeek cancellation state: {error}"))?;
    streams.insert(stream_id.to_string());
    Ok(())
}

fn clear_cancelled_stream(stream_id: &str) {
    if let Ok(mut streams) = cancelled_deepseek_streams().lock() {
        streams.remove(stream_id);
    }
}

pub(super) async fn wait_for_stream_cancel(stream_id: &str) {
    while !is_stream_cancelled(stream_id) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tauri::command]
pub(crate) fn cancel_deepseek_chat(stream_id: String) -> Result<(), String> {
    remember_cancelled_stream(&stream_id)
}

#[tauri::command]
/// Tauri 命令：调用 DeepSeek 聊天接口，并把流式结果通过事件推送给前端。
pub(crate) async fn chat_with_deepseek(
    app: AppHandle,
    model: Option<String>,
    messages: Option<Vec<DeepSeekMessage>>,
    text_edit_request: Option<TextEditAgentRequest>,
    stream_id: String,
) -> Result<(), String> {
    if is_stream_cancelled(&stream_id) {
        clear_cancelled_stream(&stream_id);
        return Err(DEEPSEEK_CANCELLED_MESSAGE.to_string());
    }

    let api_key = read_deepseek_api_key()?;
    // 文本编辑请求使用专门提示词；普通聊天请求只做角色和空消息归一化。
    let messages = match text_edit_request {
        Some(request) => build_text_edit_messages(request)?,
        None => normalize_deepseek_messages(messages.unwrap_or_default())?,
    };
    let model = normalize_deepseek_model(model.as_deref());
    // 部分 DeepSeek 模型需要显式开启 thinking/reasoning 参数。
    let payload = DeepSeekChatRequest {
        model: model.clone(),
        messages,
        stream: true,
        reasoning_effort: should_enable_deepseek_thinking(&model).then(|| "high".to_string()),
        thinking: should_enable_deepseek_thinking(&model).then(|| DeepSeekThinking {
            kind: "enabled".to_string(),
        }),
    };

    let client = deepseek_client(None, Duration::from_secs(300))?;
    let response = tokio::select! {
        response = client
            .post(DEEPSEEK_CHAT_ENDPOINT)
            .header(AUTHORIZATION, format!("Bearer {api_key}"))
            .header(CONTENT_TYPE, "application/json")
            .json(&payload)
            .send() => {
                response.map_err(|error| format!("Failed to call DeepSeek API: {error}"))?
            }
        _ = wait_for_stream_cancel(&stream_id) => {
            clear_cancelled_stream(&stream_id);
            return Err(DEEPSEEK_CANCELLED_MESSAGE.to_string());
        }
    };
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

    if is_stream_cancelled(&stream_id) {
        clear_cancelled_stream(&stream_id);
        return Err(DEEPSEEK_CANCELLED_MESSAGE.to_string());
    }

    emit_deepseek_stream_event(&app, &stream_id, "start", None, None)?;
    let stream_result = stream_deepseek_response(&app, &stream_id, response).await;
    if stream_result.is_err() && is_stream_cancelled(&stream_id) {
        clear_cancelled_stream(&stream_id);
    }
    stream_result?;

    if is_stream_cancelled(&stream_id) {
        clear_cancelled_stream(&stream_id);
        return Err(DEEPSEEK_CANCELLED_MESSAGE.to_string());
    }

    emit_deepseek_stream_event(&app, &stream_id, "done", None, None)?;

    clear_cancelled_stream(&stream_id);
    Ok(())
}

#[tauri::command]
/// Tauri 命令：在真正改写文件前，先判断用户请求属于回答、替换、插入还是需要确认。
pub(crate) async fn classify_text_selection_intent(
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
        reasoning_effort: None,
        thinking: None,
    };

    let client = deepseek_client(Some(Duration::from_secs(45)), Duration::from_secs(45))?;
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
    // 非流式分类响应仍然是 Chat Completions 形状，需要从 choices 中取文本。
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

/// 判断模型是否需要启用 DeepSeek 的思考模式参数。
fn should_enable_deepseek_thinking(model: &str) -> bool {
    model == "deepseek-v4-pro"
}

/// 创建带超时的 HTTP 客户端，避免模型调用无限挂起。
fn deepseek_client(
    total_timeout: Option<Duration>,
    read_timeout: Duration,
) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(read_timeout);
    let builder = match total_timeout {
        Some(timeout) => builder.timeout(timeout),
        None => builder,
    };

    builder
        .build()
        .map_err(|error| format!("Failed to create DeepSeek HTTP client: {error}"))
}
