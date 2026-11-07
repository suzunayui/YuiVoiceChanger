//! Moved from electron/training.cjs and electron/model-assets.cjs: turns an RVC model into a voice for this app.

use crate::config::Config;
use crate::runtime::{download, fetch_json, file_sha256, no_window, run, DownloadOptions, RunOptions};
use crate::tools::{inspect, tool};
use crate::util::write_json;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const BEATRICE: &str = "f34836de014b86956096878aecb8d3b17feaaa0b";
const RVC: &str = "e6d0c1a17da07c33557852f9dfa2bd44cc75737d";
const ASSETS: [(&str, &str, &str, &str); 5] = [
    ("beatrice/phone.pt", "fierce-cats/beatrice-trainer", "assets/pretrained/122_checkpoint_03000000.pt", "46e2d609825ace2158c83672cfc9cc1dcb3c2b7c8d294ee911fcb6840a592bae"),
    ("beatrice/pitch.pt", "fierce-cats/beatrice-trainer", "assets/pretrained/104_3_checkpoint_00300000.pt", "174e5411009e0e4f6ee8a8c97c4cd2f646791eae1b9aa2b425acb797e0353ef4"),
    ("beatrice/base.pt.gz", "fierce-cats/beatrice-trainer", "assets/pretrained/151_checkpoint_libritts_r_200_02750000.pt.gz", "14ecdb01e51cf22b80664973daa3dedeeb0bada48bbf5262e58950c818cdcb1a"),
    ("rvc/hubert_base/pytorch_model.bin", "lj1995/VoiceConversionWebUI", "hubert_base/pytorch_model.bin", "cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5"),
    ("rvc/rmvpe.pt", "lj1995/VoiceConversionWebUI", "rmvpe.pt", "6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193"),
];

fn asset_url(repository: &str, file: &str) -> String {
    let revision = if repository.starts_with("fierce-cats") { BEATRICE } else { RVC };
    format!("https://huggingface.co/{repository}/resolve/{revision}/{file}")
}

fn prepare_assets(home: &Path, progress: &dyn Fn(&str), cancel: &AtomicBool) -> Result<PathBuf, String> {
    let root = home.join("model-assets");
    for (name, repository, remote, hash) in ASSETS {
        if cancel.load(Ordering::SeqCst) {
            return Err("準備を中止しました。".to_string());
        }
        let file = root.join(name);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if file.exists() && file_sha256(&file).as_deref() == Some(hash) {
            continue;
        }
        progress(&format!("学習用ファイルを準備しています: {name}"));
        download(&asset_url(repository, remote), &file, hash, DownloadOptions { timeout: Duration::from_secs(600), cancel: Some(cancel), ..DownloadOptions::default() })?;
    }
    for name in ["config.json", "preprocessor_config.json"] {
        let url = asset_url("lj1995/VoiceConversionWebUI", &format!("hubert_base/{name}"));
        let value = fetch_json(&url).map_err(|_| "特徴抽出モデルの情報を取得できませんでした。".to_string())?;
        fs::write(root.join("rvc").join("hubert_base").join(name), value.to_string()).map_err(|error| error.to_string())?;
    }
    Ok(root)
}

