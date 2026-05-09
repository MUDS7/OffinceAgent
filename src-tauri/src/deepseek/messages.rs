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

    let action = if operation == "insert_after_selection" {
        "insert_after_selection"
    } else {
        "replace_selection"
    };
    let file_context_section =
        if request.selected_text.trim().is_empty() && !file_context.is_empty() {
            format!(
                "\nCompressed full file context:\n<<<\n{}\n>>>",
                truncate_model_context(file_context, 12_000, "file context")
            )
        } else {
            String::new()
        };
    let system_content = format!("{}{}", "You are OfficeAgent's text edit executor. The intent/planning step has already finished in a separate model call. Your only job now is to produce the exact file-edit payload. Never explain your reasoning, never mention the classifier, and never describe the operation. Put the exact text to write between <officeagent_edit> and </officeagent_edit>. Text outside those tags will be ignored.", compression_note);
    let content = if operation == "insert_after_selection" {
        format!(
            "Operation: {action}\n\nGenerate the text that should be inserted below the selected text or below the current cursor line. If there is no selected text, use the compressed full file context when it is provided.\n\nRules:\n1. Keep the original selected text unchanged; do not repeat it in the payload.\n2. For requests like \"same function Linux command\", \"equivalent shell/bash command\", or \"相同功能的 linux 命令\", output only the equivalent Linux command text to insert below the selection.\n3. Do not include explanations such as \"considering\", \"because\", \"here is\", \"the command is\", or any notes.\n4. Do not use Markdown fences unless the fences themselves should be written into the file.\n5. Put the exact inserted text inside the edit tags.\n\nRequired output shape:\n<officeagent_edit>\ntext to insert\n</officeagent_edit>\n\nFile path: {file_path}{file_context_section}\nUser request:\n<<<\n{instruction}\n>>>\nCurrent selected text:\n<<<\n{}\n>>>",
            request.selected_text
        )
    } else if request.is_full_document {
        format!(
            "Operation: replace_full_document\n\nGenerate the exact complete file content that should replace the current file.\n\nRules:\n1. Return the full updated file, not a patch, explanation, or partial fragment.\n2. Preserve unrelated content unless the user explicitly asks to change it.\n3. If this is a JSON file, output valid JSON for the complete document.\n4. Do not explain or include notes.\n5. Do not use Markdown fences unless the fences themselves should be written into the file.\n6. Put the exact replacement text inside the edit tags.\n\nRequired output shape:\n<officeagent_edit>\ncomplete updated file content\n</officeagent_edit>\n\nFile path: {file_path}\nUser request:\n<<<\n{instruction}\n>>>\nCurrent full file content:\n<<<\n{}\n>>>",
            request.selected_text
        )
    } else if request.selected_text.trim().is_empty() {
        format!(
            "Operation: {action}\n\nThe user has no selected text. Generate the exact text that should be inserted below the current cursor line. Use the compressed full file context when it is provided, but output only the new text to insert.\n\nRules:\n1. Do not explain.\n2. Do not use Markdown fences unless the fences themselves should be written into the file.\n3. Put the exact new text inside the edit tags.\n\nRequired output shape:\n<officeagent_edit>\ntext to insert\n</officeagent_edit>\n\nFile path: {file_path}{file_context_section}\nUser request:\n<<<\n{instruction}\n>>>"
        )
    } else {
        format!(
            "Operation: {action}\n\nGenerate the exact text that should replace the current selection.\n\nRules:\n1. Return the replacement only; do not repeat unrelated surrounding content.\n2. If the user wants to delete the selected text, leave the edit tags empty.\n3. Do not explain or include notes.\n4. Do not use Markdown fences unless the fences themselves should be written into the file.\n5. Put the exact replacement text inside the edit tags.\n\nRequired output shape:\n<officeagent_edit>\nreplacement text\n</officeagent_edit>\n\nFile path: {file_path}\nUser request:\n<<<\n{instruction}\n>>>\nCurrent selected text:\n<<<\n{}\n>>>",
            request.selected_text
        )
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

pub(super) fn build_text_selection_intent_messages(
    request: TextSelectionIntentRequest,
) -> Result<Vec<DeepSeekMessage>, String> {
    let file_path = request.file_path.trim();
    let filename = request.filename.trim();
    let instruction = request.instruction.trim();
    let raw_file_context = request.file_context.as_deref().unwrap_or("").trim();

    if file_path.is_empty() {
        return Err("Text selection intent classifier requires filePath".to_string());
    }

    if instruction.is_empty() {
        return Err("Text selection intent classifier requires instruction".to_string());
    }

    let selected_text = truncate_intent_selection_context(request.selected_text.trim());
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
        "You are OfficeAgent's file-edit intent classifier. This is the planning step only; a second model call will execute the edit later. The user is typing a request while a text file is open, possibly with selected text or a cursor position.\n\nChoose exactly one action:\n- answer_only: The user only asks a question, requests an explanation/summary/analysis/advice, or asks you to judge content. Do not modify the file.\n- replace_selection: The user clearly wants to rewrite, replace, polish, translate, format, delete, or otherwise transform the current selected text. Deleting selected text is replace_selection; the editor will replace the selection with empty content.\n- insert_after_selection: The user clearly wants to add, insert, append, supplement, or generate new content after the current selection or cursor, rather than replacing selected text.\n- ask_confirm: The user may want to modify the file, but the target position, replace-vs-insert choice, deletion range, or written content is unclear enough that editing directly is risky.\n\nRules:\n1. Output only one action name: answer_only, replace_selection, insert_after_selection, or ask_confirm.\n2. Do not explain. Do not output JSON.\n3. Judge from the user request, the current selected text, and the compressed full file context when no text is selected.\n4. If selected text exists and the user asks for a same-function/equivalent Linux, shell, bash, PowerShell, or command-line command, choose insert_after_selection because the original selection should remain and the new command should be added below it.\n5. If there is no selected text and the user clearly asks to add/insert/append/generate content, usually choose insert_after_selection.\n6. If there is no selected text and the user asks to replace/delete/rewrite 'this', 'here', or 'the selected content' with an unclear range, choose ask_confirm.\n7. If the user asks 'what does this mean', 'analyze this', 'give advice', or 'is this correct', choose answer_only.\n\nFile path: {file_path}\nFilename: {filename}{file_context_section}\nUser request:\n<<<\n{instruction}\n>>>\nCurrent selected text:\n<<<\n{selected_text}\n>>>"
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

    truncate_model_context(text, MAX_INTENT_SELECTION_CHARS, "selection")
}

fn truncate_model_context(text: &str, max_chars: usize, label: &str) -> String {
    let truncated = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        format!("{truncated}\n...[{label} truncated]")
    } else {
        truncated
    }
}

pub(super) fn parse_text_selection_intent(content: &str) -> &'static str {
    let normalized = content.trim().to_ascii_lowercase();

    for intent in [
        "insert_after_selection",
        "replace_selection",
        "ask_confirm",
        "answer_only",
    ] {
        if normalized == intent
            || normalized.starts_with(intent)
            || normalized.contains(&format!("\"{intent}\""))
            || normalized.contains(&format!("'{intent}'"))
        {
            return intent;
        }
    }

    if normalized == "edit"
        || normalized.starts_with("edit")
        || normalized.contains("\"edit\"")
        || normalized.contains("'edit'")
        || content.trim().starts_with("编辑")
    {
        return "replace_selection";
    }

    if normalized == "answer"
        || normalized.starts_with("answer")
        || normalized.contains("\"answer\"")
        || normalized.contains("'answer'")
    {
        return "answer_only";
    }

    "answer_only"
}

fn normalize_text_edit_operation(operation: &str) -> &'static str {
    match operation.trim().to_ascii_lowercase().as_str() {
        "insert_after_selection" => "insert_after_selection",
        _ => "replace_selection",
    }
}

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
