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
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::{Emitter, Manager};

/// 语音文本上限。前端已截断，这里是最后一道门 —— `say` 念 200 字要 40 秒以上，
/// 一个失控的长文本会把语音队列堵住。
pub const MAX_SPEECH_CHARS: usize = 200;
/// `say` 超时：正常一句话几秒；卡住时不该拖住整轮对话
const SAY_TIMEOUT_SECS: u64 = 30;
/// 演示开关：推一份固定的展示 IR，用来**不调模型**地验完整条呈现链路，验收/回归时用
pub const ENV_DEMO: &str = "DAOSHENGYI_HUD_DEMO";

/// 正在出声的子进程 PID（0 = 没有）。只服务于「一键全停」——
/// 连续对话里用户按热键必须**立刻**静音，不能等它把这句念完。
static SPEECH_PID: AtomicI32 = AtomicI32::new(0);
/// 用户已按停：后续步骤（合成完再播放）不得再开始出声。
static SPEECH_CANCELLED: AtomicBool = AtomicBool::new(false);

/// 协议登记的**全部出口名**（与前端 `SURFACE_CAPABILITIES` 一致，由契约测试钉住）。
///
/// 当前真正执行的只有 `hud` / `speech`（`session` 在前端就完成了留痕）；
/// `notify` / `tray` / `quicklook` / `im` 已登记待收编（见 `docs/PRESENT_PROTOCOL.md` P-A4）。
pub const SURFACE_NAMES: [&str; 8] = [
    "session",
    "hud",
    "speech",
    "page",
    "notify",
    "tray",
    "quicklook",
    "im",
];

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

/// 自定义引擎的超时：本地克隆类 TTS 可能很慢（本机 CPU-only），给足时间
const TTS_TIMEOUT_SECS: u64 = 180;
/// 播放超时：`afplay` 会阻塞到播完，要能盖住一段长文本的朗读时长
const PLAY_TIMEOUT_SECS: u64 = 300;

impl ExecuteOptions {
    /// 由设置推导执行许可。**只有一个推导入口**，避免两处各判一套。
    pub fn from_settings(settings: &crate::settings::AppSettings, voice: Option<String>) -> Self {
        Self {
            allow_hud: !settings.surface_silent && settings.surface_hud,
            allow_speech: !settings.surface_silent && settings.surface_speech,
            voice: voice
                .or_else(|| Some(settings.surface_speech_voice.clone()))
                .filter(|v| !v.trim().is_empty()),
            rate: settings.surface_speech_rate,
            pauses: settings.surface_speech_pause,
            silent: settings.surface_silent,
            tts_command: Some(settings.surface_tts_command.clone())
                .filter(|c| !c.trim().is_empty()),
            tts_reference: Some(settings.surface_tts_reference.clone())
                .filter(|r| !r.trim().is_empty()),
        }
    }
}

/// 执行许可（由设置与静默开关推导出来；演示路径也用它，只是直接给 true）
#[derive(Debug, Clone, Default)]
pub struct ExecuteOptions {
    pub allow_hud: bool,
    pub allow_speech: bool,
    /// 语音音色（`say -v` 的名字；空 = 系统默认）
    pub voice: Option<String>,
    /// 系统音色语速（`say -r`；0 = 系统默认）
    pub rate: u32,
    /// 句末补停顿（只有系统 `say` 认识 `[[slnc]]`；自定义引擎的文本不动）
    pub pauses: bool,
    /// 静默模式：只钉回会话（会写进总结，便于解释「为什么什么都没发生」）
    pub silent: bool,
    /// **自定义音色**：命令模板（空 = 用系统 `say`）。占位符见 `render_tts_command`
    pub tts_command: Option<String>,
    /// 参考音频路径（喂给自定义引擎；很多克隆/零样本 TTS 需要一段参考音）
    pub tts_reference: Option<String>,
}

impl SurfacePlan {
    /// 计划里是否包含某个出口
    pub fn wants(&self, surface: &str) -> bool {
        self.surfaces.iter().any(|s| s == surface)
    }

