//! Moved from electron/main.cjs: the actions the screen can ask for, and the Python worker's life.

use crate::calibration::Calibration;
use crate::config::{adopt_manual_timing, live_controls, load_config, normalize, offset_for, Config, OBS_CONNECTION_KEYS};
use crate::model_history::ModelHistory;
use crate::obs::ObsLink;
use crate::presets::Presets;
use crate::runtime::no_window;
use crate::training::Training;
use crate::util::{is_file, local_now, same, same_file, write_atomic};
use crate::{diagnostic_log, icons, obs_plugin, official, runtime, tools};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};

const SAVE_DELAY: Duration = Duration::from_millis(300);
const MODEL_EXTENSIONS: [&str; 6] = ["gz", "pt", "toml", "bin", "pth", "onnx"];
const ICON_EXTENSIONS: [&str; 4] = ["ico", "png", "jpg", "jpeg"];

/// What the logic needs from the desktop. Tauri provides it, and the tests fake it.
pub trait Host: Send + Sync {
    fn emit(&self, event: &Value);
    fn pick_file(&self, filter_name: &str, extensions: &[&str], directory: Option<PathBuf>) -> Option<PathBuf>;
    fn pick_folder(&self, directory: Option<PathBuf>) -> Option<PathBuf>;
    fn save_file(&self, default_name: &str, filter_name: &str, extensions: &[&str]) -> Option<PathBuf>;
    fn pictures_dir(&self) -> Option<PathBuf>;
    fn open_url(&self, url: &str) -> Result<(), String>;
    /// Shows a file in Explorer.
    fn reveal_file(&self, file: &Path);
    /// The app's version, and what it runs on for a bug report, such as "WebView2 145.0".
    fn versions(&self) -> (String, String);
    /// A yes or no question. Only an explicit yes returns true.
    fn confirm(&self, title: &str, message: &str, detail: &str) -> bool;
    /// Registers or clears the global hotkeys, and returns those that couldn't be registered.
    fn set_hotkeys(&self, enabled: bool) -> Vec<String>;
}

pub struct Paths {
    pub home: PathBuf,
    /// Holds backend/ with the Python code.
    pub engine_root: PathBuf,
    /// Holds README.md, docs/, LICENSE and THIRD_PARTY_NOTICES.md.
    pub docs_root: PathBuf,
    /// Where the Electron version kept its config long ago.
    pub legacy_config: Option<PathBuf>,
    /// The named pipe of our OBS plugin.
    pub obs_pipe: String,
    /// Holds obs-studio/plugins, where OBS looks for plugins.
    pub program_data: Option<PathBuf>,
}

struct Worker {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    finished: Mutex<bool>,
    finished_changed: Condvar,
}

impl Worker {
    fn write(&self, message: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or("音声プロセスが未起動です。環境をセットアップしてください。")?;
        writeln!(stdin, "{message}")
            .and_then(|()| stdin.flush())
            .map_err(|_| "音声プロセスが未起動です。環境をセットアップしてください。".to_string())
    }

    fn wait_finished(&self, timeout: Duration) -> bool {
        let guard = self.finished.lock().unwrap();
        let (guard, _) = self.finished_changed.wait_timeout_while(guard, timeout, |finished| !*finished).unwrap();
        *guard
    }

    fn kill(&self) {
        // A venv's python.exe is a launcher, and only closing the input reaches the real Python behind it.
        *self.stdin.lock().unwrap() = None;
        let _ = self.child.lock().unwrap().kill();
    }
}

struct State {
    config: Config,
    engine_state: String,
    worker: Option<Arc<Worker>>,
    worker_python: String,
    connecting: bool,
    setting_up: bool,
    preset_switching: bool,
    preset_abort: Option<Arc<AtomicBool>>,
    start_token: u64,
    muted: bool,
    quitting: bool,
    audio_devices: Option<Vec<Value>>,
    save_pending: bool,
    setup_cancel: Option<Arc<AtomicBool>>,
    official_cancel: Option<Arc<AtomicBool>>,
    icon_directory: Option<PathBuf>,
    history: ModelHistory,
    presets: Presets,
    hotkeys: Value,
    installing_obs_plugin: bool,
    config_error: Option<String>,
}

pub struct App {
    host: Arc<dyn Host>,
    paths: Paths,
    config_file: PathBuf,
    state: Mutex<State>,
    boot_lock: Mutex<()>,
    listeners: Mutex<Vec<Sender<Value>>>,
    obs: ObsLink,
    calibration: Calibration,
    training: Training,
}

#[derive(Default, Clone, Copy)]
struct SaveOptions {
    preset: bool,
    engine_timing: bool,
    deferred: bool,
}

fn config_value(config: &Config) -> Value {
    Value::Object(config.clone())
}

// The directory to open a file dialog in: the nearest one that still exists.
fn picker_directory(value: Option<&str>) -> Option<PathBuf> {
    let value = value.filter(|text| !text.trim().is_empty())?;
    let mut directory = crate::util::resolve(value);
    loop {
        if directory.is_dir() {
            return Some(directory);
        }
        directory = directory.parent()?.to_path_buf();
    }
}

