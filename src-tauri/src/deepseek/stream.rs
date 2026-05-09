use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use super::types::{DeepSeekStreamChunk, DeepSeekStreamEvent};

/// 前端监听 DeepSeek SSE 转发结果时使用的 Tauri 事件名。
const DEEPSEEK_CHAT_STREAM_EVENT: &str = "deepseek-chat-stream";

/// 读取 DeepSeek 的 SSE 响应，并把增量内容转发为 Tauri 事件。
pub(super) async fn stream_deepseek_response(
    app: &AppHandle,
    stream_id: &str,
    response: reqwest::Response,
) -> Result<(), String> {
    // 网络分片可能切在换行符中间，所以先累积到 `pending` 再按行解析。
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

/// 处理单行 SSE 数据。
///
/// 返回 `true` 表示收到 `[DONE]`，调用方可以结束流式读取。
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
            // 推理内容与最终文本分开发送，前端可以选择不同展示方式。
            emit_deepseek_stream_event(app, stream_id, "reasoning", Some(reasoning_content), None)?;
        }

        if let Some(content) = choice.delta.content {
            emit_deepseek_stream_event(app, stream_id, "delta", Some(content), None)?;
        }
    }

    Ok(false)
}

/// 向前端发送一条 DeepSeek 流式事件。
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
