//! Moved from electron/presets.cjs.

use crate::config::{effect_defaults, mix_defaults, normalize, obs_defaults, Config};
use crate::util::{is_file, same, write_json};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

fn keys() -> Vec<String> {
    let mut keys: Vec<String> = [
        "beatrice_model", "beatrice_voice", "beatrice_model_alias", "beatrice_model_icon", "beatrice_pitch", "beatrice_formant",
        "input", "output", "input_name", "output_name", "input_gain", "gain", "compute", "singing_enabled", "singing_latency_ms", "singing_block_ms",
    ]
    .iter()
    .map(|key| key.to_string())
    .collect();
    keys.extend(effect_defaults().keys().cloned());
    keys.extend(obs_defaults().keys().cloned());
    keys.extend(mix_defaults().keys().cloned());
    keys
}

fn required_keys() -> Vec<String> {
    let mix = mix_defaults();
    let optional = ["obs_video_enabled", "obs_video_sources", "obs_video_correction_ms", "obs_delay_manual", "obs_path_delay_ms", "obs_path_signature"];
    keys().into_iter().filter(|key| !mix.contains_key(key) && !optional.contains(&key.as_str())).collect()
}

pub fn snapshot(config: &Value) -> Result<Map<String, Value>, String> {
    let object = config.as_object().ok_or("保存する設定が正しくありません。")?;
    let mut with_version = object.clone();
    with_version.insert("engine_version".to_string(), json!(2));
    let clean = normalize(&Value::Object(with_version), false)?;
    Ok(keys().into_iter().map(|key| {
        let value = clean[&key].clone();
        (key, value)
    }).collect())
}

fn preset_name(value: &Value) -> Result<String, String> {
    const MESSAGE: &str = "プリセット名を1〜80文字で入力してください。";
    let text = value.as_str().ok_or(MESSAGE)?;
    let trimmed = text.trim();
    let invalid = trimmed.is_empty() || trimmed.encode_utf16().count() > 80 || text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f);
    if invalid {
        return Err(MESSAGE.to_string());
    }
    Ok(trimmed.nfc().collect())
}

pub struct Presets {
    file: PathBuf,
    pub items: Vec<Value>,
    active: String,
    error: Option<String>,
}

fn parse(text: &str) -> Result<(Vec<Value>, String), String> {
    let data: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let list = data["presets"].as_array().filter(|_| data["version"] == 1).ok_or("Invalid presets")?;
    let (mut ids, mut names) = (HashSet::new(), HashSet::new());
    let mut items = Vec::with_capacity(list.len());
    let required = required_keys();
    for item in list {
        let id = item["id"].as_str().filter(|id| !id.is_empty() && !ids.contains(*id)).ok_or("Invalid preset")?;
        let name = preset_name(&item["name"])?;
        if !names.insert(name.to_lowercase()) {
            return Err("Duplicate preset".to_string());
        }
        ids.insert(id.to_string());
        let settings = item["settings"].as_object().filter(|settings| required.iter().all(|key| settings.contains_key(key))).ok_or("Incomplete preset")?;
        items.push(json!({"id": id, "name": name, "settings": snapshot(&Value::Object(settings.clone()))?}));
    }
    let active = data["active"].as_str().filter(|active| ids.contains(*active)).unwrap_or_default().to_string();
    Ok((items, active))
}

impl Presets {
    pub fn new(home: &Path) -> Self {
        let file = home.join("presets.json");
        match fs::read_to_string(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self { file, items: Vec::new(), active: String::new(), error: None },
            result => match result.map_err(|error| error.to_string()).and_then(|text| parse(&text)) {
                Ok((items, active)) => Self { file, items, active, error: None },
                // Saving now would destroy the user's file, so nothing may write until it's fixed.
                Err(_) => Self {
                    file,
                    items: Vec::new(),
                    active: String::new(),
                    error: Some("プリセットファイルを読み込めませんでした。presets.jsonを確認してください。".to_string()),
                },
            },
        }
    }

