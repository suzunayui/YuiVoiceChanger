//! Drives the real logic with a fake Python worker that speaks the same protocol.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use yvc_core::app::{App, Host, Paths};

#[derive(Default)]
struct FakeHost {
    events: Mutex<Vec<Value>>,
    picks: Mutex<Vec<PathBuf>>,
    opened: Mutex<Vec<String>>,
    hotkeys: Mutex<Vec<bool>>,
    hotkey_failures: Mutex<Vec<String>>,
}

impl Host for FakeHost {
    fn emit(&self, event: &Value) {
        self.events.lock().unwrap().push(event.clone());
    }
    fn pick_file(&self, _filter: &str, _extensions: &[&str], _directory: Option<PathBuf>) -> Option<PathBuf> {
        self.picks.lock().unwrap().pop()
    }
    fn pick_folder(&self, _directory: Option<PathBuf>) -> Option<PathBuf> {
        self.picks.lock().unwrap().pop()
    }
    fn save_file(&self, _name: &str, _filter: &str, _extensions: &[&str]) -> Option<PathBuf> {
        self.picks.lock().unwrap().pop()
    }
    fn pictures_dir(&self) -> Option<PathBuf> {
        None
    }
    fn open_url(&self, url: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }
    fn confirm(&self, _title: &str, _message: &str, _detail: &str) -> bool {
        false
    }
    fn set_hotkeys(&self, enabled: bool) -> Vec<String> {
        self.hotkeys.lock().unwrap().push(enabled);
        self.hotkey_failures.lock().unwrap().clone()
    }
}

struct World {
    temp: PathBuf,
    home: PathBuf,
    host: Arc<FakeHost>,
    app: Arc<App>,
    log: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        self.app.shutdown();
        thread::sleep(Duration::from_millis(50));
        let _ = fs::remove_dir_all(&self.temp);
    }
}

fn fake_worker() -> String {
    let exe = Path::new(env!("CARGO_BIN_EXE_fake-worker"));
    assert!(exe.exists());
    exe.to_string_lossy().into_owned()
}

fn world() -> World {
    world_with(|_| {})
}

fn world_with(prepare: impl FnOnce(&Path)) -> World {
    let temp = std::env::temp_dir().join(format!("yvc-app-{}", uuid::Uuid::new_v4()));
    let home = temp.join("home");
    let engine = temp.join("engine");
    fs::create_dir_all(engine.join("backend")).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(engine.join("backend").join("worker.py"), "# not used by the fake").unwrap();
    fs::write(engine.join("README.md"), "ヘルプ").unwrap();
    prepare(&home);
    let log = temp.join("worker.log");
    let host = Arc::new(FakeHost::default());
    fs::create_dir_all(engine.join("obs-plugin")).unwrap();
    fs::write(engine.join("obs-plugin").join("yui-live-preview.dll"), "plugin").unwrap();
    for script in ["latency_calibration.py", "training_job.py", "model_tools.py"] {
        fs::write(engine.join("backend").join(script), "# not used by the fake").unwrap();
    }
    // A pipe nobody serves: these tests must never reach a real OBS that happens to be running.
    let obs_pipe = format!(r"\\.\pipe\yvc-no-obs-{}", uuid::Uuid::new_v4());
    let paths = Paths { home: home.clone(), engine_root: engine.clone(), docs_root: engine, legacy_config: None, obs_pipe, program_data: Some(temp.join("ProgramData")) };
    let app = App::new(host.clone(), paths);
    app.started();
    World { temp, home, host, app, log }
}

impl World {
    fn behave(&self, behavior: &str) {
        fs::write(self.temp.join("behavior"), behavior).unwrap();
    }

    fn model(&self, name: &str) -> String {
        let path = self.temp.join(name);
        fs::write(&path, "x").unwrap();
        path.to_string_lossy().into_owned()
    }

    fn config(&self) -> Value {
        self.app.invoke("config", Value::Null).unwrap()
    }

