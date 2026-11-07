//! The long-running helpers, driven with a fake Python that speaks the same protocol.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use yvc_core::calibration::Calibration;
use yvc_core::config::{normalize, Config};
use yvc_core::training::Training;

fn fake_python() -> String {
    env!("CARGO_BIN_EXE_fake-worker").to_string()
}

struct World {
    temp: PathBuf,
    engine: PathBuf,
    events: Arc<Mutex<Vec<Value>>>,
}

impl Drop for World {
    fn drop(&mut self) {
        for _ in 0..50 {
            if fs::remove_dir_all(&self.temp).is_ok() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

fn world(behavior: &str) -> World {
    let temp = std::env::temp_dir().join(format!("yvc-jobs-{}", uuid::Uuid::new_v4()));
    let engine = temp.join("engine");
    fs::create_dir_all(engine.join("backend")).unwrap();
    for script in ["latency_calibration.py", "training_job.py", "model_tools.py"] {
        fs::write(engine.join("backend").join(script), "# not used by the fake").unwrap();
    }
    fs::write(temp.join("behavior"), behavior).unwrap();
    fs::write(temp.join("voice.pt.gz"), "x").unwrap();
    World { temp, engine, events: Arc::new(Mutex::new(Vec::new())) }
}

impl World {
    fn notify(&self) -> Arc<dyn Fn(Value) + Send + Sync> {
        let events = self.events.clone();
        Arc::new(move |event| events.lock().unwrap().push(event))
    }

    fn config(&self) -> Config {
        let mut config = normalize(&json!({}), false).unwrap();
        config.insert("python".to_string(), json!(fake_python()));
        config.insert("beatrice_model".to_string(), json!(self.temp.join("voice.pt.gz").to_string_lossy()));
        config.insert("input".to_string(), json!(0));
        config.insert("output".to_string(), json!(1));
        config
    }

    fn phases(&self) -> Vec<String> {
        self.events.lock().unwrap().iter().filter_map(|event| event["phase"].as_str().map(str::to_string)).collect()
    }

    fn calibration(&self, timeout: Duration, cancel_timeout: Duration, applied: Arc<Mutex<u32>>) -> Calibration {
        Calibration::with_timeouts(
            self.engine.clone(),
            self.notify(),
            Arc::new(|| Ok(())),
            Arc::new(move |event| {
                *applied.lock().unwrap() += 1;
                event["total_delay_ms"] = json!(700);
                Ok(json!({"singing_latency_ms": event["recommended_ms"]}))
            }),
            timeout,
            cancel_timeout,
        )
    }

    fn training(&self) -> Training {
        Training::with_preparer(&self.temp.join("home"), &self.engine, self.notify(), Box::new(|home: &Path, progress: &dyn Fn(&str), _cancel: &std::sync::atomic::AtomicBool| {
            progress("学習用ファイルを準備しています");
            Ok(home.join("model-assets"))
        }))
    }
}

fn until(mut check: impl FnMut() -> bool, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("never: {label}");
}

const LONG: Duration = Duration::from_secs(30);
const SHORT: Duration = Duration::from_millis(200);

#[test]
fn calibration_applies_a_good_result() {
    let world = world("completes");
    let applied = Arc::new(Mutex::new(0));
    let calibration = world.calibration(LONG, SHORT, applied.clone());
    assert_eq!(calibration.start(&world.config()).unwrap()["busy"], true);
    assert_eq!(calibration.start(&world.config()).unwrap_err(), "自動設定は実行中です。");
    until(|| !calibration.busy(), "finished");
    let status = calibration.status();
    assert_eq!(status["phase"], "completed");
    assert_eq!(status["total_delay_ms"], 700);
    assert_eq!(*applied.lock().unwrap(), 1);
    let phases = world.phases();
    assert!(phases.iter().any(|phase| phase == "speaking"), "{phases:?}");
    let last = world.events.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last["type"], "latency-calibration");
    assert_eq!(last["config"]["singing_latency_ms"], 640);
    assert_eq!(last["busy"], false);
}

#[test]
fn calibration_rejects_an_impossible_result() {
    let world = world("invalid");
    let applied = Arc::new(Mutex::new(0));
    let calibration = world.calibration(LONG, SHORT, applied.clone());
    calibration.start(&world.config()).unwrap();
    until(|| !calibration.busy(), "finished");
    assert_eq!(calibration.status()["phase"], "failed");
    assert_eq!(calibration.status()["message"], "測定結果が正しくありません。");
    assert_eq!(*applied.lock().unwrap(), 0);
}

#[test]
fn calibration_reports_failures() {
    for (behavior, expected) in [("fails", "マイクが無音です"), ("crashes", "測定プロセスが終了しました")] {
        let world = world(behavior);
        let calibration = world.calibration(LONG, SHORT, Arc::default());
        calibration.start(&world.config()).unwrap();
        until(|| !calibration.busy(), "finished");
        assert_eq!(calibration.status()["phase"], "failed");
        assert!(calibration.status()["message"].as_str().unwrap().contains(expected), "{}", calibration.status());
    }
}

#[test]
fn cancelling_calibration_works_repeatedly_and_ignores_late_results() {
    for behavior in ["waits", "late", "ignores-cancel"] {
        let world = world(behavior);
        let applied = Arc::new(Mutex::new(0));
        let calibration = world.calibration(LONG, SHORT, applied.clone());
        for _ in 0..2 {
            world.events.lock().unwrap().clear();
            calibration.start(&world.config()).unwrap();
            until(|| world.phases().iter().any(|phase| phase == "speaking"), "speaking");
            assert_eq!(calibration.cancel()["phase"], "cancelling");
            until(|| !calibration.busy(), "stopped");
            assert_eq!(calibration.status()["phase"], "cancelled", "{behavior}");
        }
        assert_eq!(*applied.lock().unwrap(), 0, "{behavior}");
    }
}

#[test]
fn calibration_stops_at_its_time_limit() {
    let world = world("ignores-cancel");
    let calibration = world.calibration(SHORT, SHORT, Arc::default());
    calibration.start(&world.config()).unwrap();
    until(|| !calibration.busy(), "finished");
    assert!(calibration.status()["message"].as_str().unwrap().contains("時間切れ"), "{}", calibration.status());
}

#[test]
fn cancelling_before_the_process_starts_never_opens_the_microphone() {
    let world = world("completes");
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let wait = Mutex::new(wait);
    let calibration = Calibration::with_timeouts(
        world.engine.clone(),
        world.notify(),
        Arc::new(move || {
            let _ = wait.lock().unwrap().recv();
            Ok(())
        }),
        Arc::new(|_| panic!("nothing was measured")),
        LONG,
        SHORT,
    );
    calibration.start(&world.config()).unwrap();
    calibration.cancel();
    release.send(()).unwrap();
    until(|| !calibration.busy(), "finished");
    assert_eq!(calibration.status()["phase"], "cancelled");
    assert!(!world.temp.join("worker.log").exists(), "no process ran");
}

#[test]
fn calibration_checks_what_it_needs_first() {
    let world = world("completes");
    let calibration = world.calibration(LONG, SHORT, Arc::default());
    let with = |key: &str, value: Value| {
        let mut config = world.config();
        config.insert(key.to_string(), value);
        config
    };
    assert!(calibration.start(&with("python", json!(""))).unwrap_err().contains("セットアップ"));
    assert!(calibration.start(&with("beatrice_model", json!("C:\\no.pt"))).unwrap_err().contains("モデル"));
    assert!(calibration.start(&with("input", json!(-1))).unwrap_err().contains("マイク"));
    assert!(!calibration.busy());
}

#[test]
fn shutdown_ends_a_running_calibration() {
    let world = world("waits");
    let calibration = world.calibration(LONG, SHORT, Arc::default());
    calibration.start(&world.config()).unwrap();
    until(|| world.phases().iter().any(|phase| phase == "speaking"), "speaking");
    calibration.shutdown();
    assert!(!calibration.busy());
    assert_eq!(calibration.status()["phase"], "cancelled");
}

fn training_config(world: &World) -> Config {
    let mut config = world.config();
    let audio = world.temp.join("audio");
    fs::create_dir_all(&audio).unwrap();
    let source = world.temp.join("voice.pth");
    fs::write(&source, "x").unwrap();
    config.insert("training_source".to_string(), json!(source.to_string_lossy()));
    config.insert("training_audio".to_string(), json!(audio.to_string_lossy()));
    config.insert("training_steps".to_string(), json!(1234));
    config
}

#[test]
fn training_runs_to_the_end_and_remembers_it() {
    let world = world("");
    let training = world.training();
    let started = training.start(&training_config(&world), false).unwrap();
    assert_eq!(started["busy"], true);
    assert_eq!(started["phase"], "preparing");
    assert_eq!(started["total"], 1234);
    assert!(training.start(&training_config(&world), false).unwrap_err().contains("実行中"));
    until(|| !training.busy(), "finished");
    let status = training.status();
    assert_eq!(status["phase"], "completed", "{status}");
    assert_eq!(status["busy"], false);
    assert!(status["model"].as_str().unwrap().contains("models"));

    let id = status["id"].as_str().unwrap();
    let home = world.temp.join("home");
    let job = home.join("models").join(id);
    let saved: Value = serde_json::from_str(&fs::read_to_string(job.join("config.json")).unwrap()).unwrap();
    assert!(saved["assets"].as_str().unwrap().ends_with("model-assets"));
    assert!(fs::read_to_string(job.join("training.log")).unwrap().contains("a line for the log"));
    let phases = world.phases();
    assert!(phases.iter().any(|phase| phase == "training"), "{phases:?}");
    assert!(world.events.lock().unwrap().iter().all(|event| event["type"] == "training"));
    assert!(world.events.lock().unwrap().iter().any(|event| event["message"] == "学習用ファイルを準備しています"));

    let again = Training::new(&home, &world.engine, world.notify());
    assert_eq!(again.status()["phase"], "completed");
}

#[test]
fn an_interrupted_run_can_be_resumed_after_restarting() {
    let world = world("train-waits");
    let home = world.temp.join("home");
    let training = world.training();
    training.start(&training_config(&world), false).unwrap();
    until(|| world.phases().iter().any(|phase| phase == "training"), "training");
    training.cancel();
    until(|| !training.busy(), "stopped");
    assert_eq!(training.status()["phase"], "cancelled");
    assert_eq!(training.status()["message"], "保存して止めました");
    let id = training.status()["id"].clone();

    // A run that died mid-way looks like this to the next start.
    let mut record: Value = serde_json::from_str(&fs::read_to_string(home.join("last-training.json")).unwrap()).unwrap();
    record["phase"] = json!("training");
    fs::write(home.join("last-training.json"), record.to_string()).unwrap();
    let restarted = world.training();
    assert_eq!(restarted.status()["phase"], "cancelled");
    assert_eq!(restarted.status()["message"], "前回の学習を再開できます。");

    fs::write(world.temp.join("behavior"), "").unwrap();
    let resumed = restarted.start(&world.config(), true).unwrap();
    assert_eq!(resumed["id"], id);
    assert_eq!(resumed["total"], 1234, "it keeps the saved settings");
    until(|| !restarted.busy(), "finished");
    assert_eq!(restarted.status()["phase"], "completed");
}

#[test]
fn a_crash_during_training_is_reported() {
    let world = world("train-crashes");
    let training = world.training();
    training.start(&training_config(&world), false).unwrap();
    until(|| !training.busy(), "stopped");
    assert_eq!(training.status()["phase"], "failed");
    assert!(training.status()["message"].as_str().unwrap().contains("(5)"), "{}", training.status());
}

#[test]
fn training_checks_what_it_needs_first() {
    let world = world("no-gpu");
    let training = world.training();
    assert_eq!(training.start(&training_config(&world), false).unwrap_err(), "GPUが足りません");
    assert!(!training.busy());

    fs::write(world.temp.join("behavior"), "").unwrap();
    let mut direct = training_config(&world);
    direct.insert("training_source".to_string(), json!(world.temp.join("voice.pt.gz").to_string_lossy()));
    assert!(training.start(&direct, false).unwrap_err().contains("RVCの"));

    let mut no_audio = training_config(&world);
    no_audio.insert("training_audio".to_string(), json!("C:\\no\\such\\folder"));
    assert!(training.start(&no_audio, false).unwrap_err().contains("音声フォルダ"));
    assert!(training.start(&world.config(), true).unwrap_err().contains("再開できる学習"));
    assert!(training.start(&normalize(&json!({}), false).unwrap(), false).unwrap_err().contains("セットアップ"));
}

#[test]
fn shutdown_ends_a_running_training() {
    let world = world("train-waits");
    let training = world.training();
    training.start(&training_config(&world), false).unwrap();
    until(|| world.phases().iter().any(|phase| phase == "training"), "training");
    training.shutdown();
    assert!(!training.busy());
    assert_eq!(training.status()["phase"], "cancelled");
}
