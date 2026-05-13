use rusqlite::{params, Connection};

use super::super::unix_timestamp_seconds;
pub(crate) fn migrate_sqlite(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            DROP TABLE IF EXISTS chunk_assets;
            DROP TABLE IF EXISTS assets;
            DROP TABLE IF EXISTS document_blocks;
            DROP TABLE IF EXISTS document_fts;
            DROP TABLE IF EXISTS chunk_fts;

            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                original_path TEXT,
                stored_path TEXT,
                file_type TEXT NOT NULL,
                size_bytes INTEGER,
                parse_status TEXT NOT NULL DEFAULT 'pending',
                index_status TEXT NOT NULL DEFAULT 'pending',
                sha256 TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                path TEXT,
                filename TEXT NOT NULL,
                extension TEXT NOT NULL,
                indexed_at INTEGER NOT NULL,
                relative_path TEXT,
                modified_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS doc_nodes (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                parent_id TEXT,
                node_type TEXT NOT NULL,
                level INTEGER,
                title TEXT,
                text TEXT,
                order_index INTEGER NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES doc_nodes(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_doc_nodes_document
                ON doc_nodes(document_id, order_index);
            CREATE INDEX IF NOT EXISTS idx_doc_nodes_parent
                ON doc_nodes(document_id, parent_id);

            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                chunk_type TEXT NOT NULL,
                title_level_1 TEXT,
                title_level_2 TEXT,
                title_level_3 TEXT,
                title_path TEXT NOT NULL,
                heading_level INTEGER,
                content TEXT NOT NULL,
                plain_text TEXT NOT NULL,
                images_json TEXT NOT NULL,
                tables_json TEXT NOT NULL,
                paragraph_start_index INTEGER,
                paragraph_end_index INTEGER,
                order_index INTEGER NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_document
                ON chunks(document_id, order_index);
            CREATE INDEX IF NOT EXISTS idx_chunks_title_path
                ON chunks(document_id, title_path);

            CREATE TABLE IF NOT EXISTS workspace_tree_nodes (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                workspace_path TEXT NOT NULL,
                node_type TEXT NOT NULL,
                name TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                document_id TEXT,
                order_index INTEGER NOT NULL DEFAULT 0,
                is_expanded INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES workspace_tree_nodes(id) ON DELETE CASCADE,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_workspace_tree_workspace
                ON workspace_tree_nodes(workspace_path, relative_path);
            CREATE INDEX IF NOT EXISTS idx_workspace_tree_parent
                ON workspace_tree_nodes(workspace_path, parent_id, order_index);
            ",
        )
        .map_err(|error| format!("cannot migrate SQLite document store: {error}"))?;

    add_column_if_missing(connection, "documents", "name", "TEXT")?;
    add_column_if_missing(connection, "documents", "original_path", "TEXT")?;
    add_column_if_missing(connection, "documents", "stored_path", "TEXT")?;
    add_column_if_missing(connection, "documents", "file_type", "TEXT")?;
    add_column_if_missing(connection, "documents", "parse_status", "TEXT")?;
    add_column_if_missing(connection, "documents", "index_status", "TEXT")?;
    add_column_if_missing(connection, "documents", "created_at", "INTEGER")?;
    add_column_if_missing(connection, "documents", "updated_at", "INTEGER")?;
    add_column_if_missing(connection, "documents", "relative_path", "TEXT")?;
    add_column_if_missing(connection, "documents", "modified_at", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "file_id", "TEXT")?;
    add_column_if_missing(connection, "chunks", "file_name", "TEXT")?;
    add_column_if_missing(connection, "chunks", "chunk_type", "TEXT")?;
    add_column_if_missing(connection, "chunks", "title_level_1", "TEXT")?;
    add_column_if_missing(connection, "chunks", "title_level_2", "TEXT")?;
    add_column_if_missing(connection, "chunks", "title_level_3", "TEXT")?;
    add_column_if_missing(connection, "chunks", "title_path", "TEXT")?;
    add_column_if_missing(connection, "chunks", "heading_level", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "content", "TEXT")?;
    add_column_if_missing(connection, "chunks", "plain_text", "TEXT")?;
    add_column_if_missing(connection, "chunks", "images_json", "TEXT")?;
    add_column_if_missing(connection, "chunks", "tables_json", "TEXT")?;
    add_column_if_missing(connection, "chunks", "paragraph_start_index", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "paragraph_end_index", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "order_index", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "metadata_json", "TEXT")?;
    add_column_if_missing(connection, "chunks", "created_at", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "updated_at", "INTEGER")?;
    let now = unix_timestamp_seconds();
    connection
        .execute(
            "UPDATE documents SET
                name = COALESCE(NULLIF(name, ''), filename),
                file_type = COALESCE(NULLIF(file_type, ''), extension),
                stored_path = COALESCE(stored_path, path),
                original_path = COALESCE(original_path, path),
                parse_status = COALESCE(NULLIF(parse_status, ''), 'parsed'),
                index_status = COALESCE(NULLIF(index_status, ''), 'indexed'),
                created_at = COALESCE(created_at, indexed_at, ?1),
                updated_at = COALESCE(updated_at, indexed_at, ?1)",
            params![now],
        )
        .map_err(|error| format!("cannot backfill document metadata columns: {error}"))?;

    Ok(())
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("cannot inspect table {table}: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("cannot read table {table} columns: {error}"))?;

    for row in rows {
        let existing = row.map_err(|error| format!("cannot read table {table} column: {error}"))?;
        if existing == column {
            return Ok(());
        }
    }

    connection
        .execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )
        .map(|_| ())
        .map_err(|error| format!("cannot add column {table}.{column}: {error}"))
}
