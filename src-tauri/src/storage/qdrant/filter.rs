use serde_json::Value;

pub(super) fn matches_qdrant_filter(
    payload: &Value,
    filter: &Value,
    point_id: &str,
    external_id: &str,
) -> bool {
    let Some(filter) = filter.as_object() else {
        return true;
    };

    if let Some(must) = filter.get("must") {
        if !filter_conditions(must)
            .iter()
            .all(|condition| matches_qdrant_condition(payload, condition, point_id, external_id))
        {
            return false;
        }
    }
    if let Some(should) = filter.get("should") {
        let conditions = filter_conditions(should);
        if !conditions.is_empty()
            && !conditions.iter().any(|condition| {
                matches_qdrant_condition(payload, condition, point_id, external_id)
            })
        {
            return false;
        }
    }
    if let Some(must_not) = filter.get("must_not") {
        if filter_conditions(must_not)
            .iter()
            .any(|condition| matches_qdrant_condition(payload, condition, point_id, external_id))
        {
            return false;
        }
    }

    if filter.contains_key("key") || filter.contains_key("has_id") {
        return matches_qdrant_condition(
            payload,
            &Value::Object(filter.clone()),
            point_id,
            external_id,
        );
    }

    true
}

fn filter_conditions(value: &Value) -> Vec<&Value> {
    value
        .as_array()
        .map(|items| items.iter().collect())
        .unwrap_or_else(|| vec![value])
}

fn matches_qdrant_condition(
    payload: &Value,
    condition: &Value,
    point_id: &str,
    external_id: &str,
) -> bool {
    let Some(condition) = condition.as_object() else {
        return true;
    };

    if condition.contains_key("must")
        || condition.contains_key("should")
        || condition.contains_key("must_not")
    {
        return matches_qdrant_filter(
            payload,
            &Value::Object(condition.clone()),
            point_id,
            external_id,
        );
    }

    if let Some(has_id) = condition.get("has_id") {
        return filter_conditions(has_id)
            .iter()
            .any(|id| id_matches(id, point_id) || id_matches(id, external_id));
    }

    let Some(key) = condition.get("key").and_then(Value::as_str) else {
        return true;
    };
    let Some(value) = payload_value(payload, key) else {
        return false;
    };

    if let Some(match_value) = condition.get("match") {
        return matches_qdrant_match(value, match_value);
    }
    if let Some(range) = condition.get("range") {
        return matches_qdrant_range(value, range);
    }
    true
}

fn id_matches(expected: &Value, id: &str) -> bool {
    match expected {
        Value::String(value) => value == id,
        Value::Number(value) => value.to_string() == id,
        _ => false,
    }
}

fn payload_value<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    let mut current = payload;
    for part in key.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

fn matches_qdrant_match(value: &Value, expected: &Value) -> bool {
    let Some(expected) = expected.as_object() else {
        return values_equal(value, expected);
    };
    if let Some(single) = expected.get("value") {
        return values_equal(value, single);
    }
    if let Some(text) = expected.get("text").and_then(Value::as_str) {
        return value
            .as_str()
            .map(|actual| actual.contains(text))
            .unwrap_or(false);
    }
    if let Some(any) = expected.get("any").and_then(Value::as_array) {
        return any.iter().any(|candidate| values_equal(value, candidate));
    }
    if let Some(except) = expected.get("except").and_then(Value::as_array) {
        return !except
            .iter()
            .any(|candidate| values_equal(value, candidate));
    }
    true
}

fn matches_qdrant_range(value: &Value, range: &Value) -> bool {
    let Some(actual) = value.as_f64() else {
        return false;
    };
    let Some(range) = range.as_object() else {
        return true;
    };
    if let Some(gt) = range.get("gt").and_then(Value::as_f64) {
        if actual <= gt {
            return false;
        }
    }
    if let Some(gte) = range.get("gte").and_then(Value::as_f64) {
        if actual < gte {
            return false;
        }
    }
    if let Some(lt) = range.get("lt").and_then(Value::as_f64) {
        if actual >= lt {
            return false;
        }
    }
    if let Some(lte) = range.get("lte").and_then(Value::as_f64) {
        if actual > lte {
            return false;
        }
    }
    true
}

fn values_equal(actual: &Value, expected: &Value) -> bool {
    actual == expected
        || actual
            .as_str()
            .zip(expected.as_str())
            .map(|(left, right)| left.eq_ignore_ascii_case(right))
            .unwrap_or(false)
}
