//! Loads the conformance corpus (`conformance/` at the repository root) and checks it against the format in
//! `conformance/README.md`, `conformance/case.schema.json` and `conformance/manifest.schema.json`, by the same rules
//! the TypeScript runner applies: which files are corpus files, what a valid file is, and that the corpus is what
//! `conformance/manifest.json` says it is. A file that does not match is a failure, never a skip.
//!
//! This harness reads the same files, selected the same way and validated by the same schemas, as the TypeScript
//! runner does. Every case kind in the schema is validated in full, and a kind the schema does not define is
//! refused. It executes no case: a case is skipped here for want of a native implementation to run it against.

mod keywords;
mod schema;
mod selection;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::Value;

fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance")
}

/// Reads a file as UTF-8 (refusing anything else) and parses it as JSON.
fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

fn string_list(value: &Value, what: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{what}: expected a list"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{what}: expected a list of strings"))
        })
        .collect()
}

/// The two schemas, read from the corpus root.
struct Schemas {
    case: Value,
    manifest: Value,
}

/// UTF-16 code unit order, the order the TypeScript loader sorts ids in.
fn utf16_key(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// The problems of a corpus file: the schema, then the rules the schema cannot express.
/// The value encodings a runner decodes: a single-key object whose key is `$` and letters is one of these (the value encodings of an argument, and the `$contains` and `$subset` matchers of an mcp `expect`) or a defect, since a schema without negation cannot say so.
const ENCODINGS: [&str; 12] = [
    "$undefined",
    "$number",
    "$bytes",
    "$signal",
    "$ref",
    "$map",
    "$returns",
    "$reject",
    "$edit",
    "$readError",
    "$contains",
    "$subset",
];

/// The strings `$number` accepts.
const NUMBER_FORMS: [&str; 4] = ["-0", "Infinity", "-Infinity", "NaN"];

/// What an encoding key looks like: a `$` and letters only, which leaves out the `$DIRn/path` keys of a file map.
fn is_encoding_shape(key: &str) -> bool {
    key.strip_prefix('$')
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphabetic()))
}

/// The value encoding problems anywhere inside `value`, named by the case `id`.
fn encoding_problems(value: &Value, id: &str, found: &mut Vec<String>) {
    match value {
        Value::Array(items) => items
            .iter()
            .for_each(|item| encoding_problems(item, id, found)),
        Value::Object(members) => {
            let keys: Vec<&String> = members.keys().filter(|key| *key != "as").collect();
            if let [key] = keys
                .as_slice()
                .iter()
                .filter(|key| key.as_str() != "$schema" && is_encoding_shape(key))
                .collect::<Vec<_>>()
                .as_slice()
            {
                if !ENCODINGS.contains(&key.as_str()) {
                    found.push(format!("{id}: {key} is not a value encoding"));
                } else if key.as_str() == "$number"
                    && !members[key.as_str()]
                        .as_str()
                        .is_some_and(|form| NUMBER_FORMS.contains(&form))
                {
                    found.push(format!(
                        "{id}: $number is not one of -0, Infinity, -Infinity, NaN"
                    ));
                }
            }
            members
                .values()
                .for_each(|item| encoding_problems(item, id, found));
        }
        _ => {}
    }
}

fn file_problems(schemas: &Schemas, document: &Value) -> Result<Vec<String>, String> {
    let mut found = schema::problems(&schemas.case, &schemas.case, document)?;
    if !found.is_empty() {
        return Ok(found);
    }
    let mut ids = BTreeSet::new();
    for case in document["cases"].as_array().into_iter().flatten() {
        let id = case["id"].as_str().unwrap_or_default();
        if !selection::is_name(id) {
            found.push(format!("id {id} is not a name"));
        }
        if !ids.insert(id.to_owned()) {
            found.push(format!("id {id} is used twice"));
        }
        encoding_problems(case, id, &mut found);
        let from = case["from"].as_str().unwrap_or_default();
        let no_newline = !from.contains('\n');
        let original = no_newline
            && from.split_once(".test.ts: ").is_some_and(|(file, title)| {
                !title.is_empty()
                    && !file.is_empty()
                    && file.chars().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_')
                    })
            });
        let recorded = no_newline
            && from
                .strip_prefix("recorded: ")
                .is_some_and(|what| !what.is_empty());
        if !original && !recorded {
            found.push(format!(
                "{id}: from is neither a test title nor a recorded behaviour"
            ));
        }
    }
    Ok(found)
}