    fn check(&self) -> Result<(), String> {
        self.error.clone().map_or(Ok(()), Err)
    }

    pub fn list(&self, config: Option<&Config>) -> Result<Value, String> {
        self.check()?;
        let current = config.map(|config| snapshot(&Value::Object(config.clone()))).transpose()?;
        let all_keys = keys();
        Ok(Value::Array(
            self.items
                .iter()
                .map(|item| {
                    let mut entry = json!({"id": item["id"], "name": item["name"]});
                    if let Some(current) = &current {
                        let settings = &item["settings"];
                        let name_set = |key: &str| settings[key].as_str().is_some_and(|text| !text.is_empty()) && current[key].as_str().is_some_and(|text| !text.is_empty());
                        let manual = current["obs_delay_manual"] == json!(true) && settings["obs_delay_manual"] == json!(true);
                        let total = |values: &dyn Fn(&str) -> f64| values("singing_latency_ms") + values("obs_correction_ms");
                        let active = self.active == item["id"].as_str().unwrap_or_default()
                            && all_keys.iter().all(|key| {
                                if (key == "input" && name_set("input_name")) || (key == "output" && name_set("output_name")) {
                                    return true;
                                }
                                if manual && (key == "singing_latency_ms" || key == "obs_correction_ms") {
                                    return total(&|name| current[name].as_f64().unwrap_or(0.0)) == total(&|name| settings[name].as_f64().unwrap_or(0.0));
                                }
                                if key == "obs_video_sources" {
                                    return settings[key] == current[key];
                                }
                                same(&settings[key], &current[key])
                            });
                        entry["active"] = json!(active);
                    }
                    entry
                })
                .collect(),
        ))
    }

    fn get(&self, id: &str) -> Result<&Value, String> {
        self.check()?;
        self.items.iter().find(|item| item["id"] == id).ok_or_else(|| "プリセットが見つかりません。".to_string())
    }

    fn write(&mut self, items: Vec<Value>, active: Option<String>) -> Result<(), String> {
        self.check()?;
        let wanted = active.unwrap_or_else(|| self.active.clone());
        let active = if items.iter().any(|item| item["id"] == wanted.as_str()) { wanted } else { String::new() };
        write_json(&self.file, &json!({"version": 1, "presets": items, "active": active}))?;
        self.items = items;
        self.active = active;
        Ok(())
    }

    /// `payload` is {id?, name, config?}. Returns the preset's id.
    pub fn save(&mut self, payload: &Value) -> Result<String, String> {
        self.check()?;
        let id = payload["id"].as_str().filter(|id| !id.is_empty());
        if let Some(id) = id {
            self.get(id)?;
        }
        let name = preset_name(&payload["name"])?;
        let lower = name.to_lowercase();
        let duplicate = self.items.iter().any(|item| Some(item["id"].as_str().unwrap_or_default()) != id && item["name"].as_str().unwrap_or_default().to_lowercase() == lower);
        if duplicate {
            return Err("同じ名前のプリセットがあります。別の名前を付けてください。".to_string());
        }
        let settings = match payload.get("config").filter(|config| !config.is_null()) {
            Some(config) => Value::Object(snapshot(config)?),
            None => self.get(id.ok_or("保存する設定が正しくありません。")?)?["settings"].clone(),
        };
        let new_id = id.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let entry = json!({"id": new_id, "name": name, "settings": settings});
        let items = if id.is_some() {
            self.items.iter().map(|item| if item["id"] == new_id.as_str() { entry.clone() } else { item.clone() }).collect()
        } else {
            let mut items = self.items.clone();
            items.push(entry);
            items
        };
        self.write(items, None)?;
        Ok(new_id)
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        self.get(id)?;
        let items = self.items.iter().filter(|item| item["id"] != id).cloned().collect();
        self.write(items, None)
    }

    pub fn mark_applied(&mut self, id: &str) -> Result<(), String> {
        self.get(id)?;
        self.write(self.items.clone(), Some(id.to_string()))
    }

