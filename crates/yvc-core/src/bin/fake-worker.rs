// Speaks the protocols of the Python backend without any audio, for testing the code that drives it.
// Each test has its own folder, found from the script path it is given as <folder>/engine/backend/<script>.py.
// The folder's "behavior" file picks how it misbehaves. Commands go to "worker.log".

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn emit(value: Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

fn calibration(behavior: &str) {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let first = lines.next();
    assert!(first.is_some_and(|line| line.unwrap().contains("beatrice_model")));
    emit(json!({"phase": "preparing", "message": "準備", "progress": 0.0}));
    emit(json!({"phase": "speaking", "message": "話して", "progress": 0.1, "rms": 0.5}));
    match behavior {
        "completes" => {
            emit(json!({"phase": "completed", "recommended_ms": 640, "message": "完了"}));
        }
        "invalid" => {
            emit(json!({"phase": "completed", "recommended_ms": 5000}));
        }
        "fails" => {
            emit(json!({"phase": "failed", "message": "マイクが無音です"}));
            std::process::exit(1);
        }
        "crashes" => std::process::exit(9),
        "ignores-cancel" => std::thread::sleep(Duration::from_secs(120)),
        _ => {
            for line in lines.by_ref() {
                let Ok(line) = line else { break };
                if line.contains("cancel") {
                    // A result that arrives just as the cancel does must not count.
                    emit(json!({"phase": if behavior == "late" { "completed" } else { "cancelled" }, "recommended_ms": 320, "message": "中止"}));
                    break;
                }
            }
        }
    }
    // The real script waits for its input to close before exiting.
    for _ in lines {}
}

fn training(behavior: &str, args: &[String]) {
    let config: Value = serde_json::from_str(&std::fs::read_to_string(args.last().unwrap()).unwrap()).unwrap();
    println!("a line for the log");
    emit(json!({"phase": "training", "current": 5, "total": config["steps"], "assets": config["assets"]}));
    match behavior {
        "train-crashes" => std::process::exit(5),
        "train-waits" => {
            for line in std::io::stdin().lock().lines() {
                if line.is_ok_and(|line| line.contains("cancel")) {
                    emit(json!({"phase": "cancelled", "message": "保存して止めました"}));
                    return;
                }
            }
        }
        _ => emit(json!({"phase": "completed", "message": "完了", "model": config["job"]})),
    }
}

fn model_tools(behavior: &str, args: &[String]) {
    let position = args.iter().position(|arg| arg.ends_with(".py")).unwrap();
    match args[position + 1].as_str() {
        "gpu" if behavior == "no-gpu" => emit(json!({"eligible": false, "reason": "GPUが足りません"})),
        "gpu" => emit(json!({"eligible": true})),
        "inspect" => emit(json!({"train_required": args[position + 2].ends_with(".pth"), "path": args[position + 2]})),
        _ => emit(json!({"devices": []})),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let script = args.iter().find(|arg| arg.ends_with(".py")).cloned().unwrap_or_default();
    let folder: PathBuf = Path::new(&script).ancestors().nth(3).map(Path::to_path_buf).unwrap_or_default();
    let behavior = std::fs::read_to_string(folder.join("behavior")).unwrap_or_default();
    let behavior = behavior.trim();
    let log = folder.join("worker.log");
    let record = |line: &str| {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&log) {
            let _ = writeln!(file, "{line}");
        }
    };
    record(&format!("args {args:?}"));
    if script.ends_with("latency_calibration.py") {
        return calibration(behavior);
    }
    if script.ends_with("training_job.py") {
        return training(behavior, &args);
    }
    if script.ends_with("model_tools.py") {
        return model_tools(behavior, &args);
    }
    eprintln!("fake worker started");
    println!("this line is not JSON, and must only go to the log");
    if behavior == "exit-early" {
        std::process::exit(3);
    }
    emit(json!({"type": "ready"}));
    let mut running = false;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        record(&line);
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        match request["command"].as_str().unwrap_or_default() {
            "devices" => emit(json!({"type": "devices", "devices": [
                {"id": 1, "name": "Mic", "host": "Windows WASAPI", "inputs": 1, "outputs": 0},
                {"id": 2, "name": "Speaker", "host": "Windows WASAPI", "inputs": 0, "outputs": 2},
            ]})),
            "start" => {
                if behavior == "crash-on-start" {
                    std::process::exit(7);
                }
                emit(json!({"type": "state", "state": "loading"}));
                if request["config"]["beatrice_voice"] == 99 {
                    emit(json!({"type": "error", "message": "モデルを読み込めません"}));
                    emit(json!({"type": "state", "state": "stopped"}));
                    continue;
                }
                running = true;
                let mut state = json!({"type": "state", "state": "running"});
                if let Some(timing) = request["config"].get("fake_manual_timing") {
                    state["manual_timing"] = timing.clone();
                }
                emit(state);
            }
            "stop" => {
                if running {
                    running = false;
                    emit(json!({"type": "state", "state": "stopped"}));
                }
            }
            "quit" => {
                if behavior != "ignore-quit" {
                    break;
                }
            }
            _ => {}
        }
    }
    if behavior == "ignore-quit" {
        std::thread::sleep(Duration::from_secs(120));
    }
}
