mod api;

use tauri::{Emitter, Manager};
use futures::StreamExt;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好, {}! 欢迎使用道生一。", name)
}

#[tauri::command]
async fn send_message(
    app: tauri::AppHandle,
    config: api::ApiConfig,
    messages: Vec<api::ChatMessage>,
) -> Result<(), String> {
    let mut stream = api::stream_chat(config, messages).await?;

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(text) => {
                for line in text.lines() {
                    if let Some(delta) = api::parse_sse_line(line) {
                        let _ = app.emit("sse-delta", &delta);
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("sse-error", &e);
                return Err(e);
            }
        }
    }

    let _ = app.emit("sse-done", ());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, send_message])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
