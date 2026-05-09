use super::types::{DeepSeekMessage, TextEditAgentRequest, TextSelectionIntentRequest};

/// 将调用方传入的聊天消息整理成 DeepSeek 兼容的角色格式，并在发送前移除空消息。
pub(super) fn normalize_deepseek_messages(
    messages: Vec<DeepSeekMessage>,
) -> Result<Vec<DeepSeekMessage>, String> {
    let normalized = messages
        .into_iter()
        .filter_map(|message| {
            let role = message.role.trim().to_ascii_lowercase();
            let content = message.content.trim().to_string();

            // 空提示词会浪费 token，也可能让上游 API 拒绝原本有效的聊天请求。
            if content.is_empty() {
                return None;
            }

            // DeepSeek 只接受标准聊天角色；未知角色按用户输入处理，避免调用方传错值导致编辑中断。
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

/// 在意图分类器判定替换或插入之后，构造真正执行文本编辑的提示词。
pub(super) fn build_text_edit_messages(
    request: TextEditAgentRequest,
) -> Result<Vec<DeepSeekMessage>, String> {
    let file_path = request.file_path.trim();
    let instruction = request.instruction.trim();
    let operation = normalize_text_edit_operation(&request.operation);
    let file_context = request.file_context.as_deref().unwrap_or("").trim();
    let content_encoding =
        normalize_text_edit_content_encoding(request.content_encoding.as_deref());
    let compression_note = build_text_edit_compression_note(content_encoding, operation);

    if file_path.is_empty() {
        return Err("Text edit agent requires filePath".to_string());
    }

    if request.start > request.end {
        return Err("Text edit agent start cannot be greater than end".to_string());
    }

    if instruction.is_empty() {
        return Err("Text edit agent requires instruction".to_string());
    }

    let selected_text_is_empty = request.selected_text.trim().is_empty();
    let action = operation;
    // 只有编辑器没有选中文本时才附带全文上下文；否则选区本身就是最安全的编辑目标。
    let file_context_section = match (selected_text_is_empty, file_context.is_empty()) {
        (true, false) => {
            format!(
                "\nCompressed full file context:\n<<<\n{}\n>>>",
                truncate_model_context(file_context, 12_000, "file context")
            )
        }
        _ => String::new(),
    };
    // 执行器的响应会按标签解析，因此系统消息要约束模型只输出需要写入文件的内容。
    let system_content = format!("{}{}", "You are OfficeAgent's text edit executor. The intent/planning step has already finished in a separate model call. Your only job now is to produce the exact file-edit payload. Never explain your reasoning, never mention the classifier, and never describe the operation. Put the exact text to write between <officeagent_edit> and </officeagent_edit>. Text outside those tags will be ignored.", compression_note);
    let content = match (operation, request.is_full_document, selected_text_is_empty) {
        ("insert_after_selection", _, _) => format!(
            "Operation: {action}\n\nGenerate the text that should be inserted below the selected text or below the current cursor line. If there is no selected text, use the compressed full file context when it is provided.\n\nRules:\n1. Keep the original selected text unchanged; do not repeat it in the payload.\n2. For requests like \"same function Linux command\", \"equivalent shell/bash command\", or \"相同功能的 linux 命令\", output only the equivalent Linux command text to insert below the selection.\n3. Do not include explanations such as \"considering\", \"because\", \"here is\", \"the command is\", or any notes.\n4. Do not use Markdown fences unless the fences themselves should be written into the file.\n5. Put the exact inserted text inside the edit tags.\n\nRequired output shape:\n<officeagent_edit>\ntext to insert\n</officeagent_edit>\n\nFile path: {file_path}{file_context_section}\nUser request:\n<<<\n{instruction}\n>>>\nCurrent selected text:\n<<<\n{}\n>>>",
            request.selected_text
        ),
        (_, true, _) => format!(
            "Operation: replace_full_document\n\nGenerate the exact complete file content that should replace the current file.\n\nRules:\n1. Return the full updated file, not a patch, explanation, or partial fragment.\n2. Preserve unrelated content unless the user explicitly asks to change it.\n3. If this is a JSON file, output valid JSON for the complete document.\n4. Do not explain or include notes.\n5. Do not use Markdown fences unless the fences themselves should be written into the file.\n6. Put the exact replacement text inside the edit tags.\n\nRequired output shape:\n<officeagent_edit>\ncomplete updated file content\n</officeagent_edit>\n\nFile path: {file_path}\nUser request:\n<<<\n{instruction}\n>>>\nCurrent full file content:\n<<<\n{}\n>>>",
            request.selected_text
        ),
        (_, _, true) => format!(
            "Operation: {action}\n\nThe user has no selected text. Generate the exact text that should be inserted below the current cursor line. Use the compressed full file context when it is provided, but output only the new text to insert.\n\nRules:\n1. Do not explain.\n2. Do not use Markdown fences unless the fences themselves should be written into the file.\n3. Put the exact new text inside the edit tags.\n\nRequired output shape:\n<officeagent_edit>\ntext to insert\n</officeagent_edit>\n\nFile path: {file_path}{file_context_section}\nUser request:\n<<<\n{instruction}\n>>>"
        ),
        _ => format!(
            "Operation: {action}\n\nGenerate the exact text that should replace the current selection.\n\nRules:\n1. Return the replacement only; do not repeat unrelated surrounding content.\n2. If the user wants to delete the selected text, leave the edit tags empty.\n3. Do not explain or include notes.\n4. Do not use Markdown fences unless the fences themselves should be written into the file.\n5. Put the exact replacement text inside the edit tags.\n\nRequired output shape:\n<officeagent_edit>\nreplacement text\n</officeagent_edit>\n\nFile path: {file_path}\nUser request:\n<<<\n{instruction}\n>>>\nCurrent selected text:\n<<<\n{}\n>>>",
            request.selected_text
        ),
    };

    Ok(vec![
        DeepSeekMessage {
            role: "system".to_string(),
            content: system_content,
        },
        DeepSeekMessage {
            role: "user".to_string(),
            content,
        },
    ])
}

/// 在修改任何文件内容前，构造轻量级规划提示词，用于分类用户请求。
pub(super) fn build_text_selection_intent_messages(
    request: TextSelectionIntentRequest,
) -> Result<Vec<DeepSeekMessage>, String> {
    let file_path = request.file_path.trim();
    let filename = request.filename.trim();
    let instruction = request.instruction.trim();
    let raw_file_context = request.file_context.as_deref().unwrap_or("").trim();
    let file_type = classify_text_file_type(filename);

    if file_path.is_empty() {
        return Err("Text selection intent classifier requires filePath".to_string());
    }

    if instruction.is_empty() {
        return Err("Text selection intent classifier requires instruction".to_string());
    }

    let selected_text = truncate_intent_selection_context(request.selected_text.trim());
    // 没有显式选区时，给分类器一份压缩后的文件快照，帮助它区分插入、替换和仅回答。
    let file_context_section =
        if request.selected_text.trim().is_empty() && !raw_file_context.is_empty() {
            format!(
                "\nCompressed full file context:\n<<<\n{}\n>>>",
                truncate_model_context(raw_file_context, 12_000, "file context")
            )
        } else {
            String::new()
        };
    let content = format!(
        "Current open file:\nFilename: {filename}\nFile path: {file_path}\nFile type: {file_type}\nSelection state: {selection_state}\n\nYou are OfficeAgent's file-edit intent classifier. This is the planning step only; a second model call will execute the edit later. The user is typing a request while this file is open, possibly with selected text or a cursor position.\n\nChoose exactly one action:\n- answer_only: The user only asks a question, requests an explanation/summary/analysis/advice, or asks you to judge content. Do not modify the file.\n- replace_selection: The user clearly wants to rewrite, replace, polish, translate, format, delete, or otherwise transform the current selected text. Deleting selected text is replace_selection; the editor will replace the selection with empty content.\n- insert_after_selection: The user clearly wants to add, insert, append, supplement, or generate new content after the current selection or cursor, rather than replacing selected text.\n- ask_confirm: The user may want to modify the file, but the target position, replace-vs-insert choice, deletion range, or written content is unclear enough that editing directly is risky.\n\nRules:\n1. Output only one action name: answer_only, replace_selection, insert_after_selection, or ask_confirm.\n2. Do not explain. Do not output JSON.\n3. The filename and file type above are authoritative context for the user's intent.\n4. Judge from the user request, the current selected text, and the compressed full file context when no text is selected.\n5. If the current filename ends with .json, no text is selected, and the user clearly asks to modify/update/set/configure/add/remove data in the JSON file, choose replace_selection. The app will replace the full JSON document in the next step.\n6. If selected text exists and the user asks for a same-function/equivalent Linux, shell, bash, PowerShell, or command-line command, choose insert_after_selection because the original selection should remain and the new command should be added below it.\n7. If there is no selected text and the user clearly asks to add/insert/append/generate content, usually choose insert_after_selection.\n8. If there is no selected text and the user asks to replace/delete/rewrite 'this', 'here', or 'the selected content' with an unclear range, choose ask_confirm, except for the .json full-document edit case above.\n9. If the user asks 'what does this mean', 'analyze this', 'give advice', or 'is this correct', choose answer_only.\n{file_context_section}\n\nUser request:\n<<<\n{instruction}\n>>>\nCurrent selected text:\n<<<\n{selected_text}\n>>>",
        selection_state = if selected_text.trim().is_empty() {
            "none; cursor-only or whole-file context"
        } else {
            "selected text is present"
        }
    );

    Ok(vec![DeepSeekMessage {
        role: "user".to_string(),
        content,
    }])
}

/// 从 DeepSeek 聊天响应中提取第一个非空文本内容。
pub(super) fn extract_deepseek_message_content(body: &str) -> Result<String, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|error| format!("invalid JSON: {error}"))?;

    let choices = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .ok_or_else(|| "missing choices array".to_string())?;

    for choice in choices {
        // 标准聊天补全会把可见回答放在 message.content 中。
        if let Some(content) = choice
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(value_to_text)
            .map(str::trim)
            .filter(|content| !content.is_empty())
        {
            return Ok(content.to_string());
        }

        // 部分推理模型可能返回 reasoning_content；这里作为兜底读取，保证调用方仍能拿到文本。
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

/// 从预期为文本的 JSON 字段中取出字符串值。
fn value_to_text(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::String(text) => Some(text.as_str()),
        _ => None,
    }
}

/// 将选中文本限制在适合意图分类提示词的长度内。
fn truncate_intent_selection_context(text: &str) -> String {
    const MAX_INTENT_SELECTION_CHARS: usize = 4000;

    truncate_model_context(text, MAX_INTENT_SELECTION_CHARS, "selection")
}

/// 将文件名映射为粗粒度文本类型，帮助意图分类器更安全地判断替换或插入。
fn classify_text_file_type(filename: &str) -> &'static str {
    let filename = filename.trim().to_ascii_lowercase();

    match filename.rsplit_once('.') {
        Some((_, "json")) => "JSON",
        Some((_, "md" | "markdown")) => "Markdown",
        Some((_, "csv")) => "CSV",
        Some((_, "js" | "jsx" | "ts" | "tsx")) => "source code",
        Some((_, "html" | "css" | "xml" | "yaml" | "yml")) => "structured text",
        _ => "plain text",
    }
}

/// 按 Unicode 标量值截断提示词上下文，并在内容被截短时追加标记。
fn truncate_model_context(text: &str, max_chars: usize, label: &str) -> String {
    let truncated = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        format!("{truncated}\n...[{label} truncated]")
    } else {
        truncated
    }
}

