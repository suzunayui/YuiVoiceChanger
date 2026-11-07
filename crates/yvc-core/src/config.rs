//! Moved from electron/config.cjs, config-file.cjs, manual-delay.cjs and the *-config.cjs files.
//! tests/config_parity.rs checks this against the JavaScript with the same inputs.

use crate::util::same;
use regex_lite::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub type Config = Map<String, Value>;

const EFFECT_RANGES: [(&str, f64, f64); 7] = [
    ("fx_lowcut", 0.0, 200.0),
    ("fx_brightness", -6.0, 6.0),
    ("fx_compressor", 0.0, 100.0),
    ("fx_deesser", 0.0, 100.0),
    ("fx_reverb", 0.0, 50.0),
    ("fx_echo", 0.0, 50.0),
    ("fx_echo_ms", 80.0, 1000.0),
];

fn as_map(value: Value) -> Config {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

pub fn effect_defaults() -> Config {
    as_map(json!({
        "fx_enabled": false, "fx_lowcut": 80, "fx_brightness": 0, "fx_compressor": 0, "fx_deesser": 0,
        "fx_reverb": 0, "fx_echo": 0, "fx_echo_ms": 250, "fx_limiter": true,
    }))
}

pub fn obs_defaults() -> Config {
    as_map(json!({
        "obs_enabled": false, "obs_port": 4455, "obs_input_uuid": "", "obs_input_name": "", "obs_correction_ms": 0,
        "obs_delay_manual": false, "obs_path_delay_ms": 0, "obs_path_signature": "", "obs_video_enabled": false,
        "obs_video_sources": [], "obs_video_correction_ms": 0,
    }))
}

pub fn mix_defaults() -> Config {
    as_map(json!({
        "mix_enabled": false, "mix_latency_ms": 500, "mix_device_id": "default", "mix_device_name": "",
        "mix_music_gain": -6, "mix_voice_uuid": "", "mix_voice_name": "",
    }))
}

pub const OBS_CONNECTION_KEYS: [&str; 3] = ["obs_port", "obs_input_uuid", "obs_input_name"];

pub fn offset_for(config: &Value) -> Result<i64, String> {
    let value = if config["mix_enabled"] == true { config["mix_latency_ms"].as_i64() } else { config["singing_latency_ms"].as_i64().zip(config["obs_correction_ms"].as_i64()).map(|(latency, correction)| latency + correction) };
    value.filter(|value| (-950..=20000).contains(value)).ok_or_else(|| "OBSの同期オフセットは−950〜20000msにしてください。".to_string())
}

pub fn defaults() -> Config {
    let mut base = as_map(json!({
        "engine_version": 2, "beatrice_model": "", "beatrice_voice": 0, "beatrice_model_alias": "", "beatrice_model_icon": "",
        "beatrice_pitch": 14, "beatrice_formant": 0, "beatrice_block": 0.08, "schedule_ms": 160, "input_gain": 12, "gain": 0,
        "python": "", "input": -1, "output": -1, "input_name": "", "output_name": "", "singing_enabled": false, "singing_latency_ms": 400,
    }));
    base.extend(effect_defaults());
    base.extend(obs_defaults());
    base.extend(mix_defaults());
    base.extend(as_map(json!({
        "compute": "auto", "training_source": "", "training_audio": "", "teacher_pitch": 0, "training_steps": 10000, "hotkeys_enabled": false,
    })));
    base
}

fn has_control_characters(text: &str) -> bool {
    text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

/// JavaScript's string length, which counts UTF-16 units.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|number| number.fract() == 0.0 && number.is_finite())
}

fn same_type(a: &Value, b: &Value) -> bool {
    matches!(
        (a, b),
        (Value::Number(_), Value::Number(_))
            | (Value::String(_), Value::String(_))
            | (Value::Bool(_), Value::Bool(_))
            // typeof null, an array and an object are all "object" in JavaScript.
            | (Value::Array(_) | Value::Object(_) | Value::Null, Value::Array(_) | Value::Object(_) | Value::Null)
    )
}

fn normalize_video_sources(value: &Value) -> Result<Value, String> {
    let items = value.as_array().filter(|items| items.len() <= 8).ok_or("同期する映像ソースは8個以内で指定してください。")?;
    let id_format = Regex::new(r"^[a-zA-Z0-9_-]{1,64}$").expect("valid pattern");
    let (mut ids, mut sources) = (HashSet::new(), HashSet::new());
    let mut result = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let object = item.as_object().ok_or("映像ソースの設定が正しくありません。")?;
        let or = |key: &str, fallback: Value| match object.get(key) {
            None | Some(Value::Null) => fallback,
            Some(value) => value.clone(),
        };
        let id = or("id", json!(format!("source-{}", index + 1)));
        let input_uuid = or("inputUuid", json!(""));
        let input_name = or("inputName", json!(""));
        let offset = or("offset_ms", json!(0));
        let id_text = id.as_str().filter(|text| id_format.is_match(text) && !ids.contains(*text)).ok_or("映像ソースの識別子が正しくありません。")?.to_string();
        let name_check = |value: &Value| value.as_str().filter(|text| js_length(text) <= 512 && !has_control_characters(text)).map(str::to_string);
        let (Some(uuid), Some(name)) = (name_check(&input_uuid), name_check(&input_name)) else {
            return Err("OBSの映像ソース名が正しくありません。".to_string());
        };
        let valid_offset = is_integer(&offset) && offset.as_f64().is_some_and(|number| (-1000.0..=1000.0).contains(&number));
        if !valid_offset {
            return Err("映像の補正は−1000〜1000msの整数で指定してください。".to_string());
        }
        let key = if !uuid.is_empty() {
            format!("uuid:{uuid}")
        } else if !name.is_empty() {
            format!("name:{name}")
        } else {
            String::new()
        };
        if !key.is_empty() && !sources.insert(key) {
            return Err("同じ映像ソースを複数指定することはできません。".to_string());
        }
        ids.insert(id_text.clone());
        result.push(json!({"id": id_text, "inputUuid": uuid, "inputName": name}));
    }
    Ok(Value::Array(result))
}

