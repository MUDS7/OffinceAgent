use serde_json::{Map, Value};

use super::model::{QdrantChunkVectorPoint, QdrantVectorPoint};

pub(super) fn normalize_generic_qdrant_point(
    point: QdrantVectorPoint,
) -> Result<QdrantVectorPoint, String> {
    let QdrantVectorPoint {
        id,
        vector,
        payload,
    } = point;
    let payload = qdrant_chunk_payload_from_value(&id, payload)?;
    Ok(QdrantVectorPoint {
        id,
        vector,
        payload: Some(Value::Object(payload)),
    })
}

pub(super) fn qdrant_chunk_point_to_vector_point(
    point: QdrantChunkVectorPoint,
) -> Result<QdrantVectorPoint, String> {
    let point_id = point.id.unwrap_or_else(|| point.chunk_id.clone());
    let payload = qdrant_chunk_payload(
        &point.chunk_id,
        &point.document_id,
        point.document_name.as_deref(),
        &point.chunk_type,
        point.heading_path.as_ref(),
        point.order_index,
    )?;

    Ok(QdrantVectorPoint {
        id: point_id,
        vector: point.vector,
        payload: Some(Value::Object(payload)),
    })
}

pub(super) fn qdrant_chunk_payload(
    chunk_id: &str,
    document_id: &str,
    document_name: Option<&str>,
    chunk_type: &str,
    heading_path: Option<&Value>,
    order_index: i64,
) -> Result<Map<String, Value>, String> {
    if chunk_id.trim().is_empty() {
        return Err("Qdrant chunk payload requires chunk_id".to_string());
    }
    if document_id.trim().is_empty() {
        return Err(format!(
            "Qdrant chunk {} payload requires document_id",
            chunk_id
        ));
    }
    if chunk_type.trim().is_empty() {
        return Err(format!(
            "Qdrant chunk {} payload requires chunk_type",
            chunk_id
        ));
    }

    let mut payload = Map::new();
    payload.insert(
        "chunk_id".to_string(),
        Value::String(chunk_id.trim().to_string()),
    );
    payload.insert(
        "document_id".to_string(),
        Value::String(document_id.trim().to_string()),
    );
    if let Some(document_name) = document_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload.insert(
            "document_name".to_string(),
            Value::String(document_name.to_string()),
        );
    }
    payload.insert(
        "chunk_type".to_string(),
        Value::String(chunk_type.trim().to_string()),
    );
    payload.insert(
        "heading_path".to_string(),
        Value::String(qdrant_heading_path_text(heading_path)),
    );
    payload.insert("order_index".to_string(), Value::from(order_index));
    Ok(payload)
}

fn qdrant_chunk_payload_from_value(
    point_id: &str,
    payload: Option<Value>,
) -> Result<Map<String, Value>, String> {
    let object = match payload {
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(format!(
                "Qdrant chunk point {point_id} payload must be an object"
            ))
        }
        None => Map::new(),
    };
    let chunk_id =
        optional_string_field(&object, "chunk_id").unwrap_or_else(|| point_id.trim().to_string());
    let document_id = required_string_field(&object, "document_id", point_id)?;
    let document_name = optional_string_field(&object, "document_name");
    let chunk_type = required_string_field(&object, "chunk_type", point_id)?;
    let order_index = required_i64_field(&object, "order_index", point_id)?;

    qdrant_chunk_payload(
        &chunk_id,
        &document_id,
        document_name.as_deref(),
        &chunk_type,
        object.get("heading_path"),
        order_index,
    )
}

fn qdrant_heading_path_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join(" > "),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn required_string_field(
    object: &Map<String, Value>,
    field: &str,
    point_id: &str,
) -> Result<String, String> {
    optional_string_field(object, field).ok_or_else(|| {
        format!("Qdrant chunk point {point_id} payload requires string field {field}")
    })
}

fn optional_string_field(object: &Map<String, Value>, field: &str) -> Option<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn required_i64_field(
    object: &Map<String, Value>,
    field: &str,
    point_id: &str,
) -> Result<i64, String> {
    object.get(field).and_then(Value::as_i64).ok_or_else(|| {
        format!("Qdrant chunk point {point_id} payload requires integer field {field}")
    })
}
