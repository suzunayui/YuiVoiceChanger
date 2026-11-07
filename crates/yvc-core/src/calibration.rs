//! Moved from electron/latency-calibration.cjs: measures the delay by running backend/latency_calibration.py.

use crate::config::Config;
use crate::runtime::no_window;
use crate::util::is_file;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub type Notify = Arc<dyn Fn(Value) + Send + Sync>;
pub type BeforeStart = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
pub type OnComplete = Arc<dyn Fn(&mut Value) -> Result<Value, String> + Send + Sync>;

fn merged(base: &Value, extra: &Value) -> Value {
    let mut result = base.clone();
    if let (Some(target), Some(source)) = (result.as_object_mut(), extra.as_object()) {
        target.extend(source.clone());
    }
    result
}

struct Inner {
    engine_root: PathBuf,
    notify: Notify,
    before_start: BeforeStart,
    on_complete: OnComplete,
    timeout: Duration,
    cancel_timeout: Duration,
    state: Mutex<(Value, bool)>,
    finished: Condvar,
    cancelled: AtomicBool,
    // Measuring has ended, which lets the result be saved, but the result isn't in place yet.
    saving_result: AtomicBool,
    stdin: Mutex<Option<ChildStdin>>,
}

pub struct Calibration {
    inner: Arc<Inner>,
}

impl Inner {
    fn status(&self) -> Value {
        let state = self.state.lock().unwrap();
        merged(&state.0, &json!({"busy": state.1 || self.saving_result.load(Ordering::SeqCst)}))
    }

    fn update(&self, next: &Value) {
        let event = {
            let mut state = self.state.lock().unwrap();
            state.0 = merged(&state.0, next);
            merged(&state.0, &json!({"busy": state.1}))
        };
        (self.notify)(merged(&json!({"type": "latency-calibration"}), &event));
    }

    fn finish(&self, mut event: Value) {
        if self.cancelled.load(Ordering::SeqCst) {
            event = json!({"phase": "cancelled", "message": "測定を中止しました。"});
        }
        *self.stdin.lock().unwrap() = None;
        {
            let mut state = self.state.lock().unwrap();
            self.saving_result.store(true, Ordering::SeqCst);
            state.1 = false;
        }
        let mut next_config = None;
        if event["phase"] == "completed" {
            let result = match event["recommended_ms"].as_i64().filter(|ms| (200..=2000).contains(ms) && event["recommended_ms"].is_i64()) {
                Some(_) => (self.on_complete)(&mut event),
                None => Err("測定結果が正しくありません。".to_string()),
            };
            match result {
                Ok(config) => next_config = Some(config),
                Err(message) => event = json!({"phase": "failed", "message": message}),
            }
        }
        let notification = {
            // The status stays busy until now, so nobody reads an old phase as the outcome.
            let mut state = self.state.lock().unwrap();
            state.0 = event;
            self.saving_result.store(false, Ordering::SeqCst);
            merged(&state.0, &json!({"busy": false}))
        };
        let mut notification = merged(&json!({"type": "latency-calibration"}), &notification);
        if let Some(config) = next_config {
            notification["config"] = config;
        }
        (self.notify)(notification);
        self.finished.notify_all();
    }

    fn write_line(&self, line: &str) {
        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, "{line}").and_then(|()| stdin.flush());
        }
    }

    fn launch(&self, python: &str, script: &std::path::Path, config: &Value) -> Value {
        const LOST: &str = "測定プロセスが終了しました。変換環境を確認して再試行してください。";
        let mut command = Command::new(python);
        command
            .args(["-I", "-u"])
            .arg(script)
            .current_dir(&self.engine_root)
            .env("PYTHONIOENCODING", "utf-8")
            .env("OMP_NUM_THREADS", "2")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window(&mut command);
        let mut child: Child = match command.spawn() {
            Ok(child) => child,
            Err(_) => return json!({"phase": "failed", "message": "測定プロセスを起動できませんでした。"}),
        };
        let (Some(stdout), Some(mut stderr), Some(stdin)) = (child.stdout.take(), child.stderr.take(), child.stdin.take()) else {
            let _ = child.kill();
            return json!({"phase": "failed", "message": "測定プロセスを起動できませんでした。"});
        };
        *self.stdin.lock().unwrap() = Some(stdin);
        thread::spawn(move || {
            let mut sink = [0u8; 4096];
            while matches!(stderr.read(&mut sink), Ok(read) if read > 0) {}
        });
        let (sender, receiver) = mpsc::channel::<String>();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        self.write_line(&config.to_string());

        let deadline = Instant::now() + self.timeout;
        let mut cancel_at: Option<Instant> = None;
        let mut terminal: Option<Value> = None;
        let mut exited: Option<(Instant, Option<i32>)> = None;
        loop {
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(line) => {
                    if let Ok(event) = serde_json::from_str::<Value>(&line) {
                        let phase = event["phase"].as_str().unwrap_or_default();
                        if ["completed", "cancelled", "failed"].contains(&phase) {
                            terminal = Some(event);
                            *self.stdin.lock().unwrap() = None;
                        } else if ["preparing", "speaking", "measuring"].contains(&phase) && !self.cancelled.load(Ordering::SeqCst) {
                            self.update(&event);
                        }
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) if exited.is_some() => break,
                Err(_) => {}
            }
            if exited.is_none() {
                if let Ok(Some(status)) = child.try_wait() {
                    exited = Some((Instant::now(), status.code()));
                }
            }
            match exited {
                // The real Python behind a venv's launcher can hold the pipe a little after the launcher ends.
                Some((at, _)) if at.elapsed() > Duration::from_millis(500) => break,
                Some(_) => continue,
                None => {}
            }
            if self.cancelled.load(Ordering::SeqCst) {
                let at = *cancel_at.get_or_insert_with(|| Instant::now() + self.cancel_timeout);
                if Instant::now() >= at {
                    let _ = child.kill();
                }
            }
            if Instant::now() >= deadline && terminal.as_ref().is_none_or(|event| event["phase"] != "failed") {
                terminal = Some(json!({"phase": "failed", "message": "測定が時間切れになりました。再試行してください。"}));
                *self.stdin.lock().unwrap() = None;
                let _ = child.kill();
            }
        }
        let code = exited.and_then(|(_, code)| code);
        match terminal {
            Some(event) if code == Some(0) => event,
            Some(event) if event["phase"] == "failed" => json!({"phase": "failed", "message": event["message"]}),
            _ => json!({"phase": "failed", "message": LOST}),
        }
    }
}

