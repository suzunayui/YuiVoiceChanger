//! YuiVoiceChanger's desktop logic, moved from electron/. Knows nothing about Tauri,
//! so all of it can be tested alone. The audio itself stays in backend/ (Python).

pub mod app;
pub mod calibration;
pub mod config;
pub mod diagnostic_log;
pub mod icons;
pub mod model_history;
pub mod obs;
pub mod obs_plugin;
pub mod official;
pub mod presets;
pub mod runtime;
pub mod tools;
pub mod training;
pub mod util;