fn range_for(key: &str, legacy: bool) -> Option<(f64, f64)> {
    if let Some((_, low, high)) = EFFECT_RANGES.iter().find(|(name, _, _)| *name == key) {
        return Some((*low, *high));
    }
    Some(match key {
        "beatrice_voice" => (0.0, 65535.0),
        "beatrice_pitch" => (-24.0, 24.0),
        "beatrice_formant" => (-2.0, 2.0),
        "input_gain" => (-12.0, 18.0),
        "gain" => (-24.0, if legacy { 30.0 } else { 18.0 }),
        "input" | "output" => (-1.0, 65535.0),
        "teacher_pitch" => (-24.0, 24.0),
        "training_steps" => (1.0, 100000.0),
        "obs_video_correction_ms" => (-1000.0, 1000.0),
        "mix_latency_ms" => (200.0, 3000.0),
        "mix_music_gain" => (-24.0, 6.0),
        "singing_latency_ms" => (200.0, 2000.0),
        "obs_port" => (1.0, 65535.0),
        "obs_correction_ms" | "obs_path_delay_ms" => (-1000.0, 1000.0),
        _ => return None,
    })
}

pub fn normalize(value: &Value, importing: bool) -> Result<Config, String> {
    let object = value.as_object().ok_or("設定ファイルの形式が正しくありません。")?;
    let base = defaults();
    let mut clean = Map::new();

    let empty_string = |key: &str| object.get(key).is_some_and(|value| match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64() != Some(0.0),
        _ => true,
    });
    let source_list = if object.contains_key("obs_video_sources") {
        object["obs_video_sources"].clone()
    } else if empty_string("obs_video_uuid") || empty_string("obs_video_name") {
        json!([{
            "inputUuid": object.get("obs_video_uuid").cloned().unwrap_or(Value::Null),
            "inputName": object.get("obs_video_name").cloned().unwrap_or(Value::Null),
            "offset_ms": 0,
        }])
    } else {
        json!([])
    };
    let video_sources = normalize_video_sources(&source_list)?;

    let toml_model = object.get("beatrice_model").and_then(Value::as_str).is_some_and(|text| text.to_lowercase().ends_with(".toml"));
    let is_version_2 = object.get("engine_version").is_some_and(|version| same(version, &json!(2)));
    let legacy = !is_version_2 && (object.contains_key("beatrice_vst") || object.contains_key("beatrice_libs") || toml_model);

    let compute_format = Regex::new(r"^(auto|cpu|cuda(?::(?:0|[1-9]\d{0,4}))?)$").expect("valid pattern");
    let icon_format = Regex::new(r"^[a-f0-9]{64}$").expect("valid pattern");
    for key in base.keys() {
        let Some(v) = object.get(key) else { continue };
        if key == "obs_video_sources" {
            clean.insert(key.clone(), video_sources.clone());
            continue;
        }
        if !same_type(v, &base[key]) {
            return Err(format!("設定値が正しくありません: {key}"));
        }
        if let Some((low, high)) = range_for(key, legacy) {
            let number = v.as_f64().unwrap_or(f64::NAN);
            if number < low || number > high {
                return Err(format!("設定値が範囲外です: {key}"));
            }
        }
        let must_be_integer = EFFECT_RANGES.iter().any(|(name, _, _)| name == key)
            || ["singing_latency_ms", "obs_port", "obs_correction_ms", "obs_path_delay_ms", "obs_video_correction_ms"].contains(&key.as_str());
        if must_be_integer && !is_integer(v) {
            return Err(format!("設定値は整数で入力してください: {key}"));
        }
        let text = v.as_str().unwrap_or_default();
        if ["obs_input_uuid", "obs_input_name", "obs_video_uuid", "obs_video_name"].contains(&key.as_str())
            && (js_length(text) > 512 || has_control_characters(text))
        {
            return Err("OBSのソース名が正しくありません。".to_string());
        }
        if (key == "input" || key == "output") && !is_integer(v) {
            return Err(format!("デバイス番号が正しくありません: {key}"));
        }
        if key == "engine_version" && !same(v, &json!(2)) {
            return Err("未対応の設定バージョンです。".to_string());
        }
        if key == "compute" && !compute_format.is_match(text) {
            return Err("実行先の設定が不正です。".to_string());
        }
        if key == "training_steps" && !is_integer(v) {
            return Err("学習回数は整数です。".to_string());
        }
        if key == "beatrice_voice" && !is_integer(v) {
            return Err("声の番号は整数です。".to_string());
        }
        if key == "beatrice_model_alias" && (js_length(text) > 80 || has_control_characters(text)) {
            return Err("別名は改行なしの80文字以内で入力してください。".to_string());
        }
        if key == "beatrice_model_icon" && !text.is_empty() && !icon_format.is_match(text) {
            return Err("アイコンの指定が不正です。".to_string());
        }
        if key == "beatrice_formant" {
            let number = v.as_f64().unwrap_or(0.0);
            if number * 2.0 != (number * 2.0).round() {
                return Err("フォルマントは0.5半音刻みです。".to_string());
            }
        }
        if !legacy && key == "beatrice_block" && v.as_f64() != Some(0.08) {
            return Err("更新間隔は80msです。".to_string());
        }
        if key == "schedule_ms" && v.as_f64() != Some(160.0) {
            return Err("出力の待ち時間は160msです。".to_string());
        }
        if key == "obs_path_signature" && js_length(text) > 8192 {
            return Err("遅延の測定情報が正しくありません。".to_string());
        }
        if key.starts_with("mix_") && v.is_string() && (js_length(text) > 512 || has_control_characters(text)) {
            return Err("MIXの音声デバイス・ソース名が正しくありません。".to_string());
        }
        if (key == "mix_latency_ms" || key == "mix_music_gain") && !is_integer(v) {
            return Err("MIXの待ち時間・ゲインは整数で指定してください。".to_string());
        }
        clean.insert(key.clone(), v.clone());
    }
    if importing && clean.is_empty() {
        return Err("YuiVoiceChangerの設定が見つかりません。".to_string());
    }
    if importing {
        clean.insert("obs_path_signature".to_string(), json!(""));
        clean.insert("obs_path_delay_ms".to_string(), json!(0));
    }
    if legacy {
        for (key, value) in [
            ("beatrice_model", json!("")),
            ("python", json!("")),
            ("beatrice_block", json!(0.08)),
            ("schedule_ms", json!(160)),
            ("input_gain", json!(12)),
            ("gain", json!(0)),
        ] {
            clean.insert(key.to_string(), value);
        }
    }
    let mut result = base;
    for (key, value) in clean {
        result.insert(key, value);
    }
    result.insert("obs_video_sources".to_string(), video_sources);
    if result["mix_enabled"] == json!(true) {
        result.insert("singing_enabled".to_string(), json!(true));
    }
    Ok(result)
}

