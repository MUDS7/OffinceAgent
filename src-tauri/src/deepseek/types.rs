/// DeepSeek 聊天接口使用的单条消息。
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct DeepSeekMessage {
    /// 消息角色，最终会归一化为 `system`、`user` 或 `assistant`。
    pub(super) role: String,
    /// 消息文本内容。
    pub(super) content: String,
}

/// 前端发起文本编辑执行阶段时传入的上下文。
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextEditAgentRequest {
    /// 当前文件路径，用于提示词说明编辑目标。
    pub(super) file_path: String,
    /// 选区起点偏移。
    pub(super) start: usize,
    /// 选区终点偏移。
    pub(super) end: usize,
    /// 当前选中文本；全文替换时也会承载完整文件内容。
    pub(super) selected_text: String,
    /// 可选的压缩全文上下文，帮助模型在无选区时判断插入位置和风格。
    pub(super) file_context: Option<String>,
    pub(super) uploaded_document_context: Option<String>,
    #[serde(default)]
    /// 是否要求模型返回完整文件内容。
    pub(super) is_full_document: bool,
    /// 前端对文本做过的传输前压缩编码类型。
    pub(super) content_encoding: Option<String>,
    /// 用户自然语言编辑指令。
    pub(super) instruction: String,
    /// 意图分类阶段给出的编辑动作。
    pub(super) operation: String,
}

/// 前端发起文本编辑意图分类时传入的上下文。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextSelectionIntentRequest {
    /// 当前文件完整路径。
    pub(super) file_path: String,
    /// 当前文件名，用于粗略判断文本类型。
    pub(super) filename: String,
    /// 当前选中文本；没有选区时为空。
    pub(super) selected_text: String,
    /// 可选的压缩全文上下文。
    pub(super) file_context: Option<String>,
    /// 用户自然语言请求。
    pub(super) instruction: String,
}

/// 文本编辑意图分类结果。
#[derive(serde::Serialize)]
pub(crate) struct TextSelectionIntentResult {
    /// 归一化后的动作名，例如 `answer_only` 或 `replace_selection`。
    pub(super) intent: &'static str,
}

/// DeepSeek `/chat/completions` 请求体。
#[derive(serde::Serialize)]
pub(super) struct DeepSeekChatRequest {
    /// 请求使用的模型名。
    pub(super) model: String,
    /// 发送给模型的消息列表。
    pub(super) messages: Vec<DeepSeekMessage>,
    /// 是否启用 SSE 流式响应。
    pub(super) stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// 部分推理模型支持的推理强度参数。
    pub(super) reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// DeepSeek v4 pro 等模型使用的思考开关。
    pub(super) thinking: Option<DeepSeekThinking>,
}

/// DeepSeek 思考模式配置。
#[derive(serde::Serialize)]
pub(super) struct DeepSeekThinking {
    #[serde(rename = "type")]
    /// API 要求字段名为 `type`，Rust 中使用 `kind` 避免关键字冲突。
    pub(super) kind: String,
}

/// 后端转发给前端的流式事件。
#[derive(Clone, serde::Serialize)]
pub(super) struct DeepSeekStreamEvent {
    /// 前端生成的流 ID，用于区分并发请求。
    pub(super) stream_id: String,
    /// 事件类型：`start`、`reasoning`、`delta`、`done` 或错误类型。
    pub(super) kind: &'static str,
    /// 当前事件携带的文本增量。
    pub(super) content: Option<String>,
    /// 当前事件携带的错误信息。
    pub(super) error: Option<String>,
}

/// DeepSeek SSE 单行 `data:` 中的 JSON 分片。
#[derive(serde::Deserialize)]
pub(super) struct DeepSeekStreamChunk {
    /// API 可能返回多个候选增量。
    pub(super) choices: Vec<DeepSeekStreamChoice>,
}

/// 单个候选的流式增量包装。
#[derive(serde::Deserialize)]
pub(super) struct DeepSeekStreamChoice {
    /// 本次流式响应新增内容。
    pub(super) delta: DeepSeekStreamDelta,
}

/// DeepSeek 流式增量内容。
#[derive(serde::Deserialize)]
pub(super) struct DeepSeekStreamDelta {
    /// 普通回复内容。
    pub(super) content: Option<String>,
    #[serde(rename = "reasoning_content")]
    /// 推理模型可能单独返回的思考过程内容。
    pub(super) reasoning_content: Option<String>,
}