    /// 计划要求、但**本机尚未收编**的出口（协议已登记，实现待 P-A4）。
    ///
    /// 用途：把「为什么设了通知却没通知」说清楚——否则用户只能看到一片安静。
    pub fn not_yet_implemented(&self) -> Vec<String> {
        const IMPLEMENTED: [&str; 4] = ["session", "hud", "speech", "page"];
        self.surfaces
            .iter()
            .filter(|s| SURFACE_NAMES.contains(&s.as_str()) && !IMPLEMENTED.contains(&s.as_str()))
            .cloned()
            .collect()
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

/// 句末停顿（毫秒）。`say` 在 `。！？` 后只留极短的空隙，长句连着念像机关枪。
/// **只加在句末**：实测 `[[slnc]]` 跟在 `，` 后面会被 `say` 直接忽略（音频时长一模一样）。
const SENTENCE_PAUSE_MS: u32 = 220;

/// 朗读文本的「口语化」清洗。
///
/// 前端 `cleanForSpeech` 已经洗过一遍，但这里是**最后一道门**：模型输出、工具结果、
/// 自定义引擎都可能绕过前端。要解决三类「念出来不像人话」的噪音：
/// 1. markdown / URL / emoji —— `say` 会念出「星号星号」「h-t-t-p-s」；
/// 2. 符号 —— `→` `×` `℃` 会被跳过或念错；
/// 3. 模型夹带的 `[[slnc 60000]]` —— 正文不该能控制语音引擎。
pub fn naturalize_speech(text: &str) -> String {
    let mut s = strip_code_fences(text);
    s = strip_markdown_links(&s);
    s = replace_urls(&s);
    s = strip_inline_commands(&s);

    let mut out = String::with_capacity(s.len());
    let mut prev_pause = false;
    for c in s.chars() {
        match c {
            '*' | '_' | '`' | '#' | '>' | '~' => continue,
            '…' => {
                if !prev_pause {
                    out.push('，');
                    prev_pause = true;
                }
                continue;
            }
            '→' => out.push('到'),
            '←' => out.push('从'),
            '×' => out.push_str("乘以"),
            '÷' => out.push_str("除以"),
            '=' => out.push_str("等于"),
            '&' => out.push('和'),
            '℃' => out.push_str("摄氏度"),
            '°' => out.push('度'),
            '～' => out.push('到'),
            '\u{3000}' => out.push(' '),
            // 换行在中文里是「断句」而不是空格：`鹅，鹅，鹅\n曲项向天歌` 读成空格会在句中硬塞停顿，
            // 读成逗号才是吟诵的节奏。前一字符已有标点就原样保留。
            '\n' | '\r' => {
                if !prev_pause && out.chars().last().is_some_and(is_cjk) {
                    out.push('，');
                    prev_pause = true;
                }
                continue;
            }
            c if is_emoji_char(c) => continue,
            c => out.push(c),
        }
        prev_pause = matches!(c, '，' | '、' | '。' | '；' | '：');
    }

    let cleaned = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = collapse_repeated_single_chars(cleaned.trim());
    let cleaned = drop_cjk_spaces(&cleaned);
    if cleaned.is_empty() {
        return String::new();
    }
    let mut done = cleaned.to_string();
    // 没有句末标点时 `say` 会一路平到底（也不会有收尾的下降语调）
    if done.chars().last().is_some_and(char::is_alphanumeric) {
        done.push('。');
    }
    done
}

/// 句末补停顿（`say` 的内联指令）。**只给系统 `say` 用**——
/// 自定义引擎会把 `[[slnc]]` 当正文念出来。
pub fn add_sentence_pauses(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + chars.len() / 4);
    for (i, c) in chars.iter().enumerate() {
        out.push(*c);
        if i + 1 < chars.len() && matches!(c, '。' | '！' | '？' | '!' | '?') {
            out.push_str("[[slnc ");
            out.push_str(&SENTENCE_PAUSE_MS.to_string());
            out.push_str("]]");
        }
    }
    out
}

/// 纯汉字（不含标点）。
fn is_han(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

/// 「鹅，鹅，鹅」→「鹅鹅鹅」：**同一个字被逗号/顿号隔开重复三次以上**时，逐字念会一顿一顿。
/// 吟诵和口语都是连着念的（实测 7.32s → 6.38s，少掉的正是两处硬停顿）。
/// 只对**单字**重复生效：「猫，狗，鸟」这种并列不动。
fn collapse_repeated_single_chars(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        if is_han(chars[i]) {
            let mut j = i + 1;
            let mut count = 1;
            loop {
                let mut k = j;
                while k < chars.len() && matches!(chars[k], '，' | '、' | ' ') {
                    k += 1;
                }
                if k < chars.len() && k > j && chars[k] == chars[i] {
                    j = k + 1;
                    count += 1;
                } else {
                    break;
                }
            }
            if count >= 3 {
                for _ in 0..count {
                    out.push(chars[i]);
                }
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 汉字或中文标点。用于判断「这里需不需要真正的词间空格」——
/// 中文没有词间空格，模型/markdown 残留的空格在 TTS 里会变成**实打实的停顿**
/// （实测「鹅 鹅 鹅」3.96s vs「鹅鹅鹅」3.05s，多出来的 0.9s 就是三处硬停顿）。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x3000..=0x303F | 0xFF00..=0xFFEF)
}

/// 去掉**两侧都是中文**的空格；中英之间、英文之间、数字之间的空格保留。
fn drop_cjk_spaces(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    for (i, c) in chars.iter().enumerate() {
        if *c == ' ' {
            let prev = chars[..i].iter().rev().find(|x| **x != ' ');
            let next = chars[i + 1..].iter().find(|x| **x != ' ');
            if let (Some(p), Some(n)) = (prev, next) {
                if is_cjk(*p) && is_cjk(*n) {
                    continue;
                }
            }
        }
        out.push(*c);
    }
    out
}

fn strip_code_fences(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("```") {
        out.push_str(&rest[..start]);
        out.push_str("（代码略）");
        let after = &rest[start + 3..];
        match after.find("```") {
            Some(end) => rest = &after[end + 3..],
            None => rest = "",
        }
    }
    out.push_str(rest);
    out
}

fn strip_markdown_links(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open) = rest.find('[') {
        let label_end = rest[open + 1..].find(']').map(|i| open + 1 + i);
        let Some(label_end) = label_end else { break };
        let after = &rest[label_end + 1..];
        let Some(inner) = after.strip_prefix('(') else {
            out.push_str(&rest[..open + 1]);
            rest = &rest[open + 1..];
            continue;
        };
        let Some(paren_end) = inner.find(')') else {
            out.push_str(&rest[..open + 1]);
            rest = &rest[open + 1..];
            continue;
        };
        out.push_str(&rest[..open]);
        let label = &rest[open + 1..label_end];
        // 图片语法 `![alt](url)`：前面那个 `!` 不该念成感叹句
        if out.ends_with('!') {
            out.pop();
        }
        out.push_str(if label.trim().is_empty() {
            "链接"
        } else {
            label
        });
        rest = &inner[paren_end + 1..];
    }
    out.push_str(rest);
    out
}

fn replace_urls(input: &str) -> String {
    const SUFFIXES: [char; 9] = ['，', '。', '；', '！', '？', '、', '）', ')', '》'];
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let lower = rest.to_ascii_lowercase();
        let start = ["http://", "https://", "www."]
            .iter()
            .filter_map(|p| lower.find(p))
            .min();
        let Some(start) = start else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        out.push_str("链接");
        let tail = &rest[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || SUFFIXES.contains(&c))
            .unwrap_or(tail.len());
        rest = &tail[end..];
    }
    out
}

fn strip_inline_commands(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("]]") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => rest = "",
        }
    }
    out.push_str(rest);
    out
}

