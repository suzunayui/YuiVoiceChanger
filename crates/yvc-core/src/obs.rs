//! Moved from electron/obs-link.cjs and the modules it uses.
//!
//! Only what the app actually reaches is here: it talks to our OBS plugin over a named pipe, delays
//! video sources while MIX runs, and undoes everything it did, even after a crash, from journals in
//! the data folder. These journals have the same format as the Electron version's. The WebSocket
//! transport and electron/obs-sync.cjs had no way to be started from the screen, so they weren't moved.

use crate::config::{offset_for, Config};
use crate::util::{sha256, write_json};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const PIPE_NAME: &str = r"\\.\pipe\YuiVoiceChanger-OBS-v1";
const FILTER_REQUESTS: [&str; 4] = ["GetSourceFilterList", "CreateSourceFilter", "RemoveSourceFilter", "SetSourceFilterEnabled"];
const PREVIEW_FILTER: &str = "yui_preview_delay";

#[derive(Debug, Clone)]
pub struct ObsError {
    pub code: Option<i64>,
    pub message: String,
    pub unavailable: bool,
    stale: bool,
}

impl ObsError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { code: None, message: message.into(), unavailable: false, stale: false }
    }

    pub fn request(code: i64) -> Self {
        Self { code: Some(code), ..Self::new(format!("OBSで操作できませんでした（{code}）。音声ソースを確認してください。")) }
    }

    pub fn unavailable() -> Self {
        Self { unavailable: true, ..Self::new("OBSプラグインを待っています。") }
    }

    fn is(&self, codes: &[i64]) -> bool {
        self.code.is_some_and(|code| codes.contains(&code))
    }
}

impl From<String> for ObsError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

type ObsResult<T> = Result<T, ObsError>;

pub trait Transport: Send {
    fn exchange(&mut self, kind: &str, data: &Value) -> ObsResult<Value>;
    fn alive(&mut self) -> bool;
}

pub struct Conn {
    id: u64,
    port: i64,
    available: Vec<String>,
    transport: Box<dyn Transport>,
}

impl Conn {
    pub fn new(id: u64, port: i64, transport: Box<dyn Transport>) -> Self {
        Self { id, port, available: Vec::new(), transport }
    }

    fn request(&mut self, kind: &str, data: Value) -> ObsResult<Value> {
        self.transport.exchange(kind, &data)
    }

    fn offers(&self, kind: &str) -> bool {
        self.available.iter().any(|item| item == kind)
    }
}

#[cfg(windows)]
mod pipe {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;

    /// A synchronous pipe handle can't read and write at once, and a blocking read has no time
    /// limit, so a read only happens once Windows says there is something to read.
    pub struct Pipe {
        file: File,
        buffer: Vec<u8>,
        sequence: u64,
        timeout: Duration,
        broken: bool,
    }

    impl Pipe {
        pub fn open(path: &str, timeout: Duration) -> ObsResult<Self> {
            match OpenOptions::new().read(true).write(true).open(path) {
                Ok(file) => Ok(Self { file, buffer: Vec::new(), sequence: 0, timeout, broken: false }),
                // 2: not found, 231: all instances busy.
                Err(error) if matches!(error.raw_os_error(), Some(2) | Some(231)) => Err(ObsError::unavailable()),
                Err(error) => Err(ObsError::new(error.to_string())),
            }
        }

        fn waiting(&self) -> Option<u32> {
            let mut available = 0u32;
            let handle = self.file.as_raw_handle();
            let ok = unsafe { PeekNamedPipe(handle as _, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut available, std::ptr::null_mut()) };
            (ok != 0).then_some(available)
        }

        fn closed() -> ObsError {
            ObsError::new("OBSプラグインとの接続が切れました。")
        }
    }

    impl Transport for Pipe {
        fn exchange(&mut self, kind: &str, data: &Value) -> ObsResult<Value> {
            self.sequence += 1;
            let id = self.sequence.to_string();
            let line = format!("{}\n", json!({"id": id, "type": kind, "data": data}));
            if self.file.write_all(line.as_bytes()).and_then(|()| self.file.flush()).is_err() {
                self.broken = true;
                return Err(Self::closed());
            }
            let deadline = Instant::now() + self.timeout;
            loop {
                while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = self.buffer.drain(..=end).collect();
                    let reply: Value = serde_json::from_slice(&line).map_err(|error| ObsError::new(error.to_string()))?;
                    // An answer to a request that already timed out belongs to nobody.
                    if reply["id"] != id.as_str() {
                        continue;
                    }
                    return if reply["code"] == 100 {
                        Ok(if reply["data"].is_object() { reply["data"].clone() } else { json!({}) })
                    } else {
                        Err(ObsError::request(reply["code"].as_i64().unwrap_or(0)))
                    };
                }
                if self.buffer.len() > 4 * 1024 * 1024 {
                    self.broken = true;
                    return Err(ObsError::new("OBSプラグインの応答が大きすぎます。"));
                }
                let Some(waiting) = self.waiting() else {
                    self.broken = true;
                    return Err(Self::closed());
                };
                if waiting == 0 {
                    if Instant::now() >= deadline {
                        return Err(ObsError::new("OBSプラグインの応答が時間切れになりました。"));
                    }
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                let mut chunk = vec![0u8; (waiting as usize).min(64 * 1024)];
                match self.file.read(&mut chunk) {
                    Ok(read) if read > 0 => self.buffer.extend_from_slice(&chunk[..read]),
                    _ => {
                        self.broken = true;
                        return Err(Self::closed());
                    }
                }
            }
        }

        fn alive(&mut self) -> bool {
            !self.broken && self.waiting().is_some()
        }
    }
}

#[cfg(not(windows))]
mod pipe {
    use super::*;
    pub struct Pipe;
    impl Pipe {
        pub fn open(_path: &str, _timeout: Duration) -> ObsResult<Self> {
            Err(ObsError::unavailable())
        }
    }
    impl Transport for Pipe {
        fn exchange(&mut self, _kind: &str, _data: &Value) -> ObsResult<Value> {
            Err(ObsError::unavailable())
        }
        fn alive(&mut self) -> bool {
            false
        }
    }
}

pub use pipe::Pipe;

fn identity(input: &Value) -> Value {
    match input["inputUuid"].as_str().filter(|uuid| !uuid.is_empty()) {
        Some(uuid) => json!({"inputUuid": uuid}),
        None => json!({"inputName": input["inputName"]}),
    }
}

fn source_identity(input: &Value) -> Value {
    match input["inputUuid"].as_str().filter(|uuid| !uuid.is_empty()) {
        Some(uuid) => json!({"sourceUuid": uuid}),
        None => json!({"sourceName": input["inputName"]}),
    }
}

fn key_of(input: &Value) -> String {
    match input["inputUuid"].as_str().filter(|uuid| !uuid.is_empty()) {
        Some(uuid) => format!("uuid:{uuid}"),
        None => format!("name:{}", input["inputName"].as_str().unwrap_or_default()),
    }
}

fn merged(base: Value, extra: Value) -> Value {
    let mut result = base;
    if let (Some(target), Some(source)) = (result.as_object_mut(), extra.as_object()) {
        target.extend(source.clone());
    }
    result
}

fn kind_of(input: &Value) -> &str {
    input["unversionedInputKind"].as_str().filter(|kind| !kind.is_empty()).or_else(|| input["inputKind"].as_str()).unwrap_or_default()
}

