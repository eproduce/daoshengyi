use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    reasoning_content TEXT,
    images TEXT,
    timestamp INTEGER NOT NULL,
    tokens INTEGER,
    duration REAL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_msgs_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msgs_role ON messages(role);
";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConvRow {
    pub id: String,
    pub title: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MsgRow {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub reasoning_content: Option<String>,
    pub images: Option<String>,
    pub timestamp: i64,
    pub tokens: Option<i64>,
    pub duration: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub conversation_id: String,
    pub conversation_title: String,
    pub message_id: String,
    pub role: String,
    pub snippet: String,
    pub timestamp: i64,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
        let db_path = app_dir.join("daoshengyi.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("打开数据库失败: {}", e))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("初始化失败: {}", e))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("建表失败: {}", e))?;
        Ok(Database { conn: Mutex::new(conn) })
    }

    // --- 对话 CRUD ---

    pub fn list_conversations(&self) -> Result<Vec<ConvRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ConvRow {
                    id: row.get(0)?, title: row.get(1)?, model: row.get(2)?,
                    created_at: row.get(3)?, updated_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    pub fn save_conversation(&self, conv: &ConvRow, messages: &[MsgRow]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO conversations (id, title, model, created_at, updated_at) VALUES (?1,?2,?3,?4,?5)",
            params![conv.id, conv.title, conv.model, conv.created_at, conv.updated_at],
        ).map_err(|e| e.to_string())?;

        // 删除旧消息再插入
        conn.execute("DELETE FROM messages WHERE conversation_id=?1", params![conv.id])
            .map_err(|e| e.to_string())?;

        for m in messages {
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, reasoning_content, images, timestamp, tokens, duration) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![m.id, m.conversation_id, m.role, m.content, m.reasoning_content, m.images, m.timestamp, m.tokens, m.duration],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM conversations WHERE id=?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_messages(&self, conv_id: &str) -> Result<Vec<MsgRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, conversation_id, role, content, reasoning_content, images, timestamp, tokens, duration FROM messages WHERE conversation_id=?1 ORDER BY timestamp ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![conv_id], |row| {
                Ok(MsgRow {
                    id: row.get(0)?, conversation_id: row.get(1)?, role: row.get(2)?,
                    content: row.get(3)?, reasoning_content: row.get(4)?,
                    images: row.get(5)?, timestamp: row.get(6)?,
                    tokens: row.get(7)?, duration: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    // --- 全文搜索 ---

    pub fn search(&self, query: &str) -> Result<Vec<SearchResult>, String> {
        let q = format!("%{}%", query);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.title, m.id, m.role,
                        substr(m.content, max(0, instr(lower(m.content), lower(?1))-40), 120),
                        m.timestamp
                 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                 WHERE lower(m.content) LIKE lower(?1) OR lower(COALESCE(m.reasoning_content,'')) LIKE lower(?1)
                 ORDER BY m.timestamp DESC LIMIT 50"
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![q], |row| {
                Ok(SearchResult {
                    conversation_id: row.get(0)?, conversation_title: row.get(1)?,
                    message_id: row.get(2)?, role: row.get(3)?,
                    snippet: row.get(4)?, timestamp: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    // --- 导出 ---

    pub fn export_conversation(&self, conv_id: &str, format: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let conv: ConvRow = conn
            .query_row("SELECT id, title, model, created_at, updated_at FROM conversations WHERE id=?1",
                params![conv_id], |row| {
                    Ok(ConvRow { id: row.get(0)?, title: row.get(1)?, model: row.get(2)?,
                        created_at: row.get(3)?, updated_at: row.get(4)? })
                }).map_err(|e| format!("对话不存在: {}", e))?;

        let messages = self.get_messages(conv_id)?;

        if format == "json" {
            let export = serde_json::json!({
                "title": conv.title, "model": conv.model,
                "created_at": conv.created_at, "messages": messages,
            });
            return serde_json::to_string_pretty(&export).map_err(|e| e.to_string());
        }

        // Markdown
        let mut md = format!("# {}\n\n> 模型: {} | {}\n\n---\n\n",
            conv.title, conv.model,
            chrono::DateTime::from_timestamp_millis(conv.created_at)
                .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_default()
        );

        for m in &messages {
            let role = if m.role == "user" { "🧑 用户" } else { "🤖 助手" };
            md.push_str(&format!("### {}\n\n{}\n\n", role, m.content));
            if let Some(ref r) = m.reasoning_content {
                md.push_str(&format!("<details><summary>思考过程</summary>\n\n{}\n\n</details>\n\n", r));
            }
            if let Some(ref imgs) = m.images {
                if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(imgs) {
                    if !arr.is_empty() { md.push_str(&format!("> 📎 {} 张图片\n\n", arr.len())); }
                }
            }
            if let Some(t) = m.tokens { md.push_str(&format!("> Tokens: {} | 耗时: {}s\n\n", t, m.duration.unwrap_or(0.0))); }
            md.push_str("---\n\n");
        }
        Ok(md)
    }
}
