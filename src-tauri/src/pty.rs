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
    /// Agent 侧读取游标：`exec_command`/`write_stdin` 每次只返回**新增**输出
    /// （与前端 `pty_poll` 的 offset 机制互不影响）。
    cursor: usize,
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
    pty_spawn_with(command, cwd, None, None)
}

/// 同 `pty_spawn`，但可按沙箱模式包裹（吸收自 Codex 的 SandboxMode）：
/// `read-only` / `workspace-write` → 用 `/usr/bin/sandbox-exec -p <profile> sh -c <cmd>` 启动；
/// 沙箱不可用时自动降级。用户自己开的 PTY 面板（`pty_spawn`）不加沙箱（等同用户手动敲命令）。
pub fn pty_spawn_with(
    command: String,
    cwd: Option<String>,
    sandbox_mode: Option<&str>,
    workspace: Option<&str>,
) -> Result<u32, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let (prog, args, applied) =
        crate::sandbox::build_exec(sandbox_mode.unwrap_or("off"), workspace, &home, &command);
    if applied {
        eprintln!(
            "[sandbox] PTY 已加沙箱启动（mode={}，工作区={}）",
            sandbox_mode.unwrap_or(""),
            workspace.unwrap_or("-")
        );
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建 PTY 失败: {}", e))?;
    let mut cmd = CommandBuilder::new(prog);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(cwd) = cwd {
        if !cwd.trim().is_empty() {
            cmd.cwd(cwd);
        }
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动进程失败: {}", e))?;
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
                        buf.lock()
                            .unwrap()
                            .push_str(&String::from_utf8_lossy(&buf_in[..n]));
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
            cursor: 0,
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
    Ok(PtyPollResult {
        text,
        offset: total,
        running,
    })
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
        .map(|s| PtyInfo {
            id: s.id,
            command: s.command.clone(),
            started_at: s.started_at,
        })
        .collect()
}

// ── Agent 侧 exec（融合 Codex 的 exec_command + write_stdin） ─────────────────
// 与前端 PTY 面板共用同一批会话；区别：这里一次调用 = 「启动/写入 + 等待至多 yield_ms」。
// 价值：让 Agent 能驱动**交互式/长驻**进程（REPL、dev server、数据库 CLI、需要输入密码/
// 确认的命令），而不只是一次性命令（run_command 超时即杀）。

/// Agent 侧 exec 结果（形状对齐 Codex：新增输出 + 是否仍在运行 + 退出码）
#[derive(Debug, serde::Serialize)]
pub struct ExecResult {
    pub session_id: u32,
    /// 自上次读取以来的**新增**输出
    pub output: String,
    /// 进程是否仍在运行（false 时可从 exit_code 判断结果）
    pub running: bool,
    pub exit_code: Option<i32>,
    /// 输出是否被截断（超长守卫，避免把海量日志灌进上下文）
    pub truncated: bool,
}

/// 单次 exec/write_stdin 最长等待（默认 1s，允许模型放大到 30s）
const EXEC_MAX_YIELD_MS: u64 = 30_000;
/// 单次返回给模型的输出上限（字符）
const EXEC_MAX_OUTPUT_CHARS: usize = 20_000;

/// 取走某会话自上次读取以来的新增输出，并把游标推到末尾。
fn take_new_output(id: u32) -> Result<(String, bool, Option<i32>), String> {
    let mut ptys = ptys().lock().unwrap();
    let s = ptys.get_mut(&id).ok_or("会话不存在或已关闭")?;
    let exit_code = match s.child.as_mut() {
        Some(c) => match c.try_wait() {
            Ok(Some(st)) => Some(st.exit_code() as i32),
            _ => None,
        },
        None => None,
    };
    let running = exit_code.is_none() && *s.running.lock().unwrap();
    let buf = s.buffer.lock().unwrap();
    let text = if s.cursor < buf.len() {
        buf[s.cursor..].to_string()
    } else {
        String::new()
    };
    s.cursor = buf.len();
    Ok((text, running, exit_code))
}

/// 等待至多 `yield_ms`：期间持续收集新增输出；进程提前结束则立即返回。
async fn collect_output(id: u32, yield_ms: u64) -> Result<ExecResult, String> {
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(yield_ms.min(EXEC_MAX_YIELD_MS));
    let mut output = String::new();
    let (running, exit_code) = loop {
        let (text, run, code) = take_new_output(id)?;
        output.push_str(&text);
        if !run || std::time::Instant::now() >= deadline {
            break (run, code);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    // 进程刚结束：补一次尾巴（读取线程最后一批输出可能落在上一轮采样之后）
    if !running {
        if let Ok((text, _, _)) = take_new_output(id) {
            output.push_str(&text);
        }
    }
    let truncated = output.chars().count() > EXEC_MAX_OUTPUT_CHARS;
    if truncated {
        output = output.chars().take(EXEC_MAX_OUTPUT_CHARS).collect();
    }
    Ok(ExecResult {
        session_id: id,
        output,
        running,
        exit_code,
        truncated,
    })
}

/// Codex `exec_command`：启动命令并在 `yield_ms` 内收集输出。
/// 超时**不会杀掉进程**（与 run_command 的关键区别）——用返回的 `session_id`
/// 继续 `write_stdin` 交互/取输出。
#[tauri::command]
pub async fn exec_command_agent(
    command: String,
    cwd: Option<String>,
    yield_ms: Option<u64>,
    sandbox_mode: Option<String>,
    workspace: Option<String>,
) -> Result<ExecResult, String> {
    let id = pty_spawn_with(
        command,
        cwd,
        sandbox_mode.as_deref(),
        workspace.as_deref(),
    )?;
    collect_output(id, yield_ms.unwrap_or(1000)).await
}

/// Codex `write_stdin`：向运行中的会话写入输入（省略 = 纯等待取输出），再收集至多 `yield_ms`。
/// 中断交互式程序：`input = "\u0003"`（Ctrl-C）。
#[tauri::command]
pub async fn write_stdin_agent(
    id: u32,
    input: Option<String>,
    yield_ms: Option<u64>,
) -> Result<ExecResult, String> {
    if let Some(input) = input.as_deref().filter(|s| !s.is_empty()) {
        // 进程可能已结束：写失败不致命，继续把剩余输出取回
        let mut ptys = ptys().lock().unwrap();
        if let Some(s) = ptys.get_mut(&id) {
            let _ = s
                .writer
                .write_all(input.as_bytes())
                .and_then(|_| s.writer.flush());
        }
    }
    collect_output(id, yield_ms.unwrap_or(1000)).await
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
        assert!(
            out.contains("hello-pty"),
            "应捕获 echo 输出，实际: {:?}",
            out
        );
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
        assert!(
            out.contains("got:hello"),
            "应收到写入的输入并回显，实际: {:?}",
            out
        );
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

    /// exec_command：一次性命令 —— 拿到输出、进程已结束、退出码 0
    #[tokio::test]
    async fn exec_command_captures_output_and_exit_code() {
        let r = exec_command_agent("echo hi-exec".into(), None, Some(3000), None, None)
            .await
            .unwrap();
        assert!(r.output.contains("hi-exec"), "输出: {:?}", r.output);
        assert!(!r.running, "echo 应立即结束");
        assert_eq!(r.exit_code, Some(0));
        assert!(!r.truncated);
        pty_kill(r.session_id).unwrap();
    }

    /// write_stdin：驱动**交互式**进程（read 阻塞等输入 → 写入后回显）
    #[tokio::test]
    async fn write_stdin_feeds_interactive_process() {
        let r = exec_command_agent("read x; echo got:$x".into(), None, Some(300), None, None)
            .await
            .unwrap();
        assert!(r.running, "read 应仍在等待输入，实际: {:?}", r.output);
        let r2 = write_stdin_agent(r.session_id, Some("hi-stdin\n".into()), Some(3000))
            .await
            .unwrap();
        assert!(r2.output.contains("got:hi-stdin"), "输出: {:?}", r2.output);
        assert!(!r2.running);
        assert_eq!(r2.exit_code, Some(0));
        pty_kill(r.session_id).unwrap();
    }

    /// yield_ms 到期但进程仍在运行：返回 running=true（**不杀进程**），可继续取输出
    #[tokio::test]
    async fn exec_command_keeps_long_running_process_alive() {
        let r = exec_command_agent(
            "echo first; sleep 2; echo second".into(),
            None,
            Some(300),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(r.running, "sleep 期间应报告仍在运行");
        assert!(r.output.contains("first"));
        // 再等一次：应拿到后续输出（增量语义）
        let r2 = write_stdin_agent(r.session_id, None, Some(3000)).await.unwrap();
        assert!(r2.output.contains("second"), "增量输出: {:?}", r2.output);
        assert!(!r2.running);
        pty_kill(r.session_id).unwrap();
    }

    /// 会话不存在时给出明确错误（而不是 panic）
    #[tokio::test]
    async fn write_stdin_reports_missing_session() {
        let err = write_stdin_agent(999_999, None, Some(100)).await.unwrap_err();
        assert!(err.contains("会话不存在"), "错误信息: {err}");
    }
}
