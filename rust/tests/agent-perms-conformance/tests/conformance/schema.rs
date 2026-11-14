//! A validator for the JSON Schema keywords `conformance/case.schema.json` and `conformance/manifest.schema.json`
//! use, driven by those files themselves so the TypeScript runner (which compiles them with Ajv in strict mode) and
//! this harness check the same format. A keyword outside the supported set is an error, so a schema that grows a
//! feature this validator lacks fails loudly instead of being checked in part.

use serde_json::Value;

/// Keywords that annotate or hold definitions and constrain nothing.
const ANNOTATIONS: [&str; 6] = [
    "$schema",
    "$id",
    "$defs",
    "title",
    "description",
    "$comment",
];

/// Whether a JSON number is an integer, as JSON Schema counts it (`97.0` is the integer 97).
fn is_integer(number: &serde_json::Number) -> bool {
    number.is_i64() || number.is_u64() || number.as_f64().is_some_and(|f| f.fract() == 0.0)
}

fn type_matches(name: &str, instance: &Value) -> Result<bool, String> {
    Ok(match name {
        "object" => instance.is_object(),
        "array" => instance.is_array(),
        "string" => instance.is_string(),
        "boolean" => instance.is_boolean(),
        "null" => instance.is_null(),
        "integer" => instance.as_number().is_some_and(is_integer),
        "number" => instance.is_number(),
        other => return Err(format!("unsupported type {other}")),
    })
}

fn resolve<'a>(root: &'a Value, reference: &str) -> Result<&'a Value, String> {
    let pointer = reference
        .strip_prefix('#')
        .ok_or_else(|| format!("unsupported $ref {reference}"))?;
    root.pointer(pointer)
        .ok_or_else(|| format!("unresolved $ref {reference}"))
}

/// The problems of `instance` against `schema` (a subschema of `root`), each prefixed with the path to the member.
/// An `Err` means the schema itself uses something this validator does not support.
pub fn problems(root: &Value, schema: &Value, instance: &Value) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    check(root, schema, instance, "", &mut found)?;
    Ok(found)
}

fn as_count(value: &Value, keyword: &str) -> Result<u64, String> {
    value
        .as_u64()
        .ok_or_else(|| format!("{keyword} must be a non-negative integer"))
}

