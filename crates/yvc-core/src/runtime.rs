//! Moved from electron/setup.cjs: prepares the Python environment that does the audio.

use crate::util::to_hex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub const PYTHON: &str = "3.15.2";
const UV_URL: &str = "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip";
const UV_SHA: &str = "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f";
const CPU_TORCH: &str = "torch @ https://download-r2.pytorch.org/whl/cpu/torch-2.15.0%2Bcpu-cp315-cp315-win_amd64.whl#sha256=5c21ee962b6f67821dac0bc882f5ee1539a4edeabe736284d2ff1d652e595ed1";
pub const CANCELLED: &str = "セットアップを中止しました。";
const OUTPUT_LIMIT: usize = 12_000;

pub fn no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

pub struct RunOptions<'a> {
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
    pub progress: Option<&'a dyn Fn(&str)>,
    pub cancel: Option<&'a AtomicBool>,
}

impl Default for RunOptions<'_> {
    fn default() -> Self {
        Self { env: Vec::new(), timeout: Duration::from_secs(120), progress: None, cancel: None }
    }
}

fn tail(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Runs a program to its end and returns the last part of what it printed.
pub fn run(exe: &Path, args: &[String], options: RunOptions) -> Result<String, String> {
    let is_cancelled = || options.cancel.is_some_and(|cancel| cancel.load(Ordering::SeqCst));
    if is_cancelled() {
        return Err(CANCELLED.to_string());
    }
    let mut command = Command::new(exe);
    command.args(args).current_dir(std::env::temp_dir()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.envs(options.env.iter().map(|(key, value)| (key, value)));
    no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("準備用プログラムを起動できません ({error}): {}", exe.display()))?;

    let (sender, receiver) = mpsc::channel::<String>();
    let readers: Vec<Box<dyn Read + Send>> = vec![
        Box::new(child.stdout.take().expect("stdout is piped")),
        Box::new(child.stderr.take().expect("stderr is piped")),
    ];
    for mut reader in readers {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 || sender.send(String::from_utf8_lossy(&buffer[..read]).into_owned()).is_err() {
                    break;
                }
            }
        });
    }
    drop(sender);

    let deadline = Instant::now() + options.timeout;
    let mut output = String::new();
    let mut status = None;
    let mut exited_at = None;
    loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(chunk) => {
                output.push_str(&chunk);
                output = tail(&output, OUTPUT_LIMIT).to_string();
                if let Some(progress) = options.progress {
                    progress(tail(chunk.trim(), 350));
                }
            }
            Err(RecvTimeoutError::Disconnected) if status.is_some() => break,
            Err(_) => {}
        }
        if status.is_none() {
            status = child.try_wait().map_err(|error| error.to_string())?;
            if status.is_some() {
                exited_at = Some(Instant::now());
            }
        }
        // A grandchild can keep the pipes open long after the program itself has ended.
        if exited_at.is_some_and(|at: Instant| at.elapsed() > Duration::from_secs(1)) {
            break;
        }
        if status.is_none() && is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED.to_string());
        }
        if status.is_none() && Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("環境の準備が時間切れになりました。もう一度試してください。".to_string());
        }
    }
    let status = status.expect("the loop ends only after the program exits");
    if status.success() {
        Ok(output)
    } else if output.is_empty() {
        Err(format!("準備に失敗しました ({})", status.code().unwrap_or(-1)))
    } else {
        Err(output)
    }
}

pub struct DownloadOptions<'a> {
    pub timeout: Duration,
    pub cancel: Option<&'a AtomicBool>,
    pub headers: Vec<(&'a str, &'a str)>,
    pub on_progress: Option<&'a dyn Fn(u64, u64)>,
}

impl Default for DownloadOptions<'_> {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(120), cancel: None, headers: Vec::new(), on_progress: None }
    }
}

fn agent() -> Result<ureq::Agent, String> {
    let tls = native_tls::TlsConnector::new().map_err(|error| error.to_string())?;
    Ok(ureq::AgentBuilder::new()
        .tls_connector(Arc::new(tls))
        .user_agent("YuiVoiceChanger")
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .build())
}