fn versioned(kind: &str, base: &str) -> bool {
    kind == base || kind.strip_prefix(base).and_then(|rest| rest.strip_prefix("_v")).is_some_and(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
}

fn is_window_capture(input: &Value) -> bool {
    let kind = kind_of(input);
    versioned(kind, "window_capture") || versioned(kind, "av_capture_input") || ["screen_capture", "sck_capture", "dshow_input", "syphon-input", "spout_capture"].contains(&kind)
}

fn delay_filter(kind: &str) -> bool {
    kind == "gpu_delay" || kind == PREVIEW_FILTER
}

pub fn delay_parts(target: i64) -> Result<Vec<i64>, String> {
    if !(0..=4000).contains(&target) {
        return Err("映像の遅延は0〜4000msにしてください。負の補正で映像を早めることはできません。".to_string());
    }
    let mut parts = Vec::new();
    let mut remaining = target;
    while remaining > 0 {
        parts.push(remaining.min(500));
        remaining -= 500;
    }
    Ok(parts)
}

fn write_record(file: &Option<PathBuf>, record: &Option<Value>) -> ObsResult<()> {
    let Some(file) = file else { return Ok(()) };
    match record {
        None => {
            let _ = fs::remove_file(file);
            Ok(())
        }
        Some(record) => write_json(file, record).map_err(ObsError::new),
    }
}

/// Reversible changes to inputs, written down before each is made.
pub struct ObsMix {
    file: Option<PathBuf>,
    record: Option<Value>,
    error: Option<String>,
}

impl ObsMix {
    pub fn new(home: &Path, journal: &str) -> Self {
        let file = home.join(journal);
        let mut result = Self { file: Some(file.clone()), record: None, error: None };
        match fs::read_to_string(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            read => {
                let parsed = read.ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
                match parsed.filter(|record| record["version"] == 1 && record["patches"].is_array() && record["port"].is_i64()) {
                    Some(record) => result.record = Some(record),
                    None => result.error = Some(format!("OBSの復元情報を読み込めません。{journal}を確認してください。")),
                }
            }
        }
        result
    }

    pub fn pending(&self) -> bool {
        self.record.is_some() || self.error.is_some()
    }

    fn save(&self) -> ObsResult<()> {
        write_record(&self.file, &self.record)
    }

    pub fn restore(&mut self, connection: Option<&mut Conn>) -> ObsResult<()> {
        if let Some(error) = &self.error {
            return Err(ObsError::new(error.clone()));
        }
        if self.record.is_none() {
            return Ok(());
        }
        let port = self.record.as_ref().map(|record| record["port"].as_i64()).unwrap_or_default();
        let Some(connection) = connection.filter(|connection| Some(connection.port) == port) else {
            return Err(ObsError::new("MIXの取り込み設定を戻すため、元のOBSへ再接続してください。"));
        };
        loop {
            let patch = self.record.as_ref().and_then(|record| record["patches"].as_array()).and_then(|patches| patches.last()).cloned();
            let Some(patch) = patch else { break };
            let field = patch["field"].as_str().unwrap_or_default();
            let outcome = connection.request(patch["get"].as_str().unwrap_or_default(), identity(&patch["input"])).and_then(|current| {
                if current[field] == patch["value"] {
                    let mut data = identity(&patch["input"]);
                    data[field] = patch["old"].clone();
                    connection.request(patch["set"].as_str().unwrap_or_default(), data)?;
                }
                Ok(())
            });
            if let Err(error) = outcome {
                if !error.is(&[600, 602]) {
                    return Err(error);
                }
            }
            if let Some(patches) = self.record.as_mut().and_then(|record| record["patches"].as_array_mut()) {
                patches.pop();
            }
            self.save()?;
        }
        self.record = None;
        self.save()
    }

    pub fn mute_desktops(&mut self, connection: &mut Conn, desktop: &[Value]) -> ObsResult<()> {
        self.restore(Some(connection))?;
        self.record = Some(json!({"version": 1, "port": connection.port, "patches": []}));
        let result = (|| {
            for input in desktop {
                if connection.request("GetInputMute", input.clone())?["inputMuted"] == true {
                    continue;
                }
                let patch = json!({"input": input, "get": "GetInputMute", "set": "SetInputMute", "field": "inputMuted", "old": false, "value": true});
                if let Some(patches) = self.record.as_mut().and_then(|record| record["patches"].as_array_mut()) {
                    patches.push(patch);
                }
                self.save()?;
                connection.request("SetInputMute", merged(input.clone(), json!({"inputMuted": true})))?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = self.restore(Some(connection));
        }
        result
    }
}

/// Delays one source with filters of our own, suspending any delay it already had.
pub struct ObsVideoDelay {
    file: Option<PathBuf>,
    record: Option<Value>,
    connection: Option<u64>,
    load_error: String,
}

fn valid_name(value: &Value) -> bool {
    value.as_str().is_some_and(|name| name.encode_utf16().count() <= 512 && !name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f))
}

fn valid_delay_record(saved: &Value) -> bool {
    let id = saved["id"].as_str().unwrap_or_default();
    let port = saved["port"].as_i64().unwrap_or(0);
    let (Some(created), Some(disabled)) = (saved["created"].as_array(), saved["disabled"].as_array()) else { return false };
    saved["version"] == 1
        && (1..=65535).contains(&port)
        && valid_name(&saved["input"]["inputName"])
        && valid_name(&saved["input"]["inputUuid"])
        && id.len() == 36
        && id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-')
        && created.len() <= 8
        && disabled.len() <= 128
        && created.iter().all(|item| {
            let delay = item["delay"].as_i64().unwrap_or(0);
            item["name"].as_str().is_some_and(|name| name.starts_with(&format!("YUI映像同期 {id} ")))
                && (1..=500).contains(&delay)
                && (item.get("kind").is_none() || item["kind"].as_str().is_some_and(delay_filter))
        })
        && disabled.iter().all(|item| valid_name(&item["filterName"]) && item["filterKind"].as_str().is_some_and(delay_filter) && item["filterSettings"].is_object())
        && saved["target"].as_i64().is_some_and(|target| delay_parts(target).is_ok())
}

impl ObsVideoDelay {
    pub fn open(file: Option<PathBuf>) -> Self {
        let mut result = Self { file, record: None, connection: None, load_error: String::new() };
        let Some(path) = &result.file else { return result };
        match fs::read_to_string(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            read => match read.ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).filter(valid_delay_record) {
                Some(saved) => result.record = Some(saved),
                None => result.load_error = "映像同期の復元情報を読み込めませんでした。obs-video-delay.jsonを確認してください。".to_string(),
            },
        }
        result
    }

    pub fn pending(&self) -> bool {
        self.record.is_some() || !self.load_error.is_empty()
    }

    fn save(&self) -> ObsResult<()> {
        write_record(&self.file, &self.record)
    }

    fn list(connection: &mut Conn, input: &Value) -> ObsResult<Vec<Value>> {
        let reply = connection.request("GetSourceFilterList", source_identity(input))?;
        reply["filters"].as_array().cloned().ok_or_else(|| ObsError::new("映像フィルターの一覧を読み取れませんでした。"))
    }

    pub fn restore(&mut self, connection: Option<&mut Conn>) -> ObsResult<()> {
        if !self.load_error.is_empty() {
            return Err(ObsError::new(self.load_error.clone()));
        }
        let Some(snapshot) = self.record.clone() else { return Ok(()) };
        let Some(connection) = connection.filter(|connection| Some(connection.port) == snapshot["port"].as_i64()) else {
            return Err(ObsError::new("映像の遅延を戻すため、元のOBSへ再接続してください。"));
        };
        self.record.as_mut().expect("checked above")["complete"] = json!(false);
        self.connection = None;
        self.save()?;
        let input = &snapshot["input"];
        let filters = match Self::list(connection, input) {
            Ok(filters) => filters,
            Err(error) if error.is(&[600]) => {
                self.record = None;
                self.connection = None;
                return self.save();
            }
            Err(error) => return Err(error),
        };
        let id = source_identity(input);
        let tolerate = |result: ObsResult<Value>| match result {
            Err(error) if !error.is(&[600]) => Err(error),
            _ => Ok(()),
        };
        for item in snapshot["created"].as_array().cloned().unwrap_or_default().iter().rev() {
            let name = item["name"].as_str().unwrap_or_default();
            let kind = item["kind"].as_str().unwrap_or("gpu_delay");
            let matches = filters.iter().find(|filter| filter["filterName"] == name).is_some_and(|current| {
                current["filterKind"] == kind && current["filterEnabled"] == true && current["filterSettings"]["delay_ms"].as_i64() == item["delay"].as_i64()
            });
            if matches {
                tolerate(connection.request("RemoveSourceFilter", merged(id.clone(), json!({"filterName": name}))))?;
            }
            // Keep filters manually edited/renamed in OBS rather than undoing those edits.
            if let Some(created) = self.record.as_mut().and_then(|record| record["created"].as_array_mut()) {
                created.retain(|filter| filter["name"] != name);
            }
            self.save()?;
        }
        for item in snapshot["disabled"].as_array().cloned().unwrap_or_default() {
            let name = item["filterName"].as_str().unwrap_or_default();
            let matches = filters.iter().find(|filter| filter["filterName"] == name).is_some_and(|current| {
                current["filterKind"] == item["filterKind"] && current["filterEnabled"] == false && current["filterSettings"] == item["filterSettings"]
            });
            if matches {
                tolerate(connection.request("SetSourceFilterEnabled", merged(id.clone(), json!({"filterName": name, "filterEnabled": true}))))?;
            }
            if let Some(disabled) = self.record.as_mut().and_then(|record| record["disabled"].as_array_mut()) {
                disabled.retain(|filter| filter["filterName"] != name);
            }
            self.save()?;
        }
        self.record = None;
        self.connection = None;
        self.save()
    }

    pub fn apply(&mut self, connection: &mut Conn, input: &Value, target: i64, current: &dyn Fn() -> bool) -> ObsResult<bool> {
        if !self.load_error.is_empty() {
            return Err(ObsError::new(self.load_error.clone()));
        }
        let parts = delay_parts(target)?;
        let already = self.record.as_ref().is_some_and(|record| {
            record["complete"] == true
                && self.connection == Some(connection.id)
                && record["port"].as_i64() == Some(connection.port)
                && record["input"]["inputUuid"].as_str().unwrap_or_default() == input["inputUuid"].as_str().unwrap_or_default()
                && record["input"]["inputName"] == input["inputName"]
                && record["target"].as_i64() == Some(target)
        });
        if already {
            return Ok(true);
        }
        self.restore(Some(connection))?;
        if !current() {
            return Ok(false);
        }
        let settings = connection.request("GetInputSettings", identity(input))?;
        if !is_window_capture(&settings) {
            return Err(ObsError::new("映像同期にはウィンドウキャプチャか映像キャプチャデバイスを選んでください。"));
        }
        let filters = Self::list(connection, input)?;
        let mut filter_kind = "gpu_delay";
        if !parts.is_empty() && connection.offers("GetSourceFilterDefaultSettings") {
            match connection.request("GetSourceFilterDefaultSettings", json!({"filterKind": PREVIEW_FILTER})) {
                Ok(_) => filter_kind = PREVIEW_FILTER,
                Err(error) if error.is(&[607]) => {}
                Err(error) => return Err(error),
            }
        }
        if !current() {
            return Ok(false);
        }
        let record_id = uuid::Uuid::new_v4().to_string();
        self.record = Some(json!({
            "version": 1, "id": record_id, "port": connection.port,
            "input": {"inputUuid": input["inputUuid"].as_str().unwrap_or_default(), "inputName": input["inputName"]},
            "target": target, "disabled": [], "created": [], "complete": false,
        }));
        self.save()?;
        let id = source_identity(input);
        let stale = || ObsError { stale: true, ..ObsError::new("映像同期の設定が変更されました。") };
        let outcome = (|| -> ObsResult<()> {
            for filter in filters.iter().filter(|item| item["filterKind"].as_str().is_some_and(delay_filter) && item["filterEnabled"] == true) {
                if !current() {
                    return Err(stale());
                }
                let saved = json!({"filterName": filter["filterName"], "filterKind": filter["filterKind"], "filterSettings": filter["filterSettings"]});
                self.record.as_mut().expect("just set")["disabled"].as_array_mut().expect("an array").push(saved);
                self.save()?;
                connection.request("SetSourceFilterEnabled", merged(id.clone(), json!({"filterName": filter["filterName"], "filterEnabled": false})))?;
            }
            for (index, delay) in parts.iter().enumerate() {
                if !current() {
                    return Err(stale());
                }
                let name = format!("YUI映像同期 {record_id} {}", index + 1);
                self.record.as_mut().expect("just set")["created"].as_array_mut().expect("an array").push(json!({"name": name, "delay": delay, "kind": filter_kind}));
                self.save()?;
                let created = connection.request("CreateSourceFilter", merged(id.clone(), json!({"filterName": name, "filterKind": filter_kind, "filterSettings": {"delay_ms": delay}})));
                if let Err(error) = created {
                    // 601 means a filter of that name already exists, and it isn't ours.
                    if error.is(&[601]) {
                        self.record.as_mut().expect("just set")["created"].as_array_mut().expect("an array").pop();
                        self.save()?;
                    }
                    return Err(error);
                }
            }
            if !current() {
                return Err(stale());
            }
            self.record.as_mut().expect("just set")["complete"] = json!(true);
            self.connection = Some(connection.id);
            self.save()
        })();
        match outcome {
            Ok(()) => Ok(true),
            Err(error) => {
                if let Err(restore_error) = self.restore(Some(connection)) {
                    return Err(ObsError::new(format!("映像同期の設定を戻せませんでした。OBSへ再接続してください。{}", restore_error.message)));
                }
                if error.stale {
                    Ok(false)
                } else {
                    Err(error)
                }
            }
        }
    }
}

fn source_key(port: i64, input: &Value) -> String {
    json!([port, key_of(input)]).to_string()
}

pub struct ObsVideoSources {
    directory: PathBuf,
    legacy: ObsVideoDelay,
    items: BTreeMap<String, ObsVideoDelay>,
}

impl ObsVideoSources {
    pub fn new(home: &Path) -> Self {
        let directory = home.join("obs-video-delays");
        let mut legacy = ObsVideoDelay::open(Some(home.join("obs-video-delay.json")));
        let mut items = BTreeMap::new();
        match fs::read_dir(&directory) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let hashed = name.strip_suffix(".json").is_some_and(|stem| stem.len() == 64 && stem.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
                    if !hashed {
                        continue;
                    }
                    let manager = ObsVideoDelay::open(Some(entry.path()));
                    if manager.pending() {
                        let key = manager.record.as_ref().map_or(name, |record| source_key(record["port"].as_i64().unwrap_or(0), &record["input"]));
                        items.insert(key, manager);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => legacy.load_error = "映像同期の復元情報を読み込めませんでした。obs-video-delaysを確認してください。".to_string(),
        }
        Self { directory, legacy, items }
    }

    pub fn pending(&self) -> bool {
        self.legacy.pending() || self.items.values().any(ObsVideoDelay::pending)
    }

    pub fn restore(&mut self, mut connection: Option<&mut Conn>) -> ObsResult<()> {
        let mut errors = Vec::new();
        if let Err(error) = self.legacy.restore(connection.as_deref_mut()) {
            errors.push(error.message);
        }
        for manager in self.items.values_mut() {
            if let Err(error) = manager.restore(connection.as_deref_mut()) {
                errors.push(error.message);
            }
        }
        self.items.retain(|_, item| item.pending());
        if errors.is_empty() {
            Ok(())
        } else {
            Err(ObsError::new(errors.join(" ")))
        }
    }

    pub fn apply(&mut self, connection: &mut Conn, inputs: &[Value], target: i64, current: &dyn Fn() -> bool) -> ObsResult<bool> {
        delay_parts(target)?;
        let desired: Vec<(String, &Value)> = inputs.iter().map(|input| (source_key(connection.port, input), input)).collect();
        if self.legacy.pending() {
            self.legacy.restore(Some(connection))?;
        }
        let stale: Vec<String> = self.items.keys().filter(|key| !desired.iter().any(|(wanted, _)| wanted == *key)).cloned().collect();
        for key in stale {
            if let Some(manager) = self.items.get_mut(&key) {
                manager.restore(Some(connection))?;
            }
            self.items.remove(&key);
        }
        for (key, input) in desired {
            if !current() {
                return Ok(false);
            }
            let directory = &self.directory;
            let manager = self.items.entry(key.clone()).or_insert_with(|| ObsVideoDelay::open(Some(directory.join(format!("{}.json", sha256(key.as_bytes()))))));
            match manager.apply(connection, input, target, current) {
                Ok(true) => {}
                Ok(false) => return Ok(false),
                Err(error) => return Err(ObsError::new(format!("OBSの映像「{}」の遅延を設定できませんでした。{}", input["inputName"].as_str().unwrap_or_default(), error.message))),
            }
        }
        Ok(true)
    }
}

/// Removes temporary scenes left behind by version 2026.1104.19.
pub struct ObsPreviewSplit {
    file: PathBuf,
    record: Option<Value>,
    error: Option<String>,
    raw_delay: ObsVideoDelay,
    program_delay: ObsVideoDelay,
}

fn scene_identity(scene: &Value) -> Value {
    match scene["uuid"].as_str().filter(|uuid| !uuid.is_empty()) {
        Some(uuid) => json!({"sceneUuid": uuid}),
        None => json!({"sceneName": scene["name"]}),
    }
}

fn split_name(value: &Value, prefix: &str) -> bool {
    value.as_str().and_then(|name| name.strip_prefix(prefix)).is_some_and(|id| id.len() == 36 && id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-'))
}

fn wait_for_obs(mut check: impl FnMut() -> ObsResult<bool>) -> ObsResult<()> {
    for _ in 0..40 {
        if check()? {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(ObsError::new("OBSのプレビュー切り替えを確認できませんでした。"))
}

impl ObsPreviewSplit {
    pub fn new(home: &Path) -> Self {
        let file = home.join("obs-preview-split.json");
        let mut result = Self {
            record: None,
            error: None,
            raw_delay: ObsVideoDelay::open(Some(home.join("obs-preview-raw.json"))),
            program_delay: ObsVideoDelay::open(Some(home.join("obs-preview-program.json"))),
            file: file.clone(),
        };
        if file.exists() {
            let saved = fs::read_to_string(&file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).filter(|saved| {
                saved["version"] == 1
                    && saved["port"].is_i64()
                    && saved["collection"].is_string()
                    && saved["program"]["uuid"].as_str().is_some_and(|uuid| !uuid.is_empty())
                    && saved["sourceUuid"].as_str().is_some_and(|uuid| !uuid.is_empty())
                    && saved["originalId"].is_i64()
                    && split_name(&saved["preview"]["name"], "YUI 操作用 ")
                    && split_name(&saved["delayed"]["name"], "YUI 配信用 ")
            });
            match saved {
                Some(saved) => result.record = Some(saved),
                None => result.error = Some("3Dプレビューの復元情報を読み込めません。".to_string()),
            }
        }
        result
    }

    pub fn pending(&self) -> bool {
        self.record.is_some() || self.error.is_some() || self.raw_delay.pending() || self.program_delay.pending()
    }

    pub fn restore(&mut self, mut connection: Option<&mut Conn>) -> ObsResult<()> {
        if let Some(error) = &self.error {
            return Err(ObsError::new(error.clone()));
        }
        if let Some(record) = self.record.clone() {
            let message = "3Dプレビューを戻すため、元のOBSとシーンコレクションに接続してください。";
            let conn = connection.as_deref_mut().filter(|conn| Some(conn.port) == record["port"].as_i64()).ok_or_else(|| ObsError::new(message))?;
            if conn.request("GetSceneCollectionList", json!({}))?["currentSceneCollectionName"] != record["collection"] {
                return Err(ObsError::new(message));
            }
            let (preview, delayed) = (&record["preview"], &record["delayed"]);
            let is_scene = |scene: &Value, name: &Value, uuid: &Value| scene["name"] == *name || (scene["uuid"].as_str().is_some_and(|text| !text.is_empty()) && scene["uuid"] == *uuid);
            let live = conn.request("GetCurrentProgramScene", json!({}))?;
            if [preview, delayed].iter().any(|scene| is_scene(scene, &live["currentProgramSceneName"], &live["currentProgramSceneUuid"])) {
                return Err(ObsError::new("OBSで元の配信シーンに切り替えると、3Dプレビューの設定を戻せます。"));
            }
            let program = scene_identity(&record["program"]);
            if record["originalHidden"] == true || delayed["uuid"].as_str().is_some_and(|uuid| !uuid.is_empty()) {
                let attempt = (|| -> ObsResult<()> {
                    let list = conn.request("GetSceneItemList", program.clone())?;
                    let items = list["sceneItems"].as_array().cloned().unwrap_or_default();
                    let original = items.iter().find(|item| item["sceneItemId"] == record["originalId"] && item["sourceUuid"] == record["sourceUuid"]);
                    if record["originalHidden"] == true && original.is_some_and(|item| item["sceneItemEnabled"] == false) {
                        conn.request("SetSceneItemEnabled", merged(program.clone(), json!({"sceneItemId": record["originalId"], "sceneItemEnabled": true})))?;
                    }
                    for replacement in items.iter().filter(|item| item["sourceUuid"] == delayed["uuid"]) {
                        conn.request("RemoveSceneItem", merged(program.clone(), json!({"sceneItemId": replacement["sceneItemId"]})))?;
                    }
                    Ok(())
                })();
                if let Err(error) = attempt {
                    if !error.is(&[600]) {
                        return Err(error);
                    }
                }
            }
            let studio = conn.request("GetStudioModeEnabled", json!({}))?["studioModeEnabled"] == true;
            if studio && (record["previewChanged"] == true || record["studioAttempted"] == true) {
                let shown = conn.request("GetCurrentPreviewScene", json!({}))?;
                let ours = is_scene(preview, &shown["currentPreviewSceneName"], &shown["currentPreviewSceneUuid"]);
                if ours || (record["complete"] != true && record["studioAttempted"] == true) {
                    if record["studioWasEnabled"] != true {
                        conn.request("SetStudioModeEnabled", json!({"studioModeEnabled": false}))?;
                        wait_for_obs(|| Ok(conn.request("GetStudioModeEnabled", json!({}))?["studioModeEnabled"] != true))?;
                    } else if record["previousPreview"].is_object() {
                        if let Err(error) = conn.request("SetCurrentPreviewScene", scene_identity(&record["previousPreview"])) {
                            if !error.is(&[600]) {
                                return Err(error);
                            }
                        }
                    }
                }
            }
            for scene in [preview, delayed] {
                if scene["attempted"] != true {
                    continue;
                }
                if let Err(error) = conn.request("RemoveScene", scene_identity(scene)) {
                    if !error.is(&[600]) {
                        return Err(error);
                    }
                }
            }
            wait_for_obs(|| {
                let scenes = conn.request("GetSceneList", json!({}))?;
                let left = scenes["scenes"].as_array().is_some_and(|list| {
                    list.iter().any(|item| {
                        [preview, delayed].iter().any(|scene| match scene["uuid"].as_str().filter(|uuid| !uuid.is_empty()) {
                            Some(uuid) => item["sceneUuid"] == uuid,
                            None => item["sceneName"] == scene["name"],
                        })
                    })
                });
                Ok(!left)
            })?;
        }
        self.program_delay.restore(connection.as_deref_mut())?;
        self.raw_delay.restore(connection)?;
        self.record = None;
        let _ = fs::remove_file(&self.file);
        Ok(())
    }
}

type Notify = Arc<dyn Fn(Value) + Send + Sync>;
type Factory = Box<dyn Fn(i64, u64) -> ObsResult<Conn> + Send>;
type Job = Box<dyn FnOnce(&mut Worker) + Send>;

struct Shared {
    config: Mutex<Value>,
    running: AtomicBool,
    revision: AtomicU64,
    closing: AtomicBool,
    keep_desktop_muted: AtomicBool,
    state: Mutex<Value>,
    sync_at: Mutex<Option<Instant>>,
    notify: Notify,
}

impl Shared {
    fn status(&self) -> Value {
        merged(self.state.lock().unwrap().clone(), json!({"hasPassword": false, "canRemember": false}))
    }

    fn publish(&self, patch: Value) {
        let event = {
            let mut state = self.state.lock().unwrap();
            if let (Some(target), Some(source)) = (state.as_object_mut(), patch.as_object()) {
                target.extend(source.clone());
            }
            merged(json!({"type": "obs-status"}), merged(state.clone(), json!({"hasPassword": false, "canRemember": false})))
        };
        (self.notify)(event);
    }
}

struct Worker {
    shared: Arc<Shared>,
    factory: Factory,
    reconnect_delay: Duration,
    retry_at: Option<Instant>,
    next_id: u64,
    connection: Option<Conn>,
    video: ObsVideoSources,
    preview_split: ObsPreviewSplit,
    mix: ObsMix,
    desktop_mute: ObsMix,
}

const DISCONNECTED: fn() -> Value = || json!({"state": "disconnected", "inputs": [], "videoInputs": [], "appliedOffset": null, "appliedVideoOffset": null});

impl Worker {
    fn retry(&mut self) {
        if !self.shared.closing.load(Ordering::SeqCst) {
            self.retry_at = Some(Instant::now() + self.reconnect_delay);
        }
    }

    fn lost_connection(&mut self) {
        self.connection = None;
        self.shared.publish(merged(DISCONNECTED(), json!({"error": "", "message": ""})));
        self.retry();
    }

    fn check_connection(&mut self) {
        if self.connection.as_mut().is_some_and(|connection| !connection.transport.alive()) {
            self.lost_connection();
        }
    }

    fn open(&mut self, port: i64) -> ObsResult<()> {
        self.next_id += 1;
        let result = (|| -> ObsResult<()> {
            let mut connection = (self.factory)(port, self.next_id)?;
            let version = connection.request("GetVersion", json!({}))?;
            connection.available = version["availableRequests"].as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default();
            if version["protocolVersion"] != 1 {
                return Err(ObsError::new("YuiVoiceChangerのOBSプラグインを更新してください。"));
            }
            self.connection = Some(connection);
            self.shared.publish(json!({"state": "connected", "error": "", "message": "接続済み"}));
            self.inputs()
        })();
        if let Err(error) = &result {
            self.connection = None;
            self.shared.publish(merged(DISCONNECTED(), json!({"error": if error.unavailable { "" } else { error.message.as_str() }, "message": ""})));
        }
        result
    }

    fn inputs(&mut self) -> ObsResult<()> {
        let connection = self.connection.as_mut().ok_or_else(|| ObsError::new("OBSに接続してください。"))?;
        let list = connection.request("GetInputList", json!({}))?;
        let special = connection.request("GetSpecialInputs", json!({}))?;
        let mut candidates: Vec<Value> = list["inputs"].as_array().map(|items| items.iter().filter(|input| input["inputName"].is_string()).cloned().collect()).unwrap_or_default();
        for name in special.as_object().map(|items| items.values().filter(|name| name.is_string()).cloned().collect::<Vec<_>>()).unwrap_or_default() {
            if !candidates.iter().any(|input| input["inputName"] == name) {
                candidates.push(json!({"inputName": name}));
            }
        }
        let mut audio = Vec::new();
        for input in &candidates {
            match connection.request("GetInputAudioSyncOffset", identity(input)) {
                Ok(offset) => audio.push(json!({"inputName": input["inputName"], "inputUuid": input["inputUuid"].as_str().unwrap_or_default(), "offset": offset["inputAudioSyncOffset"]})),
                Err(error) if error.is(&[600, 602, 604]) => {}
                Err(error) => return Err(error),
            }
        }
        let mut video: Vec<Value> = candidates.iter().filter(|input| is_window_capture(input)).map(|input| json!({"inputName": input["inputName"], "inputUuid": input["inputUuid"].as_str().unwrap_or_default()})).collect();
        let name = |item: &Value| item["inputName"].as_str().unwrap_or_default().to_string();
        audio.sort_by_key(name);
        video.sort_by_key(name);
        self.shared.publish(json!({"inputs": audio, "videoInputs": video}));
        Ok(())
    }

    fn restore(&mut self) -> ObsResult<()> {
        let mut errors = Vec::new();
        self.shared.keep_desktop_muted.store(false, Ordering::SeqCst);
        if let Err(error) = self.desktop_mute.restore(self.connection.as_mut()) {
            errors.push(error.message);
        }
        if let Err(error) = self.preview_split.restore(self.connection.as_mut()) {
            errors.push(error.message);
        }
        if let Err(error) = self.mix.restore(self.connection.as_mut()) {
            errors.push(error.message);
        }
        match self.video.restore(self.connection.as_mut()) {
            Ok(()) => self.shared.publish(json!({"appliedVideoOffset": null})),
            Err(error) => errors.push(error.message),
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(ObsError::new(errors.join(" ")))
        }
    }

    fn sync_video(&mut self, config: &Value, mut target: i64, revision: u64) -> ObsResult<()> {
        let shared = self.shared.clone();
        let current = || shared.revision.load(Ordering::SeqCst) == revision && !shared.closing.load(Ordering::SeqCst);
        if config["mix_enabled"] == true {
            target = (target + config["obs_video_correction_ms"].as_i64().unwrap_or(0)).max(0);
        }
        let manual = if config["mix_enabled"] == true && config["obs_video_enabled"] == true { config["obs_video_sources"].as_array().cloned().unwrap_or_default() } else { Vec::new() };
        let known = shared.state.lock().unwrap()["videoInputs"].as_array().cloned().unwrap_or_default();
        let mut inputs = Vec::new();
        for selected in manual.iter().filter(|item| [&item["inputUuid"], &item["inputName"]].iter().any(|text| text.as_str().is_some_and(|text| !text.is_empty()))) {
            let uuid = selected["inputUuid"].as_str().unwrap_or_default();
            let found = known.iter().find(|item| if uuid.is_empty() { item["inputName"] == selected["inputName"] } else { item["inputUuid"] == uuid });
            match found {
                Some(input) => inputs.push(input.clone()),
                None => {
                    let shown = selected["inputName"].as_str().filter(|name| !name.is_empty()).unwrap_or(uuid);
                    return Err(ObsError::new(format!("同期する映像「{shown}」が見つかりません。OBSのソース一覧を更新してください。")));
                }
            }
        }
        let connection = self.connection.as_mut().ok_or_else(|| ObsError::new("OBSに接続してください。"))?;
        let mut automatic = Vec::new();
        if config["mix_enabled"] == true {
            let list = connection.request("GetInputList", json!({}))?;
            for input in list["inputs"].as_array().cloned().unwrap_or_default() {
                let kind = kind_of(&input);
                if !versioned(kind, "window_capture") && kind != "spout_capture" {
                    continue;
                }
                let settings = connection.request("GetInputSettings", identity(&input))?;
                let text = format!(
                    "{} {} {}",
                    input["inputName"].as_str().unwrap_or_default(),
                    settings["inputSettings"]["window"].as_str().unwrap_or_default(),
                    settings["inputSettings"]["spoutsenders"].as_str().unwrap_or_default()
                );
                if !text.to_lowercase().contains("joysound") {
                    continue;
                }
                let source = json!({"inputName": input["inputName"], "inputUuid": input["inputUuid"].as_str().unwrap_or_default()});
                automatic.push(input["inputName"].clone());
                if !inputs.iter().any(|item| key_of(item) == key_of(&source)) {
                    inputs.push(source);
                }
            }
        }
        if !current() {
            return Ok(());
        }
        if !inputs.is_empty() && !FILTER_REQUESTS.iter().all(|kind| connection.offers(kind)) {
            return Err(ObsError::new("このOBSは映像の遅延フィルター操作に対応していません。"));
        }
        if inputs.is_empty() {
            self.video.restore(Some(connection))?;
        } else if !self.video.apply(connection, &inputs, target, &current)? {
            return Ok(());
        }
        if current() {
            shared.publish(json!({"appliedVideoOffset": if inputs.is_empty() { Value::Null } else { json!(target) }, "autoVideoSources": automatic, "error": ""}));
        }
        Ok(())
    }

    fn sync(&mut self) -> ObsResult<()> {
        if self.shared.closing.load(Ordering::SeqCst) {
            return Ok(());
        }
        let revision = self.shared.revision.load(Ordering::SeqCst);
        let changed = |worker: &Self| worker.shared.revision.load(Ordering::SeqCst) != revision;
        let config = self.shared.config.lock().unwrap().clone();
        let port = config["obs_port"].as_i64().unwrap_or(4455);
        if self.connection.as_ref().is_some_and(|connection| connection.port != port) {
            self.restore()?;
            self.connection = None;
            self.shared.publish(json!({"state": "disconnected", "inputs": []}));
        }
        if self.connection.is_none() {
            if let Err(error) = self.open(port) {
                self.retry();
                // Anything left from an earlier run waits until OBS is running again.
                return if error.unavailable { Ok(()) } else { Err(error) };
            }
        }
        if changed(self) {
            return Ok(());
        }
        if !self.shared.keep_desktop_muted.load(Ordering::SeqCst) && self.desktop_mute.pending() {
            self.desktop_mute.restore(self.connection.as_mut())?;
        }
        if self.preview_split.pending() {
            self.preview_split.restore(self.connection.as_mut())?;
        }
        self.mix.restore(self.connection.as_mut())?;
        if changed(self) {
            return Ok(());
        }
        let running = self.shared.running.load(Ordering::SeqCst);
        if self.connection.is_some() && config["mix_enabled"] == true && running {
            let target = offset_for(&config)?;
            return self.sync_video(&config, target, revision);
        }
        if self.video.pending() {
            self.video.restore(self.connection.as_mut())?;
        }
        if self.connection.is_some() {
            self.shared.publish(json!({"error": "", "appliedVideoOffset": null, "autoVideoSources": [], "message": "接続済み"}));
        }
        Ok(())
    }

    fn run(mut self, jobs: mpsc::Receiver<Job>) {
        let mut next_check = Instant::now();
        loop {
            let now = Instant::now();
            let sync_at = *self.shared.sync_at.lock().unwrap();
            let wake = [sync_at, self.retry_at, Some(next_check)].into_iter().flatten().min().unwrap_or(now);
            match jobs.recv_timeout(wake.saturating_duration_since(now).min(Duration::from_millis(500))) {
                Ok(job) => job(&mut self),
                Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => {}
            }
            let now = Instant::now();
            let due = {
                let mut sync_at = self.shared.sync_at.lock().unwrap();
                let due = sync_at.is_some_and(|at| at <= now);
                if due {
                    *sync_at = None;
                }
                due
            };
            if due {
                if let Err(error) = self.sync() {
                    self.shared.publish(json!({"error": error.message}));
                }
            }
            if self.retry_at.is_some_and(|at| at <= now) {
                self.retry_at = None;
                if let Err(error) = self.sync() {
                    self.shared.publish(json!({"error": error.message}));
                    self.retry();
                }
            }
            if now >= next_check {
                self.check_connection();
                next_check = now + Duration::from_millis(500);
            }
        }
    }
}

pub struct ObsLink {
    shared: Arc<Shared>,
    jobs: Mutex<Sender<Job>>,
}

fn watched_config(config: &Config) -> Value {
    let keys = ["obs_port", "obs_video_enabled", "obs_video_sources", "obs_video_correction_ms", "singing_enabled", "singing_latency_ms", "obs_correction_ms", "mix_enabled", "mix_latency_ms"];
    Value::Object(keys.iter().filter_map(|key| config.get(*key).map(|value| (key.to_string(), value.clone()))).collect())
}

impl ObsLink {
    pub fn new(home: &Path, pipe_name: &str, notify: Notify) -> Self {
        let name = pipe_name.to_string();
        let factory: Factory = Box::new(move |port, id| {
            let pipe = Pipe::open(&name, Duration::from_secs(5))?;
            Ok(Conn::new(id, port, Box::new(pipe)))
        });
        Self::with_factory(home, notify, factory, Duration::from_secs(3), Config::new())
    }

    pub fn with_factory(home: &Path, notify: Notify, factory: Factory, reconnect_delay: Duration, config: Config) -> Self {
        let shared = Arc::new(Shared {
            config: Mutex::new(watched_config(&config)),
            running: AtomicBool::new(false),
            revision: AtomicU64::new(0),
            closing: AtomicBool::new(false),
            keep_desktop_muted: AtomicBool::new(false),
            state: Mutex::new(json!({"state": "disconnected", "inputs": [], "videoInputs": [], "message": "", "error": "", "appliedOffset": null, "appliedVideoOffset": null})),
            sync_at: Mutex::new(None),
            notify,
        });
        let worker = Worker {
            shared: shared.clone(),
            factory,
            reconnect_delay,
            retry_at: None,
            next_id: 0,
            connection: None,
            video: ObsVideoSources::new(home),
            preview_split: ObsPreviewSplit::new(home),
            mix: ObsMix::new(home, "obs-mix-routing.json"),
            desktop_mute: ObsMix::new(home, "obs-desktop-mute.json"),
        };
        let (sender, receiver) = mpsc::channel::<Job>();
        thread::spawn(move || worker.run(receiver));
        Self { shared, jobs: Mutex::new(sender) }
    }

    pub fn status(&self) -> Value {
        self.shared.status()
    }

    // One at a time, in order, and any failure shows on the screen.
    fn enqueue<T: Send + 'static>(&self, job: impl FnOnce(&mut Worker) -> ObsResult<T> + Send + 'static) -> mpsc::Receiver<ObsResult<T>> {
        let (sender, receiver) = mpsc::channel();
        let wrapped: Job = Box::new(move |worker| {
            let result = job(worker);
            if let Err(error) = &result {
                worker.shared.publish(json!({"error": error.message}));
            }
            let _ = sender.send(result);
        });
        let _ = self.jobs.lock().unwrap().send(wrapped);
        receiver
    }

    fn wait<T: Send + 'static>(&self, job: impl FnOnce(&mut Worker) -> ObsResult<T> + Send + 'static) -> Result<T, String> {
        self.enqueue(job).recv().map_err(|_| "OBSとの接続を終了しました。".to_string())?.map_err(|error| error.message)
    }

    pub fn configure(&self, config: &Config, running: bool) {
        let next = watched_config(config);
        {
            let mut current = self.shared.config.lock().unwrap();
            let same = *current == next && self.shared.running.load(Ordering::SeqCst) == running;
            if current["mix_enabled"] == true && next["mix_enabled"] != true {
                self.shared.keep_desktop_muted.store(false, Ordering::SeqCst);
            }
            *current = next;
            self.shared.running.store(running, Ordering::SeqCst);
            if same || self.shared.closing.load(Ordering::SeqCst) {
                return;
            }
        }
        self.shared.revision.fetch_add(1, Ordering::SeqCst);
        *self.shared.sync_at.lock().unwrap() = Some(Instant::now() + Duration::from_millis(150));
    }

    pub fn flush(&self) -> Result<(), String> {
        *self.shared.sync_at.lock().unwrap() = None;
        self.wait(|worker| worker.sync())
    }

    /// The same as flush, without waiting for it.
    pub fn sync_soon(&self) {
        *self.shared.sync_at.lock().unwrap() = Some(Instant::now());
        let _ = self.jobs.lock().unwrap().send(Box::new(|_| {}));
    }

    pub fn refresh(&self) -> Result<Value, String> {
        self.wait(|worker| {
            if worker.connection.is_some() {
                worker.inputs()?;
            }
            worker.sync()?;
            Ok(worker.shared.status())
        })
    }

    /// Asks before muting desktop audio, so it isn't heard twice alongside the finished mix.
    pub fn confirm_desktop_mute(&self, confirm: impl FnOnce(&[String]) -> Result<bool, String>) -> Result<(), String> {
        let found = self.wait(|worker| {
            if worker.connection.is_none() {
                worker.sync()?;
            }
            let Some(connection) = worker.connection.as_mut() else { return Ok(None) };
            let special = connection.request("GetSpecialInputs", json!({}))?;
            let mut names: Vec<String> = Vec::new();
            for key in ["desktop1", "desktop2"] {
                if let Some(name) = special[key].as_str().filter(|name| !name.is_empty()) {
                    if !names.iter().any(|known| known == name) {
                        names.push(name.to_string());
                    }
                }
            }
            if names.is_empty() {
                return Ok(None);
            }
            let list = connection.request("GetInputList", json!({}))?;
            let inputs = list["inputs"].as_array().cloned().unwrap_or_default();
            let mut desktop = Vec::new();
            for name in names {
                let input = inputs.iter().find(|item| item["inputName"] == name.as_str()).map(identity).unwrap_or_else(|| json!({"inputName": name}));
                if connection.request("GetInputMute", input.clone())?["inputMuted"] != true {
                    desktop.push((name, input));
                }
            }
            Ok(Some((connection.id, desktop)))
        })?;
        let Some((id, desktop)) = found else { return Ok(()) };
        if desktop.is_empty() {
            return Ok(());
        }
        let names: Vec<String> = desktop.iter().map(|(name, _)| name.clone()).collect();
        if !confirm(&names)? {
            return Ok(());
        }
        let inputs: Vec<Value> = desktop.into_iter().map(|(_, input)| input).collect();
        self.wait(move |worker| {
            let Some(connection) = worker.connection.as_mut().filter(|connection| connection.id == id) else {
                return Err(ObsError::new("OBSに再接続してからお試しください。"));
            };
            worker.desktop_mute.mute_desktops(connection, &inputs)?;
            worker.shared.keep_desktop_muted.store(true, Ordering::SeqCst);
            Ok(())
        })
    }

    pub fn keeps_desktop_muted(&self) -> bool {
        self.shared.keep_desktop_muted.load(Ordering::SeqCst)
    }

    /// Puts desktop audio back. Without OBS connected, this waits until the next connection.
    pub fn release_desktop_mute(&self, only_if_connected: bool) -> Result<(), String> {
        self.shared.keep_desktop_muted.store(false, Ordering::SeqCst);
        self.wait(move |worker| {
            if only_if_connected && worker.connection.is_none() {
                return Ok(());
            }
            worker.desktop_mute.restore(worker.connection.as_mut())
        })
    }

    pub fn shutdown(&self) {
        self.shared.closing.store(true, Ordering::SeqCst);
        *self.shared.sync_at.lock().unwrap() = None;
        let done = self.enqueue(|worker| {
            let result = worker.restore();
            worker.connection = None;
            worker.retry_at = None;
            result
        });
        let _ = done.recv_timeout(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeObs {
        inputs: Vec<Value>,
        filters: HashMap<String, Vec<Value>>,
        records: Vec<String>,
        ignore: String,
        down: bool,
        offline: bool,
        connections: usize,
        muted: HashMap<String, bool>,
        desktop: Vec<String>,
        filter_kinds: Vec<String>,
    }

    struct FakeTransport(Arc<Mutex<FakeObs>>);

    fn input_id(data: &Value) -> String {
        ["inputUuid", "sourceUuid", "inputName", "sourceName"].iter().find_map(|key| data[*key].as_str().map(str::to_string)).unwrap_or_default()
    }

    impl Transport for FakeTransport {
        fn exchange(&mut self, kind: &str, data: &Value) -> ObsResult<Value> {
            let mut obs = self.0.lock().unwrap();
            if obs.down {
                return Err(ObsError::new("OBSプラグインとの接続が切れました。"));
            }
            obs.records.push(kind.to_string());
            if obs.ignore == kind {
                return Err(ObsError::new("OBSプラグインの応答が時間切れになりました。"));
            }
            let id = input_id(data);
            let find = |obs: &FakeObs| obs.inputs.iter().find(|input| input["inputUuid"] == id.as_str() || input["inputName"] == id.as_str()).cloned();
            match kind {
                "GetVersion" => Ok(json!({"protocolVersion": 1, "availableRequests": FILTER_REQUESTS.iter().chain(["GetSourceFilterDefaultSettings"].iter()).collect::<Vec<_>>()})),
                "GetInputList" => Ok(json!({"inputs": obs.inputs})),
                "GetSpecialInputs" => Ok(json!({"desktop1": obs.desktop.first(), "desktop2": obs.desktop.get(1)})),
                "GetInputAudioSyncOffset" => match find(&obs) {
                    Some(input) if input["noAudio"] != true => Ok(json!({"inputAudioSyncOffset": 0})),
                    Some(_) => Err(ObsError::request(604)),
                    None => Err(ObsError::request(600)),
                },
                "GetInputSettings" => find(&obs).map(|input| json!({"inputKind": input["inputKind"], "inputSettings": input["inputSettings"]})).ok_or_else(|| ObsError::request(600)),
                "GetSourceFilterDefaultSettings" => {
                    if obs.filter_kinds.iter().any(|known| data["filterKind"] == known.as_str()) {
                        Ok(json!({}))
                    } else {
                        Err(ObsError::request(607))
                    }
                }
                "GetSourceFilterList" => find(&obs).map(|_| json!({"filters": obs.filters.get(&id).cloned().unwrap_or_default()})).ok_or_else(|| ObsError::request(600)),
                "CreateSourceFilter" => {
                    let filters = obs.filters.entry(id).or_default();
                    filters.push(json!({"filterName": data["filterName"], "filterKind": data["filterKind"], "filterEnabled": true, "filterSettings": data["filterSettings"]}));
                    Ok(json!({}))
                }
                "RemoveSourceFilter" => {
                    obs.filters.entry(id).or_default().retain(|filter| filter["filterName"] != data["filterName"]);
                    Ok(json!({}))
                }
                "SetSourceFilterEnabled" => {
                    for filter in obs.filters.entry(id).or_default() {
                        if filter["filterName"] == data["filterName"] {
                            filter["filterEnabled"] = data["filterEnabled"].clone();
                        }
                    }
                    Ok(json!({}))
                }
                "GetInputMute" => Ok(json!({"inputMuted": obs.muted.get(&id).copied().unwrap_or(false)})),
                "SetInputMute" => {
                    let muted = data["inputMuted"] == true;
                    obs.muted.insert(id, muted);
                    Ok(json!({}))
                }
                _ => Err(ObsError::request(204)),
            }
        }

        fn alive(&mut self) -> bool {
            !self.0.lock().unwrap().down
        }
    }

    struct World {
        home: PathBuf,
        obs: Arc<Mutex<FakeObs>>,
        link: ObsLink,
        events: Arc<Mutex<Vec<Value>>>,
    }

    impl Drop for World {
        fn drop(&mut self) {
            self.link.shutdown();
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    fn fake_link(home: &Path, obs: &Arc<Mutex<FakeObs>>, events: &Arc<Mutex<Vec<Value>>>) -> ObsLink {
        let (shared, recorded) = (obs.clone(), events.clone());
        let factory: Factory = Box::new(move |port, id| {
            let mut state = shared.lock().unwrap();
            if state.offline {
                return Err(ObsError::unavailable());
            }
            state.down = false;
            state.connections += 1;
            drop(state);
            Ok(Conn::new(id, port, Box::new(FakeTransport(shared.clone()))))
        });
        ObsLink::with_factory(home, Arc::new(move |event| recorded.lock().unwrap().push(event)), factory, Duration::from_millis(30), Config::new())
    }

    fn joysound() -> Value {
        json!({"inputUuid": "joy", "inputName": "カラオケJOYSOUND for STREAMER", "inputKind": "spout_capture", "noAudio": true, "inputSettings": {}})
    }

    fn user_filters() -> Vec<Value> {
        vec![
            json!({"filterName": "手動の遅延", "filterKind": "gpu_delay", "filterEnabled": true, "filterSettings": {"delay_ms": 500}}),
            json!({"filterName": "無効の遅延", "filterKind": "gpu_delay", "filterEnabled": false, "filterSettings": {"delay_ms": 80}}),
            json!({"filterName": "クロマキー", "filterKind": "chroma_key_filter_v2", "filterEnabled": true, "filterSettings": {"color": 123}}),
        ]
    }

    fn world() -> World {
        let home = std::env::temp_dir().join(format!("yvc-obs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        let obs = Arc::new(Mutex::new(FakeObs::default()));
        {
            let mut state = obs.lock().unwrap();
            state.inputs = vec![
                joysound(),
                json!({"inputUuid": "mic", "inputName": "マイク", "inputKind": "wasapi_input_capture"}),
                json!({"inputUuid": "cam", "inputName": "カメラ", "inputKind": "dshow_input", "noAudio": true, "inputSettings": {}}),
            ];
            state.filters.insert("joy".to_string(), user_filters());
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let link = fake_link(&home, &obs, &events);
        World { home, obs, link, events }
    }

    fn config(change: Value) -> Config {
        let mut base = crate::config::normalize(&json!({"mix_enabled": true, "singing_enabled": true, "mix_latency_ms": 500}), false).unwrap();
        base.extend(change.as_object().unwrap().clone());
        base
    }

    impl World {
        fn delays(&self, id: &str) -> Vec<i64> {
            let obs = self.obs.lock().unwrap();
            obs.filters.get(id).map(|filters| filters.iter().filter(|filter| filter["filterName"].as_str().unwrap().starts_with("YUI映像同期 ")).map(|filter| filter["filterSettings"]["delay_ms"].as_i64().unwrap()).collect()).unwrap_or_default()
        }

        fn filters(&self, id: &str) -> Vec<Value> {
            self.obs.lock().unwrap().filters.get(id).cloned().unwrap_or_default()
        }

        fn writes(&self) -> usize {
            self.obs.lock().unwrap().records.iter().filter(|kind| ["CreateSourceFilter", "RemoveSourceFilter", "SetSourceFilterEnabled"].contains(&kind.as_str())).count()
        }

        fn apply(&self, change: Value, running: bool) {
            self.link.configure(&config(change), running);
            self.link.flush().unwrap();
        }

        fn until(&self, check: impl Fn(&Value) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if check(&self.link.status()) {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            panic!("never reached the expected state: {}", self.link.status());
        }
    }

    #[test]
    fn splits_delays_into_filters_of_at_most_500ms() {
        for (target, expected) in [(0, vec![]), (1, vec![1]), (500, vec![500]), (519, vec![500, 19]), (1000, vec![500, 500]), (1014, vec![500, 500, 14])] {
            assert_eq!(delay_parts(target).unwrap(), expected);
        }
        assert_eq!(delay_parts(3000).unwrap(), vec![500; 6]);
        assert!(delay_parts(-1).is_err());
        assert!(delay_parts(4001).is_err());
    }

    #[test]
    fn recognizes_video_sources() {
        for kind in ["window_capture", "window_capture_v2", "screen_capture", "dshow_input", "spout_capture", "av_capture_input_v2"] {
            assert!(is_window_capture(&json!({"inputKind": kind})), "{kind}");
        }
        for kind in ["wasapi_input_capture", "window_capture_x", "window_capture_v", "image_source"] {
            assert!(!is_window_capture(&json!({"inputKind": kind})), "{kind}");
        }
        assert!(is_window_capture(&json!({"unversionedInputKind": "dshow_input", "inputKind": "other"})));
    }

    #[test]
    fn lists_sources_on_connecting() {
        let world = world();
        world.apply(json!({}), false);
        let status = world.link.status();
        assert_eq!(status["state"], "connected");
        assert_eq!(status["inputs"].as_array().unwrap().len(), 1, "only sources with audio: {status}");
        assert_eq!(status["inputs"][0]["inputName"], "マイク");
        assert_eq!(status["videoInputs"].as_array().unwrap().len(), 2);
        assert_eq!(world.writes(), 0, "nothing changes while stopped");
    }

    #[test]
    fn delays_joysound_automatically_while_mix_runs_and_restores_it() {
        let world = world();
        world.apply(json!({}), true);
        assert_eq!(world.delays("joy"), [500]);
        let status = world.link.status();
        assert_eq!(status["appliedVideoOffset"], 500);
        assert_eq!(status["autoVideoSources"][0], "カラオケJOYSOUND for STREAMER");
        assert_eq!(world.filters("joy")[0]["filterEnabled"], false, "an existing delay is suspended");
        assert_eq!(world.filters("joy")[1]["filterEnabled"], false);
        assert_eq!(world.filters("joy")[2]["filterEnabled"], true, "other filters aren't touched");
        assert!(world.filters("cam").is_empty());

        let writes = world.writes();
        world.link.flush().unwrap();
        assert_eq!(world.writes(), writes, "applying the same again changes nothing");

        world.apply(json!({}), false);
        assert_eq!(world.filters("joy"), user_filters());
        assert_eq!(world.link.status()["autoVideoSources"], json!([]));
        assert_eq!(world.link.status()["appliedVideoOffset"], Value::Null);
    }

    #[test]
    fn correction_changes_the_delay_but_can_not_go_below_zero() {
        let world = world();
        for (correction, expected, target) in [(140, vec![500, 140], 640), (-180, vec![320], 320), (-800, vec![], 0)] {
            world.apply(json!({"obs_video_correction_ms": correction}), true);
            assert_eq!(world.delays("joy"), expected);
            assert_eq!(world.link.status()["appliedVideoOffset"], target);
        }
    }

    #[test]
    fn manual_sources_are_added_without_duplicates() {
        let world = world();
        let sources = json!([{"id": "a", "inputName": "カラオケJOYSOUND for STREAMER", "inputUuid": "joy"}, {"id": "b", "inputName": "カメラ", "inputUuid": "cam"}]);
        world.apply(json!({"mix_latency_ms": 950, "obs_video_enabled": true, "obs_video_sources": sources}), true);
        assert_eq!(world.delays("joy"), [500, 450]);
        assert_eq!(world.delays("cam"), [500, 450]);

        world.apply(json!({}), true);
        assert_eq!(world.delays("cam"), Vec::<i64>::new(), "a source no longer chosen goes back");
        assert_eq!(world.delays("joy"), [500]);

        let error = {
            world.link.configure(&config(json!({"obs_video_enabled": true, "obs_video_sources": [{"id": "x", "inputName": "ない", "inputUuid": ""}]})), true);
            world.link.flush().unwrap_err()
        };
        assert!(error.contains("「ない」が見つかりません"), "{error}");
        assert!(world.link.status()["error"].as_str().unwrap().contains("ない"));
    }

    #[test]
    fn a_failed_change_leaves_obs_as_it_was() {
        let world = world();
        world.obs.lock().unwrap().ignore = "CreateSourceFilter".to_string();
        world.link.configure(&config(json!({})), true);
        let error = world.link.flush().unwrap_err();
        assert!(error.contains("時間切れ"), "{error}");
        assert_eq!(world.filters("joy"), user_filters());
        world.obs.lock().unwrap().ignore = String::new();
        world.link.flush().unwrap();
        assert_eq!(world.delays("joy"), [500]);
        assert_eq!(world.link.status()["error"], "");
    }

    #[test]
    fn a_filter_edited_in_obs_is_left_alone() {
        let world = world();
        world.apply(json!({}), true);
        for filter in world.obs.lock().unwrap().filters.get_mut("joy").unwrap() {
            if filter["filterName"].as_str().unwrap().starts_with("YUI映像同期 ") {
                filter["filterSettings"]["delay_ms"] = json!(333);
            }
        }
        world.apply(json!({}), false);
        assert_eq!(world.delays("joy"), [333]);
        assert_eq!(world.filters("joy")[0]["filterEnabled"], true);
    }

    #[test]
    fn reconnects_when_obs_comes_back() {
        let world = world();
        world.apply(json!({}), true);
        world.obs.lock().unwrap().down = true;
        world.until(|status| status["state"] == "disconnected" || status["state"] == "connected" && status["appliedVideoOffset"] == 500);
        let deadline = Instant::now() + Duration::from_secs(5);
        while world.obs.lock().unwrap().connections < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(world.obs.lock().unwrap().connections, 2);
        world.until(|status| status["appliedVideoOffset"] == 500);
        assert_eq!(world.delays("joy"), [500], "no filters pile up");
    }

    #[test]
    fn waiting_for_obs_is_not_an_error() {
        let world = world();
        world.obs.lock().unwrap().offline = true;
        world.link.flush().unwrap();
        let status = world.link.status();
        assert_eq!(status["state"], "disconnected");
        assert_eq!(status["error"], "");
        world.obs.lock().unwrap().offline = false;
        world.until(|status| status["state"] == "connected");
    }

    #[test]
    fn undoes_what_a_crashed_run_left_behind() {
        let world = world();
        world.apply(json!({}), true);
        assert_eq!(world.delays("joy"), [500]);

        // Another instance starting from the same folder is what a restart after a crash looks like.
        let events = Arc::new(Mutex::new(Vec::new()));
        let next = fake_link(&world.home, &world.obs, &events);
        next.flush().unwrap();
        assert_eq!(world.filters("joy"), user_filters());
        assert!(fs::read_dir(world.home.join("obs-video-delays")).unwrap().next().is_none(), "the journal is gone");
        next.shutdown();
    }

    #[test]
    fn reads_a_journal_written_by_the_electron_version() {
        let home = std::env::temp_dir().join(format!("yvc-obs-{}", uuid::Uuid::new_v4()));
        let directory = home.join("obs-video-delays");
        fs::create_dir_all(&directory).unwrap();
        let id = "3a6dd4ae-a077-4707-ba36-563f8660ad14";
        let journal = json!({
            "version": 1, "id": id, "port": 4455, "input": {"inputUuid": "joy", "inputName": "J"}, "target": 500, "complete": true,
            "created": [{"name": format!("YUI映像同期 {id} 1"), "delay": 500, "kind": "yui_preview_delay"}],
            "disabled": [{"filterName": "手動", "filterKind": "gpu_delay", "filterSettings": {"delay_ms": 7}}],
        });
        fs::write(directory.join(format!("{}.json", "a".repeat(64))), journal.to_string()).unwrap();
        let mut sources = ObsVideoSources::new(&home);
        assert!(sources.pending());

        let obs = Arc::new(Mutex::new(FakeObs::default()));
        {
            let mut state = obs.lock().unwrap();
            state.inputs = vec![json!({"inputUuid": "joy", "inputName": "J", "inputKind": "spout_capture"})];
            state.filters.insert("joy".to_string(), vec![
                json!({"filterName": "手動", "filterKind": "gpu_delay", "filterEnabled": false, "filterSettings": {"delay_ms": 7}}),
                json!({"filterName": format!("YUI映像同期 {id} 1"), "filterKind": "yui_preview_delay", "filterEnabled": true, "filterSettings": {"delay_ms": 500}}),
            ]);
        }
        assert!(sources.restore(None).is_err(), "it needs OBS");
        assert!(sources.pending());
        let mut wrong = Conn::new(1, 9999, Box::new(FakeTransport(obs.clone())));
        assert!(sources.restore(Some(&mut wrong)).is_err(), "and the same OBS");
        let mut conn = Conn::new(2, 4455, Box::new(FakeTransport(obs.clone())));
        sources.restore(Some(&mut conn)).unwrap();
        assert!(!sources.pending());
        let filters = obs.lock().unwrap().filters["joy"].clone();
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0]["filterEnabled"], true);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_broken_journal_blocks_rather_than_guessing() {
        let home = std::env::temp_dir().join(format!("yvc-obs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("obs-video-delay.json"), "{broken").unwrap();
        fs::write(home.join("obs-mix-routing.json"), "{broken").unwrap();
        fs::write(home.join("obs-preview-split.json"), json!({"version": 1, "port": 1}).to_string()).unwrap();
        assert!(ObsVideoSources::new(&home).pending());
        assert!(ObsMix::new(&home, "obs-mix-routing.json").restore(None).unwrap_err().message.contains("obs-mix-routing.json"));
        assert!(ObsPreviewSplit::new(&home).restore(None).unwrap_err().message.contains("3Dプレビュー"));
        assert_eq!(fs::read_to_string(home.join("obs-video-delay.json")).unwrap(), "{broken");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn uses_the_preview_filter_when_the_plugin_offers_it() {
        let world = world();
        world.obs.lock().unwrap().filter_kinds.push(PREVIEW_FILTER.to_string());
        world.apply(json!({}), true);
        let ours = world.filters("joy").into_iter().find(|filter| filter["filterName"].as_str().unwrap().starts_with("YUI映像同期 ")).unwrap();
        assert_eq!(ours["filterKind"], PREVIEW_FILTER);
    }

    #[test]
    fn asks_before_muting_desktop_audio_and_puts_it_back() {
        let world = world();
        world.apply(json!({"mix_enabled": false}), false);
        {
            let mut obs = world.obs.lock().unwrap();
            obs.desktop = vec!["デスクトップ音声".to_string()];
            obs.inputs.push(json!({"inputUuid": "desk", "inputName": "デスクトップ音声", "inputKind": "wasapi_output_capture"}));
        }
        let asked = Mutex::new(Vec::new());
        world.link.confirm_desktop_mute(|names| {
            asked.lock().unwrap().extend_from_slice(names);
            Ok(false)
        }).unwrap();
        assert_eq!(*asked.lock().unwrap(), ["デスクトップ音声"]);
        assert!(!world.obs.lock().unwrap().muted.get("desk").copied().unwrap_or(false), "no means no");
        assert!(!world.link.keeps_desktop_muted());

        world.link.confirm_desktop_mute(|_| Ok(true)).unwrap();
        assert!(world.obs.lock().unwrap().muted["desk"]);
        assert!(world.link.keeps_desktop_muted());
        assert!(world.home.join("obs-desktop-mute.json").exists());

        world.link.confirm_desktop_mute(|_| panic!("it's already muted, so there's nothing to ask")).unwrap();

        world.link.release_desktop_mute(true).unwrap();
        assert!(!world.obs.lock().unwrap().muted["desk"]);
        assert!(!world.home.join("obs-desktop-mute.json").exists());
    }

    #[test]
    fn mute_that_someone_else_changed_is_left_alone() {
        let world = world();
        world.apply(json!({"mix_enabled": false}), false);
        {
            let mut obs = world.obs.lock().unwrap();
            obs.desktop = vec!["デスクトップ音声".to_string()];
            obs.inputs.push(json!({"inputUuid": "desk", "inputName": "デスクトップ音声", "inputKind": "wasapi_output_capture"}));
        }
        world.link.confirm_desktop_mute(|_| Ok(true)).unwrap();
        world.obs.lock().unwrap().muted.insert("desk".to_string(), false);
        world.obs.lock().unwrap().records.clear();
        world.link.release_desktop_mute(true).unwrap();
        assert!(!world.obs.lock().unwrap().records.iter().any(|kind| kind == "SetInputMute"));
    }

    #[test]
    fn shutdown_restores_everything() {
        let world = world();
        world.apply(json!({}), true);
        world.link.shutdown();
        assert_eq!(world.filters("joy"), user_filters());
        assert!(world.events.lock().unwrap().iter().any(|event| event["type"] == "obs-status"));
    }

    #[cfg(windows)]
    mod real_pipe {
        use super::*;
        use std::fs::File;
        use std::io::{BufRead, BufReader, Write};
        use std::os::windows::io::{FromRawHandle, RawHandle};
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW};

        fn serve(name: &str, handler: impl FnOnce(&mut BufReader<File>, &mut File) + Send + 'static) {
            let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
            let handle = unsafe { CreateNamedPipeW(wide.as_ptr(), 3, 0, 1, 65536, 65536, 0, std::ptr::null()) };
            assert_ne!(handle, INVALID_HANDLE_VALUE);
            let raw = handle as usize;
            thread::spawn(move || {
                let handle = raw as RawHandle;
                unsafe { ConnectNamedPipe(handle as _, std::ptr::null_mut()) };
                let mut file = unsafe { File::from_raw_handle(handle) };
                let mut reader = BufReader::new(file.try_clone().unwrap());
                handler(&mut reader, &mut file);
            });
        }

        fn unique() -> String {
            format!(r"\\.\pipe\yvc-test-{}", uuid::Uuid::new_v4())
        }

        fn reply(writer: &mut File, id: &Value, code: i64, data: Value) {
            writeln!(writer, "{}", json!({"id": id, "code": code, "data": data})).unwrap();
            writer.flush().unwrap();
        }

        #[test]
        fn exchanges_over_a_real_named_pipe() {
            let name = unique();
            serve(&name, |reader, writer| {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let first: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(first["type"], "GetVersion");
                assert_eq!(first["data"]["日本語"], "値");
                // Something stale, then the answer in two pieces.
                reply(writer, &json!("old"), 100, json!({"wrong": true}));
                let text = json!({"id": first["id"], "code": 100, "data": {"protocolVersion": 1, "名前": "あ".repeat(50_000)}}).to_string();
                let (a, b) = text.as_bytes().split_at(10);
                writer.write_all(a).unwrap();
                writer.flush().unwrap();
                thread::sleep(Duration::from_millis(30));
                writer.write_all(b).unwrap();
                writer.write_all(b"\n").unwrap();
                writer.flush().unwrap();

                line.clear();
                reader.read_line(&mut line).unwrap();
                let second: Value = serde_json::from_str(&line).unwrap();
                reply(writer, &second["id"], 604, json!(null));

                line.clear();
                reader.read_line(&mut line).unwrap();
            });
            let mut pipe = Pipe::open(&name, Duration::from_secs(5)).unwrap();
            let version = pipe.exchange("GetVersion", &json!({"日本語": "値"})).unwrap();
            assert_eq!(version["protocolVersion"], 1);
            assert_eq!(version["名前"].as_str().unwrap().chars().count(), 50_000);
            let error = pipe.exchange("GetInputMute", &json!({})).unwrap_err();
            assert_eq!(error.code, Some(604));
            assert!(pipe.alive());
        }

        #[test]
        fn notices_the_other_side_going_away() {
            let name = unique();
            serve(&name, |reader, _writer| {
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
            });
            let mut pipe = Pipe::open(&name, Duration::from_secs(5)).unwrap();
            assert!(pipe.alive());
            let error = pipe.exchange("GetVersion", &json!({})).unwrap_err();
            assert!(error.message.contains("接続が切れました"), "{}", error.message);
            assert!(!pipe.alive());
        }

        #[test]
        fn gives_up_on_a_silent_plugin() {
            let name = unique();
            let (sender, receiver) = mpsc::channel::<()>();
            serve(&name, move |reader, _writer| {
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let _ = receiver.recv();
            });
            let mut pipe = Pipe::open(&name, Duration::from_millis(100)).unwrap();
            let started = Instant::now();
            let error = pipe.exchange("GetVersion", &json!({})).unwrap_err();
            assert!(error.message.contains("時間切れ"));
            assert!(started.elapsed() < Duration::from_secs(2));
            assert!(pipe.alive());
            drop(sender);
        }

        #[test]
        fn a_missing_pipe_means_obs_is_not_running_yet() {
            assert!(Pipe::open(&unique(), Duration::from_millis(100)).err().unwrap().unavailable);
        }
    }
}
