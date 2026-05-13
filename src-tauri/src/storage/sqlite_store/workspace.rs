use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use rusqlite::{params, Connection};
use tauri::State;

use super::super::{unix_timestamp_seconds, DocumentStore};
use super::{
    WorkspaceFileMetadataRecord, WorkspaceFileMetadataRequest, WorkspaceFileMetadataResult,
    WorkspaceFilesMetadataResult, WorkspaceSnapshotResult, WorkspaceTreeNodeRecord,
};
pub(crate) fn save_workspace_file_metadata(
    state: State<'_, DocumentStore>,
    request: WorkspaceFileMetadataRequest,
) -> Result<WorkspaceFileMetadataResult, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;
    save_workspace_file_metadata_with_connection(&connection, request)
}

pub(crate) fn index_workspace_files(
    state: State<'_, DocumentStore>,
    path: String,
) -> Result<WorkspaceFilesMetadataResult, String> {
    let workspace_path = normalize_workspace_scan_path(&path)?;
    let workspace_data_path = state
        .workspace_data_path
        .lock()
        .map_err(|_| "workspace data path lock is poisoned".to_string())?
        .clone();
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;

    index_workspace_files_with_connection(&mut connection, &workspace_path, &workspace_data_path)
}

pub(crate) fn load_workspace_snapshot(
    state: State<'_, DocumentStore>,
) -> Result<WorkspaceSnapshotResult, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;
    let files = load_workspace_file_records(&connection)?;
    let inferred_workspace_path = state
        .workspace_path
        .lock()
        .map_err(|_| "workspace path lock is poisoned".to_string())?
        .clone()
        .or_else(|| infer_workspace_path_from_records(&files));

    if let Some(workspace_path) = &inferred_workspace_path {
        ensure_workspace_tree_from_records(&connection, workspace_path, &files)?;
    }

    let tree_nodes = load_workspace_tree_nodes(&connection, inferred_workspace_path.as_deref())?;
    let workspace_name = inferred_workspace_path
        .as_ref()
        .and_then(|path| path.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| infer_workspace_name_from_records(&files))
        .unwrap_or_else(|| "workspace".to_string());

    Ok(WorkspaceSnapshotResult {
        workspace_path: inferred_workspace_path.map(|path| path.display().to_string()),
        workspace_name,
        files,
        tree_nodes,
    })
}

pub(super) fn save_workspace_file_metadata_with_connection(
    connection: &Connection,
    request: WorkspaceFileMetadataRequest,
) -> Result<WorkspaceFileMetadataResult, String> {
    upsert_workspace_file_metadata(connection, &request)?;
    if let Some(workspace_path) = infer_workspace_path_from_request(&request) {
        upsert_workspace_tree_for_file(connection, &workspace_path, &request)?;
    }

    Ok(WorkspaceFileMetadataResult {
        document_id: request.document_id,
        saved: true,
    })
}

pub(super) fn index_workspace_files_with_connection(
    connection: &mut Connection,
    workspace_path: &Path,
    workspace_data_path: &Path,
) -> Result<WorkspaceFilesMetadataResult, String> {
    let mut requests = Vec::new();
    let mut directory_paths = Vec::new();
    collect_workspace_file_metadata(
        workspace_path,
        workspace_path,
        workspace_data_path,
        &mut requests,
        &mut directory_paths,
    )?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("cannot start SQLite workspace metadata transaction: {error}"))?;
    rebuild_workspace_tree_nodes(&transaction, workspace_path, &directory_paths, &requests)?;
    for (index, request) in requests.iter().enumerate() {
        upsert_workspace_file_metadata(&transaction, request)?;
        upsert_workspace_tree_for_file_with_order(
            &transaction,
            workspace_path,
            request,
            index as i64,
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("cannot commit SQLite workspace metadata: {error}"))?;

    Ok(WorkspaceFilesMetadataResult {
        files_indexed: requests.len(),
    })
}

