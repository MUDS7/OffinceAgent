#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct DeepSeekMessage {
    pub(super) role: String,
    pub(super) content: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextEditAgentRequest {
    pub(super) file_path: String,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) selected_text: String,
    pub(super) file_context: Option<String>,
    #[serde(default)]
    pub(super) is_full_document: bool,
    pub(super) instruction: String,
    pub(super) operation: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextSelectionIntentRequest {
    pub(super) file_path: String,
    pub(super) filename: String,
    pub(super) selected_text: String,
    pub(super) file_context: Option<String>,
    pub(super) instruction: String,
}

#[derive(serde::Serialize)]
pub(crate) struct TextSelectionIntentResult {
    pub(super) intent: &'static str,
}

#[derive(serde::Serialize)]
pub(super) struct DeepSeekChatRequest {
    pub(super) model: String,
    pub(super) messages: Vec<DeepSeekMessage>,
    pub(super) stream: bool,
}

#[derive(Clone, serde::Serialize)]
pub(super) struct DeepSeekStreamEvent {
    pub(super) stream_id: String,
    pub(super) kind: &'static str,
    pub(super) content: Option<String>,
    pub(super) error: Option<String>,
}

#[derive(serde::Deserialize)]
pub(super) struct DeepSeekStreamChunk {
    pub(super) choices: Vec<DeepSeekStreamChoice>,
}

#[derive(serde::Deserialize)]
pub(super) struct DeepSeekStreamChoice {
    pub(super) delta: DeepSeekStreamDelta,
}

#[derive(serde::Deserialize)]
pub(super) struct DeepSeekStreamDelta {
    pub(super) content: Option<String>,
    #[serde(rename = "reasoning_content")]
    pub(super) reasoning_content: Option<String>,
}