impl Calibration {
    pub fn new(engine_root: PathBuf, notify: Notify, before_start: BeforeStart, on_complete: OnComplete) -> Self {
        Self::with_timeouts(engine_root, notify, before_start, on_complete, Duration::from_secs(120), Duration::from_secs(5))
    }

    pub fn with_timeouts(engine_root: PathBuf, notify: Notify, before_start: BeforeStart, on_complete: OnComplete, timeout: Duration, cancel_timeout: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                engine_root,
                notify,
                before_start,
                on_complete,
                timeout,
                cancel_timeout,
                state: Mutex::new((json!({"phase": "idle", "message": "", "progress": 0}), false)),
                finished: Condvar::new(),
                cancelled: AtomicBool::new(false),
                saving_result: AtomicBool::new(false),
                stdin: Mutex::new(None),
            }),
        }
    }

    pub fn busy(&self) -> bool {
        self.inner.state.lock().unwrap().1
    }

    pub fn status(&self) -> Value {
        self.inner.status()
    }

    pub fn start(&self, config: &Config) -> Result<Value, String> {
        if self.busy() || self.inner.saving_result.load(Ordering::SeqCst) {
            return Err("自動設定は実行中です。".to_string());
        }
        let text = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let python = text("python");
        if python.is_empty() || !is_file(&python) {
            return Err("変換環境をセットアップしてください。".to_string());
        }
        let model = text("beatrice_model");
        if model.is_empty() || !is_file(&model) {
            return Err("声のモデルを選んでください。".to_string());
        }
        let unset = |key: &str| config.get(key).and_then(Value::as_f64).unwrap_or(-1.0) < 0.0;
        if unset("input") || unset("output") {
            return Err("マイクと出力先を選んでください。".to_string());
        }
        let script = self.inner.engine_root.join("backend").join("latency_calibration.py");
        if !script.exists() {
            return Err("自動設定の音声処理ファイルが見つかりません。".to_string());
        }
        self.inner.cancelled.store(false, Ordering::SeqCst);
        {
            let mut state = self.inner.state.lock().unwrap();
            *state = (json!({"phase": "preparing", "message": "自動設定を準備しています…", "progress": 0}), true);
        }
        self.inner.update(&json!({}));
        let inner = self.inner.clone();
        let value = Value::Object(config.clone());
        thread::spawn(move || {
            let event = match (inner.before_start)() {
                Err(message) => json!({"phase": "failed", "message": message}),
                Ok(()) if inner.cancelled.load(Ordering::SeqCst) => json!({"phase": "cancelled", "message": "測定を中止しました。"}),
                Ok(()) => inner.launch(&python, &script, &value),
            };
            inner.finish(event);
        });
        Ok(self.status())
    }

    pub fn cancel(&self) -> Value {
        if !self.busy() {
            return self.status();
        }
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.update(&json!({"phase": "cancelling", "message": "測定を中止しています…"}));
        self.inner.write_line(r#"{"command":"cancel"}"#);
        self.status()
    }

    pub fn shutdown(&self) {
        if !self.busy() {
            return;
        }
        self.cancel();
        let guard = self.inner.state.lock().unwrap();
        let _ = self.inner.finished.wait_timeout_while(guard, Duration::from_secs(10), |state| state.1).unwrap();
    }
}