/// Saves to a temporary name, and only keeps the file if its hash is right.
pub fn download(url: &str, file: &Path, hash: &str, options: DownloadOptions) -> Result<(), String> {
    let mut request = agent()?.get(url);
    for (name, value) in &options.headers {
        request = request.set(name, value);
    }
    let response = request.call().map_err(|error| match error {
        ureq::Error::Status(code, _) => format!("ダウンロードに失敗しました ({code})"),
        ureq::Error::Transport(_) => "ダウンロードに失敗しました。インターネット接続を確認してください。".to_string(),
    })?;
    let total: u64 = response.header("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(".partial");
    let temporary = PathBuf::from(temporary);
    let result = (|| -> Result<(), String> {
        let mut output = File::create(&temporary).map_err(|error| error.to_string())?;
        let mut reader = response.into_reader();
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut received = 0u64;
        let deadline = Instant::now() + options.timeout;
        loop {
            if options.cancel.is_some_and(|cancel| cancel.load(Ordering::SeqCst)) {
                return Err(CANCELLED.to_string());
            }
            if Instant::now() >= deadline {
                return Err("ダウンロードが時間切れになりました。".to_string());
            }
            let read = reader.read(&mut buffer).map_err(|_| "ダウンロードが途中で切れました。".to_string())?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
            output.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
            received += read as u64;
            if let Some(on_progress) = options.on_progress {
                on_progress(received, total);
            }
        }
        output.flush().map_err(|error| error.to_string())?;
        drop(output);
        if to_hex(&digest.finalize()) != hash {
            return Err("ダウンロードしたファイルの検証に失敗しました。".to_string());
        }
        fs::rename(&temporary, file).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Unpacks a zip, refusing paths that would land outside the destination and links.
pub fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "圧縮ファイルを開けませんでした。".to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|_| "圧縮ファイルが壊れています。".to_string())?;
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err("圧縮ファイルにリンクが含まれています。".to_string());
        }
        let relative = entry.enclosed_name().ok_or("圧縮ファイルに不正なパスが含まれています。")?;
        let target = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::create(&target).map_err(|error| error.to_string())?;
        io::copy(&mut entry, &mut output).map_err(|_| "圧縮ファイルが壊れています。".to_string())?;
    }
    Ok(())
}

fn validate(python: &Path, engine_root: &Path, cancel: Option<&AtomicBool>) -> Result<Value, String> {
    let script = engine_root.join("backend").join("runtime_info.py");
    let args = vec!["-I".to_string(), script.to_string_lossy().into_owned()];
    let output = run(python, &args, RunOptions { cancel, ..RunOptions::default() })?;
    serde_json::from_str(output.trim()).map_err(|error| error.to_string())
}

fn has_nvidia_driver() -> bool {
    let windows = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    windows.join("System32").join("nvcuda.dll").exists()
}

fn is_runtime_folder(name: &str) -> bool {
    let Some(id) = name.strip_prefix("direct-gpu-") else { return false };
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(length, part)| part.len() == *length && part.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)))
}