fn upsert_workspace_file_metadata(
    connection: &Connection,
    request: &WorkspaceFileMetadataRequest,
) -> Result<(), String> {
    let extension = request
        .extension
        .clone()
        .or_else(|| {
            request
                .filename
                .rsplit_once('.')
                .map(|(_, ext)| ext.to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());
    let file_type = request
        .file_type
        .clone()
        .unwrap_or_else(|| extension.clone());
    let disk_metadata = std::fs::metadata(&request.path).ok();
    let size_bytes = request
        .size_bytes
        .or_else(|| disk_metadata.as_ref().map(|metadata| metadata.len()));
    let modified_at = request.modified_at.or_else(|| {
        disk_metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
    });
    let now = unix_timestamp_seconds();

    connection
        .execute(
            "INSERT INTO documents (
                id, name, original_path, stored_path, file_type, size_bytes,
                parse_status, index_status, sha256, created_at, updated_at,
                path, filename, extension, indexed_at, relative_path, modified_at
             ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, 'pending', 'pending', NULL, ?6, ?6, ?3, ?2, ?7, ?6, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                original_path = excluded.original_path,
                stored_path = excluded.stored_path,
                file_type = excluded.file_type,
                size_bytes = excluded.size_bytes,
                updated_at = excluded.updated_at,
                path = excluded.path,
                filename = excluded.filename,
                extension = excluded.extension,
                relative_path = excluded.relative_path,
                modified_at = excluded.modified_at",
            params![
                request.document_id,
                request.filename,
                request.path,
                file_type,
                size_bytes.map(|size| size as i64),
                now,
                extension,
                request.relative_path,
                modified_at,
            ],
        )
        .map_err(|error| format!("cannot save workspace file metadata: {error}"))?;

    Ok(())
}

fn rebuild_workspace_tree_nodes(
    connection: &Connection,
    workspace_path: &Path,
    directory_paths: &[PathBuf],
    _files: &[WorkspaceFileMetadataRequest],
) -> Result<(), String> {
    let workspace_path_string = workspace_path.display().to_string();
    connection
        .execute(
            "DELETE FROM workspace_tree_nodes WHERE workspace_path = ?1",
            params![workspace_path_string],
        )
        .map_err(|error| format!("cannot clear workspace tree nodes: {error}"))?;

    let root_name = workspace_root_name(workspace_path);
    let root_relative_path = root_name.clone();
    let root_id = workspace_tree_node_id("root", &workspace_path_string, &root_relative_path);
    upsert_workspace_tree_node(
        connection,
        WorkspaceTreeNodeUpsert {
            id: root_id,
            parent_id: None,
            workspace_path: workspace_path_string.clone(),
            node_type: "root",
            name: root_name,
            relative_path: root_relative_path,
            document_id: None,
            order_index: 0,
            is_expanded: true,
        },
    )?;

    for (index, directory_path) in directory_paths.iter().enumerate() {
        let relative_path = build_workspace_relative_path(workspace_path, directory_path);
        upsert_workspace_folder_tree_path(
            connection,
            &workspace_path_string,
            &relative_path,
            index as i64,
        )?;
    }

    Ok(())
}

fn upsert_workspace_tree_for_file(
    connection: &Connection,
    workspace_path: &Path,
    request: &WorkspaceFileMetadataRequest,
) -> Result<(), String> {
    upsert_workspace_tree_for_file_with_order(connection, workspace_path, request, 0)
}

fn upsert_workspace_tree_for_file_with_order(
    connection: &Connection,
    workspace_path: &Path,
    request: &WorkspaceFileMetadataRequest,
    order_index: i64,
) -> Result<(), String> {
    let workspace_path_string = workspace_path.display().to_string();
    let relative_path = request
        .relative_path
        .clone()
        .unwrap_or_else(|| build_workspace_relative_path(workspace_path, Path::new(&request.path)));
    let parent_id = upsert_workspace_folder_tree_path(
        connection,
        &workspace_path_string,
        &parent_relative_path(&relative_path),
        order_index,
    )?;
    let file_id = workspace_tree_node_id("file", &workspace_path_string, &relative_path);

    upsert_workspace_tree_node(
        connection,
        WorkspaceTreeNodeUpsert {
            id: file_id,
            parent_id: Some(parent_id),
            workspace_path: workspace_path_string,
            node_type: "file",
            name: request.filename.clone(),
            relative_path,
            document_id: Some(request.document_id.clone()),
            order_index,
            is_expanded: true,
        },
    )
}

fn upsert_workspace_folder_tree_path(
    connection: &Connection,
    workspace_path: &str,
    relative_path: &str,
    order_index: i64,
) -> Result<String, String> {
    let parts = relative_path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        let root_id = workspace_tree_node_id("root", workspace_path, "workspace");
        return Ok(root_id);
    }

    let root_relative_path = parts[0].clone();
    let mut current_relative_path = root_relative_path.clone();
    let mut parent_id: Option<String> = None;
    let mut current_id = workspace_tree_node_id("root", workspace_path, &root_relative_path);

    upsert_workspace_tree_node(
        connection,
        WorkspaceTreeNodeUpsert {
            id: current_id.clone(),
            parent_id: None,
            workspace_path: workspace_path.to_string(),
            node_type: "root",
            name: root_relative_path,
            relative_path: current_relative_path.clone(),
            document_id: None,
            order_index: 0,
            is_expanded: true,
        },
    )?;

    for (depth, folder_name) in parts.iter().enumerate().skip(1) {
        current_relative_path = format!("{current_relative_path}/{folder_name}");
        let folder_id = workspace_tree_node_id("folder", workspace_path, &current_relative_path);
        upsert_workspace_tree_node(
            connection,
            WorkspaceTreeNodeUpsert {
                id: folder_id.clone(),
                parent_id: Some(current_id),
                workspace_path: workspace_path.to_string(),
                node_type: "folder",
                name: folder_name.clone(),
                relative_path: current_relative_path.clone(),
                document_id: None,
                order_index: order_index + depth as i64,
                is_expanded: true,
            },
        )?;
        parent_id = Some(folder_id.clone());
        current_id = folder_id;
    }

    Ok(parent_id.unwrap_or(current_id))
}

struct WorkspaceTreeNodeUpsert {
    id: String,
    parent_id: Option<String>,
    workspace_path: String,
    node_type: &'static str,
    name: String,
    relative_path: String,
    document_id: Option<String>,
    order_index: i64,
    is_expanded: bool,
}

fn upsert_workspace_tree_node(
    connection: &Connection,
    node: WorkspaceTreeNodeUpsert,
) -> Result<(), String> {
    let now = unix_timestamp_seconds();
    connection
        .execute(
            "INSERT INTO workspace_tree_nodes (
                id, parent_id, workspace_path, node_type, name, relative_path,
                document_id, order_index, is_expanded, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(id) DO UPDATE SET
                parent_id = excluded.parent_id,
                workspace_path = excluded.workspace_path,
                node_type = excluded.node_type,
                name = excluded.name,
                relative_path = excluded.relative_path,
                document_id = excluded.document_id,
                order_index = excluded.order_index,
                is_expanded = excluded.is_expanded,
                updated_at = excluded.updated_at",
            params![
                node.id,
                node.parent_id,
                node.workspace_path,
                node.node_type,
                node.name,
                node.relative_path,
                node.document_id,
                node.order_index,
                i64::from(node.is_expanded),
                now,
            ],
        )
        .map(|_| ())
        .map_err(|error| format!("cannot save workspace tree node: {error}"))
}

fn load_workspace_file_records(
    connection: &Connection,
) -> Result<Vec<WorkspaceFileMetadataRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,
                    COALESCE(NULLIF(filename, ''), NULLIF(name, ''), ''),
                    COALESCE(NULLIF(path, ''), NULLIF(stored_path, ''), NULLIF(original_path, ''), ''),
                    relative_path,
                    extension,
                    file_type,
                    size_bytes,
                    modified_at
             FROM documents
             WHERE COALESCE(NULLIF(path, ''), NULLIF(stored_path, ''), NULLIF(original_path, '')) IS NOT NULL
             ORDER BY COALESCE(relative_path, filename, name)",
        )
        .map_err(|error| format!("cannot prepare workspace file metadata query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            let size_bytes = row
                .get::<_, Option<i64>>(6)?
                .and_then(|value| (value >= 0).then_some(value as u64));
            Ok(WorkspaceFileMetadataRecord {
                document_id: row.get(0)?,
                filename: row.get(1)?,
                path: row.get(2)?,
                relative_path: row.get(3)?,
                extension: row.get(4)?,
                file_type: row.get(5)?,
                size_bytes,
                modified_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("cannot query workspace file metadata: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read workspace file metadata: {error}"))
}

fn load_workspace_tree_nodes(
    connection: &Connection,
    workspace_path: Option<&Path>,
) -> Result<Vec<WorkspaceTreeNodeRecord>, String> {
    let mut sql = "SELECT id, parent_id, workspace_path, node_type, name, relative_path,
                         document_id, order_index, is_expanded
                  FROM workspace_tree_nodes"
        .to_string();
    if workspace_path.is_some() {
        sql.push_str(" WHERE workspace_path = ?1");
    }
    sql.push_str(" ORDER BY relative_path, order_index, name");

    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("cannot prepare workspace tree query: {error}"))?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(WorkspaceTreeNodeRecord {
            id: row.get(0)?,
            parent_id: row.get(1)?,
            workspace_path: row.get(2)?,
            node_type: row.get(3)?,
            name: row.get(4)?,
            relative_path: row.get(5)?,
            document_id: row.get(6)?,
            order_index: row.get(7)?,
            is_expanded: row.get::<_, i64>(8)? != 0,
        })
    };

    let rows = if let Some(path) = workspace_path {
        statement.query_map(params![path.display().to_string()], mapper)
    } else {
        statement.query_map([], mapper)
    }
    .map_err(|error| format!("cannot query workspace tree nodes: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read workspace tree nodes: {error}"))
}