    /// The config this preset gives on this PC. Devices are matched by name, since their numbers change.
    pub fn apply(&self, id: &str, current: &Config, devices: Option<&Vec<Value>>) -> Result<Config, String> {
        let mut settings = snapshot(&self.get(id)?["settings"])?;
        let model = settings["beatrice_model"].as_str().unwrap_or_default();
        if !model.is_empty() && !is_file(model) {
            return Err("プリセットのモデルファイルが見つかりません。モデルの保存先を確認してください。".to_string());
        }
        if let Some(devices) = devices {
            let host = if devices.iter().any(|device| device["host"] == "Core Audio") { "Core Audio" } else { "Windows WASAPI" };
            for (key, name_key, channel, label) in [("input", "input_name", "inputs", "マイク"), ("output", "output_name", "outputs", "出力先")] {
                let name = settings[name_key].as_str().unwrap_or_default().to_string();
                let found = devices.iter().find(|device| {
                    device["host"] == host
                        && device[channel].as_f64().unwrap_or(0.0) > 0.0
                        && if !name.is_empty() { device["name"] == name.as_str() } else { same(&device["id"], &settings[key]) }
                });
                let unset = settings[key].as_f64() == Some(-1.0);
                if found.is_none() && (!name.is_empty() || !unset) {
                    return Err(format!("プリセットの{label}が見つかりません。デバイスを接続して音声デバイス一覧を更新してください。"));
                }
                match found {
                    Some(device) => {
                        settings.insert(key.to_string(), device["id"].clone());
                        settings.insert(name_key.to_string(), device["name"].clone());
                    }
                    None => {
                        settings.insert(key.to_string(), json!(-1));
                    }
                }
            }
        }
        let mut merged = current.clone();
        merged.extend(settings);
        normalize(&Value::Object(merged), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("yvc-presets-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn base() -> Config {
        normalize(&json!({}), false).unwrap()
    }

    fn with(change: Value) -> Config {
        let mut config = base();
        config.extend(change.as_object().unwrap().clone());
        config
    }

    fn device(id: i64, name: &str, inputs: i64, outputs: i64) -> Value {
        json!({"id": id, "name": name, "host": "Windows WASAPI", "inputs": inputs, "outputs": outputs})
    }

    #[test]
    fn saves_lists_and_survives_reopening() {
        let temp = Temp::new();
        let mut presets = Presets::new(&temp.0);
        let id = presets.save(&json!({"name": " 声A ", "config": base()})).unwrap();
        let list = Presets::new(&temp.0).list(None).unwrap();
        assert_eq!(list[0]["id"], id.as_str());
        assert_eq!(list[0]["name"], "声A", "the name is trimmed");
        assert!(list[0].get("active").is_none());
    }

    #[test]
    fn names_must_be_valid_and_unique() {
        let temp = Temp::new();
        let mut presets = Presets::new(&temp.0);
        assert!(presets.save(&json!({"name": "", "config": base()})).unwrap_err().contains("1〜80"));
        assert!(presets.save(&json!({"name": "a\nb", "config": base()})).is_err());
        assert!(presets.save(&json!({"name": "x".repeat(81), "config": base()})).is_err());
        presets.save(&json!({"name": "Song", "config": base()})).unwrap();
        assert!(presets.save(&json!({"name": "song", "config": base()})).unwrap_err().contains("同じ名前"));
    }

    #[test]
    fn renames_without_changing_settings() {
        let temp = Temp::new();
        let mut presets = Presets::new(&temp.0);
        let id = presets.save(&json!({"name": "a", "config": with(json!({"beatrice_pitch": 3}))})).unwrap();
        presets.save(&json!({"id": id, "name": "b"})).unwrap();
        assert_eq!(presets.items.len(), 1);
        assert_eq!(presets.items[0]["name"], "b");
        assert_eq!(presets.items[0]["settings"]["beatrice_pitch"], 3);
    }

    #[test]
    fn marks_the_active_preset_until_the_settings_differ() {
        let temp = Temp::new();
        let mut presets = Presets::new(&temp.0);
        let config = with(json!({"beatrice_pitch": 3}));
        let id = presets.save(&json!({"name": "a", "config": config})).unwrap();
        assert_eq!(presets.list(Some(&config)).unwrap()[0]["active"], false, "not applied yet");
        presets.mark_applied(&id).unwrap();
        assert_eq!(presets.list(Some(&config)).unwrap()[0]["active"], true);
        assert_eq!(presets.list(Some(&with(json!({"beatrice_pitch": 4})))).unwrap()[0]["active"], false);
        presets.remove(&id).unwrap();
        assert!(presets.list(None).unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn a_different_device_number_with_the_same_name_is_still_active() {
        let temp = Temp::new();
        let mut presets = Presets::new(&temp.0);
        let config = with(json!({"input": 1, "input_name": "mic"}));
        let id = presets.save(&json!({"name": "a", "config": config})).unwrap();
        presets.mark_applied(&id).unwrap();
        let moved = with(json!({"input": 5, "input_name": "mic"}));
        assert_eq!(presets.list(Some(&moved)).unwrap()[0]["active"], true);
    }

    #[test]
    fn applying_finds_devices_by_name() {
        let temp = Temp::new();
        let mut presets = Presets::new(&temp.0);
        let saved = with(json!({"input": 1, "input_name": "mic", "output": 2, "output_name": "out"}));
        let id = presets.save(&json!({"name": "a", "config": saved})).unwrap();

        let devices = vec![device(7, "mic", 1, 0), device(8, "out", 0, 2)];
        let applied = presets.apply(&id, &base(), Some(&devices)).unwrap();
        assert_eq!(applied["input"], 7);
        assert_eq!(applied["output"], 8);

        let missing = vec![device(8, "out", 0, 2)];
        assert!(presets.apply(&id, &base(), Some(&missing)).unwrap_err().contains("マイク"));
        let wrong_way = vec![device(7, "mic", 0, 2), device(8, "out", 0, 2)];
        assert!(presets.apply(&id, &base(), Some(&wrong_way)).is_err(), "a device must have the right channels");
        assert!(presets.apply(&id, &base(), None).is_ok(), "no list yet means no check");
        assert!(presets.apply("nope", &base(), None).is_err());
    }

    #[test]
    fn applying_needs_the_model_file() {
        let temp = Temp::new();
        let mut presets = Presets::new(&temp.0);
        let id = presets.save(&json!({"name": "a", "config": with(json!({"beatrice_model": "C:\\missing\\a.pt"}))})).unwrap();
        assert!(presets.apply(&id, &base(), None).unwrap_err().contains("モデルファイル"));
    }

    #[test]
    fn a_broken_file_is_never_overwritten() {
        let temp = Temp::new();
        let file = temp.0.join("presets.json");
        fs::write(&file, "broken").unwrap();
        let mut presets = Presets::new(&temp.0);
        assert!(presets.list(None).unwrap_err().contains("presets.json"));
        assert!(presets.save(&json!({"name": "a", "config": base()})).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "broken");
    }

    #[test]
    fn reads_files_written_by_the_electron_version() {
        let temp = Temp::new();
        let settings = snapshot(&Value::Object(with(json!({"beatrice_pitch": 7})))).unwrap();
        let file = json!({"version": 1, "presets": [{"id": "abc", "name": "古い", "settings": settings}], "active": "abc"});
        fs::write(temp.0.join("presets.json"), file.to_string()).unwrap();
        let presets = Presets::new(&temp.0);
        assert_eq!(presets.items[0]["settings"]["beatrice_pitch"], 7);
        assert_eq!(presets.active, "abc");
        fs::write(temp.0.join("presets.json"), json!({"version": 2, "presets": []}).to_string()).unwrap();
        assert!(Presets::new(&temp.0).list(None).is_err());
    }
}