/// Each environment takes several GB, so only the active one is kept.
pub fn remove_stale_runtimes(root: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_runtime_folder(&name) && name != keep {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn reusable_runtime(active: &Path, engine_root: &Path, cancel: &AtomicBool) -> Option<String> {
    let previous: Value = serde_json::from_str(&fs::read_to_string(active).ok()?).ok()?;
    if previous["revision"] != 2 {
        return None;
    }
    let python = previous["python"].as_str()?;
    let info = validate(Path::new(python), engine_root, Some(cancel)).ok()?;
    if has_nvidia_driver() && info["cuda"] != json!(true) {
        // The GPU environment is worth setting up again for.
        return None;
    }
    Some(python.to_string())
}

fn install(dir: &Path, root: &Path, active: &Path, engine_root: &Path, progress: &dyn Fn(&str), cancel: &AtomicBool) -> Result<String, String> {
    progress("セットアップ用ツールをダウンロードしています…");
    let archive = dir.join("uv.zip");
    download(UV_URL, &archive, UV_SHA, DownloadOptions { cancel: Some(cancel), ..DownloadOptions::default() })?;
    extract_zip(&archive, dir)?;
    fs::remove_file(&archive).map_err(|error| error.to_string())?;
    let uv = dir.join("uv.exe");
    let python_home = root.join("python");
    let env = vec![
        ("UV_PYTHON_INSTALL_DIR".to_string(), python_home.to_string_lossy().into_owned()),
        ("UV_CACHE_DIR".to_string(), root.join("uv-cache").to_string_lossy().into_owned()),
        ("UV_NO_PROGRESS".to_string(), "1".to_string()),
        ("UV_PYTHON_DOWNLOADS".to_string(), "manual".to_string()),
    ];
    let args = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<String>>();

    progress(&format!("Python {PYTHON}を準備しています…"));
    run(&uv, &args(&["python", "install", PYTHON, "--no-bin", "--no-registry"]), RunOptions {
        env: env.clone(),
        timeout: Duration::from_secs(300),
        progress: Some(progress),
        cancel: Some(cancel),
    })?;
    let base = python_home.join(format!("cpython-{PYTHON}-windows-x86_64-none")).join("python.exe");
    let venv = dir.join("venv");
    run(&uv, &args(&["venv", "--python", &base.to_string_lossy(), &venv.to_string_lossy()]), RunOptions {
        env: env.clone(),
        cancel: Some(cancel),
        ..RunOptions::default()
    })?;
    let python = venv.join("Scripts").join("python.exe");

    let use_gpu = has_nvidia_driver();
    progress(if use_gpu {
        "GPU用PyTorchと音声ライブラリを準備しています（数GBのダウンロード）…"
    } else {
        "CPU用PyTorchと音声ライブラリを準備しています…"
    });
    let backend = engine_root.join("backend");
    let bundled = backend.join("requirements.txt");
    let mut requirements = if bundled.exists() { bundled } else { engine_root.join("requirements.txt") };
    if !use_gpu {
        let text = fs::read_to_string(&requirements).map_err(|error| error.to_string())?;
        let replaced: Vec<&str> = text.lines().map(|line| if line.starts_with("torch @ ") { CPU_TORCH } else { line }).collect();
        requirements = dir.join("requirements-cpu.txt");
        fs::write(&requirements, replaced.join("\n")).map_err(|error| error.to_string())?;
    }
    run(&uv, &args(&["pip", "install", "--python", &python.to_string_lossy(), "--only-binary", ":all:", "-r", &requirements.to_string_lossy()]), RunOptions {
        env,
        timeout: Duration::from_secs(1800),
        progress: Some(progress),
        cancel: Some(cancel),
    })?;

    progress("Python・GPU・音声デバイスの動作を確認しています…");
    let info = validate(&python, engine_root, Some(cancel))?;
    let python_text = python.to_string_lossy().into_owned();
    let mut record = info.as_object().cloned().unwrap_or_default();
    record.insert("python_version".to_string(), info["python"].clone());
    record.insert("revision".to_string(), json!(2));
    record.insert("python".to_string(), json!(python_text));
    record.insert("platform".to_string(), json!("win32"));
    record.insert("arch".to_string(), json!("x64"));
    fs::write(active, serde_json::to_string_pretty(&Value::Object(record)).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    remove_stale_runtimes(root, &dir.file_name().unwrap_or_default().to_string_lossy());
    Ok(python_text)
}

/// Returns the path of the Python to use, reusing a working environment if there is one.
pub fn setup(home: &Path, engine_root: &Path, progress: &dyn Fn(&str), cancel: &AtomicBool) -> Result<String, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("Windows x64を使用してください。".to_string());
    }
    let root = home.join("runtime");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let active = root.join("direct-gpu-runtime.json");
    if let Some(python) = reusable_runtime(&active, engine_root, cancel) {
        progress("既存のPython 3.15変換環境を確認しました。");
        return Ok(python);
    }
    let dir = root.join(format!("direct-gpu-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    install(&dir, &root, &active, engine_root, progress, cancel).map_err(|error| {
        let _ = fs::remove_dir_all(&dir);
        if cancel.load(Ordering::SeqCst) {
            CANCELLED.to_string()
        } else {
            error
        }
    })
}

/// Hash of a file on disk, for checking installed files. The training files run to hundreds of MB.
pub fn file_sha256(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            return Some(to_hex(&digest.finalize()));
        }
        digest.update(&buffer[..read]);
    }
}