fn ensure_workspace_tree_from_records(
    connection: &Connection,
    workspace_path: &Path,
    files: &[WorkspaceFileMetadataRecord],
) -> Result<(), String> {
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM workspace_tree_nodes WHERE workspace_path = ?1",
            params![workspace_path.display().to_string()],
            |row| row.get(0),
        )
        .map_err(|error| format!("cannot inspect workspace tree nodes: {error}"))?;
    if count > 0 {
        return Ok(());
    }

    for (index, file) in files.iter().enumerate() {
        let request = WorkspaceFileMetadataRequest {
            document_id: file.document_id.clone(),
            filename: file.filename.clone(),
            path: file.path.clone(),
            relative_path: file.relative_path.clone(),
            extension: file.extension.clone(),
            file_type: file.file_type.clone(),
            size_bytes: file.size_bytes,
            modified_at: file.modified_at,
        };
        upsert_workspace_tree_for_file_with_order(
            connection,
            workspace_path,
            &request,
            index as i64,
        )?;
    }

    Ok(())
}

fn infer_workspace_path_from_records(files: &[WorkspaceFileMetadataRecord]) -> Option<PathBuf> {
    files.iter().find_map(|file| {
        let relative_path = file.relative_path.as_deref()?;
        infer_workspace_path(&file.path, relative_path)
    })
}

