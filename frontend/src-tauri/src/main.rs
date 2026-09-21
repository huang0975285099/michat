// Do not open an extra console window alongside the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    thread,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "main-tray";

#[derive(Default)]
struct TrayFlashState {
    active: AtomicBool,
    generation: AtomicU64,
}

fn stop_tray_flashing(app: &AppHandle) {
    let state = app.state::<TrayFlashState>();
    state.active.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(app.default_window_icon().cloned());
        let _ = tray.set_tooltip(Some("Yunmi"));
    }
}

fn show_main_window(app: &AppHandle) {
    stop_tray_flashing(app);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn start_tray_flashing(app: AppHandle, state: tauri::State<'_, TrayFlashState>) {
    // A visible but unfocused window already has taskbar attention and a system
    // notification. Only blink the tray icon after the user has hidden the app.
    let is_hidden = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .is_some_and(|visible| !visible);
    if !is_hidden || state.active.swap(true, Ordering::SeqCst) {
        return;
    }

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some("Yunmi - 有新消息"));
    }

    thread::spawn(move || {
        let transparent_icon = Image::new_owned(vec![0; 32 * 32 * 4], 32, 32);
        let mut show_icon = false;

        loop {
            let state = app.state::<TrayFlashState>();
            if !state.active.load(Ordering::SeqCst)
                || state.generation.load(Ordering::SeqCst) != generation
            {
                break;
            }

            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let icon = if show_icon {
                    app.default_window_icon().cloned()
                } else {
                    Some(transparent_icon.clone())
                };
                let _ = tray.set_icon(icon);
            }
            show_icon = !show_icon;
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn main() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    }

    builder
        .manage(TrayFlashState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![start_tray_flashing])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "打开 Yunmi", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("the application icon is missing");

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .tooltip("Yunmi")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "quit" => {
                        stop_tray_flashing(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW_LABEL => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Focused(true) if window.label() == MAIN_WINDOW_LABEL => {
                stop_tray_flashing(window.app_handle());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
