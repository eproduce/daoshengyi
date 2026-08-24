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
    attachments TEXT,
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

CREATE TABLE IF NOT EXISTS tool_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    arguments TEXT,
    result TEXT,
    is_error INTEGER DEFAULT 0,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON tool_audit(created_at);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'interval',
    interval_minutes INTEGER DEFAULT 60,
    daily_time TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_result TEXT,
    created_at INTEGER NOT NULL
);

-- 用量历史累计（删除会话不冲减：token/费用统计跨会话永久保留）
CREATE TABLE IF NOT EXISTS usage_agg (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    total_duration REAL NOT NULL DEFAULT 0,
    total_msgs INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_agg_daily (
    date TEXT PRIMARY KEY,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    msgs INTEGER NOT NULL DEFAULT 0
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
    pub attachments: Option<String>,
    pub timestamp: i64,
    pub tokens: Option<i64>,
    pub duration: Option<f64>,
    pub cost: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageAggRow {
    pub total_tokens: i64,
    pub total_cost: f64,
    pub total_duration: f64,
    pub total_msgs: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageDailyRow {
    pub date: String,
    pub tokens: i64,
    pub cost: f64,
    pub msgs: i64,
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

/// 定时任务（调度器在 lib.rs 的后台线程里执行）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduledTaskRow {
    pub id: String,
    pub name: String,
    pub command: String,
    /// "interval"（每 N 分钟）| "daily"（每天 HH:MM）
    pub schedule_type: String,
    pub interval_minutes: i64,
    pub daily_time: String,
    pub enabled: bool,
    pub next_run_at: i64,
    pub last_run_at: Option<i64>,
    pub last_result: Option<String>,
    pub created_at: i64,
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
        // 旧库迁移：加 attachments 列
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN attachments TEXT", []);
        // 用量累计表迁移：首次创建时从现有 messages 一次性聚合历史数据，
        // 之后仅通过 accumulate_usage 增量累加（删除会话不清零，统计跨会话保留）
        let agg_exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM usage_agg WHERE id=1)", [], |r| r.get(0))
            .unwrap_or(false);
        if !agg_exists {
            let _ = conn.execute("INSERT INTO usage_agg (id) VALUES (1)", []);
            let _ = conn.execute(
                "UPDATE usage_agg SET
                    total_tokens = (SELECT COALESCE(SUM(tokens),0) FROM messages WHERE role='assistant' AND tokens IS NOT NULL),
                    total_cost   = (SELECT COALESCE(SUM(cost),0)   FROM messages WHERE role='assistant' AND cost IS NOT NULL),
                    total_duration = (SELECT COALESCE(SUM(duration),0) FROM messages WHERE role='assistant' AND duration IS NOT NULL),
                    total_msgs   = (SELECT COUNT(*) FROM messages WHERE role='assistant')
                 WHERE id=1",
                [],
            );
            let _ = conn.execute(
                "INSERT OR IGNORE INTO usage_agg_daily (date, tokens, cost, msgs)
                 SELECT date(timestamp/1000, 'unixepoch', 'localtime'),
                        COALESCE(SUM(tokens),0), COALESCE(SUM(cost),0), COUNT(*)
                 FROM messages WHERE role='assistant' AND tokens IS NOT NULL
                 GROUP BY 1",
                [],
            );
        }
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
                "INSERT INTO messages (id, conversation_id, role, content, reasoning_content, images, attachments, timestamp, tokens, duration, cost) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![m.id, m.conversation_id, m.role, m.content, m.reasoning_content, m.images, m.attachments, m.timestamp, m.tokens, m.duration, m.cost],
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

    // --- 用量历史累计（删除会话不冲减，跨会话保留统计） ---

    /// 累加一次 LLM 消耗（每条 assistant 消息生成时调用一次；重试会再次调用，
    /// 因为重试确实重新消耗了 API token/费用，计两次是准确的）
    pub fn accumulate_usage(&self, tokens: i64, cost: f64, duration: f64, timestamp: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO usage_agg (id, total_tokens, total_cost, total_duration, total_msgs)
             VALUES (1, ?1, ?2, ?3, 1)
             ON CONFLICT(id) DO UPDATE SET
                total_tokens   = total_tokens + ?1,
                total_cost     = total_cost + ?2,
                total_duration = total_duration + ?3,
                total_msgs     = total_msgs + 1",
            params![tokens, cost, duration],
        ).map_err(|e| e.to_string())?;
        // 按天累计（本地时区日期，与前端 new Date 一致）
        conn.execute(
            "INSERT INTO usage_agg_daily (date, tokens, cost, msgs)
             VALUES (strftime('%Y-%m-%d', ?1/1000, 'unixepoch', 'localtime'), ?2, ?3, 1)
             ON CONFLICT(date) DO UPDATE SET
                tokens = tokens + ?2,
                cost   = cost + ?3,
                msgs   = msgs + 1",
            params![timestamp, tokens, cost],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_usage_total(&self) -> Result<UsageAggRow, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT total_tokens, total_cost, total_duration, total_msgs FROM usage_agg WHERE id=1",
            [],
            |row| Ok(UsageAggRow {
                total_tokens: row.get(0)?, total_cost: row.get(1)?,
                total_duration: row.get(2)?, total_msgs: row.get(3)?,
            }),
        ).map_err(|e| e.to_string())
    }

    pub fn get_usage_daily(&self) -> Result<Vec<UsageDailyRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT date, tokens, cost, msgs FROM usage_agg_daily ORDER BY date ASC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(UsageDailyRow {
                date: row.get(0)?, tokens: row.get(1)?, cost: row.get(2)?, msgs: row.get(3)?,
            })
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows { out.push(r.map_err(|e| e.to_string())?); }
        Ok(out)
    }

    pub fn get_messages(&self, conv_id: &str) -> Result<Vec<MsgRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, conversation_id, role, content, reasoning_content, images, attachments, timestamp, tokens, duration, cost FROM messages WHERE conversation_id=?1 ORDER BY timestamp ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![conv_id], |row| {
                Ok(MsgRow {
                    id: row.get(0)?, conversation_id: row.get(1)?, role: row.get(2)?,
                    content: row.get(3)?, reasoning_content: row.get(4)?,
                    images: row.get(5)?, attachments: row.get(6)?, timestamp: row.get(7)?,
                    tokens: row.get(8)?, duration: row.get(9)?, cost: row.get(10)?,
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
            let role = if m.role == "user" { "🧑 用户" } else { "\u{1f9e0} 助手" };
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

    // --- 定时任务 ---

    pub fn list_scheduled_tasks(&self) -> Result<Vec<ScheduledTaskRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, name, command, schedule_type, interval_minutes, daily_time, enabled, next_run_at, last_run_at, last_result, created_at FROM scheduled_tasks ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(ScheduledTaskRow {
                id: row.get(0)?, name: row.get(1)?, command: row.get(2)?,
                schedule_type: row.get(3)?, interval_minutes: row.get(4)?,
                daily_time: row.get(5)?, enabled: row.get::<_, i64>(6)? != 0,
                next_run_at: row.get(7)?, last_run_at: row.get(8)?,
                last_result: row.get(9)?, created_at: row.get(10)?,
            })
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows { out.push(r.map_err(|e| e.to_string())?); }
        Ok(out)
    }

    pub fn save_scheduled_task(&self, t: &ScheduledTaskRow) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO scheduled_tasks (id, name, command, schedule_type, interval_minutes, daily_time, enabled, next_run_at, last_run_at, last_result, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![t.id, t.name, t.command, t.schedule_type, t.interval_minutes, t.daily_time, t.enabled as i64, t.next_run_at, t.last_run_at, t.last_result, t.created_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_scheduled_task(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM scheduled_tasks WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_scheduled_task_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE scheduled_tasks SET enabled=?1 WHERE id=?2", params![enabled as i64, id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    pub fn clear_usage_agg_for_test(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM usage_agg", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM usage_agg_daily", []).map_err(|e| e.to_string())?;
        Ok(())
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

    // --- 工具审计日志 ---

    pub fn log_tool_call(
        &self,
        tool_name: &str,
        arguments: &str,
        result: &str,
        is_error: bool,
        duration_ms: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // 结果截断，避免超大记录
        let result_clipped: String = result.chars().take(2000).collect();
        let args_clipped: String = arguments.chars().take(1000).collect();
        conn.execute(
            "INSERT INTO tool_audit (tool_name, arguments, result, is_error, duration_ms, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                tool_name,
                args_clipped,
                result_clipped,
                if is_error { 1 } else { 0 },
                duration_ms,
                chrono::Utc::now().timestamp_millis()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_tool_audit(&self, limit: i64) -> Result<Vec<ToolAuditRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, tool_name, arguments, result, is_error, duration_ms, created_at FROM tool_audit ORDER BY id DESC LIMIT ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(ToolAuditRow {
                    id: row.get(0)?,
                    tool_name: row.get(1)?,
                    arguments: row.get(2)?,
                    result: row.get(3)?,
                    is_error: row.get::<_, i64>(4)? != 0,
                    duration_ms: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
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

/// 工具调用审计记录
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolAuditRow {
    pub id: i64,
    pub tool_name: String,
    pub arguments: String,
    pub result: String,
    pub is_error: bool,
    pub duration_ms: i64,
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_PID: AtomicUsize = AtomicUsize::new(0);

    fn tmp_db() -> (std::path::PathBuf, Database) {
        let pid = TEST_PID.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ds_db_test_{}_{}", std::process::id(), pid));
        let db = Database::new(dir.clone()).unwrap();
        (dir, db)
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn accumulate_usage_keeps_total_and_daily() {
        let (dir, db) = tmp_db();
        let t0 = db.get_usage_total().unwrap();
        assert_eq!(t0.total_tokens, 0);
        assert_eq!(t0.total_msgs, 0);

        // 同一天累加 3 条
        let ts = 1_700_000_000_000i64;
        db.accumulate_usage(100, 0.001, 2.5, ts).unwrap();
        db.accumulate_usage(200, 0.002, 3.0, ts).unwrap();
        db.accumulate_usage(50, 0.0005, 1.0, ts + 3600000).unwrap();

        let t = db.get_usage_total().unwrap();
        assert_eq!(t.total_tokens, 350);
        assert_eq!(t.total_msgs, 3);
        assert!((t.total_cost - 0.0035).abs() < 1e-9);
        assert!((t.total_duration - 6.5).abs() < 1e-9);

        let daily = db.get_usage_daily().unwrap();
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0].tokens, 350);

        // 跨天累加 → 多一条按天记录，总量继续累加
        db.accumulate_usage(10, 0.0001, 0.5, ts + 86400000).unwrap();
        let t2 = db.get_usage_total().unwrap();
        assert_eq!(t2.total_tokens, 360);
        assert_eq!(t2.total_msgs, 4);
        let daily2 = db.get_usage_daily().unwrap();
        assert_eq!(daily2.len(), 2);
        cleanup(&dir);
    }

    #[test]
    fn migrate_aggregates_existing_messages_and_is_idempotent() {
        let pid = TEST_PID.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ds_db_mig_{}_{}", std::process::id(), pid));
        let db = Database::new(dir.clone()).unwrap();

        // 插入会话 + 消息（1 条 user + 1 条 assistant 带 tokens/cost/duration）
        let conv = ConvRow { id: "c1".into(), title: "t".into(), model: "m".into(), created_at: 1, updated_at: 2 };
        let msgs = vec![
            MsgRow { id: "m1".into(), conversation_id: "c1".into(), role: "user".into(), content: "hi".into(), reasoning_content: None, images: None, attachments: None, timestamp: 1_700_000_000_000, tokens: None, duration: None, cost: None },
            MsgRow { id: "m2".into(), conversation_id: "c1".into(), role: "assistant".into(), content: "ok".into(), reasoning_content: None, images: None, attachments: None, timestamp: 1_700_000_000_000, tokens: Some(123), duration: Some(1.5), cost: Some(0.001) },
        ];
        db.save_conversation(&conv, &msgs).unwrap();

        // 模拟旧库：删除累计行，重开数据库触发迁移聚合
        db.clear_usage_agg_for_test().unwrap();
        drop(db);
        let db2 = Database::new(dir.clone()).unwrap();
        let t = db2.get_usage_total().unwrap();
        assert_eq!(t.total_tokens, 123);
        assert_eq!(t.total_msgs, 1);
        assert!((t.total_cost - 0.001).abs() < 1e-9);

        let daily = db2.get_usage_daily().unwrap();
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0].tokens, 123);

        // 再重开：迁移幂等，不会重复聚合
        drop(db2);
        let db3 = Database::new(dir.clone()).unwrap();
        let t3 = db3.get_usage_total().unwrap();
        assert_eq!(t3.total_tokens, 123);
        cleanup(&dir);
    }
}