/// The problems of a manifest: the schema, file names at the corpus depth, and each `skip` list in ascending order.
fn manifest_problems(schemas: &Schemas, manifest: &Value) -> Result<Vec<String>, String> {
    let mut found = schema::problems(&schemas.manifest, &schemas.manifest, manifest)?;
    if !found.is_empty() {
        return Ok(found);
    }
    for (name, entry) in manifest["files"].as_object().into_iter().flatten() {
        let parts: Vec<&str> = name.split('/').collect();
        let valid = parts.len() == 2
            && parts.iter().all(|part| selection::is_name(part))
            && name.ends_with(".json");
        if !valid {
            found.push(format!("{name} is not <area>/<name>.json"));
        }
        let skip = string_list(&entry["skip"], "skip")?;
        if skip.iter().any(|id| !selection::is_name(id)) {
            found.push(format!("{name}: a skipped id is not a name"));
        }
        let mut sorted = skip.clone();
        sorted.sort_by_key(|id| utf16_key(id));
        if sorted != skip {
            found.push(format!("{name}: skip is not in ascending order"));
        }
    }
    Ok(found)
}

struct LoadedFile {
    name: String,
    case_count: usize,
    skip_ids: Vec<String>,
    rust_skip_ids: Vec<String>,
}

/// Loads and checks a whole corpus root by every rule `conformance/README.md` states: the files selected, each file
/// valid, ids unique across files, and the corpus equal to its manifest. The real corpus and every fixture corpus go
/// through this one function.
fn check_corpus(root: &Path, schemas: &Schemas) -> (Vec<LoadedFile>, Vec<String>) {
    let mut problems = Vec::new();
    let found = match selection::select_corpus_files(root) {
        Ok(found) => found,
        Err(error) => return (Vec::new(), vec![error]),
    };
    for problem in &found.problems {
        problems.push(format!(
            "{problem}: not a corpus file and not a recognised root file"
        ));
    }
    let mut files = Vec::new();
    let mut owner: BTreeMap<String, String> = BTreeMap::new();
    for name in found.selected {
        let document = match read_json(&root.join(&name)) {
            Ok(document) => document,
            Err(error) => {
                problems.push(format!("{name}: {error}"));
                continue;
            }
        };
        match file_problems(schemas, &document) {
            Ok(file_problems) => {
                problems.extend(file_problems.into_iter().map(|p| format!("{name}: {p}")))
            }
            Err(error) => problems.push(format!("{name}: {error}")),
        }
        let cases = document["cases"].as_array().cloned().unwrap_or_default();
        let mut skip_ids = Vec::new();
        let mut rust_skip_ids = Vec::new();
        for case in &cases {
            let id = case["id"].as_str().unwrap_or_default().to_owned();
            if let Some(other) = owner.insert(id.clone(), name.clone())
                && other != name
            {
                problems.push(format!("{name}: case id {id} is used by {other}"));
            }
            if let Some(implementation) = case["skip"].as_str() {
                skip_ids.push(id.clone());
                if implementation == "rust" {
                    rust_skip_ids.push(id);
                }
            }
        }
        skip_ids.sort_by_key(|id| utf16_key(id));
        files.push(LoadedFile {
            name,
            case_count: cases.len(),
            skip_ids,
            rust_skip_ids,
        });
    }
    match read_json(&root.join("manifest.json")) {
        Ok(manifest) => match manifest_problems(schemas, &manifest) {
            Ok(found) if found.is_empty() => {
                let recorded: BTreeMap<&str, (usize, Vec<String>)> = manifest["files"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(name, entry)| {
                        let count = entry["cases"].as_u64().unwrap_or_default() as usize;
                        (
                            name.as_str(),
                            (
                                count,
                                string_list(&entry["skip"], "skip").unwrap_or_default(),
                            ),
                        )
                    })
                    .collect();
                let actual: BTreeMap<&str, (usize, Vec<String>)> = files
                    .iter()
                    .map(|file| (file.name.as_str(), (file.case_count, file.skip_ids.clone())))
                    .collect();
                for name in actual
                    .keys()
                    .chain(recorded.keys())
                    .collect::<BTreeSet<_>>()
                {
                    if actual.get(*name) != recorded.get(*name) {
                        problems.push(format!(
                            "manifest.json does not match {name}: the file holds {:?}, the manifest records {:?}",
                            actual.get(*name),
                            recorded.get(*name)
                        ));
                    }
                }
            }
            Ok(found) => problems.extend(found.into_iter().map(|p| format!("manifest.json: {p}"))),
            Err(error) => problems.push(format!("manifest.json: {error}")),
        },
        Err(error) => problems.push(format!("manifest.json: {error}")),
    }
    (files, problems)
}

/// The shared fixture tree must be selected exactly as `expected.json` says.
fn check_selection_fixture(failures: &mut Vec<String>) {
    let directory = corpus_root().join("fixtures/loader-selection");
    let result = read_json(&directory.join("expected.json")).and_then(|expected| {
        let found = selection::select_corpus_files(&directory.join("tree"))?;
        let want_selected = string_list(&expected["selected"], "selected")?;
        let want_problems = string_list(&expected["problems"], "problems")?;
        if found.selected == want_selected && found.problems == want_problems {
            Ok(())
        } else {
            Err(format!(
                "loader-selection: selected {:?} and problems {:?}, expected {want_selected:?} and {want_problems:?}",
                found.selected, found.problems
            ))
        }
    });
    if let Err(error) = result {
        failures.push(error);
    }
}