    fn with_worker(&self, change: Value) -> Value {
        let mut config = self.config();
        config["python"] = json!(fake_worker());
        for (key, value) in change.as_object().unwrap() {
            config[key] = value.clone();
        }
        config
    }

    fn events(&self, kind: &str) -> Vec<Value> {
        self.host.events.lock().unwrap().iter().filter(|event| event["type"] == kind).cloned().collect()
    }

    fn wait_state(&self, state: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self.app.engine_state() == state {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("never reached {state}; it is {}", self.app.engine_state());
    }

    fn start_running(&self, change: Value) {
        self.app.invoke("start", self.with_worker(change)).unwrap();
        self.wait_state("running");
    }

    fn wait_event(&self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(event) = self.events(kind).pop() {
                return event;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("no {kind} event");
    }

    fn worker_log(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }

    fn saved(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(self.home.join("desktop.json")).unwrap()).unwrap()
    }
}

#[test]
fn starts_stops_and_lists_devices() {
    let world = world();
    world.app.invoke("start", world.with_worker(json!({"beatrice_pitch": 3}))).unwrap();
    world.wait_state("running");
    assert_eq!(world.saved()["beatrice_pitch"], 3, "starting saves first");
    assert!(world.worker_log().contains(r#""command":"start""#));
    assert!(world.worker_log().contains(r#"args ["-I", "-u""#), "the same Python flags: {}", world.worker_log());

    world.app.invoke("devices", Value::Null).unwrap();
    assert_eq!(world.wait_event("devices")["devices"][0]["name"], "Mic");

    assert_eq!(world.app.invoke("start", world.config()).unwrap_err(), "すでに起動中です。");
    world.app.invoke("stop", Value::Null).unwrap();
    world.wait_state("stopped");
    assert!(world.app.has_worker(), "the worker stays ready for next time");
}

#[test]
fn explains_when_there_is_no_python() {
    let world = world();
    let error = world.app.invoke("start", world.config()).unwrap_err();
    assert!(error.contains("セットアップ"));
    assert_eq!(world.app.engine_state(), "stopped", "it doesn't stay stuck on loading");

    let mut missing = world.config();
    missing["python"] = json!("C:\\no\\python.exe");
    assert!(world.app.invoke("start", missing).unwrap_err().contains("Python実行ファイル"));
    assert_eq!(world.app.engine_state(), "stopped");
}

#[test]
fn listing_devices_before_setup_does_nothing() {
    let world = world();
    assert_eq!(world.app.invoke("devices", Value::Null).unwrap(), Value::Null);
    assert!(!world.app.has_worker());
}

#[test]
fn a_running_engine_gets_changes_without_restarting() {
    let world = world();
    world.start_running(json!({}));
    let mut next = world.config();
    next["beatrice_pitch"] = json!(5);
    next["fx_reverb"] = json!(10);
    world.app.invoke("save", next).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !world.worker_log().contains("update-controls") && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let log = world.worker_log();
    let line = log.lines().find(|line| line.contains("update-controls")).expect("controls were sent");
    let sent: Value = serde_json::from_str(line).unwrap();
    assert_eq!(sent["controls"]["beatrice_pitch"], 5);
    assert_eq!(sent["effects"]["fx_reverb"], 10);
    assert_eq!(world.app.engine_state(), "running");
}

#[test]
fn changes_needing_a_restart_are_refused_while_running() {
    let world = world();
    world.start_running(json!({}));
    let mut next = world.config();
    next["input"] = json!(3);
    assert!(world.app.invoke("save", next).unwrap_err().contains("停止してください"));
    assert_eq!(world.config()["input"], -1, "nothing changed");
    let mut port = world.config();
    port["obs_port"] = json!(5000);
    assert!(world.app.invoke("save", port).unwrap_err().contains("OBSのポート"));
}

#[test]
fn slider_saves_reach_the_disk_soon_after() {
    let world = world();
    let mut next = world.config();
    next["gain"] = json!(5);
    world.app.invoke("save", next).unwrap();
    assert_eq!(world.config()["gain"], 5, "the config changes at once");
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if world.home.join("desktop.json").exists() && world.saved()["gain"] == 5 {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("never saved");
}

#[test]
fn shutdown_saves_what_is_pending() {
    let world = world();
    let mut next = world.config();
    next["gain"] = json!(7);
    world.app.invoke("save", next).unwrap();
    world.app.shutdown();
    assert_eq!(world.saved()["gain"], 7);
}

#[test]
fn mute_needs_a_running_engine_and_resets_on_start() {
    let world = world();
    assert!(world.app.invoke("set-mute", json!(true)).unwrap_err().contains("実行中"));
    world.start_running(json!({}));
    assert!(world.app.invoke("set-mute", json!("yes")).unwrap_err().contains("指定"));
    assert_eq!(world.app.invoke("set-mute", json!(true)).unwrap(), true);
    assert_eq!(world.wait_event("mute")["muted"], true);
    world.app.invoke("stop", Value::Null).unwrap();
    world.wait_state("stopped");
    world.app.invoke("start", world.config()).unwrap();
    world.wait_state("running");
    assert_eq!(world.events("mute").last().unwrap()["muted"], false, "a manual start is audible");
}

#[test]
fn hotkeys_toggle_mute_and_apply_presets() {
    let world = world();
    let model = world.model("a.pt");
    world.start_running(json!({"hotkeys_enabled": true, "beatrice_model": model, "input": 1, "input_name": "Mic", "output": 2, "output_name": "Speaker"}));
    assert_eq!(*world.host.hotkeys.lock().unwrap().last().unwrap(), true);
    world.app.hotkey_mute();
    assert_eq!(world.events("mute").last().unwrap()["muted"], true);
    world.app.hotkey_mute();
    assert_eq!(world.events("mute").last().unwrap()["muted"], false);

    world.app.hotkey_preset(3);
    assert!(world.events("notice").last().unwrap()["message"].as_str().unwrap().contains("4番目"));

    let mut preset = world.config();
    preset["beatrice_pitch"] = json!(-3);
    world.app.invoke("save-preset", json!({"name": "低い声", "config": preset})).unwrap();
    world.app.hotkey_preset(0);
    assert_eq!(world.config()["beatrice_pitch"], -3);
    assert!(world.events("notice").last().unwrap()["message"].as_str().unwrap().contains("低い声"));
    assert_eq!(world.app.engine_state(), "running", "a pitch change needs no restart");
}

#[test]
fn reports_hotkeys_that_could_not_be_registered() {
    let world = world();
    world.host.hotkey_failures.lock().unwrap().push("CommandOrControl+Alt+M".to_string());
    let mut next = world.config();
    next["hotkeys_enabled"] = json!(true);
    world.app.invoke("save", next).unwrap();
    assert_eq!(world.wait_event("hotkeys")["failed"][0], "CommandOrControl+Alt+M");
    assert_eq!(world.app.invoke("hotkeys-status", Value::Null).unwrap()["enabled"], true);
}

fn device_config(world: &World, voice: i64, model: &str) -> Value {
    world.with_worker(json!({"beatrice_model": model, "beatrice_voice": voice, "input": 1, "input_name": "Mic", "output": 2, "output_name": "Speaker"}))
}

#[test]
fn a_preset_needing_a_restart_switches_the_voice() {
    let world = world();
    let (a, b) = (world.model("a.pt"), world.model("b.pt"));
    world.start_running(json!({}));
    world.app.invoke("devices", Value::Null).unwrap();
    world.wait_event("devices");
    world.app.invoke("stop", Value::Null).unwrap();
    world.wait_state("stopped");

    let id = world.app.invoke("save-preset", json!({"name": "B", "config": device_config(&world, 0, &b)})).unwrap()["id"].as_str().unwrap().to_string();
    world.app.invoke("start", device_config(&world, 0, &a)).unwrap();
    world.wait_state("running");

    let result = world.app.invoke("apply-preset", json!(id)).unwrap();
    assert_eq!(result["beatrice_model"], b.as_str());
    world.wait_state("running");
    let busy: Vec<bool> = world.events("preset-switch").iter().map(|event| event["busy"].as_bool().unwrap()).collect();
    assert_eq!(busy, [true, false]);
    assert_eq!(world.app.invoke("presets", Value::Null).unwrap()[0]["active"], true);
}

#[test]
fn a_failed_switch_goes_back_to_the_old_voice() {
    let world = world();
    let (a, b) = (world.model("a.pt"), world.model("b.pt"));
    world.start_running(json!({}));
    world.app.invoke("devices", Value::Null).unwrap();
    world.wait_event("devices");
    world.app.invoke("stop", Value::Null).unwrap();
    world.wait_state("stopped");

    // The fake refuses to start voice 99.
    let id = world.app.invoke("save-preset", json!({"name": "壊れた声", "config": device_config(&world, 99, &b)})).unwrap()["id"].as_str().unwrap().to_string();
    world.app.invoke("start", device_config(&world, 0, &a)).unwrap();
    world.wait_state("running");

    let error = world.app.invoke("apply-preset", json!(id)).unwrap_err();
    assert!(error.contains("元の設定で変換を再開しました"), "{error}");
    assert!(error.contains("モデルを読み込めません"), "{error}");
    assert_eq!(world.config()["beatrice_model"], a.as_str());
    assert_eq!(world.app.engine_state(), "running");
    assert_eq!(world.saved()["beatrice_model"], a.as_str());
}

#[test]
fn a_crash_is_reported_and_can_be_restarted() {
    let world = world();
    world.behave("crash-on-start");
    world.app.invoke("start", world.with_worker(json!({}))).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while world.events("error").is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(world.events("error")[0]["message"], "音声処理が終了しました (7)。環境を確認してください。");
    world.wait_state("stopped");
    assert!(!world.app.has_worker());

    world.behave("");
    world.app.invoke("start", world.config()).unwrap();
    world.wait_state("running");
}

#[test]
fn a_worker_that_never_gets_ready_is_explained() {
    let world = world();
    world.behave("exit-early");
    let error = world.app.invoke("start", world.with_worker(json!({}))).unwrap_err();
    assert!(error.contains("Python環境を起動できませんでした"), "{error}");
    assert_eq!(world.app.engine_state(), "stopped");
}

#[test]
fn a_worker_ignoring_quit_is_ended_anyway() {
    let world = world();
    world.behave("ignore-quit");
    world.start_running(json!({}));
    world.app.shutdown();
    assert!(!world.app.has_worker());
}

#[test]
fn what_the_worker_prints_that_is_not_an_event_goes_to_the_log() {
    let world = world();
    world.start_running(json!({}));
    let log = fs::read_to_string(world.home.join("logs/independent-engine.log")).unwrap();
    assert!(log.contains("this line is not JSON"), "{log}");
}

#[test]
fn the_screen_gets_a_startup_problem_once() {
    let world = world_with(|home| fs::write(home.join("desktop.json"), "{broken").unwrap());
    assert_eq!(world.events("error").len(), 0, "the screen isn't ready yet");
    world.app.screen_ready();
    let errors = world.events("error");
    assert_eq!(errors.len(), 1);
    assert!(errors[0]["message"].as_str().unwrap().contains("初期設定で起動しました"));
    world.app.screen_ready();
    assert_eq!(world.events("error").len(), 1);
}

#[test]
fn reads_settings_saved_by_the_electron_version() {
    let world = world_with(|home| {
        fs::write(home.join("desktop.json"), json!({"engine_version": 2, "beatrice_pitch": 9, "input": 4, "unknown": true}).to_string()).unwrap();
    });
    let config = world.config();
    assert_eq!(config["beatrice_pitch"], 9);
    assert_eq!(config["input"], 4);
    assert!(config.get("unknown").is_none());
}

#[test]
fn backs_up_settings_from_before_the_engine_change() {
    let world = world_with(|home| fs::write(home.join("desktop.json"), json!({"beatrice_pitch": 9}).to_string()).unwrap());
    assert!(world.home.join("desktop-before-direct-gpu.json").exists());
}

#[test]
fn only_the_listed_help_files_can_be_read() {
    let world = world();
    assert_eq!(world.app.invoke("read-help", json!("readme")).unwrap(), "ヘルプ");
    for bad in [json!("../../secret"), json!("desktop"), json!(1)] {
        assert!(world.app.invoke("read-help", bad).unwrap_err().contains("Unknown"));
    }
}

#[test]
fn only_plain_https_links_open() {
    let world = world();
    world.app.invoke("open-help-link", json!("https://example.com/a?b=1")).unwrap();
    assert_eq!(world.host.opened.lock().unwrap().len(), 1);
    for bad in ["http://example.com/", "file:///C:/x", "https://user:pw@example.com/", "https://", "javascript:alert(1)"] {
        assert!(world.app.invoke("open-help-link", json!(bad)).is_err(), "{bad}");
    }
    assert!(world.app.invoke("open-help-link", json!(5)).is_err());
    assert_eq!(world.host.opened.lock().unwrap().len(), 1);

    world.app.invoke("open-resource", json!("cable")).unwrap();
    assert!(world.host.opened.lock().unwrap().last().unwrap().contains("vb-audio"));
    assert!(world.app.invoke("open-resource", json!("https://evil.example/")).is_err());
}

#[test]
fn exports_and_imports_settings() {
    let world = world();
    let file = world.temp.join("settings.json");
    world.host.picks.lock().unwrap().push(file.clone());
    let mut next = world.config();
    next["beatrice_pitch"] = json!(6);
    next["obs_path_delay_ms"] = json!(5);
    world.app.invoke("save", next).unwrap();
    assert_eq!(world.app.invoke("export-settings", Value::Null).unwrap(), file.to_string_lossy().as_ref());

    let mut other = world.config();
    other["beatrice_pitch"] = json!(1);
    world.app.invoke("save", other).unwrap();
    world.host.picks.lock().unwrap().push(file.clone());
    let imported = world.app.invoke("import-settings", Value::Null).unwrap();
    assert_eq!(imported["beatrice_pitch"], 6);
    assert_eq!(imported["obs_path_delay_ms"], 0, "measured delays don't carry to another PC");

    assert_eq!(world.app.invoke("export-settings", Value::Null).unwrap(), Value::Null, "cancelled");
    fs::write(&file, "{}").unwrap();
    world.host.picks.lock().unwrap().push(file);
    assert!(world.app.invoke("import-settings", Value::Null).unwrap_err().contains("設定が見つかりません"));
}

#[test]
fn the_model_library_adds_edits_and_removes() {
    let world = world();
    let model = world.model("voice.pt");
    world.host.picks.lock().unwrap().push(PathBuf::from(&model));
    let added = world.app.invoke("add-library-model", Value::Null).unwrap();
    let id = added["id"].as_str().unwrap().to_string();
    assert_eq!(added["models"][0]["label"], "voice.pt");

    let edited = world.app.invoke("edit-library-model", json!({"id": id, "alias": " ゆい ", "icon": ""})).unwrap();
    assert_eq!(edited["models"][0]["label"], "ゆい");

    let selected = world.app.invoke("select-model-history", json!(id)).unwrap();
    assert_eq!(selected["beatrice_model_alias"], "ゆい");
    assert_eq!(selected["beatrice_model"], world.app.invoke("model-history", Value::Null).unwrap()[0]["path"]);

    let removed = world.app.invoke("remove-library-model", json!({"id": id})).unwrap();
    assert_eq!(removed["models"].as_array().unwrap().len(), 0);
    assert_eq!(removed["config"]["beatrice_model"], "", "removing the current model clears it");
    assert!(world.app.invoke("edit-library-model", json!({"id": "nope"})).is_err());

    world.host.picks.lock().unwrap().push(PathBuf::from(world.model("rvc.pth")));
    assert!(world.app.invoke("add-library-model", Value::Null).unwrap()["training_source"].as_str().unwrap().ends_with("rvc.pth"));
    assert_eq!(world.app.invoke("add-library-model", Value::Null).unwrap(), Value::Null, "cancelled");
}

#[test]
fn the_library_cannot_change_while_converting() {
    let world = world();
    world.start_running(json!({}));
    assert!(world.app.invoke("add-library-model", Value::Null).unwrap_err().contains("停止"));
    assert!(world.app.invoke("select-model-history", json!("x")).unwrap_err().contains("停止"));
    assert!(world.app.invoke("setup-runtime", Value::Null).unwrap_err().contains("停止"));
    assert!(world.app.invoke("install-tsukuyomi", json!({"agreed": true})).unwrap_err().contains("停止"));
}

#[test]
fn the_official_model_needs_consent() {
    let world = world();
    assert!(world.app.invoke("install-tsukuyomi", json!({})).unwrap_err().contains("同意"));
    assert!(world.app.invoke("install-tsukuyomi", json!({"agreed": "yes"})).unwrap_err().contains("同意"));
}

#[test]
fn renaming_and_icons_check_the_model_is_still_current() {
    let world = world();
    let model = world.model("voice.pt");
    let mut next = world.config();
    next["beatrice_model"] = json!(model);
    world.app.invoke("save", next).unwrap();
    let renamed = world.app.invoke("rename-model", json!({"path": model, "voice": 0, "alias": " 新しい名前 "})).unwrap();
    assert_eq!(renamed["beatrice_model_alias"], "新しい名前");
    assert!(world.app.invoke("rename-model", json!({"path": "other.pt", "voice": 0, "alias": "x"})).unwrap_err().contains("切り替わりました"));
    assert!(world.app.invoke("rename-model", json!({"path": model, "voice": 1, "alias": "x"})).unwrap_err().contains("切り替わりました"));
    assert!(world.app.invoke("rename-model", json!({"path": model, "voice": 0})).unwrap_err().contains("別名"));
    assert_eq!(world.app.invoke("clear-model-icon", json!({"path": model, "voice": 0})).unwrap()["beatrice_model_icon"], "");
}

#[test]
fn every_action_the_screen_uses_is_known() {
    let world = world();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
    let pattern = regex_lite::Regex::new(r#"invoke\('([a-z-]+)'"#).unwrap();
    let mut seen = 0;
    for entry in fs::read_dir(src).unwrap().flatten() {
        let text = fs::read_to_string(entry.path()).unwrap_or_default();
        for found in pattern.captures_iter(&text) {
            let action = &found[1];
            seen += 1;
            // Those with effects are checked with a payload they refuse, or that does nothing without Python.
            if ["start", "stop", "save", "setup-runtime", "pick", "import-settings", "export-settings", "add-library-model"].contains(&action) {
                continue;
            }
            let answer = world.app.invoke(action, json!({}));
            assert_ne!(answer.err().as_deref(), Some("Unknown action"), "{action}");
        }
    }
    assert!(seen > 30, "the screen's actions were found: {seen}");
    assert_eq!(world.app.invoke("nonsense", Value::Null).unwrap_err(), "Unknown action");
}

#[test]
fn obs_waits_quietly_when_it_is_not_running() {
    let world = world();
    world.app.screen_ready();
    let status = world.app.invoke("obs-refresh", Value::Null).unwrap();
    assert_eq!(status["state"], "disconnected");
    assert_eq!(status["error"], "");
    assert_eq!(world.app.invoke("obs-status", Value::Null).unwrap()["videoInputs"], json!([]));
}

#[test]
fn singing_mode_turns_mix_on_with_it() {
    let world = world();
    let on = world.app.invoke("set-singing-mode", json!(true)).unwrap();
    assert_eq!(on["singing_enabled"], true);
    assert_eq!(on["mix_enabled"], true);
    assert_eq!(world.saved()["mix_enabled"], true);
    let off = world.app.invoke("set-singing-mode", json!(false)).unwrap();
    assert_eq!(off["mix_enabled"], false);
    assert!(world.app.invoke("set-singing-mode", json!("x")).is_err());
    world.start_running(json!({}));
    assert!(world.app.invoke("set-singing-mode", json!(false)).unwrap_err().contains("停止"));
}

#[test]
fn installs_the_obs_plugin_from_the_app_folder() {
    let world = world();
    assert_eq!(world.app.invoke("install-obs-plugin", Value::Null).unwrap()["alreadyInstalled"], false);
    assert_eq!(world.app.invoke("install-obs-plugin", Value::Null).unwrap()["alreadyInstalled"], true);
    assert!(world.temp.join("ProgramData/obs-studio/plugins/yui-live-preview/yui-live-preview.dll").exists());
}

fn ready_for_calibration(world: &World) -> Value {
    let model = world.model("voice.pt");
    world.with_worker(json!({"beatrice_model": model, "input": 1, "input_name": "Mic", "output": 2, "output_name": "Speaker"}))
}

#[test]
fn calibration_saves_what_it_measured() {
    let world = world();
    world.behave("completes");
    let config = ready_for_calibration(&world);
    assert_eq!(world.app.invoke("latency-calibration-start", config).unwrap()["busy"], true);
    let deadline = Instant::now() + Duration::from_secs(10);
    while world.app.invoke("latency-calibration-status", Value::Null).unwrap()["busy"] == true && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let status = world.app.invoke("latency-calibration-status", Value::Null).unwrap();
    assert_eq!(status["phase"], "completed", "{status}");
    assert_eq!(status["total_delay_ms"], 640);
    let saved = world.saved();
    assert_eq!(saved["singing_latency_ms"], 640);
    assert_eq!(saved["singing_enabled"], true);
    let event = world.events("latency-calibration").pop().unwrap();
    assert_eq!(event["config"]["singing_latency_ms"], 640, "the screen hears about it");
}

#[test]
fn other_work_waits_for_calibration() {
    let world = world();
    world.behave("waits");
    let config = ready_for_calibration(&world);
    world.app.invoke("latency-calibration-start", config.clone()).unwrap();
    assert!(world.app.invoke("start", config.clone()).unwrap_err().contains("お待ちください"));
    assert!(world.app.invoke("latency-calibration-start", config.clone()).unwrap_err().contains("停止してから"));
    assert!(world.app.invoke("training-start", config.clone()).unwrap_err().contains("停止してから"));
    assert!(world.app.invoke("select-model-history", json!("x")).unwrap_err().contains("停止"));
    let mut changed = config.clone();
    changed["beatrice_pitch"] = json!(9);
    assert!(world.app.invoke("save", changed).unwrap_err().contains("自動設定"));
    assert!(world.app.invoke("save", world.config()).is_ok(), "saving nothing new is fine");
    world.app.invoke("latency-calibration-cancel", Value::Null).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while world.app.invoke("latency-calibration-status", Value::Null).unwrap()["busy"] == true && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(world.app.invoke("latency-calibration-status", Value::Null).unwrap()["phase"], "cancelled");
}

#[test]
fn training_needs_the_engine_stopped() {
    let world = world();
    world.start_running(json!({}));
    assert!(world.app.invoke("training-start", world.config()).unwrap_err().contains("停止してから"));
    assert!(world.app.invoke("training-resume", Value::Null).unwrap_err().contains("停止してから"));
    assert_eq!(world.app.invoke("training-status", Value::Null).unwrap()["phase"], "idle");
    assert!(world.app.invoke("use-trained-model", Value::Null).unwrap_err().contains("学習モデルがありません"));
}

#[test]
fn stopping_while_connecting_returns_to_stopped() {
    let world = world();
    assert_eq!(world.app.invoke("stop", Value::Null).unwrap_err().contains("未起動"), true);
    assert_eq!(world.app.engine_state(), "stopped");
}

#[test]
fn shutdown_ends_the_worker() {
    let world = world();
    world.start_running(json!({}));
    world.app.shutdown();
    let deadline = Instant::now() + Duration::from_secs(5);
    while world.app.has_worker() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!world.app.has_worker());
}
