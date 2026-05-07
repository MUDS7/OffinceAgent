use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use super::types::{DeepSeekStreamChunk, DeepSeekStreamEvent};

const DEEPSEEK_CHAT_STREAM_EVENT: &str = "deepseek-chat-stream";

pub(super) async fn stream_deepseek_response(
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
            emit_deepseek_stream_event(app, stream_id, "reasoning", Some(reasoning_content), None)?;
        }

        if let Some(content) = choice.delta.content {
            emit_deepseek_stream_event(app, stream_id, "delta", Some(content), None)?;
        }
    }

    Ok(false)
}

pub(super) fn emit_deepseek_stream_event(
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
