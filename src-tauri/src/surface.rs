//! 展示层出口（surface）：把「展示意图」真正送出去。
//!
//! 分工（见 `docs/DESKTOP_AMBIENT_UI.md` §4）：
//!
//! - **决策在前端**（`src/utils/display-ir.ts`）：纯函数、可单测、能解释。它知道
//!   `kind`/`priority`/`life` 和用户设置，也知道主窗口是否在前台。
//! - **执行在 Rust**（本模块）：① HUD 上屏（事件推给独立的 HUD webview）；
//!   ② 语音播报（macOS `say`）。
//!
//! 执行端有两件**只有这里能做的事**：
//!
//! 1. **走统一命令管线**：`say` 是外部命令，必须经 `run_wrapped_argv`（沙箱 + 代理 + 超时 + 审计）。
//!    本项目踩过「新增能执行外部命令的工具却没走管线」的坑，这条纪律不能破。
//! 2. **兜底校验**：前端可能被绕过（或将来有别的调用方），所以长度/空文本/静默在这里再判一次。
//!
//! **一条路径原则**：`DAOSHENGYI_HUD_DEMO=1` 的演示、以及 `present` 工具，都走同一个
//! [`execute`] —— 否则「验过的」就不是「会跑的那份」。

use serde::Deserialize;
use tauri::Manager;

/// 语音文本上限。前端已截断，这里是最后一道门 —— `say` 念 200 字要 40 秒以上，
/// 一个失控的长文本会把语音队列堵住。
pub const MAX_SPEECH_CHARS: usize = 200;
/// `say` 超时：正常一句话几秒；卡住时不该拖住整轮对话
const SAY_TIMEOUT_SECS: u64 = 30;
/// 演示开关：推一份固定的展示 IR，用来**不调模型**地验完整条呈现链路，验收/回归时用
pub const ENV_DEMO: &str = "DAOSHENGYI_HUD_DEMO";

/// 前端的呈现决策结果（`planSurfaces` 的产物）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePlan {
    /// 实际要执行的出口（hud / speech / session / page）
    #[serde(default)]
    pub surfaces: Vec<String>,
    #[serde(default)]
    pub speech_text: String,
    /// 人话解释，原样回给模型 —— 便于回答「为什么没弹出来 / 为什么没出声」
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePayload {
    /// 结构化展示意图。Rust **不做业务解释**，原样转给 HUD 渲染
    /// （解释交给有渲染器的那一端，避免两端各维护一套语义）
    pub ir: serde_json::Value,
    pub plan: SurfacePlan,
}

/// 执行许可（由设置与静默开关推导出来；演示路径也用它，只是直接给 true）
#[derive(Debug, Clone, Default)]
pub struct ExecuteOptions {
    pub allow_hud: bool,
    pub allow_speech: bool,
    /// 语音音色（`say -v` 的名字；空 = 系统默认）
    pub voice: Option<String>,
    /// 静默模式：只钉回会话（会写进总结，便于解释「为什么什么都没发生」）
    pub silent: bool,
}

impl SurfacePlan {
    /// 计划里是否包含某个出口
    pub fn wants(&self, surface: &str) -> bool {
        self.surfaces.iter().any(|s| s == surface)
    }
}

