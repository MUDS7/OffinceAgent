use std::{
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, State};

// 子模块：document_index — 文档结构化解析；sqlite_store — FTS5 全文索引；qdrant — 嵌入式向量数据库
mod document_index;
mod qdrant;
mod sqlite_store;

/// 文档存储的核心状态，同时持有 SQLite（文档索引+全文搜索）和嵌入式 Qdrant（向量搜索）两份连接。
/// 每个字段都用 Mutex 包裹，使 Tauri 的各个 command 可以通过 `State` 并发访问。
pub(crate) struct DocumentStore {
    /// SQLite 连接，用于文档结构化索引和全文搜索（FTS5）
    connection: Mutex<Connection>,
    /// 当前 SQLite 数据库文件的路径
    sqlite_path: Mutex<PathBuf>,
    /// 嵌入式 Qdrant 连接，用于向量存储与语义搜索
    qdrant_connection: Mutex<Connection>,
    /// 当前 Qdrant 数据库文件的路径
    qdrant_path: Mutex<PathBuf>,
    /// 当前打开的工作区根目录，None 表示尚未打开任何工作区
    workspace_path: Mutex<Option<PathBuf>>,
    /// 工作区数据目录（默认为工作区下的 .data 目录）
    workspace_data_path: Mutex<PathBuf>,
}

/// 打开工作区后返回给前端的信息，告知数据持久化的各个路径。
#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceStorageInfo {
    workspace_path: String,
    data_path: String,
    sqlite_path: String,
    qdrant_path: String,
    created_data_dir: bool,
}

/// 应用启动时初始化默认存储。创建 SQLite 和 Qdrant 连接，并将 `DocumentStore` 注入 Tauri 状态管理。
pub(crate) fn setup_storage(app: &mut tauri::App) -> Result<(), String> {
    let db_path = sqlite_store::sqlite_db_path(app)?;
    let connection = open_sqlite_connection(&db_path)?;

    let qdrant_path = qdrant::qdrant_db_path(app)?;
    let qdrant_connection = open_qdrant_connection(&qdrant_path)?;
    let workspace_data_path = db_path
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| db_path.parent().map(PathBuf::from).unwrap_or_default());

    app.manage(DocumentStore {
        connection: Mutex::new(connection),
        sqlite_path: Mutex::new(db_path),
        qdrant_connection: Mutex::new(qdrant_connection),
        qdrant_path: Mutex::new(qdrant_path),
        workspace_path: Mutex::new(None),
        workspace_data_path: Mutex::new(workspace_data_path),
    });
    Ok(())
}

/// 打开（或切换）工作区存储。根据传入的路径创建`.data`目录结构，并替换 `DocumentStore` 中的全部连接和路径。
#[tauri::command]
pub(crate) fn open_workspace_storage(
    state: State<'_, DocumentStore>,
    path: String,
) -> Result<WorkspaceStorageInfo, String> {
    let workspace_path = normalize_workspace_path(path)?;
    let data_path = workspace_path.join(".data");
    let created_data_dir = !data_path.exists();
    let sqlite_path = workspace_sqlite_path(&data_path);
    let qdrant_path = workspace_qdrant_path(&data_path);

    let connection = open_sqlite_connection(&sqlite_path)?;
    let qdrant_connection = open_qdrant_connection(&qdrant_path)?;

    *state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())? = connection;
    *state
        .sqlite_path
        .lock()
        .map_err(|_| "SQLite path lock is poisoned".to_string())? = sqlite_path.clone();
    *state
        .qdrant_connection
        .lock()
        .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())? = qdrant_connection;
    *state
        .qdrant_path
        .lock()
        .map_err(|_| "embedded Qdrant path lock is poisoned".to_string())? = qdrant_path.clone();
    *state
        .workspace_path
        .lock()
        .map_err(|_| "workspace path lock is poisoned".to_string())? = Some(workspace_path.clone());
    *state
        .workspace_data_path
        .lock()
        .map_err(|_| "workspace data path lock is poisoned".to_string())? = data_path.clone();

    Ok(WorkspaceStorageInfo {
        workspace_path: workspace_path.display().to_string(),
        data_path: data_path.display().to_string(),
        sqlite_path: sqlite_path.display().to_string(),
        qdrant_path: qdrant_path.display().to_string(),
        created_data_dir,
    })
}

