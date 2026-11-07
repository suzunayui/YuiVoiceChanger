//! The Rust config code must answer exactly as the JavaScript it replaced.
//! The expected answers come from running electron/config.cjs: scripts/gen-config-parity.cjs.

use serde_json::{json, Value};
use yvc_core::config::{adopt_manual_timing, latency_signature, live_controls, normalize, Config};
use yvc_core::util::same;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/config-parity.json")).unwrap()
}

/// Deep equality where 14 and 14.0 are the same number, as they are in JavaScript.
fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(key, value)| y.get(key).is_some_and(|other| equal(value, other))),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| equal(p, q)),
        _ => same(a, b),
    }
}

fn check(label: &str, input: &Value, actual: Result<Value, String>, expected: &Value) {
    match actual {
        Ok(value) => {
            assert!(expected.get("error").is_none(), "{label} {input}: Rust accepted, JavaScript said {}", expected["error"]);
            assert!(equal(&value, &expected["ok"]), "{label} {input}:\n  rust: {value}\n  js:   {}", expected["ok"]);
        }
        Err(message) => {
            assert_eq!(Some(message.as_str()), expected["error"].as_str(), "{label} {input}");
        }
    }
}

fn to_config(value: &Value) -> Config {
    value.as_object().unwrap().clone()
}

#[test]
fn normalize_matches_javascript() {
    let data = fixtures();
    let cases = data["normalize"].as_array().unwrap();
    assert!(cases.len() > 150, "the fixture has real coverage");
    for case in cases {
        let actual = normalize(&case["input"], false).map(Value::Object);
        check("normalize", &case["input"], actual, &case["result"]);
    }
}

#[test]
fn importing_matches_javascript() {
    let data = fixtures();
    for case in data["importing"].as_array().unwrap() {
        let actual = normalize(&case["input"], true).map(Value::Object);
        check("importing", &case["input"], actual, &case["result"]);
    }
}

#[test]
fn things_that_are_not_objects_match_javascript() {
    let data = fixtures();
    for case in data["notObjects"].as_array().unwrap() {
        // Arrays pass JavaScript's first check and then have no keys, except for Array.isArray.
        let actual = normalize(&case["input"], false).map(Value::Object);
        check("not an object", &case["input"], actual, &case["result"]);
    }
}

#[test]
fn live_controls_match_javascript() {
    let data = fixtures();
    let base = normalize(&json!({}), false).unwrap();
    for case in data["live"].as_array().unwrap() {
        let mut next = base.clone();
        for (key, value) in case["change"].as_object().unwrap() {
            next.insert(key.clone(), value.clone());
        }
        let state = case["state"].as_str().unwrap();
        let actual = live_controls(&base, &next, state).map(|value| value.unwrap_or(Value::Null));
        check(&format!("live {state}"), &case["change"], actual, &case["result"]);
    }
}

#[test]
fn manual_timing_matches_javascript() {
    let data = fixtures();
    for case in data["timing"].as_array().unwrap() {
        let actual = adopt_manual_timing(&to_config(&case["config"]), &case["timing"]);
        let actual = actual.map(Value::Object).unwrap_or(Value::Null);
        assert!(equal(&actual, &case["result"]), "timing {}:\n  rust: {actual}\n  js:   {}", case["timing"], case["result"]);
    }
}

#[test]
fn latency_signature_matches_javascript() {
    let data = fixtures();
    for case in data["signature"].as_array().unwrap() {
        assert_eq!(latency_signature(&to_config(&case["config"])), case["result"].as_str().unwrap());
    }
}
