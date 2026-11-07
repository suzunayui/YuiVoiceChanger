use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// JavaScript's `===` for the values in the config. 14 and 14.0 are the same number there.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// Lowercased full path, for comparing files the way Windows does.
pub fn path_key(path: &str) -> String {
    resolve(path).to_string_lossy().to_lowercase()
}

pub fn resolve(path: &str) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| PathBuf::from(path))
}

pub fn same_file(a: &str, b: &str) -> bool {
    path_key(a) == path_key(b)
}

pub fn is_file(path: &str) -> bool {
    !path.is_empty() && fs::metadata(path).map(|meta| meta.is_file()).unwrap_or(false)
}

// Written beside the target and renamed over it, so a crash can't leave half a file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    write_atomic(path, text.as_bytes())
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

/// The current time as `2026-11-07T09:26:41.000Z`.
pub fn iso_now() -> String {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs() as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Howard Hinnant's civil-from-days algorithm.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60,
        elapsed.subsec_millis()
    )
}

pub struct LocalTime {
    pub year: u16,
    pub month: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
}

/// The time as the person's clock shows it.
#[cfg(windows)]
pub fn local_now() -> LocalTime {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    let mut time = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut time) };
    LocalTime { year: time.wYear, month: time.wMonth, day: time.wDay, hour: time.wHour, minute: time.wMinute, second: time.wSecond }
}

#[cfg(not(windows))]
pub fn local_now() -> LocalTime {
    let now = iso_now();
    let part = |range: std::ops::Range<usize>| now[range].parse().unwrap_or(0);
    LocalTime { year: part(0..4), month: part(5..7), day: part(8..10), hour: part(11..13), minute: part(14..16), second: part(17..19) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_local_clock() {
        let now = local_now();
        assert!(now.year >= 2026 && (1..=12).contains(&now.month) && (1..=31).contains(&now.day) && now.hour < 24 && now.minute < 60);
    }

    #[test]
    fn numbers_compare_like_javascript() {
        assert!(same(&json!(14), &json!(14.0)));
        assert!(!same(&json!(14), &json!(14.5)));
        assert!(!same(&json!(1), &json!("1")));
        assert!(same(&json!("a"), &json!("a")));
    }

    #[test]
    fn formats_the_time() {
        let now = iso_now();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.starts_with("20") && now.ends_with('Z'), "{now}");
        assert_eq!(&now[10..11], "T");
    }

    #[test]
    fn paths_compare_ignoring_case_and_separators() {
        assert!(same_file("C:\\A\\b.pt", "c:/a/B.PT"));
        assert!(!same_file("C:\\A\\b.pt", "C:\\A\\c.pt"));
    }
}
