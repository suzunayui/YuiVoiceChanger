//! Moved from electron/obs-plugin-install.cjs.

use crate::runtime::{run, RunOptions};
use crate::util::sha256;
use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const NAME: &str = "yui-live-preview";

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn encoded(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn identical(file: &Path, bytes: &[u8]) -> Result<bool, String> {
    match fs::read(file) {
        Ok(existing) => Ok(existing == bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn copy_script(source: &Path, target: &Path, temporary: &Path, hash: &str) -> String {
    format!(
        r#"$ErrorActionPreference='Stop'
$source={source}
$destination={destination}
$temporary={temporary}
$copied=$false
try {{
 if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne '{hash}') {{ throw 'Plugin file changed' }}
 $directory=$env:ProgramData
 foreach ($part in @('obs-studio','plugins','yui-live-preview')) {{
  $directory=Join-Path $directory $part
  $item=[System.IO.Directory]::CreateDirectory($directory)
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {{ throw 'Redirected OBS plugin directory' }}
 }}
 if ((Join-Path $directory 'yui-live-preview.dll') -ne $destination) {{ throw 'Unexpected destination' }}
 [System.IO.File]::Copy($source,$temporary,$false)
 $copied=$true
 if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne '{hash}') {{ throw 'Plugin file changed' }}
 if ([System.IO.File]::Exists($destination)) {{
  if ([System.IO.File]::GetAttributes($destination) -band [System.IO.FileAttributes]::ReparsePoint) {{ throw 'Redirected plugin file' }}
  [System.IO.File]::Replace($temporary,$destination,"$temporary.bak")
  [System.IO.File]::Delete("$temporary.bak")
 }}
 else {{ [System.IO.File]::Move($temporary,$destination) }}
}} finally {{ if ($copied -and [System.IO.File]::Exists($temporary)) {{ [System.IO.File]::Delete($temporary) }} }}"#,
        source = quote(&source.to_string_lossy()),
        destination = quote(&target.to_string_lossy()),
        temporary = quote(&temporary.to_string_lossy()),
    )
}

fn install_elevated(source: &Path, target: &Path, directory: &Path, bytes: &[u8]) -> Result<(), String> {
    let hash = sha256(bytes).to_uppercase();
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let copy = copy_script(source, target, &temporary, &hash);
    let elevate = format!(
        "$ErrorActionPreference='Stop'\n$p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand {}'\nexit $p.ExitCode",
        encoded(&copy)
    );
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let powershell = PathBuf::from(root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded(&elevate)].map(str::to_string);
    // Windows asks the person for permission here, which can take a while.
    run(&powershell, &args, RunOptions { timeout: Duration::from_secs(600), ..RunOptions::default() })
        .map(|_| ())
        .map_err(|_| "導入できませんでした。OBSを終了し、管理者の許可を確認してからもう一度お試しください。".to_string())
}

pub fn install_obs_plugin(source: &Path, program_data: Option<PathBuf>) -> Result<Value, String> {
    let program_data = program_data.ok_or("Windows x64で利用できます。")?;
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    let directory = program_data.join("obs-studio").join("plugins").join(NAME);
    let target = directory.join(format!("{NAME}.dll"));
    if identical(&target, &bytes)? {
        return Ok(json!({"alreadyInstalled": true}));
    }
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let attempt = (|| -> std::io::Result<()> {
        fs::create_dir_all(&directory)?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&bytes)?;
        drop(file);
        fs::rename(&temporary, &target)
    })();
    let result = match attempt {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => install_elevated(source, &target, &directory, &bytes),
        Err(error) => Err(error.to_string()),
    };
    let _ = fs::remove_file(&temporary);
    result?;
    if !identical(&target, &bytes)? {
        return Err("導入したプラグインを確認できませんでした。".to_string());
    }
    Ok(json!({"alreadyInstalled": false}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!("yvc-plugin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn installs_then_recognizes_and_replaces() {
        let root = temp();
        let source = root.join("plugin.dll");
        fs::write(&source, b"one").unwrap();
        let program_data = root.join("ProgramData");
        assert_eq!(install_obs_plugin(&source, Some(program_data.clone())).unwrap()["alreadyInstalled"], false);
        let target = program_data.join("obs-studio/plugins/yui-live-preview/yui-live-preview.dll");
        assert_eq!(fs::read(&target).unwrap(), b"one");
        assert_eq!(install_obs_plugin(&source, Some(program_data.clone())).unwrap()["alreadyInstalled"], true);

        fs::write(&source, b"two").unwrap();
        assert_eq!(install_obs_plugin(&source, Some(program_data.clone())).unwrap()["alreadyInstalled"], false);
        assert_eq!(fs::read(&target).unwrap(), b"two");
        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap()).unwrap().flatten().filter(|entry| entry.path() != target).collect();
        assert!(leftovers.is_empty(), "no temporary files stay behind");
        assert!(install_obs_plugin(&source, None).is_err());
        assert!(install_obs_plugin(&root.join("missing.dll"), Some(program_data)).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_copy_script_quotes_paths() {
        let script = copy_script(Path::new("C:\\a'b\\p.dll"), Path::new("C:\\t.dll"), Path::new("C:\\x.tmp"), "ABC");
        assert!(script.contains("$source='C:\\a''b\\p.dll'"));
        assert!(script.contains("-ne 'ABC'"));
    }

    #[test]
    fn encodes_scripts_for_powershell() {
        assert_eq!(encoded("ab"), "YQBiAA==");
    }
}