/// 清洗要念的文本：**念不出来就不念**（返回 None），别念一句噪音。
///
/// 换行/制表这类「空白类控制符」变成空格（直接删掉会把词粘成「一二」），
/// 其余控制符（响铃等）丢弃 —— 它们可能把 `say` 的参数解析搞乱。
pub fn sanitize_speech(text: &str) -> Option<String> {
    let cleaned: String = text
        .chars()
        .filter_map(|c| {
            if c == '\n' || c == '\r' || c == '\t' {
                Some(' ')
            } else if c.is_control() {
                None
            } else {
                Some(c)
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.chars().any(|c| c.is_alphanumeric()) {
        return None;
    }
    Some(trimmed.chars().take(MAX_SPEECH_CHARS).collect())
}

/// 组装 `say` 的参数。
///
/// **必须带 `--`**：正文以 `-` 开头时（如 `-1 个任务待办`）否则会被当成选项，
/// 轻则报错、重则改变念的方式（实测 `say -- "-1 个任务待办"` 正常，本机验证过）。
/// argv 形式本身已经隔绝了 shell 注入，`--` 补上的是「参数被误当作选项」这一类问题。
pub fn say_argv(text: &str, voice: Option<&str>, rate: Option<u32>) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    if let Some(v) = voice.map(str::trim).filter(|v| !v.is_empty()) {
        argv.push("-v".into());
        argv.push(v.to_string());
    }
    if let Some(r) = rate.filter(|r| *r > 0) {
        argv.push("-r".into());
        argv.push(r.to_string());
    }
    argv.push("--".into());
    argv.push(text.to_string());
    argv
}

/// 人话总结（工具结果）。要让模型与用户都能看出「出去了几条、为什么」，
/// 而不是只回一个「已呈现」——那样出问题时无从判断。
pub fn summarize(plan: &SurfacePlan, spoke: Option<&str>, hud: bool, notes: &[String]) -> String {
    let mut lines: Vec<String> = Vec::new();
    if hud {
        lines.push("HUD 浮层：已显示".into());
    } else if plan.wants("hud") {
        lines.push("HUD 浮层：未显示".into());
    }
    match spoke {
        Some(t) => lines.push(format!("语音播报：已念「{t}」")),
        None if plan.wants("speech") => lines.push("语音播报：未出声".into()),
        None => {}
    }
    if plan.wants("page") {
        lines.push("产物页：完整内容应走 answer_html（本工具不产生页面）".into());
    }
    lines.push("会话留痕：已记录（浮层可以阅后即焚，留痕不能丢）".into());
    if !plan.reasons.is_empty() {
        lines.push(format!("决策：{}", plan.reasons.join("；")));
    }
    if !notes.is_empty() {
        lines.push(format!("提示：{}", notes.join("；")));
    }
    lines.join("\n")
}

/// 真正把内容送出去：HUD 上屏 + 语音播报。返回人话总结。
///
/// 调用方（`present` 工具 / 演示）只负责给出「IR + 计划 + 许可」，
/// 出口的实际动作都在这里，避免出现两套实现。
pub async fn execute(
    app: &tauri::AppHandle,
    ir: &serde_json::Value,
    plan: &SurfacePlan,
    opts: ExecuteOptions,
) -> String {
    let wants_hud = opts.allow_hud && plan.wants("hud");
    let wants_speech = opts.allow_speech && plan.wants("speech");

    let mut notes: Vec<String> = Vec::new();
    if opts.silent {
        notes.push("静默模式已开启：只钉回会话".into());
    }

    let mut hud_ok = false;
    if wants_hud {
        match crate::hud::present(app, ir) {
            Ok(()) => hud_ok = true,
            Err(e) => notes.push(format!("HUD 未显示：{e}")),
        }
    }

    let mut spoke: Option<String> = None;
    if wants_speech {
        match sanitize_speech(&plan.speech_text) {
            None => notes.push("语音文本为空或不可读，跳过播报".into()),
            Some(text) => {
                let argv = say_argv(&text, opts.voice.as_deref(), None);
                let db = app.state::<crate::db::Database>();
                let cwd = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                match crate::run_wrapped_argv(
                    &db,
                    &cwd,
                    "say",
                    argv,
                    SAY_TIMEOUT_SECS,
                    "surface_speech",
                )
                .await
                {
                    Ok(out) if out.exit_code == 0 => spoke = Some(text),
                    Ok(out) => notes.push(format!(
                        "say 退出码 {}（{}）",
                        out.exit_code,
                        out.stderr.trim()
                    )),
                    Err(e) => notes.push(format!("say 执行失败：{e}")),
                }
            }
        }
    }

    summarize(plan, spoke.as_deref(), hud_ok, &notes)
}

/// 展示出口命令。前端把「IR + 呈现决策」一起交过来，这里只负责门禁 + 执行。
#[tauri::command]
pub async fn surface_present(
    app: tauri::AppHandle,
    payload: SurfacePayload,
) -> Result<String, String> {
    // 静默/开关在这里再判一次：前端可能被绕过，而「静默」是用户明确表达过的意愿
    let settings = crate::load_app_settings(app.state(), app.state())
        .map_err(|e| format!("读取设置失败：{e}"))?;
    let opts = ExecuteOptions {
        allow_hud: !settings.surface_silent && settings.surface_hud,
        allow_speech: !settings.surface_silent && settings.surface_speech,
        voice: Some(settings.surface_speech_voice).filter(|v| !v.is_empty()),
        silent: settings.surface_silent,
    };
    Ok(execute(&app, &payload.ir, &payload.plan, opts).await)
}

// ── 演示 / 验收 ──────────────────────────────────────────────────────────────

/// 演示用展示意图。刻意选 chart：它能同时跑通「标题 + 多行 + 进度条」三段渲染，
/// 并且**故意塞一个非法项**（字符串）来验证「坏数据被忽略而不是整条失败」。
pub fn demo_ir() -> serde_json::Value {
    serde_json::json!({
        "kind": "chart",
        "title": "本周提交分布",
        "priority": "primary",
        "life": "sticky",
        "speech": demo_speech(),
        "body": {
            "chartType": "bar",
            "series": [
                { "label": "周一", "value": 3 },
                { "label": "周二", "value": 5 },
                { "label": "周三", "value": 8 },
                "不合法项，应被忽略",
                { "label": "周四", "value": 4 },
                { "label": "周五", "value": 3 }
            ]
        }
    })
}

/// 演示要念的那一句
pub fn demo_speech() -> String {
    "本周共提交 23 次，周三最多".to_string()
}

/// 演示启动钩子（`setup` 里调用）：`DAOSHENGYI_HUD_DEMO=1` 时推一份固定内容。
///
/// 为什么需要它：不调模型就能验「Rust → HUD 事件 → 前端解析 → 渲染 → 语音」整条链路。
/// 走的是与 `present` 工具**同一个** [`execute`]，只是许可直接给 true（不受设置影响）。
pub fn demo_on_startup(app: &tauri::AppHandle) {
    if !crate::hud::env_flag(ENV_DEMO) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ir = demo_ir();
        let plan = SurfacePlan {
            surfaces: vec!["session".into(), "hud".into(), "speech".into()],
            speech_text: demo_speech(),
            reasons: vec![format!(
                "演示模式（{ENV_DEMO}=1）：不调模型，验证整条呈现链路"
            )],
        };
        let opts = ExecuteOptions {
            allow_hud: true,
            allow_speech: true,
            voice: None,
            silent: false,
        };
        let summary = execute(&app, &ir, &plan, opts).await;
        eprintln!("[surface] 演示结果:\n{summary}");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(surfaces: &[&str], speech: &str) -> SurfacePlan {
        SurfacePlan {
            surfaces: surfaces.iter().map(|s| s.to_string()).collect(),
            speech_text: speech.to_string(),
            reasons: vec!["测试".into()],
        }
    }

    #[test]
    fn sanitize_speech_rejects_empty_and_pure_symbols() {
        // 宁可不念，也别念一句噪音
        assert_eq!(sanitize_speech(""), None);
        assert_eq!(sanitize_speech("   \n\t "), None);
        assert_eq!(sanitize_speech("---"), None);
        assert_eq!(sanitize_speech("*** ！！！"), None);
        assert_eq!(sanitize_speech("完成").as_deref(), Some("完成"));
    }

    #[test]
    fn sanitize_speech_collapses_whitespace_and_control_chars() {
        assert_eq!(
            sanitize_speech("一\n二\t三  四").as_deref(),
            Some("一 二 三 四")
        );
        // 控制字符（如响铃）不能让 say 念出奇怪的东西
        assert_eq!(sanitize_speech("完成\u{7}了").as_deref(), Some("完成了"));
    }

    #[test]
    fn sanitize_speech_truncates_to_limit() {
        let long = "啊".repeat(MAX_SPEECH_CHARS + 50);
        let out = sanitize_speech(&long).expect("应有输出");
        assert_eq!(out.chars().count(), MAX_SPEECH_CHARS);
    }

    #[test]
    fn say_argv_ends_options_before_text() {
        // 正文以 `-` 开头时必须靠 `--` 保护，否则会被当成选项
        let argv = say_argv("-1 个任务待办", None, None);
        assert_eq!(argv, vec!["--", "-1 个任务待办"]);
    }

    #[test]
    fn say_argv_includes_voice_and_rate_when_given() {
        let argv = say_argv("你好", Some("Tingting"), Some(180));
        assert_eq!(argv, vec!["-v", "Tingting", "-r", "180", "--", "你好"]);
        // 空白音色/0 语速视为「没给」
        let argv = say_argv("你好", Some("  "), Some(0));
        assert_eq!(argv, vec!["--", "你好"]);
    }

    #[test]
    fn plan_wants_matches_known_surfaces() {
        let p = plan(&["session", "hud"], "");
        assert!(p.wants("hud"));
        assert!(!p.wants("speech"));
    }

    #[test]
    fn summarize_tells_the_whole_story() {
        let p = plan(&["session", "hud", "speech"], "完成");
        let text = summarize(&p, Some("完成"), true, &[]);
        assert!(text.contains("HUD 浮层：已显示"));
        assert!(text.contains("已念「完成」"));
        assert!(text.contains("会话留痕"));
        assert!(text.contains("决策："));
    }

    #[test]
    fn summarize_explains_why_nothing_happened() {
        // 计划里有 hud/speech 但实际都没执行 → 必须给出原因，否则用户只会看到「什么都没发生」
        let p = plan(&["session", "hud", "speech"], "完成");
        let text = summarize(&p, None, false, &["静默模式已开启：只钉回会话".into()]);
        assert!(text.contains("HUD 浮层：未显示"));
        assert!(text.contains("语音播报：未出声"));
        assert!(text.contains("静默模式"));
    }

    #[test]
    fn demo_ir_is_a_valid_presentation_intent() {
        // 演示数据是验收的固定输入：字段写错会让「渲染路径没问题」这个结论失效
        let ir = demo_ir();
        assert_eq!(ir["kind"], "chart");
        assert_eq!(ir["priority"], "primary");
        assert!(!ir["title"].as_str().unwrap_or_default().is_empty());
        assert_eq!(ir["speech"], demo_speech());
        let series = ir["body"]["series"].as_array().expect("series 应为数组");
        // 刻意塞了一个非法项：用来验「坏数据被忽略而不是整条失败」
        assert!(series.iter().any(|s| s.is_string()));
        assert!(series.iter().filter(|s| s.is_object()).count() >= 5);
    }

    #[test]
    fn demo_plan_covers_hud_speech_and_session() {
        // 演示若漏了某个出口，「整条链路验过」就是假的
        let plan = plan(&["session", "hud", "speech"], &demo_speech());
        assert!(plan.wants("hud") && plan.wants("speech") && plan.wants("session"));
        assert!(sanitize_speech(&plan.speech_text).is_some());
    }
}