const CONTROL_KEYS: [&str; 4] = ["beatrice_pitch", "beatrice_formant", "input_gain", "gain"];

/// What to send a running engine for this change, if anything. Err if the change needs a restart.
pub fn live_controls(current: &Config, next: &Config, state: &str) -> Result<Option<Value>, String> {
    let obs = obs_defaults();
    let effects = effect_defaults();
    let changed: Vec<&String> = next
        .keys()
        .filter(|key| {
            !current.get(*key).is_some_and(|value| same(value, &next[*key]))
                && !obs.contains_key(*key)
                && !["beatrice_model_alias", "beatrice_model_icon", "hotkeys_enabled"].contains(&key.as_str())
        })
        .collect();
    if state == "stopped" || changed.is_empty() {
        return Ok(None);
    }
    let needs_restart = changed.iter().any(|key| {
        !CONTROL_KEYS.contains(&key.as_str()) && !effects.contains_key(*key) && key.as_str() != "mix_music_gain"
    });
    if state != "running" || needs_restart {
        return Err("モデル・音声デバイス・実行先・固定遅延を変更する前に変換を停止してください。".to_string());
    }
    Ok(Some(Value::Object(CONTROL_KEYS.iter().map(|key| (key.to_string(), next[*key].clone())).collect())))
}

