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
    cost REAL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_msgs_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msgs_role ON messages(role);

CREATE TABLE IF NOT EXISTS memory_summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    msg_range_start INTEGER NOT NULL,
    msg_range_end INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_facts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    fact TEXT NOT NULL,
    fact_type TEXT NOT NULL DEFAULT 'info',
    importance INTEGER DEFAULT 5,
    access_count INTEGER DEFAULT 0,
    last_accessed INTEGER,
    embedding BLOB,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_type ON memory_facts(fact_type);
CREATE INDEX IF NOT EXISTS idx_summaries_conv ON memory_summaries(conversation_id);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
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
    pub cost: Option<f64>,
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
        // 旧库迁移：加 embedding 列
        let _ = conn.execute("ALTER TABLE memory_facts ADD COLUMN embedding BLOB", []);
        // 旧库迁移：加 cost 列
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN cost REAL", []);
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
                "INSERT INTO messages (id, conversation_id, role, content, reasoning_content, images, timestamp, tokens, duration, cost) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![m.id, m.conversation_id, m.role, m.content, m.reasoning_content, m.images, m.timestamp, m.tokens, m.duration, m.cost],
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
            .prepare("SELECT id, conversation_id, role, content, reasoning_content, images, timestamp, tokens, duration, cost FROM messages WHERE conversation_id=?1 ORDER BY timestamp ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![conv_id], |row| {
                Ok(MsgRow {
                    id: row.get(0)?, conversation_id: row.get(1)?, role: row.get(2)?,
                    content: row.get(3)?, reasoning_content: row.get(4)?,
                    images: row.get(5)?, timestamp: row.get(6)?,
                    tokens: row.get(7)?, duration: row.get(8)?, cost: row.get(9)?,
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

    // --- 记忆系统 ---

    pub fn save_summary(&self, id: &str, conv_id: &str, summary: &str, range_start: i64, range_end: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_summaries (id, conversation_id, summary, msg_range_start, msg_range_end, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![id, conv_id, summary, range_start, range_end, chrono::Utc::now().timestamp_millis()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_summaries(&self, conv_id: &str) -> Result<Vec<SummaryRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, summary, msg_range_start, msg_range_end, created_at FROM memory_summaries WHERE conversation_id=?1 ORDER BY msg_range_start ASC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![conv_id], |row| {
            Ok(SummaryRow { id: row.get(0)?, conversation_id: row.get(1)?, summary: row.get(2)?, msg_range_start: row.get(3)?, msg_range_end: row.get(4)?, created_at: row.get(5)? })
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    pub fn save_fact(&self, fact: &FactRow) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_facts (id, conversation_id, fact, fact_type, importance, access_count, last_accessed, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![fact.id, fact.conversation_id, fact.fact, fact.fact_type, fact.importance, fact.access_count, fact.last_accessed, fact.created_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_facts_by_type(&self, fact_type: &str, limit: i64) -> Result<Vec<FactRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, fact, fact_type, importance, access_count, last_accessed, created_at FROM memory_facts WHERE fact_type=?1 ORDER BY importance DESC, access_count DESC LIMIT ?2"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![fact_type, limit], |row| {
            Ok(FactRow { id: row.get(0)?, conversation_id: row.get(1)?, fact: row.get(2)?, fact_type: row.get(3)?, importance: row.get(4)?, access_count: row.get(5)?, last_accessed: row.get(6)?, created_at: row.get(7)? })
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    pub fn search_facts(&self, query: &str, limit: i64) -> Result<Vec<FactRow>, String> {
        let q = format!("%{}%", query);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, fact, fact_type, importance, access_count, last_accessed, created_at FROM memory_facts WHERE fact LIKE ?1 ORDER BY importance DESC LIMIT ?2"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![q, limit], |row| {
            Ok(FactRow { id: row.get(0)?, conversation_id: row.get(1)?, fact: row.get(2)?, fact_type: row.get(3)?, importance: row.get(4)?, access_count: row.get(5)?, last_accessed: row.get(6)?, created_at: row.get(7)? })
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    pub fn touch_fact(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE memory_facts SET access_count = access_count + 1, last_accessed = ?1 WHERE id = ?2",
            params![chrono::Utc::now().timestamp_millis(), id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_fact(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM memory_facts WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn prune_facts(&self, min_access: i64, days_old: i64) -> Result<(), String> {
        let cutoff = chrono::Utc::now().timestamp_millis() - days_old * 86400000;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM memory_facts WHERE access_count < ?1 AND last_accessed < ?2 AND fact_type != 'preference'",
            params![min_access, cutoff],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- 向量检索 ---

    pub fn set_fact_embedding(&self, id: &str, embedding: &[f32]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "UPDATE memory_facts SET embedding = ?1 WHERE id = ?2",
            params![bytes, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn search_by_embedding(&self, query_vec: &[f32], limit: i64) -> Result<Vec<(FactRow, f32)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, fact, fact_type, importance, access_count, last_accessed, embedding, created_at FROM memory_facts WHERE embedding IS NOT NULL"
        ).map_err(|e| e.to_string())?;

        let mut scored: Vec<(FactRow, f32)> = Vec::new();
        let rows = stmt.query_map([], |row| {
            let emb_bytes: Vec<u8> = row.get(7)?;
            let emb: Vec<f32> = emb_bytes.chunks(4).map(|c| f32::from_le_bytes([c[0],c[1],c[2],c[3]])).collect();
            let score = cosine_similarity(query_vec, &emb);
            Ok((FactRow {
                id: row.get(0)?, conversation_id: row.get(1)?, fact: row.get(2)?,
                fact_type: row.get(3)?, importance: row.get(4)?, access_count: row.get(5)?,
                last_accessed: row.get(6)?, created_at: row.get(8)?,
            }, score))
        }).map_err(|e| e.to_string())?;

        for r in rows {
            let (fact, score) = r.map_err(|e| e.to_string())?;
            scored.push((fact, score));
        }
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit as usize);
        Ok(scored)
    }

    // --- 应用设置存取 ---

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT value FROM app_settings WHERE key=?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![key], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        match rows.next() {
            Some(Ok(v)) => Ok(Some(v)),
            Some(Err(e)) => Err(e.to_string()),
            None => Ok(None),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() { return 0.0; }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 { return 0.0; }
    dot / (na * nb)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SummaryRow {
    pub id: String,
    pub conversation_id: String,
    pub summary: String,
    pub msg_range_start: i64,
    pub msg_range_end: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FactRow {
    pub id: String,
    pub conversation_id: Option<String>,
    pub fact: String,
    pub fact_type: String,
    pub importance: i64,
    pub access_count: i64,
    pub last_accessed: Option<i64>,
    pub created_at: i64,
}
