use rusqlite::{Connection, OptionalExtension, params};
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

-- 长期记忆 1.4 记忆分层：episodic 聚合层（跨会话主题汇总）。
-- semantic=memory_facts（事实）、episodic 单会话=memory_summaries、
-- episodic 聚合层=memory_episodic（跨会话反复出现的主题/项目/持续关注点）。
CREATE TABLE IF NOT EXISTS memory_episodic (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_summary_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodic_updated ON memory_episodic(updated_at);

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

-- FTS5 全文索引：中文按 unigram（逐字）分词 + 英文单词，替代 LIKE 全表扫，
-- 提升跨会话召回（DeepSeek 无 embeddings 时尤为重要）。
-- rowid 与 memory_facts.rowid 一一对应；由 Rust 侧在 save/delete 时同步维护。
CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(fact_terms, tokenize='unicode61');

-- Phase 3 知识库 RAG：本地文件分块（kb_index 写入）+ FTS5 关键词检索 + 语义向量（可选）
CREATE TABLE IF NOT EXISTS kb_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kb_name TEXT NOT NULL,
    file TEXT NOT NULL,
    chunk TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_kb_name ON kb_chunks(kb_name);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(chunk_terms, tokenize='unicode61');

-- 项目语义索引（P-A3 补全）：自然语言找代码（按 root 项目目录组织，向量余弦检索）
CREATE TABLE IF NOT EXISTS code_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root TEXT NOT NULL,
    file TEXT NOT NULL,
    chunk TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_code_root ON code_chunks(root);

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

-- 会话内撤销：文件写/删操作前的快照（回滚用）。action: edit(编辑)/create(新建)/delete(删除)
CREATE TABLE IF NOT EXISTS undo_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    path TEXT NOT NULL,
    backup TEXT,
    existed INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_undo_created ON undo_history(created_at);

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
        // 旧库迁移：kb_chunks 加 embedding 列（知识库语义向量）
        let _ = conn.execute("ALTER TABLE kb_chunks ADD COLUMN embedding BLOB", []);
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
        // FTS5 索引回填：旧库 memory_facts 已有数据但 fts 表为空 → 逐条分词补建
        let fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_facts_fts", [], |r| r.get(0))
            .unwrap_or(0);
        let fact_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_facts", [], |r| r.get(0))
            .unwrap_or(0);
        if fts_count == 0 && fact_count > 0 {
            let rows: Vec<(i64, String)> = conn
                .prepare("SELECT rowid, fact FROM memory_facts")
                .map_err(|e| e.to_string())?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for (rid, fact) in rows {
                let terms = cjk_terms(&fact);
                let _ = conn.execute(
                    "INSERT INTO memory_facts_fts(rowid, fact_terms) VALUES (?1, ?2)",
                    params![rid, terms],
                );
            }
            eprintln!("[memory] FTS 索引回填 {} 条", fact_count);
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

    /// 列出全部会话摘要（记忆管理面板用），按创建时间倒序
    pub fn list_all_summaries(&self, limit: i64) -> Result<Vec<SummaryRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, summary, msg_range_start, msg_range_end, created_at FROM memory_summaries ORDER BY created_at DESC LIMIT ?1"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(SummaryRow { id: row.get(0)?, conversation_id: row.get(1)?, summary: row.get(2)?, msg_range_start: row.get(3)?, msg_range_end: row.get(4)?, created_at: row.get(5)? })
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    // --- 记忆分层 1.4：episodic 聚合层（跨会话主题汇总） ---

    /// 保存/更新一条跨会话主题条目（upsert）。source_summary_ids 为来源会话摘要 id 的 JSON 数组。
    pub fn save_episodic(&self, id: &str, title: &str, summary: &str, source_summary_ids: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT OR REPLACE INTO memory_episodic (id, title, summary, source_summary_ids, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![id, title, summary, source_summary_ids, now, now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 列出跨会话主题条目，按更新时间倒序
    pub fn list_episodic(&self, limit: i64) -> Result<Vec<EpisodicRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, title, summary, source_summary_ids, created_at, updated_at FROM memory_episodic ORDER BY updated_at DESC LIMIT ?1"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(EpisodicRow { id: row.get(0)?, title: row.get(1)?, summary: row.get(2)?, source_summary_ids: row.get(3)?, created_at: row.get(4)?, updated_at: row.get(5)? })
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    pub fn delete_episodic(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM memory_episodic WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 已参与跨会话汇总的会话摘要 id 列表（避免重复汇总同一批摘要）
    pub fn episodic_covered(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT source_summary_ids FROM memory_episodic").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut covered: Vec<String> = Vec::new();
        for r in rows {
            if let Ok(list) = r {
                if let Ok(ids) = serde_json::from_str::<Vec<String>>(&list) {
                    covered.extend(ids);
                }
            }
        }
        Ok(covered)
    }

    /// 保存事实（带 FTS 索引同步 + 近似去重合并）：
    /// - 若与已有同类型事实高度相似（字符集相似度 > 0.62）→ 合并：累加 importance、
    ///   保留更长/更新的文本、更新访问信息，返回合并目标 id
    /// - 否则插入新事实，同步写 FTS 索引
    /// 返回 (是否新插入, 生效的 id)
    pub fn save_fact(&self, fact: &FactRow) -> Result<(bool, String), String> {
        // 先去重：查同类型所有事实，做字符级相似度匹配
        if let Some(existing) = self.find_similar_fact(&fact.fact, &fact.fact_type)? {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            // 合并：文本取更长者（信息更全），重要度累加，保留原始创建时间
            let new_importance = (existing.importance + fact.importance).min(10);
            let new_fact = if fact.fact.len() > existing.fact.len() { fact.fact.clone() } else { existing.fact.clone() };
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "UPDATE memory_facts SET fact=?1, importance=?2, access_count = access_count + 1, last_accessed=?3 WHERE id=?4",
                params![new_fact, new_importance, now, existing.id],
            ).map_err(|e| e.to_string())?;
            // 同步更新 FTS 索引
            if let Ok(rid) = conn.query_row("SELECT rowid FROM memory_facts WHERE id=?1", params![existing.id], |r| r.get::<_, i64>(0)) {
                let _ = conn.execute("DELETE FROM memory_facts_fts WHERE rowid=?1", params![rid]);
                let _ = conn.execute(
                    "INSERT INTO memory_facts_fts(rowid, fact_terms) VALUES (?1, ?2)",
                    params![rid, cjk_terms(&new_fact)],
                );
            }
            return Ok((false, existing.id.clone()));
        }

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_facts (id, conversation_id, fact, fact_type, importance, access_count, last_accessed, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![fact.id, fact.conversation_id, fact.fact, fact.fact_type, fact.importance, fact.access_count, fact.last_accessed, fact.created_at],
        ).map_err(|e| e.to_string())?;
        // 同步 FTS 索引
        if let Ok(rid) = conn.query_row("SELECT rowid FROM memory_facts WHERE id=?1", params![fact.id], |r| r.get::<_, i64>(0)) {
            let _ = conn.execute("DELETE FROM memory_facts_fts WHERE rowid=?1", params![rid]);
            let _ = conn.execute(
                "INSERT INTO memory_facts_fts(rowid, fact_terms) VALUES (?1, ?2)",
                params![rid, cjk_terms(&fact.fact)],
            );
        }
        Ok((true, fact.id.clone()))
    }

    /// 查找与给定事实高度相似的同类型已有事实（字符集 Jaccard 相似度 > 0.62）
    fn find_similar_fact(&self, fact: &str, fact_type: &str) -> Result<Option<FactRow>, String> {
        let candidates = self.get_facts_by_type(fact_type, 500)?;
        let mut best: Option<(f32, FactRow)> = None;
        for c in candidates {
            if c.fact == fact { return Ok(Some(c)); }
            let sim = char_set_similarity(&c.fact, fact);
            if sim > 0.62 {
                match &best {
                    Some((s, _)) if *s >= sim => {}
                    _ => best = Some((sim, c)),
                }
            }
        }
        Ok(best.map(|(_, f)| f))
    }

    /// 列出事实（记忆管理用）：按类型过滤（空=全部），按 重要度/最近访问/创建时间 排序
    pub fn list_facts(&self, fact_type: &str, limit: i64) -> Result<Vec<FactRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = if fact_type.is_empty() {
            conn.prepare(
                "SELECT id, conversation_id, fact, fact_type, importance, access_count, last_accessed, created_at FROM memory_facts ORDER BY importance DESC, COALESCE(last_accessed,0) DESC LIMIT ?1"
            )
        } else {
            conn.prepare(
                "SELECT id, conversation_id, fact, fact_type, importance, access_count, last_accessed, created_at FROM memory_facts WHERE fact_type=?1 ORDER BY importance DESC, COALESCE(last_accessed,0) DESC LIMIT ?2"
            )
        }.map_err(|e| e.to_string())?;
        let row_map = |row: &rusqlite::Row| -> rusqlite::Result<FactRow> {
            Ok(FactRow { id: row.get(0)?, conversation_id: row.get(1)?, fact: row.get(2)?, fact_type: row.get(3)?, importance: row.get(4)?, access_count: row.get(5)?, last_accessed: row.get(6)?, created_at: row.get(7)? })
        };
        let rows = if fact_type.is_empty() {
            stmt.query_map(params![limit], row_map)
        } else {
            stmt.query_map(params![fact_type, limit], row_map)
        }.map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
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

    /// 混合检索：FTS5 全文（bm25 相关度）+ LIKE 兜底，按 相关度 × importance × recency 加权排序。
    /// DeepSeek 无 embedding 时这是跨会话召回的主力（中文 unigram 分词替代 LIKE 全表扫）。
    pub fn search_facts(&self, query: &str, limit: i64) -> Result<Vec<FactRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        let mut rows: Vec<(f32, FactRow)> = Vec::new();

        // 1) FTS5 全文检索（分词匹配，覆盖中文逐字 + 英文单词）
        let terms = cjk_terms(query);
        let match_q = fts_query(&terms);
        if !match_q.is_empty() {
            let sql = "SELECT mf.rowid, mf.id, mf.conversation_id, mf.fact, mf.fact_type, mf.importance, mf.access_count, mf.last_accessed, mf.created_at, bm25(memory_facts_fts) AS score
                       FROM memory_facts_fts JOIN memory_facts mf ON mf.rowid = memory_facts_fts.rowid
                       WHERE memory_facts_fts MATCH ?1";
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let iter = stmt.query_map(params![match_q], |row| {
                let fact = FactRow {
                    id: row.get(1)?, conversation_id: row.get(2)?, fact: row.get(3)?,
                    fact_type: row.get(4)?, importance: row.get(5)?, access_count: row.get(6)?,
                    last_accessed: row.get(7)?, created_at: row.get(8)?,
                };
                Ok((row.get::<_, f32>(9)?, fact))
            }).map_err(|e| e.to_string())?;
            for r in iter {
                if let Ok((score, fact)) = r {
                    let recency = if fact.last_accessed.is_some() { 1.0 } else { 0.5 };
                    let weighted = -score * 1.0 + fact.importance as f32 * 0.3 + recency * 0.5;
                    rows.push((weighted, fact));
                }
            }
        }

        // 2) LIKE 精确兜底（英文/数字/特殊串 FTS 可能不覆盖）
        let q = format!("%{}%", query);
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, fact, fact_type, importance, access_count, last_accessed, created_at FROM memory_facts WHERE fact LIKE ?1 AND fact NOT IN (SELECT fact FROM memory_facts WHERE id IN (SELECT id FROM memory_facts LIMIT 0)) ORDER BY importance DESC LIMIT ?2"
        ).map_err(|e| e.to_string())?;
        let iter = stmt.query_map(params![q, limit * 2], |row| {
            Ok(FactRow { id: row.get(0)?, conversation_id: row.get(1)?, fact: row.get(2)?, fact_type: row.get(3)?, importance: row.get(4)?, access_count: row.get(5)?, last_accessed: row.get(6)?, created_at: row.get(7)? })
        }).map_err(|e| e.to_string())?;
        for r in iter {
            if let Ok(fact) = r {
                let recency = if fact.last_accessed.is_some() { 1.0 } else { 0.5 };
                let weighted = fact.importance as f32 * 0.5 + recency * 0.5;
                rows.push((weighted, fact));
            }
        }

        // 3) 按加权分降序去重
        rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for (_, f) in rows {
            if seen.insert(f.id.clone()) {
                out.push(f);
                if out.len() >= limit as usize { break; }
            }
        }
        let _ = now;
        Ok(out)
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
        // 先删 FTS 索引再删记录
        if let Ok(rid) = conn.query_row("SELECT rowid FROM memory_facts WHERE id=?1", params![id], |r| r.get::<_, i64>(0)) {
            let _ = conn.execute("DELETE FROM memory_facts_fts WHERE rowid=?1", params![rid]);
        }
        conn.execute("DELETE FROM memory_facts WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 编辑事实（记忆管理）：更新文本/类型/重要度，同步重建 FTS 索引
    pub fn update_fact(&self, id: &str, fact: &str, fact_type: &str, importance: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE memory_facts SET fact=?1, fact_type=?2, importance=?3 WHERE id=?4",
            params![fact, fact_type, importance.clamp(1, 10), id],
        ).map_err(|e| e.to_string())?;
        // 同步重建 FTS 索引
        if let Ok(rid) = conn.query_row("SELECT rowid FROM memory_facts WHERE id=?1", params![id], |r| r.get::<_, i64>(0)) {
            let _ = conn.execute("DELETE FROM memory_facts_fts WHERE rowid=?1", params![rid]);
            let _ = conn.execute(
                "INSERT INTO memory_facts_fts(rowid, fact_terms) VALUES (?1, ?2)",
                params![rid, cjk_terms(fact)],
            );
        }
        Ok(())
    }

    /// 记忆维护（启动/每日调度）：衰减 + 遗忘 + FTS 清理。
    /// - 重要度随时间衰减（>45 天未访问且非 preference，importance 降 1，最低 1）
    /// - 遗忘：低价值（importance<=2）且 60 天未访问的非 preference 删除
    /// - 清理孤儿 FTS 索引行
    pub fn maintain_facts(&self) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        let day = 86400000i64;

        // 1) 重要度衰减（保留 preference 与近期访问过的事实）
        conn.execute(
            "UPDATE memory_facts SET importance = MAX(1, importance - 1)
             WHERE fact_type != 'preference' AND last_accessed IS NOT NULL
               AND last_accessed < ?1 AND importance > 1",
            params![now - 45 * day],
        ).map_err(|e| e.to_string())?;

        // 2) 遗忘低价值冷记忆
        conn.execute(
            "DELETE FROM memory_facts WHERE fact_type != 'preference' AND importance <= 2 AND last_accessed < ?1",
            params![now - 60 * day],
        ).map_err(|e| e.to_string())?;

        // 3) 清理孤儿 FTS 行（记录已删但索引残留）
        conn.execute(
            "DELETE FROM memory_facts_fts WHERE rowid NOT IN (SELECT rowid FROM memory_facts)",
            [],
        ).map_err(|e| e.to_string())?;

        let remaining: i64 = conn.query_row("SELECT COUNT(*) FROM memory_facts", [], |r| r.get(0)).unwrap_or(0);
        Ok(format!("记忆维护完成，当前 {} 条事实", remaining))
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

    // --- Phase 3 知识库 RAG（kb_chunks + FTS5 关键词检索） ---

    /// 清空某知识库所有分块（重建索引前调用；同步清理 FTS 行）
    pub fn kb_clear(&self, kb_name: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let ids: Vec<i64> = conn
            .prepare("SELECT id FROM kb_chunks WHERE kb_name=?1")
            .map_err(|e| e.to_string())?
            .query_map(params![kb_name], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        for id in ids {
            let _ = conn.execute("DELETE FROM kb_chunks_fts WHERE rowid=?1", params![id]);
        }
        conn.execute("DELETE FROM kb_chunks WHERE kb_name=?1", params![kb_name])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 写入一个分块（自动建 FTS 索引；embedding 可选，供语义向量检索）
    pub fn kb_add_chunk(
        &self,
        kb_name: &str,
        file: &str,
        chunk: &str,
        chunk_idx: i64,
        embedding: Option<&[f32]>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let emb_bytes: Option<Vec<u8>> = embedding.map(|e| e.iter().flat_map(|f| f.to_le_bytes()).collect());
        conn.execute(
            "INSERT INTO kb_chunks(kb_name, file, chunk, chunk_idx, created_at, embedding) VALUES (?1,?2,?3,?4,?5,?6)",
            params![kb_name, file, chunk, chunk_idx, chrono::Utc::now().timestamp_millis(), emb_bytes],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO kb_chunks_fts(rowid, chunk_terms) VALUES (?1, ?2)",
            params![id, cjk_terms(chunk)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 检索知识库（FTS5 关键词，中文 unigram 分词）
    /// 混合检索：FTS5 关键词命中（最相关，bm25 序）在前，语义向量（query_vec 提供且分块
    /// 有 embedding 时）按余弦补充召回未命中的分块（追加在后）；去重、截断 limit。
    pub fn kb_search_hybrid(&self, kb_name: &str, query: &str, query_vec: Option<&[f32]>, limit: i64) -> Result<Vec<KbChunk>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // 1) FTS5 关键词结果（bm25 序）
        let mut merged: Vec<KbChunk> = Vec::new();
        let q = fts_query(&cjk_terms(query));
        if !q.is_empty() {
            let sql = "SELECT kc.id, kc.kb_name, kc.file, kc.chunk, kc.chunk_idx, kc.created_at
                       FROM kb_chunks_fts JOIN kb_chunks kc ON kc.id = kb_chunks_fts.rowid
                       WHERE kb_chunks_fts MATCH ?1 AND kc.kb_name = ?2
                       ORDER BY bm25(kb_chunks_fts) LIMIT ?3";
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![q, kb_name, limit], |r| {
                    Ok(KbChunk {
                        id: r.get(0)?, kb_name: r.get(1)?, file: r.get(2)?,
                        chunk: r.get(3)?, chunk_idx: r.get(4)?, created_at: r.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for r in rows {
                merged.push(r.map_err(|e| e.to_string())?);
            }
        }
        // 2) 语义向量补充（分块有 embedding 时；只加关键词未命中的，按余弦序追加在后）
        if let Some(vec) = query_vec {
            let mut stmt = conn
                .prepare("SELECT id, kb_name, file, chunk, chunk_idx, created_at, embedding FROM kb_chunks WHERE kb_name=?1 AND embedding IS NOT NULL")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![kb_name], |row| {
                    let emb_bytes: Vec<u8> = row.get(6)?;
                    let emb: Vec<f32> = emb_bytes
                        .chunks(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect();
                    let score = cosine_similarity(vec, &emb);
                    Ok((
                        KbChunk {
                            id: row.get(0)?, kb_name: row.get(1)?, file: row.get(2)?,
                            chunk: row.get(3)?, chunk_idx: row.get(4)?, created_at: row.get(5)?,
                        },
                        score,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut vec_scored: Vec<(KbChunk, f32)> = Vec::new();
            for r in rows {
                vec_scored.push(r.map_err(|e| e.to_string())?);
            }
            vec_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            for (c, _) in vec_scored {
                if !merged.iter().any(|m| m.id == c.id) {
                    merged.push(c);
                }
            }
        }
        merged.truncate(limit as usize);
        Ok(merged)
    }

    /// 列出所有知识库及分块数
    pub fn kb_list(&self) -> Result<Vec<KbInfo>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT kb_name, COUNT(*) FROM kb_chunks GROUP BY kb_name ORDER BY kb_name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok(KbInfo { name: r.get(0)?, chunks: r.get(1)? }))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// 删除整个知识库
    pub fn kb_delete(&self, kb_name: &str) -> Result<(), String> {
        self.kb_clear(kb_name)
    }

    // --- 项目语义索引（P-A3 补全：自然语言找代码） ---

    /// 清空某项目的代码索引（重建前调用）
    pub fn code_clear(&self, root: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM code_chunks WHERE root=?1", params![root]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 写入一个代码分块（embedding 为 Ollama 向量）
    pub fn code_add_chunk(
        &self,
        root: &str,
        file: &str,
        chunk: &str,
        chunk_idx: i64,
        embedding: Option<&[f32]>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let emb_bytes: Option<Vec<u8>> = embedding.map(|e| e.iter().flat_map(|f| f.to_le_bytes()).collect());
        conn.execute(
            "INSERT INTO code_chunks(root, file, chunk, chunk_idx, created_at, embedding) VALUES (?1,?2,?3,?4,?5,?6)",
            params![root, file, chunk, chunk_idx, chrono::Utc::now().timestamp_millis(), emb_bytes],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 语义检索项目代码（余弦相似度，仅返回有 embedding 的分块，按相似度降序）
    pub fn code_search(&self, root: &str, query_vec: &[f32], limit: i64) -> Result<Vec<CodeChunkRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, root, file, chunk, chunk_idx, created_at, embedding FROM code_chunks WHERE root=?1 AND embedding IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![root], |row| {
                let emb_bytes: Vec<u8> = row.get(6)?;
                let emb: Vec<f32> = emb_bytes
                    .chunks(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect();
                let score = cosine_similarity(query_vec, &emb);
                Ok((
                    CodeChunkRow {
                        id: row.get(0)?, root: row.get(1)?, file: row.get(2)?,
                        chunk: row.get(3)?, chunk_idx: row.get(4)?, created_at: row.get(5)?,
                    },
                    score,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut scored: Vec<(CodeChunkRow, f32)> = Vec::new();
        for r in rows { scored.push(r.map_err(|e| e.to_string())?); }
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit as usize);
        Ok(scored.into_iter().map(|(c, _)| c).collect())
    }

    /// 已索引的项目根目录列表
    pub fn code_roots(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT DISTINCT root FROM code_chunks ORDER BY root").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows { out.push(r.map_err(|e| e.to_string())?); }
        Ok(out)
    }

    /// 某项目的索引统计（文件数, 分块数）
    pub fn code_stats(&self, root: &str) -> Result<(i64, i64), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let (files, chunks): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(DISTINCT file), COUNT(*) FROM code_chunks WHERE root=?1",
                params![root],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        Ok((files, chunks))
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

    // --- 会话内撤销：文件写/删操作快照与回滚 ---

    /// 记录一次可撤销的文件操作（写盘/删除前调用）。
    /// action: edit（编辑覆盖，原内容在 backup）/ create（新建，原不存在）/ delete（删除，原内容在 backup）
    pub fn record_undo(&self, action: &str, path: &str, backup: &str, existed: bool) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO undo_history (action, path, backup, existed, created_at) VALUES (?1,?2,?3,?4,?5)",
            params![action, path, backup, if existed { 1 } else { 0 }, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    /// 列出可撤销操作（最近优先）
    pub fn list_undo(&self, limit: i64) -> Result<Vec<UndoRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, action, path, backup, existed, created_at FROM undo_history ORDER BY id DESC LIMIT ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(UndoRow {
                    id: row.get(0)?,
                    action: row.get(1)?,
                    path: row.get(2)?,
                    backup: row.get(3)?,
                    existed: row.get::<_, i64>(4)? != 0,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in rows { result.push(r.map_err(|e| e.to_string())?); }
        Ok(result)
    }

    /// 撤销指定操作：按 action 回滚文件系统状态，删除该 undo 记录。返回操作摘要。
    pub fn undo_by_id(&self, id: i64) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let (action, path, backup): (String, String, String) = conn
            .query_row(
                "SELECT action, path, backup FROM undo_history WHERE id=?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("该操作不存在或已被撤销")?;
        let p = std::path::Path::new(&path);
        match action.as_str() {
            "edit" => {
                // 撤销编辑：恢复原内容
                std::fs::write(&path, &backup).map_err(|e| format!("恢复文件失败: {}", e))?;
            }
            "create" => {
                // 撤销新建：当时文件不存在，现在删掉它
                if p.exists() {
                    std::fs::remove_file(&path).map_err(|e| format!("删除文件失败: {}", e))?;
                }
            }
            "delete" => {
                // 撤销删除：恢复原内容
                if let Some(parent) = p.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&path, &backup).map_err(|e| format!("恢复文件失败: {}", e))?;
            }
            _ => return Err("未知操作类型".into()),
        }
        conn.execute("DELETE FROM undo_history WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        Ok(format!("已撤销（{}）: {}", action_label(&action), path))
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

/// 中文分词（unigram）：汉字逐字分词 + 英文/数字按空白词切分，供 FTS5 unicode61 索引。
/// 例如 "华为技术有限公司" → "华 为 技 术 有 限 公 司"，"DeepSeek v4" → "deepseek v4"
fn cjk_terms(s: &str) -> String {
    let mut out = String::new();
    let mut prev_ascii = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
            if prev_ascii { out.push(c); }
            else { out.push(' '); out.push(c.to_ascii_lowercase()); prev_ascii = true; }
        } else if c.is_whitespace() {
            prev_ascii = false;
        } else {
            // 汉字/标点/其它：逐字符为独立 token
            out.push(' '); out.push(c); prev_ascii = false;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 把分词串转成 FTS5 MATCH 查询串：每个 token 用双引号包裹 + 空格（隐含 AND）
fn fts_query(terms: &str) -> String {
    let toks: Vec<String> = terms.split_whitespace().map(|t| format!("\"{}\"", t)).collect();
    // 过多 token 会让 AND 过于严格，最多取 8 个
    let limited: Vec<String> = toks.into_iter().take(8).collect();
    limited.join(" ")
}

/// 字符集 Jaccard 相似度（用于事实去重）：
/// 两段文本去空格后的字符集合交并比 × 长度比惩罚（长度差过大不算重复，
/// 避免「用户喜欢简洁」与「用户喜欢简洁回答」这类包含关系被误并）
fn char_set_similarity(a: &str, b: &str) -> f32 {
    let va: Vec<char> = a.chars().filter(|c| !c.is_whitespace()).collect();
    let vb: Vec<char> = b.chars().filter(|c| !c.is_whitespace()).collect();
    if va.is_empty() || vb.is_empty() { return 0.0; }
    let set_a: std::collections::HashSet<char> = va.iter().copied().collect();
    let set_b: std::collections::HashSet<char> = vb.iter().copied().collect();
    let inter = set_a.intersection(&set_b).count();
    let union = set_a.union(&set_b).count();
    if union == 0 { return 0.0; }
    let jaccard = inter as f32 / union as f32;
    let len_ratio = va.len().min(vb.len()) as f32 / va.len().max(vb.len()) as f32;
    if len_ratio < 0.55 { return 0.0; }
    jaccard
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

/// 记忆分层 1.4：episodic 聚合层条目（跨会话主题汇总）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EpisodicRow {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub source_summary_ids: String,
    pub created_at: i64,
    pub updated_at: i64,
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

/// 会话内撤销记录（文件写/删操作前的快照）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UndoRow {
    pub id: i64,
    pub action: String, // edit / create / delete
    pub path: String,
    pub backup: String,
    pub existed: bool,
    pub created_at: i64,
}

fn action_label(action: &str) -> &str {
    match action {
        "edit" => "编辑",
        "create" => "新建",
        "delete" => "删除",
        _ => action,
    }
}

/// 项目语义索引分块（P-A3 补全：自然语言找代码）
#[derive(Debug, serde::Serialize)]
pub struct CodeChunkRow {
    pub id: i64,
    pub root: String,
    pub file: String,
    pub chunk: String,
    pub chunk_idx: i64,
    pub created_at: i64,
}

/// 知识库分块（Phase 3 RAG）
#[derive(Debug, serde::Serialize)]
pub struct KbChunk {
    pub id: i64,
    pub kb_name: String,
    pub file: String,
    pub chunk: String,
    pub chunk_idx: i64,
    pub created_at: i64,
}

/// 知识库概览（Phase 3 RAG）
#[derive(Debug, serde::Serialize)]
pub struct KbInfo {
    pub name: String,
    pub chunks: i64,
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

    // Phase 3 知识库 RAG：写入/检索/隔离/列表/清空
    #[test]
    fn kb_add_search_list_clear() {
        let (dir, db) = tmp_db();
        db.kb_add_chunk("docs", "a.md", "华为技术有限公司成立于1987年", 0, None).unwrap();
        db.kb_add_chunk("docs", "b.md", "DeepSeek 是一个大语言模型", 0, None).unwrap();
        db.kb_add_chunk("notes", "c.md", "今天天气很好", 0, None).unwrap();

        let hits = db.kb_search_hybrid("docs", "华为", None, 5).unwrap();
        assert!(hits.iter().any(|c| c.chunk.contains("华为")), "中文 unigram 命中");
        assert!(!hits.iter().any(|c| c.file == "b.md"), "无关文件不命中");

        // 跨库隔离：other 库查不到 docs 内容
        assert!(db.kb_search_hybrid("other", "华为", None, 5).unwrap().is_empty(), "跨库隔离");
        // kb_list 汇总
        let list = db.kb_list().unwrap();
        let docs = list.iter().find(|k| k.name == "docs").unwrap();
        assert_eq!(docs.chunks, 2);
        assert_eq!(list.len(), 2);
        // 清空后检索为空
        db.kb_clear("docs").unwrap();
        assert!(db.kb_search_hybrid("docs", "华为", None, 5).unwrap().is_empty(), "清空后检索为空");
        assert_eq!(db.kb_list().unwrap().len(), 1);
        cleanup(&dir);
    }

    // Phase 3 知识库语义向量：带 embedding 存储 + 混合检索（语义命中关键词未中的分块）
    #[test]
    fn kb_hybrid_semantic_recalls_similar_chunk() {
        let (dir, db) = tmp_db();
        // 关键词「华为」能命中 a；语义上「这家通信公司」也应召回 a（用接近向量模拟语义）
        db.kb_add_chunk("docs", "a.md", "华为技术有限公司", 0, Some(&[0.9, 0.1, 0.1])).unwrap();
        db.kb_add_chunk("docs", "b.md", "今天天气不错", 0, Some(&[0.1, 0.9, 0.1])).unwrap();
        // 关键词命中 a
        let kw = db.kb_search_hybrid("docs", "华为", None, 5).unwrap();
        assert!(kw.iter().any(|c| c.file == "a.md"), "关键词命中 a");
        // 语义查询向量偏向 a（与 a 的 embedding 接近），即使查询词不在 chunk 里也应召回 a
        let sem = db.kb_search_hybrid("docs", "通讯设备制造巨头", Some(&[0.95, 0.1, 0.1]), 5).unwrap();
        assert_eq!(sem.first().map(|c| c.file.as_str()), Some("a.md"), "语义优先召回 a");
        // 混合：语义结果排在关键词结果前
        let hy = db.kb_search_hybrid("docs", "华为", Some(&[0.95, 0.1, 0.1]), 5).unwrap();
        assert!(hy.len() >= 1 && hy[0].file == "a.md", "混合检索去重且 a 在前");
        cleanup(&dir);
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

    fn test_fact(id: &str, text: &str, fact_type: &str, importance: i64) -> FactRow {
        FactRow {
            id: id.into(), conversation_id: Some("c1".into()), fact: text.into(),
            fact_type: fact_type.into(), importance, access_count: 0,
            last_accessed: None, created_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn fts_search_finds_chinese_by_unigram() {
        let (dir, db) = tmp_db();
        db.save_fact(&test_fact("f1", "用户喜欢简洁的回答方式", "preference", 8)).unwrap();
        db.save_fact(&test_fact("f2", "项目使用 React 18 和 TypeScript", "info", 5)).unwrap();

        // 中文 unigram：查询词与事实文本部分重合即可召回（"简洁"命中 f1）
        let r = db.search_facts("简洁回答", 5).unwrap();
        assert!(!r.is_empty(), "中文 unigram 检索应命中");
        assert!(r.iter().any(|f| f.id == "f1"), "应召回 f1，实际: {:?}", r.iter().map(|f| &f.id).collect::<Vec<_>>());

        // 英文单词检索
        let r2 = db.search_facts("typescript", 5).unwrap();
        assert!(r2.iter().any(|f| f.id == "f2"), "英文应命中 f2: {:?}", r2.iter().map(|f| &f.id).collect::<Vec<_>>());
        cleanup(&dir);
    }

    #[test]
    fn save_fact_dedups_similar_text() {
        let (dir, db) = tmp_db();
        let (new1, id1) = db.save_fact(&test_fact("f1", "用户喜欢简洁回答", "preference", 8)).unwrap();
        assert!(new1);
        // 近似重复：同字不同序（LLM 重复提取的典型）→ 合并而非新增
        let (new2, id2) = db.save_fact(&test_fact("f2", "用户简洁回答喜欢", "preference", 7)).unwrap();
        assert!(!new2, "同字重排应合并，而非新增");
        assert_eq!(id1, id2, "合并后应复用原 id");

        // 合并后重要度累加（上限 10）、文本取更长者
        let all = db.get_facts_by_type("preference", 10).unwrap();
        assert_eq!(all.len(), 1, "同义事实应只保留 1 条");
        assert_eq!(all[0].importance, 10, "重要度 8+7 累加后钳制到上限 10");
        assert!(all[0].fact.len() >= "用户喜欢简洁回答".len());

        // 语义相反（含不同字符）→ 不应误合并，新增
        let (new3, _) = db.save_fact(&test_fact("f3", "用户喜欢详细回答", "preference", 6)).unwrap();
        assert!(new3, "不同偏好不应误合并");
        // 完全不同的偏好 → 新增
        let (new4, _) = db.save_fact(&test_fact("f4", "用户是后端工程师", "preference", 6)).unwrap();
        assert!(new4);
        assert_eq!(db.get_facts_by_type("preference", 10).unwrap().len(), 3);
        cleanup(&dir);
    }

    #[test]
    fn update_fact_rebuilds_fts() {
        let (dir, db) = tmp_db();
        db.save_fact(&test_fact("f1", "用户喜欢简洁回答", "preference", 8)).unwrap();
        // 编辑：改文本/类型/重要度
        db.update_fact("f1", "用户喜欢极简的回答风格", "preference", 9).unwrap();

        let all = db.list_facts("preference", 10).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].fact, "用户喜欢极简的回答风格");
        assert_eq!(all[0].importance, 9);

        // FTS 索引应已重建：新词"极简"能检索到
        let r = db.search_facts("极简", 5).unwrap();
        assert!(r.iter().any(|f| f.id == "f1"), "编辑后新词应可检索: {:?}", r.iter().map(|f| &f.fact).collect::<Vec<_>>());
        cleanup(&dir);
    }

    #[test]
    fn list_facts_sorts_and_filters() {
        let (dir, db) = tmp_db();
        db.save_fact(&test_fact("f1", "用户喜欢番茄炒蛋", "preference", 9)).unwrap();
        db.save_fact(&test_fact("f2", "项目用 React", "info", 4)).unwrap();
        db.save_fact(&test_fact("f3", "决策采用微服务", "decision", 7)).unwrap();

        // 全部：按重要度降序（preference 9 最前）
        let all = db.list_facts("", 10).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].id, "f1", "重要度最高应排最前");

        // 按类型过滤
        let prefs = db.list_facts("preference", 10).unwrap();
        assert_eq!(prefs.len(), 1);
        assert_eq!(prefs[0].fact, "用户喜欢番茄炒蛋");
        let info = db.list_facts("info", 10).unwrap();
        assert_eq!(info.len(), 1);
        assert_eq!(info[0].id, "f2");
        cleanup(&dir);
    }

    #[test]
    fn maintain_facts_decays_and_prunes() {
        let (dir, db) = tmp_db();
        // 旧记忆：preference 受保护不删
        db.save_fact(&test_fact("p1", "用户喜欢番茄炒蛋", "preference", 9)).unwrap();
        // 旧低价值 info：应被遗忘
        db.save_fact(&test_fact("i1", "三年前的临时笔记", "info", 1)).unwrap();
        // 近期访问的重要 info：应保留
        db.save_fact(&test_fact("i2", "最近讨论的项目决定", "info", 7)).unwrap();
        // 让 i1 变成"60 天前未访问"：直接更新 last_accessed 为旧时间
        {
            let conn = db.conn.lock().unwrap();
            let old = 1_500_000_000_000i64; // 约 2023 年
            conn.execute("UPDATE memory_facts SET last_accessed=?1 WHERE id IN ('i1')", params![old]).unwrap();
        }
        db.maintain_facts().unwrap();

        let all = db.get_facts_by_type("info", 10).unwrap();
        assert!(!all.iter().any(|f| f.id == "i1"), "低价值冷记忆应被遗忘");
        assert!(all.iter().any(|f| f.id == "i2"), "近期重要记忆应保留");
        let prefs = db.get_facts_by_type("preference", 10).unwrap();
        assert!(prefs.iter().any(|f| f.id == "p1"), "preference 应受保护");
        cleanup(&dir);
    }

    // --- 记忆分层 1.4：episodic 聚合层（跨会话主题汇总） ---

    #[test]
    fn episodic_save_list_covered_delete() {
        let (dir, db) = tmp_db();
        // 保存两条跨会话主题（来源摘要 id 为 JSON 数组字符串）
        db.save_episodic("e1", "道生一项目", "持续开发道生一 AI 客户端，近期完成知识库语义向量与工作流编辑器", r#"["s1","s2","s3"]"#).unwrap();
        db.save_episodic("e2", "健身计划", "用户计划每周跑步三次", r#"["s4"]"#).unwrap();

        // 列表：按 updated_at 倒序，e2 后写应在最前（同毫秒时顺序不保证，改查数量与字段）
        let list = db.list_episodic(10).unwrap();
        assert_eq!(list.len(), 2);
        let e1 = list.iter().find(|e| e.id == "e1").unwrap();
        assert_eq!(e1.title, "道生一项目");
        assert!(e1.summary.contains("知识库语义向量"));
        assert_eq!(e1.source_summary_ids, r#"["s1","s2","s3"]"#);

        // covered：收集所有来源摘要 id（跨多条）
        let covered = db.episodic_covered().unwrap();
        assert_eq!(covered.len(), 4);
        assert!(covered.contains(&"s3".to_string()));
        assert!(covered.contains(&"s4".to_string()));

        // upsert：同 id 更新不新增
        db.save_episodic("e2", "健身计划", "用户每周跑步三次，并开始练瑜伽", r#"["s4","s5"]"#).unwrap();
        assert_eq!(db.list_episodic(10).unwrap().len(), 2);
        let covered2 = db.episodic_covered().unwrap();
        assert_eq!(covered2.len(), 5, "upsert 后来源合并为 5 个: {:?}", covered2);

        // 删除：列表与 covered 同步减少
        db.delete_episodic("e1").unwrap();
        assert_eq!(db.list_episodic(10).unwrap().len(), 1);
        assert!(!db.episodic_covered().unwrap().contains(&"s1".to_string()), "删除后来源摘要不再被覆盖");
        cleanup(&dir);
    }

    // --- 会话内撤销：文件写/删操作快照与回滚 ---

    #[test]
    fn undo_edit_restores_original_content() {
        let (dir, db) = tmp_db();
        let file = dir.join("undo.txt");
        std::fs::write(&file, "版本一\n").unwrap();
        let path = file.to_str().unwrap().to_string();

        // 模拟编辑：写盘前记录 undo（backup=原内容），再写入新内容
        db.record_undo("edit", &path, "版本一\n", true).unwrap();
        std::fs::write(&file, "版本二（被 agent 改写）\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "版本二（被 agent 改写）\n");

        // 撤销 → 恢复原内容
        let msg = db.undo_by_id(db.list_undo(10).unwrap()[0].id).unwrap();
        assert!(msg.contains("编辑"), "摘要含操作类型: {}", msg);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "版本一\n", "撤销后应恢复原内容");
        assert!(db.list_undo(10).unwrap().is_empty(), "撤销后记录应删除");
        cleanup(&dir);
    }

    #[test]
    fn undo_create_deletes_new_file() {
        let (dir, db) = tmp_db();
        let file = dir.join("new.txt");
        let path = file.to_str().unwrap().to_string();
        assert!(!file.exists());

        // 模拟新建：操作前不存在 → record create
        db.record_undo("create", &path, "", false).unwrap();
        std::fs::write(&file, "新建内容").unwrap();
        assert!(file.exists());

        // 撤销新建 → 删除文件（回到操作前不存在）
        db.undo_by_id(db.list_undo(10).unwrap()[0].id).unwrap();
        assert!(!file.exists(), "撤销新建后文件应删除");
        cleanup(&dir);
    }

    #[test]
    fn undo_delete_restores_file() {
        let (dir, db) = tmp_db();
        let file = dir.join("del.txt");
        std::fs::write(&file, "要删除的内容").unwrap();
        let path = file.to_str().unwrap().to_string();

        // 模拟删除：删除前记录 undo（backup=原内容），再删除
        db.record_undo("delete", &path, "要删除的内容", true).unwrap();
        std::fs::remove_file(&file).unwrap();
        assert!(!file.exists());

        // 撤销删除 → 恢复文件与内容
        db.undo_by_id(db.list_undo(10).unwrap()[0].id).unwrap();
        assert!(file.exists(), "撤销删除后文件应恢复");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "要删除的内容");
        cleanup(&dir);
    }

    #[test]
    fn undo_unknown_id_errors() {
        let (dir, db) = tmp_db();
        assert!(db.undo_by_id(9999).is_err(), "不存在的 undo id 应报错");
        cleanup(&dir);
    }

    // --- 项目语义索引：code_chunks 存取 + 余弦召回 ---

    #[test]
    fn code_index_search_recalls_relevant_chunk() {
        let (dir, db) = tmp_db();
        db.code_add_chunk("/proj", "auth.rs", "fn login(user, pwd) { verify password }", 0, Some(&[0.9, 0.1, 0.2])).unwrap();
        db.code_add_chunk("/proj", "ui.rs", "fn renderButton() { draw }", 0, Some(&[0.1, 0.9, 0.1])).unwrap();
        db.code_add_chunk("/other", "x.rs", "fn login(user) {}", 0, Some(&[0.9, 0.1, 0.2])).unwrap();

        // 查询向量偏「登录/鉴权」→ 命中 auth.rs 的 login 分块
        let hits = db.code_search("/proj", &[0.9, 0.1, 0.2], 5).unwrap();
        assert!(hits.len() >= 1 && hits[0].file == "auth.rs", "余弦最相似分块应在前: {:?}", hits.iter().map(|h| &h.file).collect::<Vec<_>>());

        // 跨项目隔离：other 查不到 proj 内容
        assert!(db.code_search("/other", &[0.1, 0.9, 0.1], 5).unwrap().iter().all(|h| h.file == "x.rs"), "跨项目隔离");

        // roots 列出已索引项目
        let roots = db.code_roots().unwrap();
        assert!(roots.contains(&"/proj".to_string()) && roots.contains(&"/other".to_string()));

        // stats
        let (files, chunks) = db.code_stats("/proj").unwrap();
        assert_eq!(files, 2);
        assert_eq!(chunks, 2);

        // 清空
        db.code_clear("/proj").unwrap();
        assert!(db.code_search("/proj", &[0.9, 0.1, 0.2], 5).unwrap().is_empty(), "清空后检索为空");
        cleanup(&dir);
    }
}