pub struct Loaded {
    pub saved: Value,
    pub config: Config,
    pub error: Option<String>,
}

fn stamp() -> String {
    // 2026-11-07T09:26:41.000Z becomes 20261107-092641.
    let now = crate::util::iso_now().replace(['-', ':'], "").replace('T', "-");
    now.chars().take(15).collect()
}

fn unreadable(file: &Path, home: &Path, detail: &str) -> Loaded {
    // The screen saves soon after startup, so a broken file must be copied aside before defaults replace it.
    let suffix: String = uuid::Uuid::new_v4().simple().to_string().chars().take(4).collect();
    let backup = home.join(format!("desktop.unreadable-{}-{suffix}.json", stamp()));
    let kept = fs::create_dir_all(home)
        .and_then(|()| fs::copy(file, &backup))
        .map(|_| format!("元のファイルは {} に残しています。", backup.display()))
        .unwrap_or_default();
    Loaded {
        saved: json!({}),
        config: defaults_clean(),
        error: Some(format!("設定ファイルを読み込めなかったため、初期設定で起動しました。{kept}（{detail}）")),
    }
}

fn defaults_clean() -> Config {
    normalize(&json!({}), false).expect("defaults are valid")
}

pub fn load_config(file: &Path, home: &Path) -> Loaded {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Loaded { saved: json!({}), config: defaults_clean(), error: None };
        }
        Err(error) => return unreadable(file, home, &error.to_string()),
    };
    let saved: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(saved) => saved,
        Err(_) => return unreadable(file, home, "JSONの形式が正しくありません"),
    };
    match normalize(&saved, false) {
        Ok(config) => Loaded { saved, config, error: None },
        Err(error) => unreadable(file, home, &error),
    }
}

