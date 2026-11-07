//! Moved from electron/compute-devices.cjs and the tool part of training.cjs.
//! These run backend/model_tools.py, and read what it prints.

use crate::runtime::{run, RunOptions};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

pub fn tool(python: &str, engine_root: &Path, command: &str, args: &[String]) -> Result<Value, String> {
    if python.is_empty() {
        return Err("実行環境をセットアップしてください。".to_string());
    }
    let script = engine_root.join("backend").join("model_tools.py");
    let mut full = vec!["-I".to_string(), script.to_string_lossy().into_owned(), command.to_string()];
    full.extend_from_slice(args);
    let output = run(Path::new(python), &full, RunOptions::default())?;
    let last = output.trim().lines().last().unwrap_or_default();
    serde_json::from_str(last).map_err(|error| error.to_string())
}

// ONNX models need the onnx package, which older environments don't have.
fn ensure_onnx(python: &str, home: &Path) -> Result<(), String> {
    let check = ["-I", "-c", "import onnx"].map(str::to_string);
    if run(Path::new(python), &check, RunOptions::default()).is_ok() {
        return Ok(());
    }
    let record = home.join("runtime").join("direct-gpu-runtime.json");
    let manifest: Value = serde_json::from_str(&fs::read_to_string(record).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let installed = PathBuf::from(manifest["python"].as_str().unwrap_or_default());
    let uv = installed.ancestors().nth(3).map(|root| root.join("uv.exe")).ok_or("セットアップ用ツールが見つかりません。")?;
    let args = ["pip", "install", "--python", python, "--only-binary", ":all:", "onnx==1.23.2"].map(str::to_string);
    run(&uv, &args, RunOptions { timeout: Duration::from_secs(300), ..RunOptions::default() }).map(|_| ())
}

pub fn inspect(python: &str, engine_root: &Path, home: &Path, file: &str) -> Result<Value, String> {
    if file.is_empty() {
        return Err("モデルを選んでください。".to_string());
    }
    if file.to_lowercase().ends_with(".onnx") {
        ensure_onnx(python, home)?;
    }
    tool(python, engine_root, "inspect", &[file.to_string()])
}

fn powershell_json(script: &str) -> Result<Value, String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let exe = PathBuf::from(root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let args = ["-NoProfile", "-NonInteractive", "-Command", &format!("[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); {script} | ConvertTo-Json -Compress")].map(str::to_string);
    let output = run(&exe, &args, RunOptions { timeout: Duration::from_secs(15), ..RunOptions::default() })?;
    let text = output.trim();
    serde_json::from_str(if text.is_empty() { "[]" } else { text }).map_err(|error| error.to_string())
}

pub fn compute_devices(python: &str, engine_root: &Path) -> Value {
    let root = engine_root.to_path_buf();
    let python_owned = python.to_string();
    let runtime = thread::spawn(move || if python_owned.is_empty() { Ok(json!({"devices": []})) } else { tool(&python_owned, &root, "compute-devices", &[]) });
    let adapters = thread::spawn(|| powershell_json("@(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name)"));
    let cpu_name = thread::spawn(|| powershell_json("(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)"));

    let runtime = runtime.join().unwrap_or_else(|_| Err("failed".to_string()));
    let adapters = adapters.join().unwrap_or_else(|_| Err("failed".to_string())).map(|value| match value {
        Value::Array(items) => items,
        single => vec![single],
    });
    let cpu = cpu_name.join().ok().and_then(Result::ok).and_then(|value| value.as_str().map(|name| name.trim().to_string())).filter(|name| !name.is_empty()).unwrap_or_else(|| "CPU".to_string());

    let mut gpus: Vec<Value> = runtime.as_ref().ok().and_then(|value| value["devices"].as_array().cloned()).unwrap_or_default();
    let mut remaining = gpus.clone();
    for (index, name) in adapters.as_ref().map(Vec::as_slice).unwrap_or_default().iter().enumerate() {
        if let Some(position) = remaining.iter().position(|gpu| gpu["name"] == *name) {
            remaining.remove(position);
            continue;
        }
        // Keep every CUDA device, including identically named cards, selectable.
        if gpus.iter().any(|gpu| gpu["name"] == *name) {
            continue;
        }
        let label = name.as_str().unwrap_or_default();
        let reason = if python.is_empty() {
            "実行環境をセットアップすると利用可否を確認できます。"
        } else if runtime.is_err() {
            "GPUの利用可否を確認できませんでした。"
        } else if label.to_lowercase().contains("nvidia") {
            "現在の実行環境では利用できません。環境設定で環境を確認してください。"
        } else {
            "このGPUでの変換には対応していません。"
        };
        gpus.push(json!({"id": format!("unsupported:{index}"), "kind": "GPU", "name": name, "available": false, "reason": reason}));
    }
    let mut devices = vec![json!({"id": "cpu", "kind": "CPU", "name": cpu, "available": true})];
    devices.extend(gpus);
    let warning = if runtime.is_err() {
        "GPUの確認に失敗しました。実行環境を確認して再読み込みしてください。"
    } else if adapters.is_err() {
        "一部のGPU情報を取得できませんでした。"
    } else {
        ""
    };
    json!({"devices": devices, "warning": warning})
}
