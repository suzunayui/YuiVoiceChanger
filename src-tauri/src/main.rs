#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use yvc_core::app::{App, Host, Paths};

const MUTE_KEY: &str = "CommandOrControl+Alt+M";
const PRESET_COUNT: usize = 9;
const REPEAT: Duration = Duration::from_millis(400);

struct TauriHost {
    handle: AppHandle,
}

impl TauriHost {
    fn dialog(&self) -> FileDialogBuilder<tauri::Wry> {
        let dialog = self.handle.dialog().file();
        match self.handle.get_webview_window("main") {
            Some(window) => dialog.set_parent(&window),
            None => dialog,
        }
    }

    fn app(&self) -> Arc<App> {
        self.handle.state::<Arc<App>>().inner().clone()
    }

    fn bind(&self, key: &str, action: impl Fn(Arc<App>) + Send + Sync + 'static) -> Result<(), String> {
        // Holding a key repeats it; a toggle that flips on every repeat would be unusable on air.
        let last = Mutex::new(None::<Instant>);
        let app = self.app();
        let action = Arc::new(action);
        self.handle
            .global_shortcut()
            .on_shortcut(key, move |_handle, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let now = Instant::now();
                let repeat = last.lock().unwrap().replace(now).is_some_and(|previous| now - previous < REPEAT);
                if !repeat {
                    let (app, action) = (app.clone(), action.clone());
                    // A preset can take a while to switch, and this is the window's thread.
                    std::thread::spawn(move || action(app));
                }
            })
            .map_err(|error| error.to_string())
    }
}

impl Host for TauriHost {
    fn emit(&self, event: &Value) {
        let _ = self.handle.emit("engine-event", event);
    }

    fn pick_file(&self, filter_name: &str, extensions: &[&str], directory: Option<PathBuf>) -> Option<PathBuf> {
        let mut dialog = self.dialog().add_filter(filter_name, extensions);
        if let Some(directory) = directory {
            dialog = dialog.set_directory(directory);
        }
        dialog.blocking_pick_file()?.into_path().ok()
    }

    fn pick_folder(&self, directory: Option<PathBuf>) -> Option<PathBuf> {
        let mut dialog = self.dialog();
        if let Some(directory) = directory {
            dialog = dialog.set_directory(directory);
        }
        dialog.blocking_pick_folder()?.into_path().ok()
    }

    fn save_file(&self, default_name: &str, filter_name: &str, extensions: &[&str]) -> Option<PathBuf> {
        self.dialog().add_filter(filter_name, extensions).set_file_name(default_name).blocking_save_file()?.into_path().ok()
    }

    fn pictures_dir(&self) -> Option<PathBuf> {
        self.handle.path().picture_dir().ok()
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        self.handle.opener().open_url(url, None::<&str>).map_err(|error| error.to_string())
    }

    fn reveal_file(&self, file: &Path) {
        let _ = self.handle.opener().reveal_item_in_dir(file);
    }

    fn versions(&self) -> (String, String) {
        let webview = tauri::webview_version().unwrap_or_else(|_| "不明".to_string());
        (self.handle.package_info().version.to_string(), format!("WebView2 {webview}"))
    }

    fn confirm(&self, title: &str, message: &str, detail: &str) -> bool {
        let mut dialog = self
            .handle
            .dialog()
            .message(format!("{message}\n\n{detail}"))
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("はい".to_string(), "いいえ".to_string()));
        if let Some(window) = self.handle.get_webview_window("main") {
            dialog = dialog.parent(&window);
        }
        dialog.blocking_show()
    }

    fn set_hotkeys(&self, enabled: bool) -> Vec<String> {
        let _ = self.handle.global_shortcut().unregister_all();
        if !enabled {
            return Vec::new();
        }
        let mut failed = Vec::new();
        if self.bind(MUTE_KEY, |app| app.hotkey_mute()).is_err() {
            failed.push(MUTE_KEY.to_string());
        }
        for index in 0..PRESET_COUNT {
            let key = format!("CommandOrControl+Alt+{}", index + 1);
            if self.bind(&key, move |app| app.hotkey_preset(index)).is_err() {
                failed.push(key);
            }
        }
        failed
    }
}

// Long actions like the environment setup must not hold up Tauri's own workers.
#[tauri::command]
async fn yvc_invoke(app: State<'_, Arc<App>>, action: String, payload: Option<Value>) -> Result<Value, String> {
    let app = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || app.invoke(&action, payload.unwrap_or(Value::Null)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn yvc_ready(app: State<'_, Arc<App>>) {
    app.screen_ready();
}

fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

fn data_home(handle: &AppHandle) -> PathBuf {
    if let Some(home) = std::env::var_os("YVC_DESKTOP_HOME").filter(|home| !home.is_empty()) {
        return PathBuf::from(home);
    }
    let home = handle.path().home_dir().expect("the user has a home folder");
    home.join(".YuiVoiceChanger")
}

fn main() {
    let quitting = Arc::new(AtomicBool::new(false));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|handle, _args, _cwd| {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            let resources = plain_path(handle.path().resource_dir()?).join("engine");
            let legacy_config = std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join("YuiVoiceChanger").join("desktop.json"));
            let paths = Paths {
                home: data_home(&handle),
                engine_root: resources.clone(),
                docs_root: resources,
                legacy_config,
                obs_pipe: yvc_core::obs::PIPE_NAME.to_string(),
                program_data: std::env::var_os("ProgramData").map(PathBuf::from),
            };
            let app = App::new(Arc::new(TauriHost { handle: handle.clone() }), paths);
            tauri_app.manage(app.clone());
            app.started();
            if let Some(window) = handle.get_webview_window("main") {
                let version = &handle.package_info().version;
                let _ = window.set_title(&format!("Yui Voice Changer — {version}"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![yvc_invoke, yvc_ready])
        .build(tauri::generate_context!())
        .expect("the app could start");

    app.run(move |handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            // Python has to finish cleanly, or the audio device can stay held.
            if quitting.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            let handle = handle.clone();
            std::thread::spawn(move || {
                handle.state::<Arc<App>>().shutdown();
                handle.exit(0);
            });
        }
    });
}