fn or_value(text: &Value, fallback: Value) -> Value {
    match text {
        Value::String(value) if !value.is_empty() => text.clone(),
        _ => fallback,
    }
}

/// Moved from manual-delay.cjs: a change of model, device or OBS source invalidates a measured delay.
pub fn latency_signature(config: &Config) -> String {
    let value_or = |key: &str, fallback: Value| config.get(key).filter(|value| !value.is_null()).cloned().unwrap_or(fallback);
    let model = or_value(&value_or("beatrice_model", json!("")), json!(""));
    let voice = match value_or("beatrice_voice", json!(0)) {
        value if value.as_f64() == Some(0.0) => json!(0),
        value => value,
    };
    let compute = or_value(&value_or("compute", json!("")), json!("auto"));
    let input = or_value(&value_or("input_name", json!("")), value_or("input", json!(-1)));
    let output = or_value(&value_or("output_name", json!("")), value_or("output", json!(-1)));
    let port = value_or("obs_port", json!(4455));
    let source = or_value(&value_or("obs_input_uuid", json!("")), or_value(&value_or("obs_input_name", json!("")), json!("")));
    json!([model, voice, compute, input, output, port, source]).to_string()
}

/// The engine reports the timing it actually applied. A manual adjustment keeps the total the user set.
pub fn adopt_manual_timing(config: &Config, timing: &Value) -> Option<Config> {
    if config["singing_enabled"] != json!(true) || !timing.is_object() {
        return None;
    }
    let legacy = timing["legacy_timing"] == json!(true);
    let manual = config["obs_delay_manual"] == json!(true);
    if if legacy { manual } else { !manual } {
        return None;
    }
    if !same(&timing["previous_base_ms"], &config["singing_latency_ms"]) || !same(&timing["previous_correction_ms"], &config["obs_correction_ms"]) {
        return None;
    }
    let (base, correction) = (&timing["singing_latency_ms"], &timing["obs_correction_ms"]);
    let (Some(base_number), Some(correction_number)) = (base.as_f64(), correction.as_f64()) else { return None };
    if !is_integer(base) || !(200.0..=2000.0).contains(&base_number) || !is_integer(correction) || correction_number.abs() > 1000.0 {
        return None;
    }
    let current_base = config["singing_latency_ms"].as_f64()?;
    let current_correction = config["obs_correction_ms"].as_f64()?;
    if legacy {
        let signature_matches = config["obs_path_signature"].as_str() == Some(latency_signature(config).as_str());
        let expected = if signature_matches { config["obs_path_delay_ms"].as_f64()? } else { 0.0 };
        if correction_number != expected || base_number < current_base {
            return None;
        }
    } else if base_number + correction_number != current_base + current_correction {
        return None;
    }
    let mut next = config.clone();
    next.insert("singing_latency_ms".to_string(), base.clone());
    next.insert("obs_correction_ms".to_string(), correction.clone());
    next.insert("obs_delay_manual".to_string(), json!(true));
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broken_files_are_kept_and_reported() {
        let home = std::env::temp_dir().join(format!("yvc-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        let file = home.join("desktop.json");

        let missing = load_config(&file, &home);
        assert!(missing.error.is_none());
        assert_eq!(missing.config["beatrice_pitch"], json!(14));

        fs::write(&file, "{broken").unwrap();
        let broken = load_config(&file, &home);
        assert!(broken.error.as_ref().unwrap().contains("JSONの形式"));
        let kept = fs::read_dir(&home).unwrap().flatten().filter(|entry| entry.file_name().to_string_lossy().starts_with("desktop.unreadable-")).count();
        assert_eq!(kept, 1);

        fs::write(&file, "\u{feff}{\"beatrice_pitch\":3}").unwrap();
        assert_eq!(load_config(&file, &home).config["beatrice_pitch"], json!(3));

        fs::write(&file, "{\"beatrice_pitch\":99}").unwrap();
        assert!(load_config(&file, &home).error.as_ref().unwrap().contains("範囲外"));
        let _ = fs::remove_dir_all(&home);
    }
}