fn prepare_onnx(home: &Path, progress: &dyn Fn(&str), cancel: &AtomicBool) -> Result<PathBuf, String> {
    let root = home.join("runtime");
    let text = fs::read_to_string(root.join("direct-gpu-runtime.json")).map_err(|error| error.to_string())?;
    let manifest: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    // Reuse the verified uv already acquired by normal setup; no system Python.
    let installed = PathBuf::from(manifest["python"].as_str().unwrap_or_default());
    let uv = installed.ancestors().nth(3).map(|folder| folder.join("uv.exe")).filter(|uv| uv.exists()).ok_or("通常の環境セットアップを先に実行してください。")?;
    let dir = root.join("onnx-helper-3.14");
    let python = dir.join("Scripts").join("python.exe");
    let check = ["-I", "-c", "import sys,onnxruntime as o,numpy; assert sys.version_info[:3]>=(3,14,10); assert \"CUDAExecutionProvider\" in o.get_available_providers()"].map(str::to_string);
    if python.exists() && run(&python, &check, RunOptions { cancel: Some(cancel), ..RunOptions::default() }).is_ok() {
        return Ok(python);
    }
    let env = vec![
        ("UV_PYTHON_INSTALL_DIR".to_string(), root.join("python").to_string_lossy().into_owned()),
        ("UV_CACHE_DIR".to_string(), root.join("uv-cache").to_string_lossy().into_owned()),
        ("UV_NO_PROGRESS".to_string(), "1".to_string()),
    ];
    let args = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<String>>();
    let long = |env: &Vec<(String, String)>| RunOptions { env: env.clone(), timeout: Duration::from_secs(300), progress: Some(progress), cancel: Some(cancel) };
    let short = |env: &Vec<(String, String)>| RunOptions { env: env.clone(), cancel: Some(cancel), ..RunOptions::default() };
    progress("ONNX専用の互換環境を準備しています…");
    run(&uv, &args(&["python", "install", "3.14.10", "--no-bin", "--no-registry"]), long(&env))?;
    let base = root.join("python").join("cpython-3.14.10-windows-x86_64-none").join("python.exe");
    if !python.exists() {
        run(&uv, &args(&["venv", "--python", &base.to_string_lossy(), &dir.to_string_lossy()]), short(&env))?;
    }
    let python_text = python.to_string_lossy().into_owned();
    run(&uv, &args(&["pip", "uninstall", "--python", &python_text, "onnxruntime"]), short(&env))?;
    run(&uv, &args(&["pip", "install", "--python", &python_text, "--only-binary", ":all:", "onnxruntime-gpu==1.31.1", "numpy==2.5.4"]), long(&env))?;
    Ok(python)
}

fn is_job_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-')
}

pub type Preparer = Box<dyn Fn(&Path, &dyn Fn(&str), &AtomicBool) -> Result<PathBuf, String> + Send + Sync>;

struct Inner {
    home: PathBuf,
    engine_root: PathBuf,
    notify: Arc<dyn Fn(Value) + Send + Sync>,
    prepare: Preparer,
    record: PathBuf,
    state: Mutex<(Value, bool)>,
    finished: Condvar,
    starting: AtomicBool,
    cancelled: Arc<AtomicBool>,
    stdin: Mutex<Option<ChildStdin>>,
    child_id: Mutex<Option<Arc<Mutex<std::process::Child>>>>,
}

impl Inner {
    fn update(&self, value: &Value) {
        let event = {
            let mut guard = self.state.lock().unwrap();
            if let (Some(target), Some(source)) = (guard.0.as_object_mut(), value.as_object()) {
                target.extend(source.clone());
            }
            let _ = fs::create_dir_all(&self.home);
            let _ = fs::write(&self.record, serde_json::to_string_pretty(&guard.0).unwrap_or_default());
            let mut event = guard.0.clone();
            event["busy"] = json!(guard.1);
            event["type"] = json!("training");
            event
        };
        (self.notify)(event);
    }