/// The names in a fixture directory, sorted; a directory with none is a failure, since a loop over nothing passes.
fn fixture_names(relative: &str, failures: &mut Vec<String>) -> Vec<String> {
    let directory = corpus_root().join("fixtures").join(relative);
    let mut names = match fs::read_dir(&directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        Err(error) => {
            failures.push(format!("{}: {error}", directory.display()));
            return Vec::new();
        }
    };
    names.sort();
    if names.is_empty() {
        failures.push(format!("fixtures/{relative} holds no fixtures"));
    }
    names
}

/// A negative fixture must fail for the rule it exists for. Each file in `invalid` has a file of the same name in
/// `repaired` that differs by that one defect and is valid, so the invalid one cannot stay rejected for another
/// reason. A file that cannot be read as UTF-8 JSON counts as rejected.
fn check_pairs(
    invalid: &str,
    repaired: &str,
    problems_of: impl Fn(&Value) -> Result<Vec<String>, String>,
    failures: &mut Vec<String>,
) {
    let names = fixture_names(invalid, failures);
    if fixture_names(repaired, failures) != names {
        failures.push(format!(
            "fixtures/{repaired} and fixtures/{invalid} do not hold the same names"
        ));
    }
    let root = corpus_root().join("fixtures");
    for name in names {
        let rejected = read_json(&root.join(invalid).join(&name)).map_or(true, |value| {
            problems_of(&value).map_or(true, |found| !found.is_empty())
        });
        if !rejected {
            failures.push(format!("{invalid}/{name} validated, and must not"));
        }
        match read_json(&root.join(repaired).join(&name)).and_then(|value| problems_of(&value)) {
            Ok(found) if found.is_empty() => {}
            Ok(found) => failures.push(format!("{repaired}/{name} must validate: {found:?}")),
            Err(error) => failures.push(format!("{repaired}/{name} must validate: {error}")),
        }
    }
}

/// Each whole-corpus fixture has a problem, and its repaired twin has none.
fn check_corpus_pairs(schemas: &Schemas, failures: &mut Vec<String>) {
    let names = fixture_names("corpora/invalid", failures);
    if fixture_names("corpora/repaired", failures) != names {
        failures.push(
            "fixtures/corpora/repaired and fixtures/corpora/invalid do not hold the same names"
                .to_owned(),
        );
    }
    let root = corpus_root().join("fixtures/corpora");
    for name in names {
        if check_corpus(&root.join("invalid").join(&name), schemas)
            .1
            .is_empty()
        {
            failures.push(format!("corpora/invalid/{name} has no problem, and must"));
        }
        for problem in check_corpus(&root.join("repaired").join(&name), schemas).1 {
            failures.push(format!("corpora/repaired/{name}: {problem}"));
        }
    }
}

fn main() -> ExitCode {
    let mut failures = Vec::new();
    let root = corpus_root();
    let schemas = match (
        read_json(&root.join("case.schema.json")),
        read_json(&root.join("manifest.schema.json")),
    ) {
        (Ok(case), Ok(manifest)) => Schemas { case, manifest },
        (case, manifest) => {
            for error in [case.err(), manifest.err()].into_iter().flatten() {
                eprintln!("FAIL {error}");
            }
            return ExitCode::FAILURE;
        }
    };
    keywords::check(&mut failures);
    check_selection_fixture(&mut failures);
    check_pairs(
        "cases/invalid",
        "cases/repaired",
        |value| file_problems(&schemas, value),
        &mut failures,
    );
    check_pairs(
        "manifests/invalid",
        "manifests/repaired",
        |value| manifest_problems(&schemas, value),
        &mut failures,
    );
    check_corpus_pairs(&schemas, &mut failures);
    let (files, problems) = check_corpus(&root, &schemas);
    failures.extend(problems);
    let total: usize = files.iter().map(|file| file.case_count).sum();
    let skipped_marked: usize = files.iter().map(|file| file.rust_skip_ids.len()).sum();
    for file in &files {
        println!(
            "{}: {} cases ({} skipped by one implementation)",
            file.name,
            file.case_count,
            file.skip_ids.len()
        );
    }
    for failure in &failures {
        eprintln!("FAIL {failure}");
    }
    if failures.is_empty() {
        println!(
            "checked {} files: {} cases, 0 executed, {skipped_marked} skipped because they are marked for rust, {} skipped because there is no native implementation to run them against",
            files.len(),
            total,
            total - skipped_marked
        );
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
