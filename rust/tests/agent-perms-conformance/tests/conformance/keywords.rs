//! Proof that the schema validator does what it says per keyword: every keyword it implements judges an instance
//! the way JSON Schema does, and every other keyword of the 2020-12 vocabulary is refused by name, so a schema that
//! grows a keyword this validator lacks fails loudly instead of being checked in part.

use serde_json::{Value, json};

use crate::schema;

/// Every keyword the validator implements, with a schema using it, an instance that satisfies it and one that does not.
fn implemented() -> Vec<(&'static str, Value, Value, Value)> {
    vec![
        ("type", json!({"type": "string"}), json!("a"), json!(1)),
        (
            "type (integer)",
            json!({"type": "integer"}),
            json!(97.0),
            json!(1.5),
        ),
        ("const", json!({"const": 1}), json!(1), json!(2)),
        ("enum", json!({"enum": ["a", "b"]}), json!("a"), json!("c")),
        (
            "minLength",
            json!({"minLength": 2}),
            json!("ab"),
            json!("a"),
        ),
        ("minimum", json!({"minimum": 1}), json!(1), json!(0)),
        ("maximum", json!({"maximum": 1}), json!(1), json!(2)),
        ("minItems", json!({"minItems": 1}), json!([1]), json!([])),
        (
            "uniqueItems",
            json!({"uniqueItems": true}),
            json!([1, 2]),
            json!([1, 1]),
        ),
        (
            "minProperties",
            json!({"minProperties": 1}),
            json!({"a": 1}),
            json!({}),
        ),
        (
            "items",
            json!({"items": {"type": "string"}}),
            json!(["a"]),
            json!([1]),
        ),
        (
            "required",
            json!({"required": ["a"]}),
            json!({"a": 1}),
            json!({}),
        ),
        (
            "properties",
            json!({"properties": {"a": {"type": "string"}}}),
            json!({"a": "x"}),
            json!({"a": 1}),
        ),
        (
            "additionalProperties (false)",
            json!({"properties": {"a": {}}, "additionalProperties": false}),
            json!({"a": 1}),
            json!({"b": 1}),
        ),
        (
            "additionalProperties (schema)",
            json!({"additionalProperties": {"type": "string"}}),
            json!({"b": "x"}),
            json!({"b": 1}),
        ),
        (
            "dependentRequired",
            json!({"dependentRequired": {"a": ["b"]}}),
            json!({"a": 1, "b": 2}),
            json!({"a": 1}),
        ),
        (
            "oneOf",
            json!({"oneOf": [{"type": "string"}, {"type": "integer"}]}),
            json!("a"),
            json!(true),
        ),
        (
            "anyOf",
            json!({"anyOf": [{"type": "string"}, {"type": "integer"}]}),
            json!(1),
            json!(true),
        ),
        (
            "$ref",
            json!({"$defs": {"s": {"type": "string"}}, "$ref": "#/$defs/s"}),
            json!("a"),
            json!(1),
        ),
        (
            "$defs, $schema, $id, title, description and $comment constrain nothing",
            json!({"$schema": "x", "$id": "y", "$defs": {}, "title": "t", "description": "d", "$comment": "c"}),
            json!(1),
            json!("any"),
        ),
        (
            "pattern (anchored character class)",
            json!({"pattern": "^[a]"}),
            json!("abc"),
            json!("xyz"),
        ),
        (
            "pattern (negated anchored character class)",
            json!({"pattern": "^[^$]"}),
            json!("abc"),
            json!("$abc"),
        ),
        (
            "propertyNames",
            json!({"propertyNames": {"pattern": "^[^$]"}}),
            json!({"a": 1}),
            json!({"$nope": 1}),
        ),
    ]
}

/// The keywords of the 2020-12 vocabulary the validator does not implement.
const REFUSED: &[&str] = &[
    "$anchor",
    "$dynamicAnchor",
    "$dynamicRef",
    "$recursiveRef",
    "$recursiveAnchor",
    "$vocabulary",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "dependentSchemas",
    "prefixItems",
    "contains",
    "patternProperties",
    "unevaluatedItems",
    "unevaluatedProperties",
    "multipleOf",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maxLength",
    "maxItems",
    "maxContains",
    "minContains",
    "maxProperties",
    "format",
    "contentEncoding",
    "contentMediaType",
    "contentSchema",
    "deprecated",
    "readOnly",
    "writeOnly",
    "examples",
    "default",
    "dependencies",
    "additionalItems",
    "definitions",
];

pub fn check(failures: &mut Vec<String>) {
    for (name, schema_value, good, bad) in implemented() {
        match (
            schema::problems(&schema_value, &schema_value, &good),
            schema::problems(&schema_value, &schema_value, &bad),
        ) {
            (Ok(none), Ok(some))
                if none.is_empty() && (!some.is_empty() || name.starts_with("$defs")) => {}
            (a, b) => failures.push(format!(
                "keyword {name}: accepted {good} as {a:?} and {bad} as {b:?}"
            )),
        }
    }
    for keyword in REFUSED.iter().copied() {
        let schema_value = json!({ keyword: true });
        match schema::problems(&schema_value, &schema_value, &json!(1)) {
            Err(message) if message.contains(keyword) => {}
            other => failures.push(format!(
                "keyword {keyword} is not implemented and must be refused by name, got {other:?}"
            )),
        }
    }
}
