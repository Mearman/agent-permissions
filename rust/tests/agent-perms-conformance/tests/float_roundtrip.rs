//! Proof that `serde_json`'s `float_roundtrip` feature is on. Without it, this literal parses one
//! unit in the last place away from the value `f64::from_str` and JSON.parse both give it (verified
//! against the installed serde_json empirically: with the feature off it reads as 9007199254740994.0,
//! bits 0x4340000000000001), which would make this side disagree with the TypeScript runner at
//! exactly the kind of numeric boundary a corpus case can carry.

#[test]
fn reads_a_boundary_float_literal_exactly() {
    let value: serde_json::Value = serde_json::from_str("9007199254740993.0").unwrap();
    let read = value.as_f64().unwrap();
    let exact: f64 = "9007199254740993.0".parse().unwrap();
    assert_eq!(
        read.to_bits(),
        exact.to_bits(),
        "read {read:?}, exact {exact:?}"
    );
}