    fn execute(&self, python: &str, options: &mut Value) -> Result<(), String> {
        const STOPPED: &str = "準備を中止しました。再開できます。";
        let progress = |message: &str| self.update(&json!({"message": message}));
        let cancel = self.cancelled.as_ref();
        let assets = (self.prepare)(&self.home, &progress, cancel)?;
        options["assets"] = json!(assets.to_string_lossy());
        if cancel.load(Ordering::SeqCst) {
            self.update(&json!({"phase": "cancelled", "message": STOPPED}));
            return Ok(());
        }
        let source = options["source"].as_str().unwrap_or_default().to_lowercase();
        if source.ends_with(".onnx") {
            let helper = prepare_onnx(&self.home, &progress, cancel)?;
            options["helper"] = json!(helper.to_string_lossy());
        }
        if cancel.load(Ordering::SeqCst) {
            self.update(&json!({"phase": "cancelled", "message": STOPPED}));
            return Ok(());
        }
        let job = PathBuf::from(options["job"].as_str().unwrap_or_default());
        let config_file = job.join("config.json");
        write_json(&config_file, options)?;
        let log_path = job.join("training.log");
        let mut command = Command::new(python);
        command
            .args(["-I", "-u"])
            .arg(self.engine_root.join("backend").join("training_job.py"))
            .arg(&config_file)
            .current_dir(&self.engine_root)
            .env("PYTHONIOENCODING", "utf-8")
            .env("OMP_NUM_THREADS", "2")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window(&mut command);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        *self.stdin.lock().unwrap() = child.stdin.take();
        let child = Arc::new(Mutex::new(child));
        *self.child_id.lock().unwrap() = Some(child.clone());
        // Cancelling just before the process began must still reach it.
        if cancel.load(Ordering::SeqCst) {
            self.send_cancel();
        }
        let stderr_log = OpenOptions::new().create(true).append(true).open(&log_path).ok();
        thread::spawn(move || {
            let Some(mut log) = stderr_log else { return };
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut log);
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
        let mut log: Option<File> = OpenOptions::new().create(true).append(true).open(&log_path).ok();
        let mut terminal = false;
        let mut exited: Option<(Instant, Option<i32>)> = None;
        loop {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    match serde_json::from_str::<Value>(&line) {
                        Ok(event) if event.is_object() => {
                            if ["completed", "cancelled", "failed"].contains(&event["phase"].as_str().unwrap_or_default()) {
                                terminal = true;
                            }
                            self.update(&event);
                        }
                        _ => {
                            if let Some(log) = log.as_mut() {
                                let _ = writeln!(log, "{line}");
                            }
                        }
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) if exited.is_some() => break,
                Err(_) => {}
            }
            if exited.is_none() {
                if let Ok(Some(status)) = child.lock().unwrap().try_wait() {
                    exited = Some((Instant::now(), status.code()));
                }
            }
            if exited.is_some_and(|(at, _)| at.elapsed() > Duration::from_millis(500)) {
                break;
            }
        }
        *self.stdin.lock().unwrap() = None;
        *self.child_id.lock().unwrap() = None;
        if !terminal {
            let code = exited.and_then(|(_, code)| code).unwrap_or(-1);
            let stopped = cancel.load(Ordering::SeqCst);
            self.update(&json!({
                "phase": if stopped { "cancelled" } else { "failed" },
                "message": if stopped { "学習を中断しました。保存済みの状態から再開できます。".to_string() } else { format!("学習プロセスが終了しました ({code})。詳細は学習ログを確認してください。") },
            }));
        }
        Ok(())
    }

    fn send_cancel(&self) {
        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, r#"{{"command":"cancel"}}"#).and_then(|()| stdin.flush());
        }
    }
}

pub struct Training {
    inner: Arc<Inner>,
}

impl Training {
    pub fn new(home: &Path, engine_root: &Path, notify: Arc<dyn Fn(Value) + Send + Sync>) -> Self {
        Self::with_preparer(home, engine_root, notify, Box::new(prepare_assets))
    }