fn check(
    root: &Value,
    schema: &Value,
    instance: &Value,
    path: &str,
    found: &mut Vec<String>,
) -> Result<(), String> {
    let Some(keywords) = schema.as_object() else {
        return Err(format!("{path}: a schema must be an object"));
    };
    // A macro rather than a closure: a closure would hold `found` borrowed across the recursive calls.
    macro_rules! fail {
        ($($message:tt)*) => {
            found.push(format!("{path}/ {}", format!($($message)*)))
        };
    }
    for (keyword, value) in keywords {
        match keyword.as_str() {
            key if ANNOTATIONS.contains(&key) => {}
            "$ref" => {
                let target = resolve(root, value.as_str().ok_or("$ref must be a string")?)?;
                check(root, target, instance, path, found)?;
            }
            "type" => {
                let names: Vec<&str> = match value {
                    Value::String(name) => vec![name.as_str()],
                    Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
                    _ => return Err("type must be a string or a list".to_owned()),
                };
                let mut any = false;
                for name in names {
                    any |= type_matches(name, instance)?;
                }
                if !any {
                    fail!("is not of type {value}");
                }
            }
            "const" => {
                if instance != value {
                    fail!("must equal {value}");
                }
            }
            "enum" => {
                if !value
                    .as_array()
                    .ok_or("enum must be a list")?
                    .contains(instance)
                {
                    fail!("must be one of {value}");
                }
            }
            "minLength" => {
                let minimum = as_count(value, keyword)?;
                if let Some(text) = instance.as_str()
                    && (text.encode_utf16().count() as u64) < minimum
                {
                    fail!("must have at least {minimum} characters");
                }
            }
            "minimum" | "maximum" => {
                let bound = value.as_f64().ok_or("a bound must be a number")?;
                if let Some(number) = instance.as_f64()
                    && ((keyword == "minimum" && number < bound)
                        || (keyword == "maximum" && number > bound))
                {
                    fail!("violates {keyword} {bound}");
                }
            }
            "minItems" => {
                let minimum = as_count(value, keyword)?;
                if let Some(items) = instance.as_array()
                    && (items.len() as u64) < minimum
                {
                    fail!("must have at least {minimum} items");
                }
            }
            "uniqueItems" => {
                if let (Some(items), Value::Bool(true)) = (instance.as_array(), value) {
                    for (index, item) in items.iter().enumerate() {
                        if items[..index].contains(item) {
                            fail!("repeats item {index}");
                        }
                    }
                }
            }
            "minProperties" => {
                let minimum = as_count(value, keyword)?;
                if let Some(members) = instance.as_object()
                    && (members.len() as u64) < minimum
                {
                    fail!("must have at least {minimum} members");
                }
            }
            "items" => {
                if let Some(items) = instance.as_array() {
                    for (index, item) in items.iter().enumerate() {
                        check(root, value, item, &format!("{path}/{index}"), found)?;
                    }
                }
            }
            "required" => {
                let names = value.as_array().ok_or("required must be a list")?;
                if let Some(members) = instance.as_object() {
                    for name in names.iter().filter_map(Value::as_str) {
                        if !members.contains_key(name) {
                            fail!("lacks the required member {name}");
                        }
                    }
                }
            }
            "properties" => {
                let subschemas = value.as_object().ok_or("properties must be an object")?;
                if let Some(members) = instance.as_object() {
                    for (name, subschema) in subschemas {
                        if let Some(member) = members.get(name) {
                            check(root, subschema, member, &format!("{path}/{name}"), found)?;
                        }
                    }
                }
            }
            "additionalProperties" => {
                let known = keywords.get("properties").and_then(Value::as_object);
                for (name, member) in instance.as_object().into_iter().flatten() {
                    if known.is_some_and(|known| known.contains_key(name)) {
                        continue;
                    }
                    match value {
                        Value::Bool(false) => fail!("has the unexpected member {name}"),
                        Value::Bool(true) => {}
                        subschema => {
                            check(root, subschema, member, &format!("{path}/{name}"), found)?;
                        }
                    }
                }
            }
            "dependentRequired" => {
                let dependencies = value
                    .as_object()
                    .ok_or("dependentRequired must be an object")?;
                if let Some(members) = instance.as_object() {
                    for (name, needed) in dependencies {
                        if !members.contains_key(name) {
                            continue;
                        }
                        let needed = needed.as_array().ok_or("dependentRequired holds lists")?;
                        for other in needed.iter().filter_map(Value::as_str) {
                            if !members.contains_key(other) {
                                fail!("has {name} and lacks {other}");
                            }
                        }
                    }
                }
            }
            "anyOf" => {
                let mut matching = 0;
                for branch in value.as_array().ok_or("anyOf must be a list")? {
                    let mut inner = Vec::new();
                    check(root, branch, instance, path, &mut inner)?;
                    if inner.is_empty() {
                        matching += 1;
                    }
                }
                if matching == 0 {
                    fail!("matches none of the anyOf branches");
                }
            }
            "oneOf" => {
                let mut matching = 0;
                for branch in value.as_array().ok_or("oneOf must be a list")? {
                    let mut inner = Vec::new();
                    check(root, branch, instance, path, &mut inner)?;
                    if inner.is_empty() {
                        matching += 1;
                    }
                }
                if matching != 1 {
                    fail!("matches {matching} of the oneOf branches, not exactly one");
                }
            }
            other => {
                return Err(format!(
                    "{path}: the keyword {other} is not supported by this validator"
                ));
            }
        }
    }
    Ok(())
}
