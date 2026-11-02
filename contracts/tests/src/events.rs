//! NEP-297 event parsing, validation against JSON schemas, and assertions.

use anyhow::{anyhow, Context, Result};
use near_workspaces::result::ExecutionFinalResult;
use serde_json::Value;
use std::path::PathBuf;

/// Finds the `schemas/events` directory.
pub fn event_schemas_dir() -> PathBuf {
    let root = crate::wasms::workspace_root();
    root.join("schemas/events")
}

/// Decodes all `EVENT_JSON:` logs emitted across all transaction receipt outcomes.
pub fn decode_events(res: &ExecutionFinalResult) -> Vec<Value> {
    let mut events = Vec::new();

    let logs = res.logs();
    for log in logs {
        if let Some(json_str) = log.strip_prefix("EVENT_JSON:") {
            if let Ok(val) = serde_json::from_str::<Value>(json_str.trim()) {
                events.push(val);
            }
        }
    }

    events
}

/// Validates a parsed NEP-297 event value against its schema in `schemas/events/<event>.schema.json`.
pub fn validate_event_against_schema(event_val: &Value) -> Result<()> {
    let event_name = event_val
        .get("event")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Event missing string 'event' property"))?;

    let schema_file = event_schemas_dir().join(format!("{event_name}.schema.json"));
    if !schema_file.exists() {
        return Err(anyhow!(
            "Schema file not found for event '{}' at {}",
            event_name,
            schema_file.display()
        ));
    }

    let schema_content = std::fs::read_to_string(&schema_file)
        .with_context(|| format!("Failed to read schema file at {}", schema_file.display()))?;
    let schema: Value = serde_json::from_str(&schema_content)?;

    // 1. Verify standard
    let expected_standard = schema
        .get("properties")
        .and_then(|p| p.get("standard"))
        .and_then(|s| s.get("const"))
        .and_then(Value::as_str)
        .unwrap_or("openrail");
    let standard = event_val.get("standard").and_then(Value::as_str);
    if standard != Some(expected_standard) {
        return Err(anyhow!(
            "Event standard mismatch: expected {:?}, got {:?}",
            expected_standard,
            standard
        ));
    }

    // 2. Verify version
    let version = event_val.get("version").and_then(Value::as_str);
    if version != Some("1.0.0") {
        return Err(anyhow!(
            "Event version mismatch: expected '1.0.0', got {:?}",
            version
        ));
    }

    // 3. Verify data array
    let data_arr = event_val
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Event 'data' field must be an array"))?;
    if data_arr.is_empty() {
        return Err(anyhow!("Event 'data' array must not be empty"));
    }

    // 4. Verify required fields on each item in data array
    if let Some(required) = schema
        .get("properties")
        .and_then(|p| p.get("data"))
        .and_then(|d| d.get("items"))
        .and_then(|i| i.get("required"))
        .and_then(Value::as_array)
    {
        for (idx, item) in data_arr.iter().enumerate() {
            let item_obj = item
                .as_object()
                .ok_or_else(|| anyhow!("data[{idx}] must be a JSON object"))?;
            for req in required {
                let req_key = req.as_str().unwrap_or_default();
                if !item_obj.contains_key(req_key) {
                    return Err(anyhow!(
                        "Event '{}' data[{}] missing required field '{}'",
                        event_name,
                        idx,
                        req_key
                    ));
                }
            }
        }
    }

    Ok(())
}

/// Asserts that an event named `event_name` was emitted and conforms to its schema,
/// returning the matching event objects.
pub fn assert_event_emitted(res: &ExecutionFinalResult, event_name: &str) -> Vec<Value> {
    let events = decode_events(res);
    let matching: Vec<Value> = events
        .into_iter()
        .filter(|e| e.get("event").and_then(Value::as_str) == Some(event_name))
        .collect();

    assert!(
        !matching.is_empty(),
        "Expected event '{}' to be emitted, but found none. Logs: {:?}",
        event_name,
        res.logs()
    );

    for ev in &matching {
        validate_event_against_schema(ev)
            .unwrap_or_else(|err| panic!("Event '{event_name}' failed schema validation: {err}"));
    }

    matching
}
