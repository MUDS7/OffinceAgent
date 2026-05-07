use super::types::{DeepSeekMessage, TextEditAgentRequest, TextSelectionIntentRequest};

pub(super) fn normalize_deepseek_messages(
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

pub(super) fn build_text_edit_messages(
    request: TextEditAgentRequest,
) -> Result<Vec<DeepSeekMessage>, String> {
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
            "你是文本修改助手。\n\n请根据用户要求生成需要新增的文本。\n\n用户要求：\n{instruction}\n\n只返回新增的文本，不要解释。不要使用 Markdown 代码围栏，除非用户明确要求。"
        )
    } else {
        format!(
            "你是文本修改助手。\n\n请根据用户要求修改选中文本。\n\n用户要求：\n{instruction}\n\n选中文本：\n<<<\n{}\n>>>\n\n只返回修改后的文本，不要解释。不要使用 Markdown 代码围栏，除非用户明确要求。",
            request.selected_text
        )
    };

    Ok(vec![DeepSeekMessage {
        role: "user".to_string(),
        content,
    }])
}

pub(super) fn build_text_selection_intent_messages(
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
        "你是 OfficeAgent 的意图分类器。用户正在文本文件中输入一条针对当前光标或选中文本的请求。\n\n请判断这条请求是：\n- edit：用户明确要求修改、替换、删除、插入、润色、重写、翻译、格式化或生成要写入文件的文本。\n- answer：用户只是提问、解释、总结、分析、询问含义、询问建议或让你判断文本内容，不应该修改文件。\n\n规则：\n1. 只输出一个英文单词：edit 或 answer。\n2. 不要解释。\n3. 如果用户说“帮我写”、“写一个/一条”、“生成”、“添加”、“插入”、“改成/转成/翻译成”，通常输出 edit。\n4. 如果用户要求“同样功能的 Linux 命令”、“等价 shell/bash 命令”并且当前是文本文件上下文，输出 edit。\n5. 如果意图仍不明确，输出 answer，避免误改文件。\n\n文件路径：{file_path}\n文件名：{filename}\n用户请求：\n<<<\n{instruction}\n>>>\n当前选中文本：\n<<<\n{selected_text}\n>>>"
    );

    Ok(vec![DeepSeekMessage {
        role: "user".to_string(),
        content,
    }])
}

pub(super) fn extract_deepseek_message_content(body: &str) -> Result<String, String> {
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

pub(super) fn parse_text_selection_intent(content: &str) -> &'static str {
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