fn is_emoji_char(c: char) -> bool {
    matches!(
        c as u32,
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0xFE00..=0xFE0F | 0x200D
    )
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
    let pending = plan.not_yet_implemented();
    if !pending.is_empty() {
        notes.push(format!(
            "已登记但尚未收编的出口：{}（协议里有，实现待 P-A4）",
            pending.join("/")
        ));
    }

    let mut hud_ok = false;
    if wants_hud {
        match crate::hud::present(app, ir) {
            Ok(()) => hud_ok = true,
            Err(e) => notes.push(format!("HUD 未显示：{e}")),
        }
    }

    let mut spoke: Option<String> = None;
    let mut speech_notes: Vec<String> = Vec::new();
    if wants_speech {
        // 先口语化再清洗：`sanitize_speech` 会把换行压成空格，而中文换行是**断句**
        // （顺序反了，`鹅，鹅，鹅\n曲项向天歌` 就变成句中硬停顿）
        let prepared = naturalize_speech(&plan.speech_text);
        match sanitize_speech(&prepared) {
            None => notes.push("语音文本为空或不可读，跳过播报".into()),
            Some(text) => match speak(app, &text, &opts).await {
                Ok(sp) => {
                    spoke = Some(sp.text);
                    if let Some(secs) = sp.seconds {
                        speech_notes.push(format!("音频 {secs:.1}s"));
                    }
                    speech_notes.extend(sp.notes);
                }
                Err(e) => notes.push(e),
            },
        }
    }
    notes.extend(speech_notes);

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
    let opts = ExecuteOptions::from_settings(&settings, None);
    Ok(execute(&app, &payload.ir, &payload.plan, opts).await)
}

// ── 音色列表（`say -v ?`）─────────────────────────────────────────────────────
//
// 为什么不自己维护一份音色表：**不同机器装的语音包不一样**（本机 180 个，其中中文 10+ 个），
// 写死必然过时。让系统报给我们，顺带拿到每个音色**自带的示例句** —— 那就是最好的试听素材，
// 也正是设置界面里「示例」的来源。

/// 一个可用音色
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SayVoice {
    /// 音色名（可直接传给 `say -v`；可能含空格/括号/中文，如 `Eddy (中文（中国大陆）)`）
    pub name: String,
    /// 语言区域，如 `zh_CN` / `en_US`
    pub locale: String,
    /// 系统自带的示例句（`say -v ?` 里 `#` 之后那段）
    pub example: String,
    /// **变体/趣味音色**（Apple 的 novelty voice：`Eddy` / `Flo` / `Grandma`…）
    ///
    /// 判定依据：名字里带括号 —— 它们本质是**多语言变体音色**，
    /// 列表里形如 `Eddy (中文（中国大陆）)`，每个语言都有一份。
    /// 念中文时是明显的机器怪声（本机实测：中文组里 16/19 个都是它们）。
    /// 必须在 UI 里与真人音色分开排、并给出提示，否则用户第一个试听见到的就是最怪的。
    #[serde(default)]
    pub variant: bool,
}

/// 名字里带括号 = Apple 的多语言变体/趣味音色
fn is_variant_name(name: &str) -> bool {
    name.contains('(')
}

/// 是否是 `xx_XX` 形式的语言区域
fn is_locale(token: &str) -> bool {
    let parts: Vec<&str> = token.split('_').collect();
    parts.len() == 2
        && parts
            .iter()
            .all(|p| (2..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic()))
}

/// 解析 `say -v ?` 的输出。
///
/// 真实格式（本机实测）：
/// ```text
/// Albert              en_US    # Hello! My name is Albert.
/// Eddy (中文（中国大陆）)     zh_CN    # 你好！我叫Eddy。
/// ```
/// 难点是**音色名里可以有空格、括号、中文**，所以不能简单按空白切两段 ——
/// 而是从右往左找第一个「长得像 locale」的 token，它左边全部是名字。
pub fn parse_say_voices(out: &str) -> Vec<SayVoice> {
    out.lines()
        .filter_map(|line| {
            let (left, example) = match line.split_once('#') {
                Some((l, r)) => (l, r.trim()),
                None => (line, ""),
            };
            let tokens: Vec<&str> = left.split_whitespace().collect();
            let at = tokens.iter().rposition(|t| is_locale(t))?;
            let name = tokens[..at].join(" ");
            if name.is_empty() {
                return None;
            }
            Some(SayVoice {
                variant: is_variant_name(&name),
                name,
                locale: tokens[at].to_string(),
                example: example.to_string(),
            })
        })
        .collect()
}

