//! Moved from electron/model-history.cjs.

use crate::config::Config;
use crate::util::{is_file, iso_now, path_key, resolve, same_file, write_json};
use regex_lite::Regex;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub struct ModelHistory {
    file: PathBuf,
    items: Vec<Value>,
}

fn base_name(file: &str) -> String {
    file.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_string()
}

pub fn model_name(file: &str, alias: &str) -> String {
    let alias = alias.trim();
    if !alias.is_empty() {
        return alias.to_string();
    }
    let name = base_name(file);
    if name.is_empty() {
        "未選択".to_string()
    } else {
        name
    }
}

fn text<'a>(item: &'a Value, key: &str) -> &'a str {
    item[key].as_str().unwrap_or_default()
}

fn key_of(path: &str, voice: &Value) -> String {
    format!("{}#{}", path_key(path), voice.as_f64().unwrap_or(0.0))
}

impl ModelHistory {
    pub fn new(home: &Path) -> Self {
        let file = home.join("model-history.json");
        let icon = Regex::new(r"^[a-f0-9]{64}$").expect("valid pattern");
        let items = fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|saved| saved.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                item["id"].is_string()
                    && item["path"].is_string()
                    && item["voice"].as_f64().is_some_and(|voice| voice.fract() == 0.0 && (0.0..=65535.0).contains(&voice))
            })
            .map(|item| {
                // Old labels included inferred names. Only the explicit alias field counts.
                let alias = item["alias"].as_str().unwrap_or_default();
                let saved_icon = item["icon"].as_str().filter(|value| icon.is_match(value)).unwrap_or_default();
                json!({"id": item["id"], "path": item["path"], "voice": item["voice"], "last_used": item["last_used"], "alias": alias, "icon": saved_icon})
            })
            .collect();
        Self { file, items }
    }

    pub fn list(&self) -> Vec<Value> {
        self.items
            .iter()
            .map(|item| {
                let mut entry = item.clone();
                entry["label"] = json!(model_name(text(item, "path"), text(item, "alias")));
                entry["available"] = json!(is_file(text(item, "path")));
                entry
            })
            .collect()
    }

    pub fn list_value(&self) -> Value {
        Value::Array(self.list())
    }

    fn write(&mut self, items: Vec<Value>) -> Result<(), String> {
        write_json(&self.file, &Value::Array(items.clone()))?;
        self.items = items;
        Ok(())
    }

    pub fn edit(&mut self, id: &str, alias: &str, icon: &str) -> Result<(), String> {
        if !self.items.iter().any(|item| item["id"] == id) {
            return Err("モデルが一覧に見つかりません。".to_string());
        }
        let items = self
            .items
            .iter()
            .map(|item| {
                let mut entry = item.clone();
                if item["id"] == id {
                    entry["alias"] = json!(alias);
                    entry["icon"] = json!(icon);
                }
                entry
            })
            .collect();
        self.write(items)
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if !self.items.iter().any(|item| item["id"] == id) {
            return Err("モデルが一覧に見つかりません。".to_string());
        }
        let items = self.items.iter().filter(|item| item["id"] != id).cloned().collect();
        self.write(items)
    }

    /// Puts the config's model first. True if the list changed.
    pub fn remember(&mut self, config: &Config) -> Result<bool, String> {
        let file = config.get("beatrice_model").and_then(Value::as_str).unwrap_or_default();
        let model_file = Regex::new(r"(?i)\.(pt(\.gz)?|toml|bin)$").expect("valid pattern");
        if file.is_empty() || !model_file.is_match(file) || !is_file(file) {
            return Ok(false);
        }
        let voice = config.get("beatrice_voice").cloned().unwrap_or(json!(0));
        let alias = config.get("beatrice_model_alias").and_then(Value::as_str).unwrap_or_default();
        let icon = config.get("beatrice_model_icon").and_then(Value::as_str).unwrap_or_default();
        let path = resolve(file).to_string_lossy().into_owned();
        let key = key_of(&path, &voice);
        let previous = self.items.iter().position(|entry| key_of(text(entry, "path"), &entry["voice"]) == key);
        if previous == Some(0) && text(&self.items[0], "alias") == alias && text(&self.items[0], "icon") == icon {
            return Ok(false);
        }
        let id = previous.map(|index| self.items[index]["id"].clone()).unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string()));
        let mut next = vec![json!({"path": path, "voice": voice, "alias": alias, "icon": icon, "id": id, "last_used": iso_now()})];
        next.extend(self.items.iter().filter(|entry| key_of(text(entry, "path"), &entry["voice"]) != key).cloned());
        self.write(next)?;
        Ok(true)
    }

    pub fn find_by_id(&self, id: &str) -> Option<Value> {
        self.list().into_iter().find(|entry| entry["id"] == id)
    }

    pub fn find_by_path(&self, path: &str, voice: &Value) -> Option<Value> {
        self.list().into_iter().find(|entry| same_file(text(entry, "path"), path) && crate::util::same(&entry["voice"], voice))
    }

    /// The config fields for choosing this model.
    pub fn select(&self, id: &str) -> Result<Map<String, Value>, String> {
        let item = self.find_by_id(id).ok_or("モデルの履歴が見つかりません。")?;
        if item["available"] != json!(true) {
            return Err("モデルファイルが見つかりません。「モデル一覧」から追加し直してください。".to_string());
        }
        let mut selected = Map::new();
        selected.insert("beatrice_model".to_string(), item["path"].clone());
        selected.insert("beatrice_voice".to_string(), item["voice"].clone());
        selected.insert("beatrice_model_alias".to_string(), item["alias"].clone());
        selected.insert("beatrice_model_icon".to_string(), item["icon"].clone());
        Ok(selected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("yvc-history-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn model(&self, name: &str) -> String {
            let path = self.0.join(name);
            fs::write(&path, "x").unwrap();
            path.to_string_lossy().into_owned()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn config(model: &str, voice: i64, alias: &str) -> Config {
        json!({"beatrice_model": model, "beatrice_voice": voice, "beatrice_model_alias": alias, "beatrice_model_icon": ""}).as_object().unwrap().clone()
    }

    #[test]
    fn remembers_newest_first_and_survives_reopening() {
        let temp = Temp::new();
        let (a, b) = (temp.model("a.pt"), temp.model("b.toml"));
        let mut history = ModelHistory::new(&temp.0);
        assert!(history.remember(&config(&a, 0, "")).unwrap());
        assert!(history.remember(&config(&b, 0, "")).unwrap());
        assert!(history.remember(&config(&a, 0, "")).unwrap(), "moving to the front is a change");
        assert!(!history.remember(&config(&a, 0, "")).unwrap(), "no change at all");
        let list = ModelHistory::new(&temp.0).list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["label"], "a.pt");
        assert_eq!(list[1]["label"], "b.toml");
        assert_eq!(list[0]["available"], true);
    }

    #[test]
    fn a_voice_counts_as_its_own_entry_and_keeps_its_id() {
        let temp = Temp::new();
        let a = temp.model("a.pt");
        let mut history = ModelHistory::new(&temp.0);
        history.remember(&config(&a, 0, "")).unwrap();
        let first = history.list()[0]["id"].clone();
        history.remember(&config(&a, 1, "")).unwrap();
        assert_eq!(history.list().len(), 2);
        history.remember(&config(&a, 0, "別名")).unwrap();
        let list = history.list();
        assert_eq!(list[0]["id"], first);
        assert_eq!(list[0]["label"], "別名");
    }

    #[test]
    fn ignores_files_it_cannot_use() {
        let temp = Temp::new();
        let mut history = ModelHistory::new(&temp.0);
        assert!(!history.remember(&config(&temp.model("a.pth"), 0, "")).unwrap(), "RVC needs training first");
        assert!(!history.remember(&config("C:\\missing\\a.pt", 0, "")).unwrap());
        assert!(!history.remember(&config("", 0, "")).unwrap());
    }

    #[test]
    fn selecting_needs_the_file_to_exist() {
        let temp = Temp::new();
        let a = temp.model("a.pt");
        let mut history = ModelHistory::new(&temp.0);
        history.remember(&config(&a, 2, "x")).unwrap();
        let id = history.list()[0]["id"].as_str().unwrap().to_string();
        let selected = history.select(&id).unwrap();
        assert_eq!(selected["beatrice_voice"], 2);
        assert_eq!(selected["beatrice_model_alias"], "x");
        fs::remove_file(&a).unwrap();
        assert!(history.select(&id).unwrap_err().contains("見つかりません"));
        assert!(history.select("nope").unwrap_err().contains("履歴"));
    }

    #[test]
    fn edits_and_removes() {
        let temp = Temp::new();
        let a = temp.model("a.pt");
        let mut history = ModelHistory::new(&temp.0);
        history.remember(&config(&a, 0, "")).unwrap();
        let id = history.list()[0]["id"].as_str().unwrap().to_string();
        history.edit(&id, "新しい名前", "").unwrap();
        assert_eq!(history.list()[0]["label"], "新しい名前");
        assert!(history.edit("nope", "", "").is_err());
        history.remove(&id).unwrap();
        assert!(history.list().is_empty());
        assert!(history.remove(&id).is_err());
    }

    #[test]
    fn reads_files_written_by_the_electron_version() {
        let temp = Temp::new();
        let a = temp.model("a.pt");
        let saved = json!([
            {"id": "1", "path": a, "voice": 0, "last_used": "2026-01-01T00:00:00.000Z", "alias": "x", "icon": "not-a-hash"},
            {"id": "2", "path": a, "voice": -1},
            {"path": a, "voice": 0},
            "junk"
        ]);
        fs::write(temp.0.join("model-history.json"), saved.to_string()).unwrap();
        let list = ModelHistory::new(&temp.0).list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["icon"], "", "a bad icon is dropped");
        fs::write(temp.0.join("model-history.json"), "broken").unwrap();
        assert!(ModelHistory::new(&temp.0).list().is_empty());
    }
}
