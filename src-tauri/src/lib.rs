mod api;
mod middleware;
mod db;

use tauri::{Emitter, Manager, State};
use futures::StreamExt;
use db::Database;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好, {}! 欢迎使用道生一。", name)
}

#[tauri::command]
async fn send_message(
    app: tauri::AppHandle,
    config: api::ApiConfig,
    mut messages: Vec<api::ChatMessage>,
) -> Result<(), String> {
    middleware::preprocess_messages(&mut messages);
    let mut stream = api::stream_chat(config, messages).await?;

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(text) => {
                for line in text.lines() {
                    if let Some(mut delta) = api::parse_sse_line(line) {
                        middleware::sanitize_delta(&mut delta);
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

// --- 对话持久化命令 ---

#[tauri::command]
fn load_conversations(db: State<Database>) -> Result<Vec<db::ConvRow>, String> {
    db.list_conversations()
}

#[tauri::command]
fn get_messages(db: State<Database>, conversation_id: String) -> Result<Vec<db::MsgRow>, String> {
    db.get_messages(&conversation_id)
}

#[tauri::command]
fn save_conversation(
    db: State<Database>,
    conv: db::ConvRow,
    messages: Vec<db::MsgRow>,
) -> Result<(), String> {
    db.save_conversation(&conv, &messages)
}

#[tauri::command]
fn delete_conversation_cmd(db: State<Database>, id: String) -> Result<(), String> {
    db.delete_conversation(&id)
}

#[tauri::command]
fn search_conversations_cmd(db: State<Database>, query: String) -> Result<Vec<db::SearchResult>, String> {
    db.search(&query)
}

#[tauri::command]
fn export_conversation_cmd(db: State<Database>, id: String, format: String) -> Result<String, String> {
    db.export_conversation(&id, &format)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("无法获取数据目录");
            let database = Database::new(app_dir).expect("数据库初始化失败");
            app.manage(database);

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            send_message,
            load_conversations,
            get_messages,
            save_conversation,
            delete_conversation_cmd,
            search_conversations_cmd,
            export_conversation_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