/// 将分类器响应解析为已知意图动作，并兼容旧提示词格式和带引号的模型输出。
pub(super) fn parse_text_selection_intent(content: &str) -> &'static str {
    let normalized = content.trim().to_ascii_lowercase();

    for intent in [
        "insert_after_selection",
        "replace_selection",
        "ask_confirm",
        "answer_only",
    ] {
        if matches_model_action(&normalized, intent) {
            return intent;
        }
    }

    if matches_model_action(&normalized, "edit") || content.trim().starts_with("编辑") {
        return "replace_selection";
    }

    if matches_model_action(&normalized, "answer") {
        return "answer_only";
    }

    "answer_only"
}

/// 判断模型输出是否命中了指定动作名，并兼容带引号或带前缀说明的回答。
fn matches_model_action(normalized: &str, action: &str) -> bool {
    normalized == action
        || normalized.starts_with(action)
        || normalized.contains(&format!("\"{action}\""))
        || normalized.contains(&format!("'{action}'"))
}

/// 将未知编辑操作归一化为默认的替换行为。
fn normalize_text_edit_operation(operation: &str) -> &'static str {
    match operation.trim().to_ascii_lowercase().as_str() {
        "insert_after_selection" => "insert_after_selection",
        _ => "replace_selection",
    }
}