/// 解析文档结构（段落、标题、表格等），生成结构化索引存入 SQLite。
#[tauri::command]
pub(crate) fn index_document_structure(
    state: State<'_, DocumentStore>,
    request: sqlite_store::DocumentIndexRequest,
) -> Result<sqlite_store::DocumentIndexResult, String> {
    sqlite_store::index_document_structure(state, request)
}

/// 全文搜索文档内容（基于 SQLite FTS5）。
#[tauri::command]
pub(crate) fn search_document_full_text(
    state: State<'_, DocumentStore>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<sqlite_store::FullTextSearchHit>, String> {
    sqlite_store::search_document_full_text(state, query, limit)
}

/// 获取 Qdrant 向量数据库的运行状态（collection 数量等信息）。
#[tauri::command]
pub(crate) async fn get_qdrant_status(
    state: State<'_, DocumentStore>,
) -> Result<qdrant::QdrantStatus, String> {
    qdrant::get_qdrant_status(state).await
}

/// 确保 Qdrant collection 存在，不存在则自动创建。
#[tauri::command]
pub(crate) async fn ensure_qdrant_collection(
    state: State<'_, DocumentStore>,
    request: qdrant::QdrantCollectionRequest,
) -> Result<qdrant::QdrantStatus, String> {
    qdrant::ensure_qdrant_collection(state, request).await
}

/// 插入或更新文档级别的向量。
#[tauri::command]
pub(crate) async fn upsert_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: qdrant::QdrantUpsertRequest,
) -> Result<qdrant::QdrantUpsertResult, String> {
    qdrant::upsert_qdrant_vectors(state, request).await
}

/// 插入或更新文档分块级别的向量（语义分块后的段落/片段）。
#[tauri::command]
pub(crate) async fn upsert_qdrant_chunk_vectors(
    state: State<'_, DocumentStore>,
    request: qdrant::QdrantChunkUpsertRequest,
) -> Result<qdrant::QdrantUpsertResult, String> {
    qdrant::upsert_qdrant_chunk_vectors(state, request).await
}

/// 在 Qdrant 中执行向量语义搜索（基于嵌入向量的相似度匹配）。
#[tauri::command]
pub(crate) async fn search_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: qdrant::QdrantSearchRequest,
) -> Result<serde_json::Value, String> {
    qdrant::search_qdrant_vectors(state, request).await
}

/// 当前 Unix 时间戳（秒），用于给索引记录打时间标记。
pub(super) fn unix_timestamp_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

/// 校验并规范化工作区路径：去除空白、解析为绝对路径、确保路径指向已存在的目录。
fn normalize_workspace_path(path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() {
        return Err("workspace path is empty".to_string());
    }

    let path = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve workspace path {}: {error}", path.display()))?;
    if !path.is_dir() {
        return Err(format!(
            "workspace path is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

/// 工作区内的 SQLite 数据库路径：`<data_path>/sqlite/office-agent.sqlite3`。
fn workspace_sqlite_path(data_path: &std::path::Path) -> PathBuf {
    data_path.join("sqlite").join("office-agent.sqlite3")
}

/// 工作区内的 Qdrant 数据库路径：`<data_path>/qdrant/office-agent-qdrant.sqlite3`。
fn workspace_qdrant_path(data_path: &std::path::Path) -> PathBuf {
    data_path.join("qdrant").join("office-agent-qdrant.sqlite3")
}

/// 打开 SQLite 连接，必要时自动创建父目录并执行数据库迁移。
fn open_sqlite_connection(db_path: &std::path::Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "cannot create SQLite database directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let connection = Connection::open(db_path)
        .map_err(|error| format!("cannot open SQLite database {}: {error}", db_path.display()))?;
    sqlite_store::migrate_sqlite(&connection)?;
    Ok(connection)
}

/// 打开嵌入式 Qdrant 连接，必要时自动创建父目录并执行数据库迁移。
fn open_qdrant_connection(db_path: &std::path::Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "cannot create embedded Qdrant directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let connection = Connection::open(db_path).map_err(|error| {
        format!(
            "cannot open embedded Qdrant store {}: {error}",
            db_path.display()
        )
    })?;
    qdrant::migrate_qdrant(&connection)?;
    Ok(connection)
}