/// 排序：**真人音色优先，变体/趣味音色排最后**；中文在各自组内靠前。
///
/// 这条规则的来由是一次真机反馈：按「中文优先 + 名字字典序」排，中文组第一个是
/// `Eddy (中文（中国大陆）)`（趣味音色）—— 用户点开设置试听的第一个就是最怪的那个，
/// 于是得到结论「除了 Tingting 其它音色都很奇怪」。**排序也是一种产品决策。**
pub fn sort_voices_for_ui(mut voices: Vec<SayVoice>) -> Vec<SayVoice> {
    fn rank(v: &SayVoice) -> u8 {
        // 1) 变体/趣味音色永远在最后（不管它是哪个语言）
        // 2) 其次是中文（用户多半只想在这几个里挑）
        // 3) 最后才是其余语言
        match (v.variant, v.locale.starts_with("zh")) {
            (true, _) => 3,
            (false, true) => 0,
            (false, false) => 1,
        }
    }
    voices.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.locale.cmp(&b.locale))
            .then_with(|| a.name.cmp(&b.name))
    });
    voices
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| ".".to_string())
}

// ── 自定义音色（命令模板）────────────────────────────────────────────────────
//
// 为什么是「命令模板」而不是内置克隆：
// - 本机是 Intel Mac（无可用 GPU），内置克隆推理（GPT-SoVITS / CosyVoice 之流）不现实；
//   而把几百 MB~GB 的模型与 PyTorch 塞进这个仓库更不现实。
// - 用户真正要的是「用自己的声音念」；**能力来源可以是任意外部引擎**。
//   我们只负责：把文本/输出路径/参考音频交给它，然后把产出的音频**放出来**（可打断、时长已知）。
// - 这也让「自定义音色」当天可用：接 piper / GPT-SoVITS / 自写脚本都行，宿主不绑定实现。

/// shell 单引号转义：`'` → `'\''`。
///
/// 模板是用户写的，但**文本来自模型/工具结果**（不可信）—— 绝不能让它拼出命令。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 把模板渲染成一条 shell 命令。
///
/// - `{text}` → 单引号包裹的待念文本；
/// - `{out}` → 单引号包裹的输出音频路径；
/// - `{ref}` → 单引号包裹的参考音频路径（空串也照给，引擎可自行判定）；
/// - 其余 `{...}` 一律不动（避免把引擎自己的模板语法当成我们的占位符）。
pub fn render_tts_command(template: &str, text: &str, out: &str, reference: &str) -> String {
    template
        .replace("{text}", &sh_quote(text))
        .replace("{out}", &sh_quote(out))
        .replace("{ref}", &sh_quote(reference))
}

/// 模板是否让引擎写文件（含 `{out}`）。
///
/// 不含 `{out}` = 引擎自己负责出声（如直接调 `afplay`/`ffplay`）——
/// 这时我们不播、也不假装知道时长。
pub fn tts_template_writes_file(template: &str) -> bool {
    template.contains("{out}")
}

/// 模板是否能拿到待念文本。没有 `{text}` 就没法念，直接报错比默默念出空话好。
pub fn tts_template_has_text(template: &str) -> bool {
    template.contains("{text}")
}