fn infer_workspace_path_from_request(request: &WorkspaceFileMetadataRequest) -> Option<PathBuf> {
    let relative_path = request.relative_path.as_deref()?;
    infer_workspace_path(&request.path, relative_path)
}

fn infer_workspace_path(file_path: &str, relative_path: &str) -> Option<PathBuf> {
    let normalized_relative_path = relative_path.replace('\\', "/");
    let parts = normalized_relative_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return Path::new(file_path).parent().map(PathBuf::from);
    }

    let mut path = PathBuf::from(file_path);
    path.pop();
    for _ in 0..parts.len().saturating_sub(2) {
        path.pop();
    }
    Some(path)
}

fn infer_workspace_name_from_records(files: &[WorkspaceFileMetadataRecord]) -> Option<String> {
    files.iter().find_map(|file| {
        file.relative_path
            .as_deref()
            .and_then(|path| {
                path.replace('\\', "/")
                    .split('/')
                    .next()
                    .map(str::to_string)
            })
            .filter(|name| !name.is_empty())
    })
}

fn workspace_root_name(workspace_path: &Path) -> String {
    workspace_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".to_string())
}

fn parent_relative_path(relative_path: &str) -> String {
    let mut parts = relative_path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parts.len() > 1 {
        parts.pop();
    }
    parts.join("/")
}

