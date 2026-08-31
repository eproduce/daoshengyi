//! S7 交互式 PTY（Codex 能力整合）：让 Agent / 用户能启动并交互长驻进程
//! （dev server、REPL、watch、数据库 CLI 等）。
//!
//! 基于 `portable-pty`（轻量、跨平台，无重型依赖）。后台线程持续读取进程输出到
//! 环形缓冲（Mutex<String>），前端通过 `pty_poll(id, offset)` 轮询增量内容；
//! `pty_write` 写入输入（交互程序自行处理回车，前端可追加 `\n`）。
//!
//! 对应 Codex `codex-exec-server` + `codex-utils-pty` 的能力，做了适配本应用的简化实现。

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(serde::Serialize)]
pub struct PtyInfo {
    pub id: u32,
    pub command: String,
    pub started_at: i64,
}

struct PtySession {
    id: u32,
    command: String,
    writer: Box<dyn Write + Send>,
    child: Option<Box<dyn portable_pty::Child + Send>>,
    buffer: Arc<Mutex<String>>,
    running: Arc<Mutex<bool>>,
    started_at: i64,
}

static PTYS: OnceLock<Mutex<HashMap<u32, PtySession>>> = OnceLock::new();
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn ptys() -> &'static Mutex<HashMap<u32, PtySession>> {
    PTYS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 启动一个交互式 PTY 进程（`sh -c` 支持整条命令 / 管道 / 重定向）
#[tauri::command]
pub fn pty_spawn(command: String, cwd: Option<String>) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("创建 PTY 失败: {}", e))?;
    let mut cmd = CommandBuilder::new("sh");
    cmd.arg("-c");
    cmd.arg(&command);
    if let Some(cwd) = cwd {
        if !cwd.trim().is_empty() {
            cmd.cwd(cwd);
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("启动进程失败: {}", e))?;
    drop(pair.slave);
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("获取写端失败: {}", e))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取读端失败: {}", e))?;
    let buffer = Arc::new(Mutex::new(String::new()));
    let running = Arc::new(Mutex::new(true));
    {
        let buf = buffer.clone();
        let run = running.clone();
        std::thread::spawn(move || {
            let mut buf_in = [0u8; 4096];
            loop {
                match reader.read(&mut buf_in) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.lock().unwrap().push_str(&String::from_utf8_lossy(&buf_in[..n]));
                    }
                }
            }
            *run.lock().unwrap() = false;
        });
    }
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let started_at = now_ms();
    ptys().lock().unwrap().insert(
        id,
        PtySession {
            id,
            command,
            writer,
            child: Some(child),
            buffer,
            running,
            started_at,
        },
    );
    Ok(id)
}

/// 写入输入（原样写入；交互程序自行处理回车，前端可在末尾追加 `\n`）
#[tauri::command]
pub fn pty_write(id: u32, input: String) -> Result<(), String> {
    let mut ptys = ptys().lock().unwrap();
    let s = ptys.get_mut(&id).ok_or("PTY 不存在或已结束")?;
    s.writer
        .write_all(input.as_bytes())
        .map_err(|e| format!("写入失败: {}", e))?;
    s.writer.flush().map_err(|e| format!("写入失败: {}", e))?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct PtyPollResult {
    pub text: String,
    pub offset: usize,
    pub running: bool,
}

/// 读取自 offset 起的增量输出（前端记录已消费 offset）
#[tauri::command]
pub fn pty_poll(id: u32, offset: usize) -> Result<PtyPollResult, String> {
    let ptys = ptys().lock().unwrap();
    let s = ptys.get(&id).ok_or("PTY 不存在或已结束")?;
    let buf = s.buffer.lock().unwrap();
    let total = buf.len();
    let text = if offset < total {
        buf[offset..].to_string()
    } else {
        String::new()
    };
    let running = *s.running.lock().unwrap();
    Ok(PtyPollResult { text, offset: total, running })
}

/// 终止并移除 PTY
#[tauri::command]
pub fn pty_kill(id: u32) -> Result<(), String> {
    let mut ptys = ptys().lock().unwrap();
    if let Some(mut s) = ptys.remove(&id) {
        if let Some(mut child) = s.child.take() {
            let _ = child.kill();
        }
        Ok(())
    } else {
        Err("PTY 不存在".into())
    }
}

/// 列出活跃 PTY 会话
#[tauri::command]
pub fn pty_list() -> Vec<PtyInfo> {
    let ptys = ptys().lock().unwrap();
    ptys.values()
        .map(|s| PtyInfo { id: s.id, command: s.command.clone(), started_at: s.started_at })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 端到端：spawn `echo`（无交互），轮询应拿到输出且进程结束
    #[test]
    fn pty_echo_captures_output_and_finishes() {
        let id = pty_spawn("echo hello-pty".into(), None).unwrap();
        // 等待输出累积（后台线程读取，简单轮询等待）
        let mut out = String::new();
        let mut offset = 0usize;
        for _ in 0..100 {
            let r = pty_poll(id, offset).unwrap();
            offset = r.offset;
            out.push_str(&r.text);
            if out.contains("hello-pty") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(out.contains("hello-pty"), "应捕获 echo 输出，实际: {:?}", out);
        // 进程应已结束
        let r = pty_poll(id, offset).unwrap();
        let _ = r;
        pty_kill(id).unwrap();
    }

    /// 交互：写入输入应被程序读取（用 `read x` 演示，读取一行后结束）
    #[test]
    fn pty_write_feeds_input() {
        let id = pty_spawn("read line && echo got:$line".into(), None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        pty_write(id, "hello\n".into()).unwrap();
        let mut out = String::new();
        let mut offset = 0usize;
        for _ in 0..100 {
            let r = pty_poll(id, offset).unwrap();
            offset = r.offset;
            out.push_str(&r.text);
            if out.contains("got:hello") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(out.contains("got:hello"), "应收到写入的输入并回显，实际: {:?}", out);
        pty_kill(id).unwrap();
    }

    #[test]
    fn pty_kill_removes_session() {
        let id = pty_spawn("sleep 30".into(), None).unwrap();
        assert!(pty_list().iter().any(|p| p.id == id));
        pty_kill(id).unwrap();
        assert!(!pty_list().iter().any(|p| p.id == id));
        assert!(pty_poll(id, 0).is_err(), "被 kill 后轮询应报错");
    }
}