/// 识别发送给模型前应用过的内容编码，以便提示词说明如何保留或还原空白字符。
fn normalize_text_edit_content_encoding(encoding: Option<&str>) -> Option<&'static str> {
    match encoding
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("json_minified") => Some("json_minified"),
        Some("text_whitespace_compacted") => Some("text_whitespace_compacted"),
        _ => None,
    }
}

/// 当上下文在传输前被压缩时，追加面向模型的处理说明。
fn build_text_edit_compression_note(
    encoding: Option<&'static str>,
    operation: &'static str,
) -> &'static str {
    match (encoding, operation) {
        (Some("json_minified"), "insert_after_selection") => {
            " Whitespace transmission note: the current JSON context was minified before being sent to you. Use it only as context; return the new inserted text in normal file form."
        }
        (Some("json_minified"), _) => {
            " Whitespace transmission note: the current JSON content was minified before being sent to you. Return the edited JSON in the same minified representation; the app will restore the user's formatting after your response."
        }
        (Some("text_whitespace_compacted"), "insert_after_selection") => {
            " Whitespace transmission note: runs of spaces, tabs, and line breaks in the current TXT context were compacted before being sent to you. Use it only as context; return the new inserted text in normal file form."
        }
        (Some("text_whitespace_compacted"), _) => {
            " Whitespace transmission note: runs of spaces, tabs, and line breaks in the current TXT content were compacted before being sent to you. Return the edited content in the same compacted representation; the app will restore whitespace after your response."
        }
        _ => "",
    }
}
