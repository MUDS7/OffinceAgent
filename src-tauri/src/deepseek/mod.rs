mod config;
mod messages;
mod stream;
mod types;

use std::time::Duration;

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
        DeepSeekChatRequest, DeepSeekMessage, TextEditAgentRequest, TextSelectionIntentRequest,
        TextSelectionIntentResult,
    },
};

const DEEPSEEK_CHAT_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";

#[tauri::command]
pub(crate) async fn chat_with_deepseek(
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

    let client = deepseek_client(Duration::from_secs(90))?;
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
    };

    let client = deepseek_client(Duration::from_secs(45))?;
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

fn deepseek_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Failed to create DeepSeek HTTP client: {error}"))
}