impl App {
    pub fn new(host: Arc<dyn Host>, paths: Paths) -> Arc<Self> {
        let config_file = paths.home.join("desktop.json");
        let source = match &paths.legacy_config {
            Some(legacy) if !config_file.exists() => legacy.clone(),
            _ => config_file.clone(),
        };
        let loaded = load_config(&source, &paths.home);
        let is_v2 = loaded.saved.get("engine_version").is_some_and(|version| same(version, &json!(2)));
        let has_saved = loaded.saved.as_object().is_some_and(|saved| !saved.is_empty());
        if !is_v2 && has_saved && source.exists() {
            let backup = paths.home.join("desktop-before-direct-gpu.json");
            if !backup.exists() {
                let _ = fs::create_dir_all(&paths.home);
                let _ = fs::copy(&source, backup);
            }
        }
        let state = State {
            config: loaded.config,
            engine_state: "stopped".to_string(),
            worker: None,
            worker_python: String::new(),
            connecting: false,
            setting_up: false,
            preset_switching: false,
            preset_abort: None,
            start_token: 0,
            muted: false,
            quitting: false,
            audio_devices: None,
            save_pending: false,
            setup_cancel: None,
            official_cancel: None,
            icon_directory: None,
            history: ModelHistory::new(&paths.home),
            presets: Presets::new(&paths.home),
            hotkeys: json!({"enabled": false, "failed": []}),
            installing_obs_plugin: false,
            config_error: loaded.error,
        };
        Arc::new_cyclic(|this: &Weak<Self>| {
            let weak = this.clone();
            let notify: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |event| {
                if let Some(app) = weak.upgrade() {
                    app.send(event);
                }
            });
            let before = this.clone();
            let complete = this.clone();
            let calibration = Calibration::new(
                paths.engine_root.clone(),
                notify.clone(),
                Arc::new(move || {
                    if let Some(app) = before.upgrade() {
                        let _guard = app.boot_lock.lock().unwrap();
                        app.stop_worker();
                    }
                    Ok(())
                }),
                Arc::new(move |result| {
                    let app = complete.upgrade().ok_or("アプリを終了しています。")?;
                    let next = app.with_config(json!({"singing_enabled": true, "singing_latency_ms": result["recommended_ms"], "obs_delay_manual": false}));
                    let saved = app.save(next, SaveOptions::default())?;
                    let saved = config_value(&saved);
                    result["total_delay_ms"] = json!(offset_for(&saved)?);
                    Ok(saved)
                }),
            );
            Self {
                obs: ObsLink::new(&paths.home, &paths.obs_pipe, notify.clone()),
                training: Training::new(&paths.home, &paths.engine_root, notify),
                calibration,
                host,
                paths,
                config_file,
                state: Mutex::new(state),
                boot_lock: Mutex::new(()),
                listeners: Mutex::new(Vec::new()),
            }
        })
    }

    fn sync_obs(&self) {
        let (config, running) = {
            let st = self.st();
            (st.config.clone(), st.engine_state == "running")
        };
        self.obs.configure(&config, running);
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    /// Call once the window exists.
    pub fn started(&self) {
        let enabled = self.st().config["hotkeys_enabled"] == json!(true);
        let failed = self.host.set_hotkeys(enabled);
        self.st().hotkeys = json!({"enabled": enabled, "failed": failed});
    }

    /// Call once the screen has loaded, so it can show a startup problem.
    pub fn screen_ready(&self) {
        let error = self.st().config_error.take();
        if let Some(message) = error {
            self.send(json!({"type": "error", "message": message}));
        }
        self.sync_obs();
        self.obs.sync_soon();
    }

    fn subscribe(&self) -> Receiver<Value> {
        let (sender, receiver) = mpsc::channel();
        self.listeners.lock().unwrap().push(sender);
        receiver
    }

    fn send(&self, mut event: Value) {
        let kind = event["type"].as_str().unwrap_or_default().to_string();
        if kind == "devices" {
            self.st().audio_devices = event["devices"].as_array().cloned();
        }
        if kind == "state" && event["state"] == "running" && event.get("manual_timing").is_some_and(|timing| !timing.is_null()) {
            let adopted = adopt_manual_timing(&self.st().config, &event["manual_timing"]);
            if let Some(next) = adopted {
                match self.save(config_value(&next), SaveOptions { engine_timing: true, ..SaveOptions::default() }) {
                    Ok(config) => event["config"] = config_value(&config),
                    Err(error) => {
                        self.send(json!({"type": "error", "message": format!("遅延設定の保存に失敗しました。{error}")}));
                        event["config"] = config_value(&self.st().config);
                    }
                }
            }
        }
        if kind == "state" {
            self.st().engine_state = event["state"].as_str().unwrap_or("stopped").to_string();
            self.sync_obs();
        }
        self.host.emit(&event);
        self.listeners.lock().unwrap().retain(|listener| listener.send(event.clone()).is_ok());
    }

    fn publish_presets(&self) {
        let list = {
            let st = self.st();
            st.presets.list(Some(&st.config))
        };
        if let Ok(items) = list {
            self.send(json!({"type": "presets", "items": items}));
        }
    }

    fn write_config(&self) -> Result<(), String> {
        let config = {
            let mut st = self.st();
            st.save_pending = false;
            config_value(&st.config)
        };
        let text = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
        write_atomic(&self.config_file, text.as_bytes())
    }

    // Slider drags change the config many times a second; the audio follows at once and the disk catches up.
    fn write_config_soon(self: &Arc<Self>) {
        {
            let mut st = self.st();
            if st.save_pending {
                return;
            }
            st.save_pending = true;
        }
        let this = self.clone();
        thread::spawn(move || {
            thread::sleep(SAVE_DELAY);
            if this.st().save_pending {
                if let Err(error) = this.write_config() {
                    this.send(json!({"type": "error", "message": format!("設定の保存に失敗しました。{error}")}));
                }
            }
        });
    }

    fn request(&self, command: &str, payload: Value) -> Result<(), String> {
        let worker = self.st().worker.clone().ok_or("音声プロセスが未起動です。環境をセットアップしてください。")?;
        let mut message = json!({"command": command});
        if let (Some(target), Some(extra)) = (message.as_object_mut(), payload.as_object()) {
            target.extend(extra.clone());
        }
        worker.write(&message)
    }

    fn save_now(self: &Arc<Self>, next: Value) -> Result<Config, String> {
        self.save_with(next, SaveOptions::default())
    }

    // send() calls this from worker threads, without needing the Arc.
    fn save(&self, next: Value, options: SaveOptions) -> Result<Config, String> {
        let clean = normalize(&next, false)?;
        self.apply_save(clean, options)?;
        self.write_config()?;
        self.after_save();
        Ok(self.st().config.clone())
    }

    fn save_with(self: &Arc<Self>, next: Value, options: SaveOptions) -> Result<Config, String> {
        let clean = normalize(&next, false)?;
        self.apply_save(clean, options)?;
        if options.deferred {
            self.write_config_soon();
        } else {
            self.write_config()?;
        }
        self.after_save();
        Ok(self.st().config.clone())
    }

    fn apply_save(&self, clean: Config, options: SaveOptions) -> Result<(), String> {
        let (current, engine_state) = {
            let st = self.st();
            (st.config.clone(), st.engine_state.clone())
        };
        if !options.engine_timing && self.calibration.busy() && clean.iter().any(|(key, value)| !same(value, &current[key])) {
            return Err("自動設定の測定が終わるまでお待ちください。".to_string());
        }
        if !options.preset && engine_state != "stopped" && OBS_CONNECTION_KEYS.iter().any(|key| !same(&current[*key], &clean[*key])) {
            return Err("変換を停止してからOBSのポート・伴奏ソースを変更してください。".to_string());
        }
        let controls = if options.engine_timing { None } else { live_controls(&current, &clean, &engine_state)? };
        if let Some(controls) = controls {
            let effect_keys: Vec<String> = crate::config::effect_defaults().keys().cloned().collect();
            let mut payload = json!({"controls": controls});
            if effect_keys.iter().any(|key| !same(&current[key], &clean[key])) {
                payload["effects"] = Value::Object(effect_keys.iter().map(|key| (key.clone(), clean[key].clone())).collect());
            }
            self.request("update-controls", payload)?;
            if !same(&clean["mix_music_gain"], &current["mix_music_gain"]) {
                self.request("update-mix", json!({"gain": clean["mix_music_gain"]}))?;
            }
        }
        let hotkeys_changed = !same(&clean["hotkeys_enabled"], &current["hotkeys_enabled"]);
        self.st().config = clean;
        self.sync_obs();
        if hotkeys_changed {
            let enabled = self.st().config["hotkeys_enabled"] == json!(true);
            let failed = self.host.set_hotkeys(enabled);
            let status = json!({"enabled": enabled, "failed": failed});
            self.st().hotkeys = status.clone();
            let mut event = status;
            event["type"] = json!("hotkeys");
            self.send(event);
        }
        Ok(())
    }

    fn after_save(&self) {
        let remembered = {
            let mut st = self.st();
            let config = st.config.clone();
            st.history.remember(&config).unwrap_or(false)
        };
        if remembered {
            self.publish_models();
        }
        self.publish_presets();
    }

    fn publish_models(&self) -> Value {
        let models = self.st().history.list_value();
        self.send(json!({"type": "model-history", "models": models}));
        models
    }

    fn stop_worker(&self) {
        let Some(worker) = self.st().worker.clone() else { return };
        if worker.write(&json!({"command": "quit"})).is_err() {
            worker.kill();
        }
        if !worker.wait_finished(Duration::from_secs(20)) {
            worker.kill();
            worker.wait_finished(Duration::from_secs(5));
        }
    }

    fn boot(self: &Arc<Self>) -> Result<(), String> {
        let _guard = self.boot_lock.lock().unwrap();
        let python = {
            let st = self.st();
            let python = st.config["python"].as_str().unwrap_or_default().to_string();
            if st.worker.is_some() && st.worker_python == python {
                return Ok(());
            }
            python
        };
        if python.is_empty() {
            return Err("必要な環境を自動セットアップしてください。".to_string());
        }
        self.st().connecting = true;
        let result = self.boot_worker(&python);
        self.st().connecting = false;
        result
    }

    fn boot_worker(self: &Arc<Self>, python: &str) -> Result<(), String> {
        self.stop_worker();
        if !is_file(python) {
            return Err("環境設定でPython実行ファイルを指定してください。".to_string());
        }
        let script = self.paths.engine_root.join("backend").join("worker.py");
        if !script.exists() {
            return Err("音声処理ファイルが見つかりません。アプリをすべて展開してください。".to_string());
        }
        let logs = self.paths.home.join("logs");
        fs::create_dir_all(&logs).map_err(|error| error.to_string())?;
        let log_path = logs.join("independent-engine.log");

        let mut command = Command::new(python);
        command
            .args(["-I", "-u"])
            .arg(&script)
            .current_dir(&self.paths.engine_root)
            .env("PYTHONIOENCODING", "utf-8")
            .env("OMP_NUM_THREADS", "2")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window(&mut command);
        let mut child = command.spawn().map_err(|error| format!("Pythonを起動できません ({error}): {python}"))?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let stdin = child.stdin.take().expect("stdin is piped");
        let worker = Arc::new(Worker {
            child: Mutex::new(child),
            stdin: Mutex::new(Some(stdin)),
            finished: Mutex::new(false),
            finished_changed: Condvar::new(),
        });
        {
            let mut st = self.st();
            st.worker = Some(worker.clone());
            st.worker_python = python.to_string();
        }

        let stderr_log = OpenOptions::new().create(true).append(true).open(&log_path).ok();
        thread::spawn(move || {
            let Some(mut log) = stderr_log else { return };
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut log);
        });

        let (ready_sender, ready_receiver) = mpsc::channel::<Result<(), String>>();
        let this = self.clone();
        let reader_worker = worker.clone();
        let python_name = python.to_string();
        thread::spawn(move || {
            let mut log: Option<File> = OpenOptions::new().create(true).append(true).open(&log_path).ok();
            let mut ready = false;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                match serde_json::from_str::<Value>(&line) {
                    Ok(event) => {
                        let is_ready = event["type"] == "ready";
                        this.send(event);
                        if is_ready {
                            ready = true;
                            let _ = ready_sender.send(Ok(()));
                        }
                    }
                    Err(_) => {
                        if let Some(log) = log.as_mut() {
                            let _ = writeln!(log, "{line}");
                        }
                    }
                }
            }
            let code = reader_worker.child.lock().unwrap().wait().ok().and_then(|status| status.code());
            let (connecting, quitting) = {
                let mut st = this.st();
                if st.worker.as_ref().is_some_and(|current| Arc::ptr_eq(current, &reader_worker)) {
                    st.worker = None;
                }
                (st.connecting, st.quitting)
            };
            if !connecting {
                this.send(json!({"type": "state", "state": "stopped"}));
            }
            if !ready {
                let _ = ready_sender.send(Err(format!("Python環境を起動できませんでした。Python 3.15の環境をセットアップしてください。（{python_name}）")));
            } else if !quitting && code.is_some_and(|code| code != 0) {
                this.send(json!({"type": "error", "message": format!("音声処理が終了しました ({})。環境を確認してください。", code.unwrap_or(-1))}));
            }
            *reader_worker.finished.lock().unwrap() = true;
            reader_worker.finished_changed.notify_all();
        });

        match ready_receiver.recv_timeout(Duration::from_secs(30)) {
            Ok(result) => result,
            Err(_) => {
                worker.kill();
                Err("Pythonの起動が時間切れになりました。環境を確認してください。".to_string())
            }
        }
    }

    fn engine_start_config(&self) -> Value {
        let st = self.st();
        let mut config = st.config.clone();
        if st.muted {
            config.insert("muted".to_string(), json!(true));
        }
        Value::Object(config)
    }

    fn set_muted(&self, value: &Value) -> Result<Value, String> {
        let wanted = value.as_bool().ok_or("ミュートの指定が正しくありません。")?;
        let (state, switching) = {
            let st = self.st();
            (st.engine_state.clone(), st.preset_switching)
        };
        if state != "running" && !switching {
            return Err("声変換の実行中だけミュートできます。".to_string());
        }
        if state == "running" {
            self.request("set-mute", json!({"muted": wanted}))?;
        }
        self.st().muted = wanted;
        self.send(json!({"type": "mute", "muted": wanted}));
        Ok(json!(wanted))
    }

    /// From the global hotkey.
    pub fn hotkey_mute(&self) {
        let muted = self.st().muted;
        if let Err(message) = self.set_muted(&json!(!muted)) {
            self.send(json!({"type": "notice", "message": message}));
        }
    }

    /// From the global hotkey.
    pub fn hotkey_preset(self: &Arc<Self>, index: usize) {
        let item = self.st().presets.items.get(index).cloned();
        let Some(item) = item else {
            self.send(json!({"type": "notice", "message": format!("{}番目のプリセットはまだありません。", index + 1)}));
            return;
        };
        let id = item["id"].as_str().unwrap_or_default();
        match self.apply_preset(id) {
            Ok(_) => {
                let config = config_value(&self.st().config);
                self.send(json!({"type": "preset-config", "config": config}));
                self.send(json!({"type": "notice", "message": format!("「{}」を適用しました。", item["name"].as_str().unwrap_or_default())}));
            }
            Err(message) => self.send(json!({"type": "error", "message": message})),
        }
    }

    fn start_preset_engine(self: &Arc<Self>, abort: &AtomicBool, label: &str) -> Result<(), String> {
        let stopped = format!("{label}を中止しました。");
        let aborted = |this: &Self| abort.load(Ordering::SeqCst) || this.st().quitting;
        if aborted(self) {
            return Err(stopped);
        }
        self.send(json!({"type": "state", "state": "loading"}));
        self.boot()?;
        if aborted(self) {
            return Err(stopped);
        }
        let events = self.subscribe();
        self.request("start", json!({"config": self.engine_start_config()}))?;
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut detail = String::new();
        loop {
            if abort.load(Ordering::SeqCst) {
                return Err(stopped);
            }
            if Instant::now() >= deadline {
                return Err(format!("{label}の読み込みが時間切れになりました。"));
            }
            match events.recv_timeout(Duration::from_millis(50)) {
                Ok(event) => {
                    if event["type"] == "error" {
                        detail = event["message"].as_str().unwrap_or_default().to_string();
                    }
                    if event["type"] == "state" && event["state"] == "running" {
                        return Ok(());
                    }
                    if event["type"] == "state" && event["state"] == "stopped" {
                        return Err(if detail.is_empty() { "音声変換を開始できませんでした。".to_string() } else { detail });
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err("音声変換を開始できませんでした。".to_string()),
            }
        }
    }

    fn stop_preset_engine(&self, reuse_worker: bool, abort: &AtomicBool) -> Result<(), String> {
        if !reuse_worker || self.st().worker.is_none() {
            self.stop_worker();
            return Ok(());
        }
        if self.st().engine_state == "stopped" {
            return Ok(());
        }
        let events = self.subscribe();
        let result = (|| {
            if abort.load(Ordering::SeqCst) {
                return Err("プリセットの切り替えを中止しました。".to_string());
            }
            self.request("stop", json!({}))?;
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if abort.load(Ordering::SeqCst) {
                    return Err("プリセットの切り替えを中止しました。".to_string());
                }
                if Instant::now() >= deadline {
                    return Err("音声の停止が時間切れになりました。".to_string());
                }
                match events.recv_timeout(Duration::from_millis(50)) {
                    Ok(event) if event["type"] == "state" && event["state"] == "stopped" => return Ok(()),
                    Err(RecvTimeoutError::Disconnected) => return Err("音声の停止に失敗しました。".to_string()),
                    _ => {}
                }
            }
        })();
        if result.is_err() {
            self.stop_worker();
        }
        result
    }

    fn apply_preset(self: &Arc<Self>, id: &str) -> Result<Value, String> {
        const BUSY: &str = "準備・停止・学習・自動設定が終わってからプリセットを適用してください。";
        let (previous, next, running) = {
            let st = self.st();
            if self.training.busy() || self.calibration.busy() || st.setting_up || st.preset_switching || !["stopped", "running"].contains(&st.engine_state.as_str()) {
                return Err(BUSY.to_string());
            }
            let next = st.presets.apply(id, &st.config, st.audio_devices.as_ref())?;
            (st.config.clone(), next, st.engine_state == "running")
        };
        let mut restart = false;
        if running {
            let unset = next["beatrice_model"].as_str().unwrap_or_default().is_empty() || next["input"].as_f64().unwrap_or(-1.0) < 0.0 || next["output"].as_f64().unwrap_or(-1.0) < 0.0;
            if unset {
                return Err("モデル・マイク・出力先を選択したプリセットを使用してください。".to_string());
            }
            restart = live_controls(&previous, &next, "running").is_err();
        }
        if !restart {
            self.save_with(config_value(&next), SaveOptions { preset: true, ..SaveOptions::default() })?;
            self.st().presets.mark_applied(id)?;
            self.publish_presets();
            return Ok(config_value(&self.st().config));
        }
        let reuse_worker = ["python", "compute", "beatrice_voice"].iter().all(|key| same(&previous[*key], &next[*key]))
            && same_file(previous["beatrice_model"].as_str().unwrap_or_default(), next["beatrice_model"].as_str().unwrap_or_default());
        let abort = Arc::new(AtomicBool::new(false));
        {
            let mut st = self.st();
            st.preset_switching = true;
            st.preset_abort = Some(abort.clone());
        }
        self.send(json!({"type": "preset-switch", "busy": true}));
        let result = self.switch_preset(id, &previous, &next, reuse_worker, &abort);
        {
            let mut st = self.st();
            st.preset_switching = false;
            st.preset_abort = None;
        }
        self.send(json!({"type": "preset-switch", "busy": false}));
        result
    }

    fn switch_preset(self: &Arc<Self>, id: &str, previous: &Config, next: &Config, reuse_worker: bool, abort: &AtomicBool) -> Result<Value, String> {
        let stopping = |this: &Self| abort.load(Ordering::SeqCst) || this.st().quitting;
        let attempt = (|| {
            self.send(json!({"type": "state", "state": "stopping"}));
            self.stop_preset_engine(reuse_worker, abort)?;
            if stopping(self) {
                return Err("プリセットの切り替えを中止しました。".to_string());
            }
            self.save_now(config_value(next))?;
            let config = config_value(&self.st().config);
            self.send(json!({"type": "preset-config", "config": config}));
            self.start_preset_engine(abort, "プリセットの切り替え")?;
            self.st().presets.mark_applied(id)?;
            self.publish_presets();
            Ok(config_value(&self.st().config))
        })();
        let Err(error) = attempt else { return attempt };
        // An explicit Stop or quit never restarts either voice.
        if stopping(self) {
            return Err(error);
        }
        let _ = self.stop_preset_engine(reuse_worker, abort);
        self.send(json!({"type": "state", "state": "stopped"}));
        self.save_now(config_value(previous))?;
        let config = config_value(&self.st().config);
        self.send(json!({"type": "preset-config", "config": config}));
        if stopping(self) {
            return Err(error);
        }
        if let Err(restore_error) = self.start_preset_engine(abort, "プリセットの切り替え") {
            let _ = self.stop_preset_engine(reuse_worker, abort);
            self.send(json!({"type": "state", "state": "stopped"}));
            if stopping(self) {
                return Err("プリセットの切り替えを中止しました。".to_string());
            }
            return Err(format!("プリセットを切り替えられませんでした。元の設定へ戻しましたが、変換を再開できませんでした。{error} {restore_error}"));
        }
        Err(format!("プリセットを切り替えられませんでした。元の設定で変換を再開しました。{error}"))
    }

    fn set_singing_mode(self: &Arc<Self>, enabled: bool) -> Result<Value, String> {
        const BUSY: &str = "声変換を停止してから歌枠モードに切り替えてください。";
        let stopped = |this: &Self| if this.st().engine_state == "stopped" { Ok(()) } else { Err(BUSY.to_string()) };
        stopped(self)?;
        let mix = enabled;
        if mix && self.st().config["mix_enabled"] != true {
            self.obs.confirm_desktop_mute(|names| {
                stopped(self)?;
                Ok(self.host.confirm(
                    "歌枠モード",
                    "音が二重にならないようにデスクトップ音声をオフにしますか？",
                    &format!("{} をOBSでミュートします。歌枠モードを解除すると元に戻します。", names.join("、")),
                ))
            })?;
        }
        match self.save_now(self.with_config(json!({"singing_enabled": enabled, "mix_enabled": mix}))) {
            Ok(next) => {
                if !enabled {
                    let _ = self.obs.release_desktop_mute(true);
                }
                Ok(json!({"singing_enabled": next["singing_enabled"], "mix_enabled": next["mix_enabled"]}))
            }
            Err(error) => {
                if mix && self.obs.keeps_desktop_muted() {
                    self.obs.release_desktop_mute(false)?;
                }
                Err(error)
            }
        }
    }

    fn export_log(&self) -> Result<Value, String> {
        let log_file = self.paths.home.join("logs").join("independent-engine.log");
        if !log_file.exists() {
            return Err(diagnostic_log::MISSING_LOG.to_string());
        }
        let now = local_now();
        let name = format!("YuiVoiceChanger-log-{}{:02}{:02}-{:02}{:02}.txt", now.year, now.month, now.day, now.hour, now.minute);
        let Some(output) = self.host.save_file(&name, "テキスト", &["txt"]) else { return Ok(Value::Null) };
        let (version, runtime) = self.host.versions();
        let saved_at = format!("{}/{}/{} {}:{:02}:{:02}", now.year, now.month, now.day, now.hour, now.minute, now.second);
        let args = ["/c", "ver"].map(str::to_string);
        let cmd = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())).join("System32\\cmd.exe");
        let reported = runtime::run(&cmd, &args, runtime::RunOptions::default()).unwrap_or_default();
        let release = reported.split_whitespace().last().unwrap_or_default().trim_end_matches(']').to_string();
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let info = diagnostic_log::Info { version: &version, runtime: &runtime, release: &release, saved_at: &saved_at };
        diagnostic_log::export_diagnostic_log(&log_file, &output, &home, &info)?;
        self.host.reveal_file(&output);
        Ok(json!(output.to_string_lossy()))
    }

    fn install_plugin(&self) -> Result<Value, String> {
        {
            let mut st = self.st();
            if st.installing_obs_plugin {
                return Err("OBSプラグインを導入中です。".to_string());
            }
            st.installing_obs_plugin = true;
        }
        let source = self.paths.engine_root.join("obs-plugin").join("yui-live-preview.dll");
        let result = obs_plugin::install_obs_plugin(&source, self.paths.program_data.clone());
        self.st().installing_obs_plugin = false;
        result
    }

    fn require_idle(&self, message: &str) -> Result<(), String> {
        let busy = self.training.busy() || self.calibration.busy();
        let st = self.st();
        if busy || st.setting_up || st.engine_state != "stopped" {
            return Err(message.to_string());
        }
        Ok(())
    }

    fn python(&self) -> String {
        self.st().config["python"].as_str().unwrap_or_default().to_string()
    }

    fn inspect(&self, python: &str, file: &str) -> Result<Value, String> {
        tools::inspect(python, &self.paths.engine_root, &self.paths.home, file)
    }

    fn pick_icon(&self) -> Option<PathBuf> {
        let directory = self.st().icon_directory.clone().or_else(|| self.host.pictures_dir());
        self.host.pick_file("アイコン画像", &ICON_EXTENSIONS, directory)
    }

    fn store_icon(&self, file: &Path) -> Result<String, String> {
        let icon = icons::store_icon(&self.paths.home, file)?;
        self.st().icon_directory = file.parent().map(Path::to_path_buf);
        Ok(icon)
    }

    fn library_action(self: &Arc<Self>, action: &str, payload: &Value) -> Result<Value, String> {
        const BUSY: &str = "変換や学習を停止してからモデル一覧を変更してください。";
        self.require_idle(BUSY)?;
        if action == "add-library-model" {
            let directory = picker_directory(self.st().config["beatrice_model"].as_str());
            let Some(selected) = self.host.pick_file("音声モデル", &MODEL_EXTENSIONS, directory) else { return Ok(Value::Null) };
            self.require_idle(BUSY)?;
            let mut file = selected.to_string_lossy().into_owned();
            let lower = file.to_lowercase();
            if lower.ends_with(".pth") || lower.ends_with(".onnx") {
                return Ok(json!({"training_source": file}));
            }
            let python = self.python();
            if !python.is_empty() {
                let info = self.inspect(&python, &file)?;
                let path = info["path"].as_str().unwrap_or(&file).to_string();
                if info["train_required"] == json!(true) {
                    return Ok(json!({"training_source": path}));
                }
                file = path;
            }
            self.require_idle(BUSY)?;
            {
                let mut st = self.st();
                let previous = st.history.find_by_path(&file, &json!(0));
                let alias = previous.as_ref().map(|item| item["alias"].clone()).unwrap_or(json!(""));
                let icon = previous.as_ref().map(|item| item["icon"].clone()).unwrap_or(json!(""));
                let entry = json!({"beatrice_model": file, "beatrice_voice": 0, "beatrice_model_alias": alias, "beatrice_model_icon": icon});
                st.history.remember(entry.as_object().expect("an object"))?;
            }
            let models = self.publish_models();
            let id = self.st().history.find_by_path(&file, &json!(0)).map(|item| item["id"].clone()).ok_or("Beatriceの.pt.gz・.pt・.toml・.binを選んでください。")?;
            return Ok(json!({"models": models, "id": id}));
        }
        let id = payload["id"].as_str().unwrap_or_default();
        let item = self.st().history.find_by_id(id).ok_or("モデルが一覧に見つかりません。")?;
        let is_current = {
            let st = self.st();
            let model = st.config["beatrice_model"].as_str().unwrap_or(".");
            same_file(item["path"].as_str().unwrap_or_default(), if model.is_empty() { "." } else { model }) && same(&item["voice"], &st.config["beatrice_voice"])
        };
        if action == "pick-library-icon" {
            let Some(file) = self.pick_icon() else { return Ok(Value::Null) };
            self.require_idle(BUSY)?;
            let icon = self.store_icon(&file)?;
            return Ok(json!({"icon": icon, "data": icons::read_icon(&self.paths.home, &icon)?}));
        }
        let config = config_value(&self.st().config);
        if action == "edit-library-model" {
            let clean = normalize(&json!({"beatrice_model_alias": payload.get("alias").cloned().unwrap_or(json!("")), "beatrice_model_icon": payload.get("icon").cloned().unwrap_or(json!(""))}), false)?;
            let alias = clean["beatrice_model_alias"].as_str().unwrap_or_default().trim().to_string();
            let icon = clean["beatrice_model_icon"].as_str().unwrap_or_default().to_string();
            self.st().history.edit(id, &alias, &icon)?;
            if is_current {
                let mut next = config;
                next["beatrice_model_alias"] = json!(alias);
                next["beatrice_model_icon"] = json!(icon);
                self.save_now(next)?;
            }
        } else {
            self.st().history.remove(id)?;
            if is_current {
                let mut next = config;
                next["beatrice_model"] = json!("");
                next["beatrice_voice"] = json!(0);
                next["beatrice_model_alias"] = json!("");
                next["beatrice_model_icon"] = json!("");
                self.save_now(next)?;
            }
        }
        let models = self.publish_models();
        Ok(json!({"models": models, "config": config_value(&self.st().config)}))
    }

    fn check_selection(&self, payload: &Value, busy: &str, changed: &str) -> Result<(), String> {
        self.require_idle(busy)?;
        let st = self.st();
        let model = st.config["beatrice_model"].as_str().unwrap_or_default();
        let matches = !model.is_empty() && payload["path"].as_str().is_some_and(|path| same_file(path, model)) && same(&payload["voice"], &st.config["beatrice_voice"]);
        if matches {
            Ok(())
        } else {
            Err(changed.to_string())
        }
    }

    fn with_config(&self, change: Value) -> Value {
        let mut next = self.st().config.clone();
        if let Some(change) = change.as_object() {
            next.extend(change.clone());
        }
        Value::Object(next)
    }

    fn install_official(self: &Arc<Self>, payload: &Value) -> Result<Value, String> {
        if payload["agreed"] != json!(true) {
            return Err("公式モデルの利用規約への同意が必要です。".to_string());
        }
        self.require_idle("変換と学習を停止してから導入してください。")?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut st = self.st();
            st.setting_up = true;
            st.official_cancel = Some(cancel.clone());
        }
        let result = (|| {
            let progress = |message: &str| self.send(json!({"type": "official-model-progress", "message": message}));
            let selected = official::install_official(&self.paths.home, &cancel, &progress)?;
            let voice = json!(selected.voice);
            let previous = self.st().history.find_by_path(&selected.model, &voice);
            let icon = match previous.as_ref().and_then(|item| item["icon"].as_str()).filter(|icon| !icon.is_empty()) {
                Some(icon) => icon.to_string(),
                None => {
                    let picture = Path::new(&selected.model).parent().unwrap_or(Path::new(".")).join("tsukuyomichan.png");
                    icons::store_icon(&self.paths.home, &picture)?
                }
            };
            let alias = previous.as_ref().and_then(|item| item["alias"].as_str()).filter(|alias| !alias.is_empty()).unwrap_or("つくよみちゃん").to_string();
            let entry = json!({"beatrice_model": selected.model, "beatrice_voice": voice, "beatrice_model_alias": alias, "beatrice_model_icon": icon});
            self.st().history.remember(entry.as_object().expect("an object"))?;
            let is_current = {
                let st = self.st();
                let model = st.config["beatrice_model"].as_str().unwrap_or_default();
                !model.is_empty() && same_file(model, &selected.model) && same(&st.config["beatrice_voice"], &voice)
            };
            if is_current {
                self.save_now(self.with_config(json!({"beatrice_model_alias": alias, "beatrice_model_icon": icon})))?;
            }
            let models = self.publish_models();
            let id = self.st().history.find_by_path(&selected.model, &voice).map(|item| item["id"].clone()).unwrap_or(Value::Null);
            Ok(json!({"models": models, "id": id, "config": config_value(&self.st().config)}))
        })();
        let mut st = self.st();
        st.setting_up = false;
        st.official_cancel = None;
        drop(st);
        result
    }

    fn setup_runtime(self: &Arc<Self>) -> Result<Value, String> {
        self.require_idle("変換と学習を停止してからセットアップしてください。")?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut st = self.st();
            st.setting_up = true;
            st.setup_cancel = Some(cancel.clone());
        }
        let result = (|| {
            self.stop_worker();
            let progress = |message: &str| self.send(json!({"type": "setup", "message": message}));
            let python = runtime::setup(&self.paths.home, &self.paths.engine_root, &progress, &cancel)?;
            self.save_now(self.with_config(json!({"python": python})))?;
            self.boot()?;
            self.request("devices", json!({}))?;
            Ok(config_value(&self.st().config))
        })();
        let mut st = self.st();
        st.setting_up = false;
        st.setup_cancel = None;
        drop(st);
        result
    }

    fn read_help(&self, payload: &Value) -> Result<Value, String> {
        let docs = &self.paths.docs_root;
        let file = match payload.as_str().unwrap_or_default() {
            "readme" => docs.join("README.md"),
            "beatrice" => docs.join("docs").join("beatrice.md"),
            "mac" => docs.join("docs").join("mac-preview.md"),
            "license" => docs.join("LICENSE"),
            "notices" => docs.join("THIRD_PARTY_NOTICES.md"),
            _ => return Err("Unknown help document".to_string()),
        };
        fs::read_to_string(file).map(Value::String).map_err(|error| error.to_string())
    }

    fn start(self: &Arc<Self>, payload: Value) -> Result<Value, String> {
        {
            let busy = self.training.busy() || self.calibration.busy();
            let st = self.st();
            if busy || st.setting_up {
                return Err("セットアップ・学習・自動設定が終わるまでお待ちください。".to_string());
            }
            if st.engine_state != "stopped" {
                return Err("すでに起動中です。".to_string());
            }
        }
        self.save_now(payload)?;
        // Every manual start begins audible; only a preset restart carries the mute across.
        if self.st().muted {
            self.st().muted = false;
            self.send(json!({"type": "mute", "muted": false}));
        }
        let token = {
            let mut st = self.st();
            st.start_token += 1;
            st.start_token
        };
        self.send(json!({"type": "state", "state": "loading"}));
        let result = (|| {
            self.boot()?;
            {
                let st = self.st();
                if st.start_token != token || st.quitting {
                    return Ok(());
                }
            }
            self.request("start", json!({"config": self.engine_start_config()}))
        })();
        if let Err(error) = result {
            self.send(json!({"type": "state", "state": "stopped"}));
            return Err(error);
        }
        Ok(Value::Null)
    }

    fn stop(&self) -> Result<Value, String> {
        let (abort, connecting) = {
            let mut st = self.st();
            st.start_token += 1;
            (st.preset_switching.then(|| st.preset_abort.clone()).flatten(), st.connecting)
        };
        if let Some(abort) = abort {
            abort.store(true, Ordering::SeqCst);
            self.stop_worker();
            self.send(json!({"type": "state", "state": "stopped"}));
            return Ok(Value::Null);
        }
        if connecting {
            self.send(json!({"type": "state", "state": "stopped"}));
            return Ok(Value::Null);
        }
        self.request("stop", json!({}))?;
        Ok(Value::Null)
    }

    /// One request from the screen.
    pub fn invoke(self: &Arc<Self>, action: &str, payload: Value) -> Result<Value, String> {
        const DURING_SWITCH: [&str; 10] = ["config", "presets", "model-icon", "read-help", "open-help-link", "training-status", "latency-calibration-status", "obs-status", "hotkeys-status", "set-mute"];
        if self.st().preset_switching && !DURING_SWITCH.contains(&action) && action != "stop" {
            return Err("プリセットを切り替えています。完了までお待ちください。".to_string());
        }
        match action {
            "config" => Ok(config_value(&self.st().config)),
            "hotkeys-status" => Ok(self.st().hotkeys.clone()),
            "set-mute" => self.set_muted(&payload),
            "cancel-setup" => {
                if let Some(cancel) = &self.st().setup_cancel {
                    cancel.store(true, Ordering::SeqCst);
                }
                Ok(Value::Null)
            }
            "cancel-official-model" => {
                if let Some(cancel) = &self.st().official_cancel {
                    cancel.store(true, Ordering::SeqCst);
                }
                Ok(Value::Null)
            }
            "presets" => {
                let st = self.st();
                st.presets.list(Some(&st.config))
            }
            "save-preset" => {
                if !payload.is_object() {
                    return Err("プリセットの指定が正しくありません。".to_string());
                }
                let id = self.st().presets.save(&payload)?;
                self.publish_presets();
                let st = self.st();
                Ok(json!({"id": id, "items": st.presets.list(Some(&st.config))?}))
            }
            "remove-preset" => {
                self.st().presets.remove(payload.as_str().unwrap_or_default())?;
                self.publish_presets();
                let st = self.st();
                st.presets.list(Some(&st.config))
            }
            "apply-preset" => self.apply_preset(payload.as_str().unwrap_or_default()),
            "set-singing-mode" => {
                let enabled = payload.as_bool().ok_or("歌枠モードの指定が正しくありません。")?;
                self.set_singing_mode(enabled)
            }
            "model-history" => {
                {
                    let mut st = self.st();
                    let config = st.config.clone();
                    st.history.remember(&config)?;
                }
                Ok(self.st().history.list_value())
            }
            "add-library-model" | "edit-library-model" | "remove-library-model" | "pick-library-icon" => self.library_action(action, &payload),
            "model-icon" => icons::read_icon(&self.paths.home, payload.as_str().unwrap_or_default()).map(Value::String),
            "pick-model-icon" | "clear-model-icon" => {
                const BUSY: &str = "変換や学習を停止してからアイコンを変更してください。";
                const CHANGED: &str = "モデルが切り替わりました。もう一度アイコンを設定してください。";
                self.check_selection(&payload, BUSY, CHANGED)?;
                if action == "clear-model-icon" {
                    return self.save_now(self.with_config(json!({"beatrice_model_icon": ""}))).map(|config| config_value(&config));
                }
                let Some(file) = self.pick_icon() else { return Ok(Value::Null) };
                self.check_selection(&payload, BUSY, CHANGED)?;
                let icon = self.store_icon(&file)?;
                self.save_now(self.with_config(json!({"beatrice_model_icon": icon}))).map(|config| config_value(&config))
            }
            "rename-model" => {
                self.check_selection(&payload, "変換や学習を停止してから別名を変更してください。", "モデルが切り替わりました。もう一度別名を設定してください。")?;
                let alias = payload["alias"].as_str().ok_or("別名を入力してください。")?.trim().to_string();
                self.save_now(self.with_config(json!({"beatrice_model_alias": alias}))).map(|config| config_value(&config))
            }
            "select-model-history" => {
                const BUSY: &str = "変換や学習を停止してからモデルを切り替えてください。";
                self.require_idle(BUSY)?;
                let id = payload.as_str().unwrap_or_default();
                let selected = self.st().history.select(id)?;
                let python = self.python();
                if !python.is_empty() {
                    let info = self.inspect(&python, selected["beatrice_model"].as_str().unwrap_or_default())?;
                    if info["train_required"] == json!(true) {
                        return Err("このモデルは学習が必要です。モデルを選び直してください。".to_string());
                    }
                }
                // Recheck the file and engine state after asynchronous inspection.
                self.require_idle(BUSY)?;
                self.st().history.select(id)?;
                self.save_now(self.with_config(Value::Object(selected))).map(|config| config_value(&config))
            }
            "read-help" => self.read_help(&payload),
            "open-help-link" => {
                let text = payload.as_str().ok_or("Invalid help link")?;
                let rest = text.strip_prefix("https://").ok_or("Invalid help link")?;
                let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
                if authority.is_empty() || authority.contains('@') {
                    return Err("Invalid help link".to_string());
                }
                self.host.open_url(text)?;
                Ok(Value::Null)
            }
            "save" => self.save_with(payload, SaveOptions { deferred: true, ..SaveOptions::default() }).map(|config| config_value(&config)),
            "inspect-model" => self.inspect(&self.python(), payload.as_str().unwrap_or_default()),
            "gpu-info" => tools::tool(&self.python(), &self.paths.engine_root, "gpu", &[]),
            "compute-devices" => Ok(tools::compute_devices(&self.python(), &self.paths.engine_root)),
            "use-trained-model" => {
                let status = self.training.status();
                let model = status["model"].as_str().unwrap_or_default().to_string();
                if status["busy"] == true || !is_file(&model) {
                    return Err("使用できる学習モデルがありません。".to_string());
                }
                self.save_now(self.with_config(json!({"beatrice_model": model, "beatrice_voice": 0, "beatrice_model_alias": "", "beatrice_model_icon": ""}))).map(|config| config_value(&config))
            }
            "install-tsukuyomi" => self.install_official(&payload),
            "setup-runtime" => self.setup_runtime(),
            "open-resource" => {
                let url = match payload.as_str().unwrap_or_default() {
                    "models" => "https://github.com/fierce-cats/beatrice-trainer",
                    "python" => "https://www.python.org/downloads/",
                    "cable" => "https://vb-audio.com/Cable/",
                    "tsukuyomi_terms" => official::TERMS_URL,
                    _ => return Err("Unknown resource".to_string()),
                };
                self.host.open_url(url)?;
                Ok(Value::Null)
            }
            "export-settings" => {
                let Some(file) = self.host.save_file("YuiVoiceChanger-settings.json", "YuiVoiceChanger 設定", &["json"]) else { return Ok(Value::Null) };
                let text = serde_json::to_string_pretty(&config_value(&self.st().config)).map_err(|error| error.to_string())?;
                fs::write(&file, text).map_err(|error| error.to_string())?;
                Ok(json!(file.to_string_lossy()))
            }
            "export-log" => self.export_log(),
            "import-settings" => {
                if self.calibration.busy() || self.st().engine_state != "stopped" {
                    return Err("変換や自動設定を停止してください。".to_string());
                }
                let Some(file) = self.host.pick_file("YuiVoiceChanger 設定", &["json"], None) else { return Ok(Value::Null) };
                let text = fs::read_to_string(&file).map_err(|error| error.to_string())?;
                let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|error| error.to_string())?;
                let clean = normalize(&value, true)?;
                self.save_now(config_value(&clean)).map(|config| config_value(&config))
            }
            "pick" => {
                let key = payload.as_str().unwrap_or_default();
                let current = self.st().config.get(key).and_then(Value::as_str).map(str::to_string);
                let directory = picker_directory(current.as_deref());
                let chosen = match key {
                    "training_audio" => self.host.pick_folder(directory),
                    "python" => self.host.pick_file("Python", &["exe"], directory),
                    "beatrice_model" | "training_source" => self.host.pick_file("音声モデル", &MODEL_EXTENSIONS, directory),
                    _ => return Err("Invalid selection".to_string()),
                };
                Ok(chosen.map_or(Value::Null, |path| json!(path.to_string_lossy())))
            }
            "mix-devices" => {
                if self.python().is_empty() {
                    return Ok(Value::Null);
                }
                self.boot()?;
                self.request("mix-devices", json!({}))?;
                Ok(Value::Null)
            }
            "devices" | "connect" => {
                if self.st().setting_up || self.python().is_empty() {
                    return Ok(Value::Null);
                }
                self.boot()?;
                self.request("devices", json!({}))?;
                Ok(Value::Null)
            }
            "start" => self.start(payload),
            "stop" => self.stop(),

            "obs-status" => Ok(self.obs.status()),
            "obs-refresh" => self.obs.refresh(),
            "install-obs-plugin" => self.install_plugin(),
            "latency-calibration-status" => Ok(self.calibration.status()),
            "latency-calibration-cancel" => Ok(self.calibration.cancel()),
            "latency-calibration-start" => {
                let refused = self.training.busy() || self.calibration.busy() || {
                    let st = self.st();
                    st.setting_up || st.engine_state != "stopped"
                };
                if refused {
                    return Err("変換・セットアップ・学習を停止してから自動設定してください。".to_string());
                }
                let config = self.save_now(payload)?;
                self.calibration.start(&config)
            }
            "training-status" => Ok(self.training.status()),
            "training-cancel" => Ok(self.training.cancel()),
            "training-start" | "training-resume" => {
                let refused = self.calibration.busy() || {
                    let st = self.st();
                    st.setting_up || st.engine_state != "stopped"
                };
                if refused {
                    return Err("声変換を停止してから学習してください。".to_string());
                }
                let resume = action == "training-resume";
                let config = if resume { self.st().config.clone() } else { self.save_now(payload)? };
                self.training.start(&config, resume)
            }
            _ => Err("Unknown action".to_string()),
        }
    }

    /// Call before exiting. Stops the worker cleanly and saves anything pending.
    pub fn shutdown(&self) {
        let pending = {
            let mut st = self.st();
            st.quitting = true;
            for cancel in [&st.official_cancel, &st.setup_cancel].into_iter().flatten() {
                cancel.store(true, Ordering::SeqCst);
            }
            if let Some(abort) = &st.preset_abort {
                abort.store(true, Ordering::SeqCst);
            }
            st.save_pending
        };
        if pending {
            let _ = self.write_config();
        }
        self.stop_worker();
        self.training.shutdown();
        self.calibration.shutdown();
        self.obs.shutdown();
    }

    /// Only for tests and diagnostics.
    pub fn engine_state(&self) -> String {
        self.st().engine_state.clone()
    }

    pub fn has_worker(&self) -> bool {
        self.st().worker.is_some()
    }
}