/// 从 `afinfo` 输出里取时长（秒）。拿到真实时长就能做「浮层跟着朗读淡出」。
pub fn parse_afinfo_duration(out: &str) -> Option<f64> {
    for line in out.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("estimated duration:") {
            let num: String = rest
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f64>() {
                if v > 0.0 {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// 一次播报的结果
pub struct Spoken {
    /// 实际念出去的文本
    pub text: String,
    /// 真实音频时长（秒）—— 拿得到就说明「浮层跟着朗读淡出」有真实依据
    pub seconds: Option<f64>,
    /// 需要回传给用户的提醒
    pub notes: Vec<String>,
}

/// 自定义引擎的输出音频路径（放在应用数据目录，不污染用户目录）
fn tts_out_path(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败：{e}"))?
        .join("tts-out");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 tts-out 目录失败：{e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(dir
        .join(format!("tts-{ts}.wav"))
        .to_string_lossy()
        .to_string())
}

/// 取音频真实时长（`afinfo`）——失败时返回 None，不因此让播报失败
async fn afinfo_seconds(db: &crate::db::Database, home: &str, path: &str) -> Option<f64> {
    let out = crate::run_wrapped_argv(
        db,
        home,
        "afinfo",
        vec![path.to_string()],
        15,
        "surface_audio_info",
    )
    .await
    .ok()?;
    parse_afinfo_duration(&out.stdout).or_else(|| parse_afinfo_duration(&out.stderr))
}

/// **语音出口的唯一实现**：要么走系统 `say`，要么交给用户配的自定义引擎。
///
/// 试听与实际播报走同一条路 —— 否则设置里的「试听」就是在骗人。
pub async fn speak(
    app: &tauri::AppHandle,
    text: &str,
    opts: &ExecuteOptions,
) -> Result<Spoken, String> {
    // 每次播报重置取消位：上一次的「停」不该影响下一次
    SPEECH_CANCELLED.store(false, Ordering::SeqCst);
    let _ = app.emit(
        crate::voice::EVENT_SPEAKING,
        serde_json::json!({ "stage": "start" }),
    );
    let result = speak_inner(app, text, opts).await;
    let _ = app.emit(
        crate::voice::EVENT_SPEAKING,
        serde_json::json!({ "stage": "end", "ok": result.is_ok() }),
    );
    result
}

fn speech_cancelled() -> bool {
    SPEECH_CANCELLED.load(Ordering::SeqCst)
}

/// 一键全停：停掉正在念的那句（前端再配合停流式输出与浮层）。
/// 返回 `true` 表示确实有一个播报进程被终止。
///
/// 独立成普通函数是因为**全局语音快捷键在 Rust 侧**处理：按下热键时要先静音，
/// 不该再绕一圈 IPC 去调命令。
pub fn stop_speech_now() -> bool {
    SPEECH_CANCELLED.store(true, Ordering::SeqCst);
    let pid = SPEECH_PID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        // SIGTERM 而非 SIGKILL：让 say 自己收尾（否则可能留下半句音频缓冲）
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn surface_stop_speech() -> bool {
    stop_speech_now()
}

async fn speak_inner(
    app: &tauri::AppHandle,
    text: &str,
    opts: &ExecuteOptions,
) -> Result<Spoken, String> {
    let db = app.state::<crate::db::Database>();
    let home = home_dir();
    let template = opts
        .tts_command
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());

    // 先口语化（两类引擎都受益）；空串说明整句都是念不出来的噪音 → 退回原文
    let natural = {
        let n = naturalize_speech(text);
        if n.is_empty() {
            text.to_string()
        } else {
            n
        }
    };

    let Some(template) = template else {
        // 系统音色：一条命令、零依赖、离线
        let say_text = if opts.pauses {
            add_sentence_pauses(&natural)
        } else {
            natural.clone()
        };
        let argv = say_argv(&say_text, opts.voice.as_deref(), Some(opts.rate));
        let out = crate::run_wrapped_argv_tracked(
            &db,
            &home,
            "say",
            argv,
            SAY_TIMEOUT_SECS,
            "surface_speech",
            Some(&SPEECH_PID),
        )
        .await?;
        if speech_cancelled() {
            return Err("已停止播报".to_string());
        }
        if out.exit_code != 0 {
            return Err(format!(
                "say 退出码 {}（{}）",
                out.exit_code,
                out.stderr.trim()
            ));
        }
        return Ok(Spoken {
            text: natural,
            seconds: None,
            notes: Vec::new(),
        });
    };

    // 自定义引擎：先合成（可能很慢，给足超时），再播放
    if !tts_template_has_text(template) {
        return Err(
            "自定义语音命令里没有 {text} 占位符，引擎不知道要念什么（可用：{text} / {out} / {ref}）"
                .to_string(),
        );
    }
    let writes_file = tts_template_writes_file(template);
    let out_path = if writes_file {
        tts_out_path(app)?
    } else {
        String::new()
    };
    let reference = opts.tts_reference.clone().unwrap_or_default();
    let cmd = render_tts_command(template, &natural, &out_path, &reference);
    // 沙箱不介入：这是用户显式配置的引擎，它要写模型缓存/输出文件；
    // 等同“用户自己在终端跑”，但仍然带着代理注入与超时清理（run_shell_command_with 的统一行为）。
    let gen =
        crate::run_shell_command_with(&cmd, Some(&home), Some(TTS_TIMEOUT_SECS), None).await?;
    if gen.exit_code != 0 {
        let err: String = gen.stderr.trim().chars().take(200).collect();
        return Err(format!("自定义语音命令退出码 {}（{err}）", gen.exit_code));
    }
    if !writes_file {
        // 引擎自己出声（比如它内部调了 afplay）—— 我们不播、也不假装知道时长
        return Ok(Spoken {
            text: natural,
            seconds: None,
            notes: vec!["自定义引擎自行播放（命令模板里没有 {out}）".to_string()],
        });
    }
    if !std::path::Path::new(&out_path).exists() {
        return Err(format!("自定义引擎没有产出音频文件：{out_path}"));
    }
    if speech_cancelled() {
        return Err("已停止播报".to_string());
    }
    let seconds = afinfo_seconds(&db, &home, &out_path).await;
    let play = crate::run_wrapped_argv_tracked(
        &db,
        &home,
        "afplay",
        vec![out_path.clone()],
        PLAY_TIMEOUT_SECS,
        "surface_speech_play",
        Some(&SPEECH_PID),
    )
    .await?;
    if speech_cancelled() {
        return Err("已停止播报".to_string());
    }
    if play.exit_code != 0 {
        return Err(format!(
            "afplay 退出码 {}（{}）",
            play.exit_code,
            play.stderr.trim()
        ));
    }
    Ok(Spoken {
        text: natural,
        seconds,
        notes: Vec::new(),
    })
}

/// 列出本机可用音色（走统一命令管线：外部命令一律沙箱 + 审计）
#[tauri::command]
pub async fn list_say_voices(app: tauri::AppHandle) -> Result<Vec<SayVoice>, String> {
    let db = app.state::<crate::db::Database>();
    let out = crate::run_wrapped_argv(
        &db,
        &home_dir(),
        "say",
        vec!["-v".to_string(), "?".to_string()],
        20,
        "surface_voices",
    )
    .await?;
    if out.exit_code != 0 {
        return Err(format!(
            "say -v ? 退出码 {}（{}）",
            out.exit_code,
            out.stderr.trim()
        ));
    }
    // 多数版本把清单打到 stdout，但不同系统/构建可能走 stderr —— 两边都认，别让「列表为空」变成谜
    let text = if out.stdout.trim().is_empty() {
        out.stderr
    } else {
        out.stdout
    };
    Ok(sort_voices_for_ui(parse_say_voices(&text)))
}

/// 试听：按指定音色念一句话。默认用该音色自带的示例句，用户改文本也就改了内容。
///
/// **走的是与实际播报同一条路**（`speak`）：配了自定义引擎就试听自定义引擎，
/// 否则试听系统音色。设置页不会骗人。
#[tauri::command]
pub async fn preview_voice(
    app: tauri::AppHandle,
    voice: String,
    text: String,
) -> Result<String, String> {
    let prepared = naturalize_speech(&text);
    let spoken = sanitize_speech(&prepared).ok_or_else(|| "试听文本为空或不可读".to_string())?;
    let settings = crate::load_app_settings(app.state(), app.state())
        .map_err(|e| format!("读取设置失败：{e}"))?;
    let opts =
        ExecuteOptions::from_settings(&settings, Some(voice).filter(|v| !v.trim().is_empty()));
    let result = speak(&app, &spoken, &opts).await?;
    let tail: Vec<String> = result
        .seconds
        .map(|s| format!("音频 {s:.1}s"))
        .into_iter()
        .chain(result.notes.iter().cloned())
        .collect();
    Ok(if tail.is_empty() {
        result.text
    } else {
        format!("{}（{}）", result.text, tail.join("；"))
    })
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
            ..Default::default()
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
    fn naturalize_speech_strips_markdown_urls_and_emoji() {
        let out = naturalize_speech("**完成**：见 [文档](https://example.com/a) ✅");
        assert!(!out.contains('*'), "{out}");
        assert!(out.contains("完成"), "{out}");
        assert!(out.contains("文档"), "{out}");
        assert!(!out.contains("http"), "{out}");
        assert!(!out.contains('✅'), "{out}");
    }

    #[test]
    fn repeated_single_chars_collapse_but_parallel_items_do_not() {
        // 「鹅，鹅，鹅」逐字念会一顿一顿；吟诵是连读
        assert_eq!(naturalize_speech("鹅，鹅，鹅"), "鹅鹅鹅。");
        assert_eq!(naturalize_speech("好，好，好。"), "好好好。");
        // 不同字的并列必须原样保留（否则意思就变了）
        assert_eq!(naturalize_speech("猫，狗，鸟。"), "猫，狗，鸟。");
        assert_eq!(
            naturalize_speech("第一，第二，第三。"),
            "第一，第二，第三。"
        );
        // 只重复两次不动（「走，走开」不是重复吟诵）
        assert_eq!(naturalize_speech("走，走开。"), "走，走开。");
    }

    #[test]
    fn naturalize_speech_drops_spaces_between_chinese_chars() {
        // 模型/markdown 残留的空格在 TTS 里是**停顿**：实测「鹅 鹅 鹅」3.96s vs「鹅鹅鹅」3.05s
        assert_eq!(naturalize_speech("鹅 鹅 鹅"), "鹅鹅鹅。");
        assert_eq!(naturalize_speech("曲项 向天歌"), "曲项向天歌。");
        // 中英之间、数字与单位之间的空格要保留
        assert_eq!(naturalize_speech("用 Rust 写"), "用 Rust 写。");
        assert_eq!(naturalize_speech("共 3 个文件"), "共 3 个文件。");
    }

    #[test]
    fn naturalize_before_sanitize_keeps_recitation_rhythm() {
        // execute() 的顺序：naturalize（换行→逗号）再 sanitize（压空白/截断）。
        // 反了就会把换行压成空格，`say`/edge 会在句中硬停顿。
        let raw = "鹅，鹅，鹅\n曲项向天歌。\n白毛浮绿水，\n红掌拨清波。";
        let prepared = naturalize_speech(raw);
        let spoken = sanitize_speech(&prepared).expect("应有输出");
        assert_eq!(spoken, "鹅鹅鹅，曲项向天歌。白毛浮绿水，红掌拨清波。");
        assert!(!spoken.contains(' '), "汉字之间不该有空格：{spoken}");
    }

    #[test]
    fn naturalize_speech_turns_newlines_into_recitation_pauses() {
        // 换行在中文里是断句：不加标点会变成句中的硬停顿（`say` 会念得一顿一顿）
        // 三个「鹅」被逗号隔开 → collapse 规则先收成「鹅鹅鹅」（吟诵不该一顿一顿）
        assert_eq!(
            naturalize_speech("鹅，鹅，鹅\n曲项向天歌\n白毛浮绿水"),
            "鹅鹅鹅，曲项向天歌，白毛浮绿水。"
        );
        // 行尾已有标点时不重复添加
        assert_eq!(naturalize_speech("第一句。\n第二句。"), "第一句。第二句。");
    }

    #[test]
    fn naturalize_speech_turns_symbols_into_spoken_words() {
        assert_eq!(naturalize_speech("3 → 5 × 2"), "3 到 5 乘以 2。");
        assert_eq!(naturalize_speech("25℃"), "25摄氏度。");
    }

    #[test]
    fn naturalize_speech_strips_inline_speech_commands() {
        // 正文来源不可信：不能让它把 say 拖进 60 秒静音
        assert_eq!(
            naturalize_speech("好的[[slnc 60000]]完成了"),
            "好的完成了。"
        );
    }

    #[test]
    fn naturalize_speech_keeps_terminal_punctuation() {
        assert_eq!(naturalize_speech("完成了。"), "完成了。");
        assert_eq!(naturalize_speech("完成了"), "完成了。");
    }

    #[test]
    fn sentence_pauses_only_follow_sentence_end() {
        // 实测：`say` 会忽略逗号后的 slnc，只有句末才有效
        assert_eq!(
            add_sentence_pauses("第一句。第二句，第三句！"),
            "第一句。[[slnc 220]]第二句，第三句！"
        );
        assert_eq!(add_sentence_pauses("只有一句。"), "只有一句。");
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

    #[test]
    fn parse_say_voices_handles_real_macos_format() {
        // 真实输出片段（本机实测）：名字里有空格/括号/中文，示例在 `#` 之后。
        // 直接用真实字符而不是 \u 转义 —— 转义写错会让测试变成语法错误，得不偿失。
        let raw = concat!(
            "Albert              en_US    # Hello! My name is Albert.\n",
            "Eddy (中文（中国大陆）)     zh_CN    # 你好！我叫Eddy。\n",
            "Tingting            zh_CN    # 你好，我叫Tingting。\n",
        );
        let voices = parse_say_voices(raw);
        assert_eq!(voices.len(), 3);
        assert_eq!(voices[0].name, "Albert");
        assert_eq!(voices[0].locale, "en_US");
        assert_eq!(voices[0].example, "Hello! My name is Albert.");
        // 名字带空格与括号（含全角括号）也不能被切坏
        assert_eq!(voices[1].name, "Eddy (中文（中国大陆）)");
        assert_eq!(voices[1].locale, "zh_CN");
        assert_eq!(voices[1].example, "你好！我叫Eddy。");
        assert_eq!(voices[2].name, "Tingting");
        // `variant` 是给 UI 分组/提示用的：名字带括号的是 Apple 多语言变体（趣味音色）
        assert!(!voices[0].variant, "Albert 是真人音色");
        assert!(voices[1].variant, "Eddy (中文（中国大陆）) 是变体音色");
        assert!(!voices[2].variant, "Tingting 是真人音色");
    }

    #[test]
    fn parse_say_voices_skips_junk_lines_instead_of_failing() {
        // 空行/分隔线/没有 locale 的行都要能跳过 —— 解析失败会让「音色列表为空」变成谜
        let raw = "\n----\n音色清单\nno-locale-here\nAlex  fr_FR\n";
        let voices = parse_say_voices(raw);
        assert_eq!(voices.len(), 1);
        assert_eq!(voices[0].name, "Alex");
        assert_eq!(voices[0].locale, "fr_FR");
        assert_eq!(voices[0].example, ""); // 没有 `#` 时示例为空
        assert!(!voices[0].variant);
    }

    #[test]
    fn tts_command_quotes_text_so_model_output_cannot_inject() {
        // 模板是用户写的，但 `{text}` 来自模型/工具结果（不可信）—— 绝不能拼出命令
        let cmd = render_tts_command(
            "mytts --text {text} --out {out}",
            "'; rm -rf ~; echo '",
            "/tmp/a.wav",
            "",
        );
        assert!(
            cmd.contains("'\\''; rm -rf ~; echo '\\''"),
            "文本必须被单引号转义：{cmd}"
        );
        assert!(
            cmd.starts_with("mytts --text '"),
            "文本要整体作为一个参数：{cmd}"
        );

        // 正常文本（含中文与空格）也要原样作为单参数传入
        let cmd2 = render_tts_command("mytts {text}", "本周提交 23 次", "/tmp/o.wav", "");
        assert_eq!(cmd2, "mytts '本周提交 23 次'");
    }

    #[test]
    fn tts_command_keeps_unknown_placeholders_untouched() {
        // 引擎自己的模板语法（如 `{speed}`）不能被我们吃掉
        let cmd = render_tts_command("engine --speed {speed} --text {text}", "嗨", "", "");
        assert!(cmd.contains("{speed}"), "非白名单占位符应原样保留：{cmd}");
        assert!(cmd.contains("'嗨'"));
    }

    #[test]
    fn tts_template_capabilities_are_detected() {
        assert!(tts_template_writes_file("e --out {out}"));
        assert!(!tts_template_writes_file("e --text {text}")); // 引擎自己出声
        assert!(tts_template_has_text("e {text}"));
        assert!(!tts_template_has_text("e {out}"));
    }

    #[test]
    fn parse_afinfo_duration_reads_real_output() {
        // 本机实测格式：`estimated duration: 3.002630 sec`
        let raw = "File: /tmp/x.aiff\nestimated duration: 3.002630 sec\n";
        assert_eq!(parse_afinfo_duration(raw), Some(3.00263));
        // 拿不到就返回 None，不因此让播报失败
        assert_eq!(parse_afinfo_duration("File: /tmp/x.aiff\n"), None);
        assert_eq!(parse_afinfo_duration("estimated duration: 0 sec"), None);
    }

    #[test]
    fn surface_names_match_protocol_registry() {
        // 协议登记的出口名就这几个（改了要同步改 docs/PRESENT_PROTOCOL.md §3 与前端注册表）
        assert_eq!(SURFACE_NAMES.len(), 8);
        assert!(SURFACE_NAMES.contains(&"hud") && SURFACE_NAMES.contains(&"speech"));
        assert!(SURFACE_NAMES.contains(&"notify") && SURFACE_NAMES.contains(&"im"));
    }

    #[test]
    fn not_yet_implemented_names_the_missing_surfaces() {
        // 登记了但没实现的出口要说出来，不能默默忽略（“设了通知却没通知”必须可解释）
        let p = plan(&["session", "hud", "notify"], "");
        assert_eq!(p.not_yet_implemented(), vec!["notify"]);
        // 未知名字不报（前端发来的脏数据不该被当成“未收编出口”吓用户）
        let dirty = plan(&["session", "telepathy"], "");
        assert!(dirty.not_yet_implemented().is_empty());
    }

    #[test]
    fn sort_voices_puts_chinese_first() {
        let v = |n: &str, l: &str| SayVoice {
            name: n.into(),
            locale: l.into(),
            example: String::new(),
            variant: false,
        };
        let sorted = sort_voices_for_ui(vec![
            v("Alex", "en_US"),
            v("Tingting", "zh_CN"),
            v("Mei-Jia", "zh_TW"),
        ]);
        assert_eq!(sorted[0].locale, "zh_CN");
        assert_eq!(sorted[1].locale, "zh_TW");
        assert_eq!(sorted[2].locale, "en_US");
    }

    #[test]
    fn sort_voices_puts_novelty_variants_last() {
        // **真机反馈的回归测试**：中文组里 16/19 个是 `Eddy (中文（中国大陆）)` 这类趣味变体，
        // 按名字字典序它们会排在 Tingting 前面 → 用户点开设置第一个试听的就是最怪的。
        // 所以变体必须排到最后（哪怕它是 zh_CN，而对照物是 en_US 真人音色）。
        let v = |n: &str, l: &str, variant: bool| SayVoice {
            name: n.into(),
            locale: l.into(),
            example: String::new(),
            variant,
        };
        let sorted = sort_voices_for_ui(vec![
            v("Eddy (中文（中国大陆）)", "zh_CN", true),
            v("Grandma (中文（中国大陆）)", "zh_CN", true),
            v("Sinji", "zh_HK", false),
            v("Meijia", "zh_TW", false),
            v("Tingting", "zh_CN", false),
            v("Alex", "en_US", false),
        ]);
        let names: Vec<&str> = sorted.iter().map(|v| v.name.as_str()).collect();
        // 真人中文（按 locale：zh_CN → zh_HK → zh_TW）→ 其它语言真人 → 变体（最后）
        assert_eq!(
            names,
            vec![
                "Tingting",
                "Sinji",
                "Meijia",
                "Alex",
                "Eddy (中文（中国大陆）)",
                "Grandma (中文（中国大陆）)"
            ]
        );
    }

    #[test]
    fn is_locale_only_accepts_language_region_pairs() {
        assert!(is_locale("zh_CN"));
        assert!(is_locale("en_US"));
        assert!(is_locale("yue_HK"));
        // 名字里的括号片段、纯词、过长的都别误判成 locale
        assert!(!is_locale("Eddy"));
        assert!(!is_locale("(\u{4e2d}\u{6587})"));
        assert!(!is_locale("abcdef_gh"));
        assert!(!is_locale("zh"));
    }

    /// 真机 live 测试（默认 `#[ignore]`）：音色列表必须**真的**能从 `say -v ?` 走完整管线拿到，
    /// 且本机至少有一个中文音色 —— 单测里的假数据证明不了这一点。
    ///
    /// 跑法：`cargo test --offline --lib surface::live_ -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_list_say_voices_yields_chinese_voice() {
        let dir = std::env::temp_dir().join(format!("dsy-voices-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let db = crate::db::Database::new(dir).expect("临时库应能创建");
        let out = crate::run_wrapped_argv(
            &db,
            &home_dir(),
            "say",
            vec!["-v".to_string(), "?".to_string()],
            30,
            "surface_list_voices",
        )
        .await
        .expect("say 应能执行");
        // 本机 `say -v ?` 走的是 stdout，但留个兜底以防版本差异
        let raw = if out.stdout.trim().is_empty() {
            out.stderr
        } else {
            out.stdout
        };
        let voices = sort_voices_for_ui(parse_say_voices(&raw));
        println!(
            "音色总数 {}，中文 {} 个，第一个是 {}（{}）示例：{}",
            voices.len(),
            voices.iter().filter(|v| v.locale.starts_with("zh")).count(),
            voices[0].name,
            voices[0].locale,
            voices[0].example
        );
        assert!(
            voices.len() > 20,
            "音色太少（{}），解析或管线有问题",
            voices.len()
        );
        assert!(
            voices.iter().any(|v| v.locale.starts_with("zh")),
            "本机应有中文音色，否则设置里的「中文」分组会是空的"
        );
        assert!(
            voices.iter().any(|v| !v.example.is_empty()),
            "示例句全空 → 设置界面的「示例」提示没东西可显示"
        );
    }
}