pub fn fetch_json(url: &str) -> Result<Value, String> {
    let response = agent()?.get(url).timeout(Duration::from_secs(30)).call().map_err(|error| error.to_string())?;
    let text = response.into_string().map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::sha256;
    use std::net::TcpListener;
    use zip::write::SimpleFileOptions;

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!("yvc-runtime-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn powershell() -> PathBuf {
        PathBuf::from(std::env::var("SystemRoot").unwrap_or("C:\\Windows".to_string())).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    }

    fn script(text: &str) -> Vec<String> {
        vec!["-NoProfile".to_string(), "-NonInteractive".to_string(), "-Command".to_string(), text.to_string()]
    }

    #[test]
    fn returns_output_and_reports_progress() {
        let seen = std::cell::RefCell::new(String::new());
        let progress = |text: &str| seen.borrow_mut().push_str(text);
        let output = run(&powershell(), &script("Write-Output hello"), RunOptions { progress: Some(&progress), ..RunOptions::default() }).unwrap();
        assert_eq!(output.trim(), "hello");
        assert!(seen.borrow().contains("hello"));
    }

    #[test]
    fn a_failure_returns_its_output() {
        let error = run(&powershell(), &script("Write-Output oops; exit 3"), RunOptions::default()).unwrap_err();
        assert!(error.contains("oops"));
        let silent = run(&powershell(), &script("exit 4"), RunOptions::default()).unwrap_err();
        assert!(silent.contains('4'));
    }

    #[test]
    fn a_missing_program_is_explained() {
        let error = run(Path::new("C:\\no\\such\\program.exe"), &[], RunOptions::default()).unwrap_err();
        assert!(error.contains("起動できません"));
    }

    #[test]
    fn stops_at_the_time_limit_and_when_cancelled() {
        let started = Instant::now();
        let timed_out = run(&powershell(), &script("Start-Sleep 30"), RunOptions { timeout: Duration::from_millis(300), ..RunOptions::default() });
        assert!(timed_out.unwrap_err().contains("時間切れ"));
        assert!(started.elapsed() < Duration::from_secs(10));

        let cancel = AtomicBool::new(true);
        let cancelled = run(&powershell(), &script("Start-Sleep 30"), RunOptions { cancel: Some(&cancel), ..RunOptions::default() });
        assert_eq!(cancelled.unwrap_err(), CANCELLED);
    }

    fn serve_once(body: Vec<u8>, status: u16) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(&body);
        });
        url
    }

    #[test]
    fn keeps_a_download_only_if_the_hash_is_right() {
        let dir = temp();
        let body = b"hello".to_vec();
        let good = dir.join("good");
        download(&serve_once(body.clone(), 200), &good, &sha256(&body), DownloadOptions::default()).unwrap();
        assert_eq!(fs::read(&good).unwrap(), body);

        let bad = dir.join("bad");
        let error = download(&serve_once(body.clone(), 200), &bad, &"0".repeat(64), DownloadOptions::default()).unwrap_err();
        assert!(error.contains("検証"));
        assert!(!bad.exists());
        assert!(!dir.join("bad.partial").exists());

        let missing = download(&serve_once(Vec::new(), 404), &dir.join("x"), "", DownloadOptions::default()).unwrap_err();
        assert!(missing.contains("404"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelling_a_download_leaves_nothing() {
        let dir = temp();
        let cancel = AtomicBool::new(true);
        let target = dir.join("x");
        let error = download(&serve_once(vec![0; 10], 200), &target, "", DownloadOptions { cancel: Some(&cancel), ..DownloadOptions::default() }).unwrap_err();
        assert_eq!(error, CANCELLED);
        assert!(!target.exists());
        assert!(!dir.join("x.partial").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, body) in files {
            writer.start_file(*name, SimpleFileOptions::default()).unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn unpacks_only_inside_the_destination() {
        let dir = temp();
        let good = dir.join("good.zip");
        make_zip(&good, &[("a/b.txt", b"hi")]);
        let out = dir.join("out");
        extract_zip(&good, &out).unwrap();
        assert_eq!(fs::read(out.join("a/b.txt")).unwrap(), b"hi");

        let evil = dir.join("evil.zip");
        make_zip(&evil, &[("../evil.txt", b"bad")]);
        assert!(extract_zip(&evil, &dir.join("out2")).is_err());
        assert!(!dir.join("evil.txt").exists());

        let broken = dir.join("broken.zip");
        fs::write(&broken, "not a zip").unwrap();
        assert!(extract_zip(&broken, &dir.join("out3")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removes_only_old_environments() {
        let root = temp();
        let keep = "direct-gpu-3a6dd4ae-a077-4707-ba36-563f8660ad14";
        let stale = "direct-gpu-00000000-a077-4707-ba36-563f8660ad14";
        for name in [keep, stale, "python", "uv-cache", "direct-gpu-notauuid"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        remove_stale_runtimes(&root, keep);
        assert!(root.join(keep).exists());
        assert!(!root.join(stale).exists());
        assert!(root.join("python").exists());
        assert!(root.join("uv-cache").exists());
        assert!(root.join("direct-gpu-notauuid").exists(), "only exact names are touched");
        let _ = fs::remove_dir_all(&root);
    }
}
