// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs;
use std::path::Path;
use serde::Serialize;
use lofty::prelude::*;
use lofty::probe::Probe;
use base64::prelude::*;

#[derive(Serialize, Debug, Clone)]
pub struct Song {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub cover_art: Option<String>,
    pub lyrics_path: Option<String>,
}

#[tauri::command]
fn select_folder() -> Option<String> {
    let result = rfd::FileDialog::new().pick_folder();
    result.map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn scan_song_file(file_path: &Path) -> Option<Song> {
    let ext = file_path.extension()?.to_str()?.to_ascii_lowercase();
    if ext == "mp3" || ext == "m4a" || ext == "flac" || ext == "wav" || ext == "ogg" {
        let mut title = file_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Unknown".to_string());
        let mut artist = "Unknown Artist".to_string();
        let mut album = "Unknown Album".to_string();
        let mut duration = 0.0;
        let mut cover_art = None;

        if let Ok(tagged_file) = Probe::open(file_path).and_then(|p| p.read()) {
            let properties = tagged_file.properties();
            duration = properties.duration().as_secs_f64();

            if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
                if let Some(t) = tag.title() {
                    if !t.trim().is_empty() {
                        title = t.into_owned();
                    }
                }
                if let Some(a) = tag.artist() {
                    if !a.trim().is_empty() {
                        artist = a.into_owned();
                    }
                }
                if let Some(al) = tag.album() {
                    if !al.trim().is_empty() {
                        album = al.into_owned();
                    }
                }
                
                // Extract picture/cover art
                for picture in tag.pictures() {
                    let data = BASE64_STANDARD.encode(picture.data());
                    let mime = picture.mime_type()
                        .map(|m| m.to_string())
                        .unwrap_or_else(|| "image/jpeg".to_string());
                    cover_art = Some(format!("data:{};base64,{}", mime, data));
                    break; // just take the first picture
                }
            }
        }

        // Check for matching LRC file
        let mut lyrics_path = None;
        let lrc_path = file_path.with_extension("lrc");
        if lrc_path.exists() && lrc_path.is_file() {
            lyrics_path = Some(lrc_path.to_string_lossy().into_owned());
        }

        Some(Song {
            id: file_path.to_string_lossy().into_owned(),
            path: file_path.to_string_lossy().into_owned(),
            title,
            artist,
            album,
            duration,
            cover_art,
            lyrics_path,
        })
    } else {
        None
    }
}

fn visit_dirs(dir: &Path, songs: &mut Vec<Song>, depth: usize) {
    if depth > 12 {
        return; // Avoid too deep recursion
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit_dirs(&path, songs, depth + 1);
            } else if path.is_file() {
                if let Some(song) = scan_song_file(&path) {
                    songs.push(song);
                }
            }
        }
    }
}

#[tauri::command]
fn scan_folder(folder_path: String) -> Result<Vec<Song>, String> {
    let mut path = Path::new(&folder_path).to_path_buf();
    if path.is_file() {
        if let Some(parent) = path.parent() {
            path = parent.to_path_buf();
        } else {
            return Err("Invalid file path".to_string());
        }
    }
    if !path.is_dir() {
        return Err("Not a directory".to_string());
    }

    let mut songs = Vec::new();
    visit_dirs(&path, &mut songs, 0);

    // Sort songs alphabetically by title
    songs.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));

    Ok(songs)
}

#[tauri::command]
fn get_lyrics(lyrics_path: String) -> Result<String, String> {
    let path = Path::new(&lyrics_path);
    if !path.is_file() {
        return Err("Lyrics file not found".to_string());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, Emitter,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Create menu items for the system tray
            let play_i = MenuItem::with_id(app, "play_pause", "Play / Pause", true, None::<&str>)?;
            let next_i = MenuItem::with_id(app, "next", "Next Track", true, None::<&str>)?;
            let prev_i = MenuItem::with_id(app, "prev", "Previous Track", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Player", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&play_i, &next_i, &prev_i, &show_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("main_tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "play_pause" => {
                            let _ = app.emit("tray-play-pause", ());
                        }
                        "next" => {
                            let _ = app.emit("tray-next", ());
                        }
                        "prev" => {
                            let _ = app.emit("tray-prev", ());
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            if is_visible {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![select_folder, scan_folder, get_lyrics])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