    /// `prepare` fetches the several GB of files that training starts from.
    pub fn with_preparer(home: &Path, engine_root: &Path, notify: Arc<dyn Fn(Value) + Send + Sync>, prepare: Preparer) -> Self {
        let record = home.join("last-training.json");
        let mut state = json!({"phase": "idle", "message": "RVCモデルから、このアプリ用の声を学習できます。"});
        if let Some(mut saved) = fs::read_to_string(&record).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).filter(Value::is_object) {
            if !["completed", "cancelled", "failed", "idle"].contains(&saved["phase"].as_str().unwrap_or_default()) {
                saved["phase"] = json!("cancelled");
                saved["message"] = json!("前回の学習を再開できます。");
            }
            state = saved;
        }
        Self {
            inner: Arc::new(Inner {
                home: home.to_path_buf(),
                engine_root: engine_root.to_path_buf(),
                notify,
                prepare,
                record,
                state: Mutex::new((state, false)),
                finished: Condvar::new(),
                starting: AtomicBool::new(false),
                cancelled: Arc::new(AtomicBool::new(false)),
                stdin: Mutex::new(None),
                child_id: Mutex::new(None),
            }),
        }
    }

    pub fn busy(&self) -> bool {
        self.inner.state.lock().unwrap().1
    }

    pub fn status(&self) -> Value {
        let guard = self.inner.state.lock().unwrap();
        let mut status = guard.0.clone();
        status["busy"] = json!(guard.1);
        status
    }

    pub fn start(&self, config: &Config, resume: bool) -> Result<Value, String> {
        if self.busy() || self.inner.starting.swap(true, Ordering::SeqCst) {
            return Err("学習は実行中です。".to_string());
        }
        let result = self.start_checked(config, resume);
        self.inner.starting.store(false, Ordering::SeqCst);
        result
    }

    fn start_checked(&self, config: &Config, resume: bool) -> Result<Value, String> {
        let inner = &self.inner;
        let text = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let python = text("python");
        let gpu = tool(&python, &inner.engine_root, "gpu", &[])?;
        if gpu["eligible"] != json!(true) {
            return Err(gpu["reason"].as_str().unwrap_or("このGPUでは学習できません。").to_string());
        }
        let (job, mut options) = if resume {
            let id = inner.state.lock().unwrap().0["id"].as_str().unwrap_or_default().to_string();
            if !is_job_id(&id) {
                return Err("再開できる学習がありません。".to_string());
            }
            let job = inner.home.join("models").join(&id);
            let saved = fs::read_to_string(job.join("config.json")).map_err(|error| error.to_string())?;
            (job, serde_json::from_str::<Value>(&saved).map_err(|error| error.to_string())?)
        } else {
            let source = text("training_source");
            let info = inspect(&python, &inner.engine_root, &inner.home, &source)?;
            if info["train_required"] != json!(true) {
                return Err("RVCの.pthまたは.onnxを選んでください。".to_string());
            }
            let audio = text("training_audio");
            if !Path::new(&audio).is_dir() {
                return Err("学習素材の音声フォルダを選んでください。".to_string());
            }
            let job = inner.home.join("models").join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&job).map_err(|error| error.to_string())?;
            let options = json!({"source": source, "audio": audio, "pitch": config.get("teacher_pitch"), "steps": config.get("training_steps"), "job": job.to_string_lossy()});
            write_json(&job.join("config.json"), &options)?;
            (job, options)
        };
        inner.state.lock().unwrap().1 = true;
        inner.cancelled.store(false, Ordering::SeqCst);
        let id = job.file_name().unwrap_or_default().to_string_lossy().into_owned();
        inner.update(&json!({"id": id, "phase": "preparing", "message": "学習環境を準備しています", "model": null, "current": 0, "total": options["steps"], "eta_seconds": null}));
        let worker = inner.clone();
        thread::spawn(move || {
            if let Err(message) = worker.execute(&python, &mut options) {
                let stopped = worker.cancelled.load(Ordering::SeqCst);
                worker.update(&json!({"phase": if stopped { "cancelled" } else { "failed" }, "message": if stopped { "準備を中止しました。".to_string() } else { message }}));
            }
            worker.state.lock().unwrap().1 = false;
            worker.update(&json!({}));
            worker.finished.notify_all();
        });
        Ok(self.status())
    }

    pub fn cancel(&self) -> Value {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.send_cancel();
        if self.busy() {
            self.inner.update(&json!({"message": "中断を要求しました。処理の区切りで保存して停止します。"}));
        }
        self.status()
    }

    pub fn shutdown(&self) {
        self.shutdown_within(Duration::from_secs(20));
    }

    pub fn shutdown_within(&self, limit: Duration) {
        if !self.busy() {
            return;
        }
        self.cancel();
        let guard = self.inner.state.lock().unwrap();
        let (guard, _) = self.inner.finished.wait_timeout_while(guard, limit, |state| state.1).unwrap();
        drop(guard);
        if self.busy() {
            let child = self.inner.child_id.lock().unwrap().clone();
            if let Some(child) = child {
                let _ = child.lock().unwrap().kill();
            }
            *self.inner.stdin.lock().unwrap() = None;
        }
    }
}