fn workspace_tree_node_id(node_type: &str, workspace_path: &str, relative_path: &str) -> String {
    format!(
        "tree:{node_type}:{}",
        normalize_document_path(&format!("{workspace_path}/{relative_path}")).to_lowercase()
    )
}

fn collect_workspace_file_metadata(
    workspace_path: &Path,
    dir: &Path,
    workspace_data_path: &Path,
    requests: &mut Vec<WorkspaceFileMetadataRequest>,
    directory_paths: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| format!("cannot scan workspace directory {}: {error}", dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "cannot read workspace directory entry {}: {error}",
                dir.display()
            )
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            format!("cannot inspect workspace entry {}: {error}", path.display())
        })?;

        if file_type.is_dir() {
            if should_skip_workspace_dir(workspace_path, workspace_data_path, &path) {
                continue;
            }
            directory_paths.push(path.clone());
            collect_workspace_file_metadata(
                workspace_path,
                &path,
                workspace_data_path,
                requests,
                directory_paths,
            )?;
        } else if file_type.is_file() {
            requests.push(build_workspace_file_metadata_request(
                workspace_path,
                &path,
            )?);
        }
    }

    Ok(())
}

fn build_workspace_file_metadata_request(
    workspace_path: &Path,
    file_path: &Path,
) -> Result<WorkspaceFileMetadataRequest, String> {
    let metadata = std::fs::metadata(file_path)
        .map_err(|error| format!("cannot read file metadata {}: {error}", file_path.display()))?;
    let path = file_path.display().to_string();
    let filename = file_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.clone());
    let extension = file_path
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .filter(|extension| !extension.is_empty());
    let relative_path = build_workspace_relative_path(workspace_path, file_path);
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    Ok(WorkspaceFileMetadataRequest {
        document_id: workspace_document_id(&path),
        filename,
        path,
        relative_path: Some(relative_path),
        extension: extension.clone(),
        file_type: extension.or_else(|| Some("unknown".to_string())),
        size_bytes: Some(metadata.len()),
        modified_at,
    })
}

fn build_workspace_relative_path(workspace_path: &Path, file_path: &Path) -> String {
    let root_name = workspace_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".to_string());
    let relative_tail = file_path
        .strip_prefix(workspace_path)
        .ok()
        .map(|path| normalize_document_path(&path.display().to_string()))
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| {
            file_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| file_path.display().to_string())
        });

    format!("{root_name}/{relative_tail}")
}

fn should_skip_workspace_dir(
    workspace_path: &Path,
    workspace_data_path: &Path,
    candidate: &Path,
) -> bool {
    let is_root_data_dir = candidate.file_name().is_some_and(|name| name == ".data")
        && candidate.parent() == Some(workspace_path);
    is_root_data_dir || candidate == workspace_data_path
}

fn normalize_workspace_scan_path(path: &str) -> Result<PathBuf, String> {
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

fn workspace_document_id(path: &str) -> String {
    format!("path:{}", normalize_document_path(path).to_lowercase())
}

fn normalize_document_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches('/').to_string()
}
