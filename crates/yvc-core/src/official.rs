//! Moved from electron/official-model.cjs. Downloads the official model only after explicit consent.

use crate::runtime::{download, extract_zip, file_sha256, DownloadOptions};
use crate::util::iso_now;
use serde_json::json;
use std::cell::Cell;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const TERMS_URL: &str = "https://prj-beatrice.com/2.0.0-rc.0-official-model-1-terms";
const DOWNLOAD_URL: &str = "https://storage.prj-beatrice.com/beatrice_2.0.0-rc.0_official_model_1.zip";
const ARCHIVE_SHA: &str = "046273adf7403143c64fabe1f84645f3a0349fdaf6aad23055a0dda23a2efe8f";
const STEM: &str = "beatrice_2.0.0-rc.0_official_model_1";
const FILES: [(&str, &str); 10] = [
    ("README.txt", "ceb6f0c451c5aa85fa186ff7b6490c1c13872b906c3de9b22fba6a9ac0ccd363"),
    ("embedding_setter.bin", "96a26173e970b1c38223a1fba6a6855f235d987d43972b39e7a8f9b434cdfd1b"),
    ("speaker_embeddings.bin", "3b2a6ff73398d6a2acac4e0b4ae562d85c4c0eb2fb1e8fb7dedadab6457bf270"),
    ("phone_extractor.bin", "2fc0f8f2f9af6a1831a38ee236907c1663a25809ed4368dfc1c88288aab60e63"),
    ("pitch_estimator.bin", "a99cba14478c6e8a8a727191316f0df5ff1951f968316d5e464356aa5b1708f1"),
    ("waveform_generator.bin", "294ee92c1a7a9d514285e313b54ef7b9e138e6b787deec8234a6ba7b6e5fdb0c"),
    ("beatrice_2.0.0-rc.0_official_model_1.toml", "518a73586eb57668a0f52684babcfdd5638e14c5b0151c981f0931ff88254ff7"),
    ("tsukuyomichan.png", "229f95643480f8b4845aa085161653e7b4757a39043d2e22272670f5f8c35cb8"),
    ("tokinashigure.png", "b6d75cffa8648850b1afdc99259980a02291818588a6c978e56df2af3e0d63ce"),
    ("olune.png", "e207ce0c610b48633c14c2a2ec3ea7c540884d54ee832531fc27c7f93cc7f9aa"),
];

pub struct Installed {
    pub model: String,
    pub voice: i64,
}

fn valid_installation(folder: &Path) -> bool {
    FILES.iter().all(|(name, hash)| file_sha256(&folder.join(name)).as_deref() == Some(*hash))
}

fn receipt() -> String {
    json!({
        "source": DOWNLOAD_URL,
        "archive_sha256": ARCHIVE_SHA,
        "terms_url": TERMS_URL,
        "agreed_at": iso_now(),
        "consent": "explicit-install-button",
        "voice": 1,
        "name": "つくよみちゃん（コーパス）",
    })
    .to_string()
}

pub fn install_official(home: &Path, cancel: &AtomicBool, progress: &dyn Fn(&str)) -> Result<Installed, String> {
    let root = crate::util::resolve(&home.join("models").to_string_lossy());
    let target = root.join("beatrice-official-model-1-rc0");
    let manifest = format!("{STEM}.toml");
    let result = || Installed { model: target.join(&manifest).to_string_lossy().into_owned(), voice: 1 };
    if valid_installation(&target) {
        fs::write(target.join("installation.json"), receipt()).map_err(|error| error.to_string())?;
        progress("導入済みの公式モデルを確認しました。");
        return Ok(result());
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let stage = root.join(format!(".official-install-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&stage).map_err(|error| error.to_string())?;
    let outcome = (|| -> Result<(), String> {
        progress("公式配布元からモデルをダウンロードしています…");
        let last = Cell::new(-1i64);
        let on_progress = |received: u64, total: u64| {
            let percent = if total > 0 { (received * 100 / total) as i64 } else { -1 };
            if percent > last.get() {
                last.set(percent);
                progress(&format!("公式モデルをダウンロード中… {percent}%"));
            }
        };
        let archive = stage.join("model.zip");
        download(DOWNLOAD_URL, &archive, ARCHIVE_SHA, DownloadOptions {
            timeout: Duration::from_secs(300),
            cancel: Some(cancel),
            headers: vec![("Referer", TERMS_URL)],
            on_progress: Some(&on_progress),
        })?;
        if cancel.load(Ordering::SeqCst) {
            return Err("公式モデルの導入を中止しました。".to_string());
        }
        progress("公式モデルを展開・確認しています…");
        let destination = stage.join("extracted");
        extract_zip(&archive, &destination)?;
        if cancel.load(Ordering::SeqCst) {
            return Err("公式モデルの導入を中止しました。".to_string());
        }
        let model = destination.join(STEM);
        if !valid_installation(&model) {
            return Err("公式モデルの検証に失敗しました。もう一度導入してください。".to_string());
        }
        fs::write(model.join("installation.json"), receipt()).map_err(|error| error.to_string())?;
        let backup = if target.exists() {
            let backup = root.join(format!("beatrice-official-model-1-rc0.previous-{}", uuid::Uuid::new_v4()));
            fs::rename(&target, &backup).map_err(|error| error.to_string())?;
            Some(backup)
        } else {
            None
        };
        if let Err(error) = fs::rename(&model, &target) {
            if let Some(backup) = backup {
                if !target.exists() {
                    let _ = fs::rename(backup, &target);
                }
            }
            return Err(error.to_string());
        }
        progress("つくよみちゃん（コーパス）の導入が完了しました。");
        Ok(())
    })();
    let _ = fs::remove_dir_all(&stage);
    outcome.map(|()| result())
}
