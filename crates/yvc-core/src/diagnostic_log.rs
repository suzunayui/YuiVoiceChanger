//! Moved from electron/diagnostic-log.cjs.

use regex_lite::Regex;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
pub const MISSING_LOG: &str = "診断ログはまだありません。声変換を一度開始してから保存してください。";

pub struct Info<'a> {
    pub version: &'a str,
    pub runtime: &'a str,
    pub release: &'a str,
    /// Already written as the person's clock shows it.
    pub saved_at: &'a str,
}

/// People post this file, so user folder names must not survive in any spelling.
pub fn redact_paths(text: &str, home: &str) -> String {
    let parts: Vec<String> = home.split(['\\', '/']).filter(|part| !part.is_empty()).map(regex_lite::escape).collect();
    let mut result = text.to_string();
    if !parts.is_empty() {
        let pattern = format!("(?i){}", parts.join(r"[\\/]+"));
        let home_pattern = Regex::new(&pattern).expect("everything variable is escaped");
        result = home_pattern.replace_all(&result, "%USERPROFILE%").into_owned();
    }
    let users = Regex::new(r#"(?i)([\\/]Users[\\/]+)[^\\/\s"':]+"#).expect("a fixed pattern");
    let result = users.replace_all(&result, "${1}<user>").into_owned();
    let homes = Regex::new(r#"(/home/)[^/\s"':]+"#).expect("a fixed pattern");
    homes.replace_all(&result, "${1}<user>").into_owned()
}

fn read_newest(file: &Path) -> Result<(String, bool), String> {
    let mut handle = File::open(file).map_err(|error| error.to_string())?;
    let size = handle.metadata().map_err(|error| error.to_string())?.len();
    let start = size.saturating_sub(MAX_LOG_BYTES);
    handle.seek(SeekFrom::Start(start)).map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    handle.read_to_end(&mut buffer).map_err(|error| error.to_string())?;
    if start == 0 {
        return Ok((String::from_utf8_lossy(&buffer).into_owned(), false));
    }
    // It never starts mid-line.
    let first_line = buffer.iter().position(|byte| *byte == b'\n').map_or(0, |end| end + 1);
    Ok((String::from_utf8_lossy(&buffer[first_line..]).into_owned(), true))
}

pub fn export_diagnostic_log(log_file: &Path, output_file: &Path, home: &str, info: &Info) -> Result<(), String> {
    if !log_file.exists() {
        return Err(MISSING_LOG.to_string());
    }
    let (text, trimmed) = read_newest(log_file)?;
    let mut header = vec![
        format!("YuiVoiceChanger {}", info.version),
        info.runtime.to_string(),
        format!("win32 {} x64", info.release),
        format!("保存日時 {}", info.saved_at),
        String::new(),
    ];
    if trimmed {
        header.push("（古い部分を省略しました）".to_string());
    }
    fs::write(output_file, format!("{}\n{}", header.join("\n"), redact_paths(&text, home))).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const HOME: &str = "C:\\Users\\mikan";

    #[test]
    fn hides_every_spelling_of_a_user_folder() {
        assert_eq!(redact_paths("C:\\Users\\mikan\\.YuiVoiceChanger\\runtime\\x.py", HOME), "%USERPROFILE%\\.YuiVoiceChanger\\runtime\\x.py");
        assert_eq!(redact_paths("c:/users/MIKAN/a.py", HOME), "%USERPROFILE%/a.py");
        assert_eq!(redact_paths("D:\\Users\\other\\a.py and /Users/person/b.py and /home/someone/c.py", HOME), "D:\\Users\\<user>\\a.py and /Users/<user>/b.py and /home/<user>/c.py");
        assert_eq!(redact_paths("File \"C:\\Program Files\\app\\x.py\", line 3", HOME), "File \"C:\\Program Files\\app\\x.py\", line 3");
    }

    #[test]
    fn handles_names_that_are_not_plain_ascii() {
        assert_eq!(redact_paths("C:\\Users\\すず な (1)\\a.py", "C:\\Users\\すず な (1)"), "%USERPROFILE%\\a.py");
        assert_eq!(redact_paths("D:\\Users\\すずな\\a.py", HOME), "D:\\Users\\<user>\\a.py");
        assert_eq!(redact_paths("D:\\Users\\すず　な\\a.py", HOME), "D:\\Users\\<user>\\a.py", "a full-width space doesn't end the name");
    }

    #[test]
    fn an_unknown_home_still_hides_user_folders() {
        assert_eq!(redact_paths("C:\\Users\\mikan\\a.py", ""), "C:\\Users\\<user>\\a.py");
    }

    struct Folder(PathBuf);
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn folder() -> Folder {
        let path = std::env::temp_dir().join(format!("yvc-diag-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Folder(path)
    }

    const INFO: Info = Info { version: "1.2.3", runtime: "WebView2 145.0", release: "10.0.26300", saved_at: "2026/11/7 20:00:00" };

    #[test]
    fn exports_the_log_with_a_header() {
        let folder = folder();
        let (log, output) = (folder.0.join("independent-engine.log"), folder.0.join("out.txt"));
        assert_eq!(export_diagnostic_log(&log, &output, HOME, &INFO).unwrap_err(), MISSING_LOG);
        assert!(!output.exists());
        fs::write(&log, "2026-11-07 Audio report: callback_late=1\nFile \"C:\\Users\\mikan\\a.py\"\n").unwrap();
        export_diagnostic_log(&log, &output, HOME, &INFO).unwrap();
        let text = fs::read_to_string(&output).unwrap();
        for expected in ["YuiVoiceChanger 1.2.3", "WebView2 145.0", "win32 10.0.26300 x64", "保存日時 2026/11/7 20:00:00", "Audio report: callback_late=1", "%USERPROFILE%\\a.py"] {
            assert!(text.contains(expected), "{expected}: {text}");
        }
        assert!(!text.contains("mikan"));
        assert!(!text.contains("省略"));
    }

    #[test]
    fn a_long_log_keeps_its_newest_lines_and_never_starts_mid_line() {
        let folder = folder();
        let (log, output) = (folder.0.join("independent-engine.log"), folder.0.join("out.txt"));
        let old = format!("OLD {}\n", "x".repeat(99));
        let count = MAX_LOG_BYTES as usize / old.len() + 50;
        fs::write(&log, format!("{}RECENT Audio report\n", old.repeat(count))).unwrap();
        export_diagnostic_log(&log, &output, HOME, &INFO).unwrap();
        let text = fs::read_to_string(&output).unwrap();
        assert!((text.len() as u64) < MAX_LOG_BYTES + 1000);
        assert!(text.ends_with("RECENT Audio report\n"));
        let body = text.split_once("省略しました）\n").expect("it says it was shortened").1;
        assert_eq!(body.lines().next().unwrap(), old.trim_end());
    }

    #[test]
    fn a_broken_multibyte_character_at_the_cut_does_not_fail() {
        let folder = folder();
        let (log, output) = (folder.0.join("independent-engine.log"), folder.0.join("out.txt"));
        let mut bytes = "あ".repeat(MAX_LOG_BYTES as usize / 3 + 10).into_bytes();
        bytes.extend_from_slice(b"\nend\n");
        fs::write(&log, bytes).unwrap();
        export_diagnostic_log(&log, &output, HOME, &INFO).unwrap();
        assert!(fs::read_to_string(&output).unwrap().ends_with("end\n"));
    }
}
