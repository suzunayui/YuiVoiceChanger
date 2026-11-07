//! Moved from electron/model-icons.cjs. Icons are stored as 128px PNGs, named by their hash.

use crate::util::{sha256, write_atomic};
use base64::Engine;
use image::imageops::FilterType;
use regex_lite::Regex;
use std::fs;
use std::io::Cursor;
use std::path::Path;

const MAX_BYTES: u64 = 20 * 1024 * 1024;

fn valid_id(id: &str) -> bool {
    Regex::new(r"^[a-f0-9]{64}$").expect("valid pattern").is_match(id)
}

pub fn store_icon(home: &Path, file: &Path) -> Result<String, String> {
    let name = file.to_string_lossy().to_lowercase();
    if ![".ico", ".png", ".jpg", ".jpeg"].iter().any(|suffix| name.ends_with(suffix)) {
        return Err("ICO・PNG・JPG画像を選んでください。".to_string());
    }
    let meta = fs::metadata(file).map_err(|error| error.to_string())?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Err("アイコン画像は20MB以下のファイルを選んでください。".to_string());
    }
    let source = image::open(file).map_err(|_| "画像を読み込めませんでした。別のICO・PNG・JPG画像を選んでください。".to_string())?;
    let (width, height) = (source.width().max(1), source.height().max(1));
    let (target_width, target_height) = if width >= height {
        (128, (128 * height / width).max(1))
    } else {
        ((128 * width / height).max(1), 128)
    };
    let resized = source.resize_exact(target_width, target_height, FilterType::Lanczos3);
    let mut png = Cursor::new(Vec::new());
    resized.write_to(&mut png, image::ImageFormat::Png).map_err(|error| error.to_string())?;
    let png = png.into_inner();
    let id = sha256(&png);
    let target = home.join("model-icons").join(format!("{id}.png"));
    if !target.exists() {
        write_atomic(&target, &png)?;
    }
    Ok(id)
}

pub fn read_icon(home: &Path, id: &str) -> Result<String, String> {
    if id.is_empty() {
        return Ok(String::new());
    }
    if !valid_id(id) {
        return Err("アイコンの指定が不正です。".to_string());
    }
    Ok(fs::read(home.join("model-icons").join(format!("{id}.png")))
        .map(|bytes| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgba};

    fn temp() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("yvc-icons-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn stores_a_small_copy_keeping_its_shape() {
        let home = temp();
        let source = home.join("wide.png");
        let picture: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_pixel(400, 200, Rgba([255, 0, 0, 255]));
        picture.save_with_format(&source, ImageFormat::Png).unwrap();
        let id = store_icon(&home, &source).unwrap();
        let stored = image::open(home.join("model-icons").join(format!("{id}.png"))).unwrap();
        assert_eq!((stored.width(), stored.height()), (128, 64));
        assert!(read_icon(&home, &id).unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(store_icon(&home, &source).unwrap(), id, "the same image gets the same name");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn refuses_what_it_cannot_use() {
        let home = temp();
        let text = home.join("a.txt");
        fs::write(&text, "x").unwrap();
        assert!(store_icon(&home, &text).unwrap_err().contains("ICO"));
        let fake = home.join("fake.png");
        fs::write(&fake, "not an image").unwrap();
        assert!(store_icon(&home, &fake).unwrap_err().contains("読み込めません"));
        assert!(read_icon(&home, "../../secret").is_err());
        assert_eq!(read_icon(&home, "").unwrap(), "");
        assert_eq!(read_icon(&home, &"a".repeat(64)).unwrap(), "", "a missing icon is just empty");
        let _ = fs::remove_dir_all(&home);
    }
}
