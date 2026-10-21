//! Answer me with HTML（方案 B）：内置工具 `answer_html` 的后端。
//!
//! 上游技能 <https://github.com/QingYunA/answer-me-with-html>（MIT）的工作方式是
//! 「**模型只写 Markdown 草稿** → 自带 CLI 负责布局 / 配色 / SVG 坐标 / STE 检查 →
//! 输出单文件离线 HTML」。我们**不照搬它的安装方式**（它要 `npx skills add`，且 SKILL.md
//! 通篇依赖 `${CLAUDE_SKILL_DIR}` 这种别家变量、导入后必然指向不存在的路径），
//! 而是把这条链路做成宿主的**受控命令**：
//!
//! - **CLI 随包内嵌**：`src-tauri/resources/am.mjs`（471 KB 单文件、零 npm 依赖；
//!   版本/commit/哈希见同目录 `AM-MJS-NOTICE.md`）—— 用户不需要装 npm 包，离线可用；
//! - **不走 heredoc**：草稿由宿主写到临时文件（`$TMPDIR`，沙箱天然放行），CLI 以 **argv**
//!   形态调用 —— 避开上游 SKILL.md 里 `<<'AM_EOF'` 那种引号/反引号/中文标点的转义坑；
//! - **走统一命令管线**：`sandbox::wrap_argv_auto` + 超时 + `log_tool_call` 审计
//!   （与 `run_tests` / `git_operation` 同款，绝不自己 `Command::new` 绕开沙箱）；
//! - **前置探测**：CLI 与 Node（≥ 20）缺失时给可读错误，不让模型反复试错烧轮次；
//! - **输出落点**：显式 `out_path` 优先（仍过 P-A8 路径白名单），否则
//!   `~/Documents/道生一产物/`；`read-only` 沙箱下明确拒绝（生成页面本质是写文件），
//!   `workspace-write` 下默认落到工作区内（否则沙箱会拒写、报错难懂）。
//!
//! 触发策略：**每次显式要求**（用户明确说「用网页/HTML 回答」时才用），
//! 不做 always-on 自动出页 —— 这一条由 `builtin-tools.ts` 的描述与系统提示词负责。

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::db::Database;
use crate::{artifact_root, sandbox, sandbox_config_for, sandbox_file_path};

/// 上游要求的最低 Node 主版本（SKILL.md：Node.js 20+）
pub const MIN_NODE_MAJOR: u32 = 20;
/// 渲染超时：上游 CLI 典型耗时约 50 ms，这里给足余量（首次冷启动 node 也在 1 s 内）
pub const RENDER_TIMEOUT_SECS: u64 = 120;
/// node 探测超时
const NODE_PROBE_TIMEOUT_SECS: u64 = 10;
/// 内嵌 CLI 文件名（Tauri resource）
const CLI_FILE: &str = "am.mjs";
/// 文件名限长（字符数）
const SLUG_MAX_CHARS: usize = 40;

/// 渲染结果（回传前端，供模型原样引用路径）
#[derive(Debug, serde::Serialize)]
pub struct AnswerHtmlResult {
    /// 生成的 HTML 绝对路径（模型必须在回复里**原样**引用）
    pub html_path: String,
    /// 实际使用的 node 版本（如 `24.16.0`）
    pub node_version: String,
    /// 实际使用的 CLI 路径
    pub cli: String,
    /// 产物字节数
    pub bytes: u64,
    /// 实际使用的模板（sheet / doc）
    pub template: String,
    /// 草稿里的 ```chart 图表数量
    pub charts: usize,
    /// 图表渲染引擎：echarts（默认）/ svg（ECharts 资源缺失时的回退）
    pub chart_engine: String,
    /// 是否内联了 Tailwind CSS
    pub tailwind: bool,
    /// 渲染后的离线自检提示（外部资源引用等；空 = 没问题）
    pub warnings: Vec<String>,
}

/// 解析 `node --version` 输出（形如 `v24.16.0`）→ (主, 次)。无法解析返回 None。
pub fn parse_node_version(out: &str) -> Option<(u32, u32)> {
    let t = out.trim();
    let t = t.strip_prefix('v').unwrap_or(t);
    let mut it = t.split(['.', '-', '+', ' ']);
    let major: u32 = it.next()?.trim().parse().ok()?;
    let minor: u32 = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
    Some((major, minor))
}

/// 版本是否满足上游要求（主版本 ≥ MIN_NODE_MAJOR）
pub fn node_version_ok(v: (u32, u32)) -> bool {
    v.0 >= MIN_NODE_MAJOR
}

/// 候选 node 可执行文件（按优先级）。
///
/// 打包后的 app 由 Finder 启动，`PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`
/// —— 靠 `Command::new("node")` 必然找不到 Homebrew/nvm 装的 node，必须显式给候选路径。
pub fn node_candidates(home: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"), // Apple Silicon Homebrew
        PathBuf::from("/usr/local/bin/node"),    // Intel Homebrew / 官方 pkg
        PathBuf::from("/usr/bin/node"),
    ];
    if !home.is_empty() {
        let h = Path::new(home);
        v.push(h.join(".volta/bin/node"));
        v.push(h.join(".local/bin/node"));
        v.push(h.join("n/bin/node")); // n
                                      // nvm：~/.nvm/versions/node/vX.Y.Z/bin/node —— 取版本号最大的一个
        if let Ok(rd) = std::fs::read_dir(h.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            // 目录名形如 v24.16.0：按 (主, 次) 数值排序，避免字符串序把 v9 排在 v24 之后
            versions.sort_by_key(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .and_then(parse_node_version)
                    .unwrap_or((0, 0))
            });
            if let Some(latest) = versions.last() {
                v.push(latest.join("bin/node"));
            }
        }
    }
    v
}

/// 开发态（非打包）下从可执行文件位置回溯找 `resources/am.mjs`。
/// 逐级上溯而不是写死层数：debug / release / 自定义 target 目录都能命中。
pub fn dev_cli_candidates(exe: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Some(exe) = exe else { return out };
    for anc in exe.ancestors().skip(1).take(6) {
        out.push(anc.join("resources").join(CLI_FILE));
        out.push(anc.join("src-tauri").join("resources").join(CLI_FILE));
    }
    out
}

/// 定位内嵌 CLI：打包态走 resource 目录，开发态回溯项目目录
pub fn locate_cli(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        for cand in [dir.join("resources").join(CLI_FILE), dir.join(CLI_FILE)] {
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    let exe = std::env::current_exe().ok();
    dev_cli_candidates(exe.as_deref())
        .into_iter()
        .find(|p| p.exists())
}

/// 内嵌 ECharts（仅在页面含 chart 块时内联；见 resources/ECHARTS-NOTICE.md）
const ECHARTS_FILE: &str = "echarts.min.js";
/// 预编译 Tailwind CSS（仅在需要工具类时内联；见 resources/TAILWIND-NOTICE.md）
const TAILWIND_FILE: &str = "tailwind.css";

/// 开发态回溯查找任意 resource 文件。
pub fn dev_resource_candidates(exe: Option<&Path>, file: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Some(exe) = exe else { return out };
    for anc in exe.ancestors().skip(1).take(6) {
        out.push(anc.join("resources").join(file));
        out.push(anc.join("src-tauri").join("resources").join(file));
    }
    out
}

/// 定位内嵌 Tailwind CSS：打包态走 resource 目录，开发态回溯项目目录。
pub fn locate_tailwind(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        for cand in [
            dir.join("resources").join(TAILWIND_FILE),
            dir.join(TAILWIND_FILE),
        ] {
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    let exe = std::env::current_exe().ok();
    dev_resource_candidates(exe.as_deref(), TAILWIND_FILE)
        .into_iter()
        .find(|p| p.exists())
}

/// 定位内嵌 ECharts：打包态走 resource 目录，开发态回溯项目目录。
pub fn locate_echarts(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        for cand in [
            dir.join("resources").join(ECHARTS_FILE),
            dir.join(ECHARTS_FILE),
        ] {
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    let exe = std::env::current_exe().ok();
    dev_resource_candidates(exe.as_deref(), ECHARTS_FILE)
        .into_iter()
        .find(|p| p.exists())
}

/// 拼装草稿：已有 frontmatter 就原样用；否则（给了 title/lang 时）补一个最小 frontmatter。
/// 上游 CLI 会按草稿语言自动决定 `<html lang>` 与按钮文案，所以 title/lang 都缺省时不必硬塞 frontmatter。
pub fn build_draft(markdown: &str, title: Option<&str>, lang: Option<&str>) -> String {
    let md = markdown.trim();
    if md.starts_with("---\n") || md.starts_with("---\r\n") {
        return md.to_string();
    }
    let t = title.map(str::trim).filter(|s| !s.is_empty());
    let l = lang.map(str::trim).filter(|s| !s.is_empty());
    if t.is_none() && l.is_none() {
        return md.to_string();
    }
    let mut fm = String::from("---\n");
    if let Some(t) = t {
        fm.push_str(&format!("title: {t}\n"));
    }
    if let Some(l) = l {
        fm.push_str(&format!("lang: {l}\n"));
    }
    fm.push_str("---\n\n");
    fm.push_str(md);
    fm
}

/// 文件名 slug：保留中英数字，其余字符折成 `-`，限长并去掉首尾分隔符。
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in s.chars() {
        let keep = ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fa5}').contains(&ch);
        if keep {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.chars().count() >= SLUG_MAX_CHARS {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "page".to_string()
    } else {
        trimmed
    }
}

/// CLI 参数（argv 形态）：`am.mjs render <draft> -o <out> --no-open`
/// `--no-open` 是硬约定：绝不代替用户在屏幕上弹浏览器（页面由我们自己的 open_file 打开）。
#[cfg(test)]
pub fn render_args(cli: &Path, draft: &Path, out: &Path) -> Vec<String> {
    render_args_with(cli, draft, out, None, None)
}

/// 同 `render_args`，可附加 `--template` / `--theme`（值已由调用方校验）。
pub fn render_args_with(
    cli: &Path,
    draft: &Path,
    out: &Path,
    template: Option<&str>,
    theme: Option<&str>,
) -> Vec<String> {
    let mut v = vec![
        cli.to_string_lossy().to_string(),
        "render".to_string(),
        draft.to_string_lossy().to_string(),
        "-o".to_string(),
        out.to_string_lossy().to_string(),
        "--no-open".to_string(),
    ];
    if let Some(t) = template.filter(|s| !s.is_empty()) {
        v.push("--template".to_string());
        v.push(t.to_string());
    }
    if let Some(t) = theme.filter(|s| !s.is_empty()) {
        v.push("--theme".to_string());
        v.push(t.to_string());
    }
    v
}

/// 决定输出路径。
///
/// 优先级：显式 `out_path`（白名单已在命令层校验）→ **产物目录**（用户的明确约定）。
/// 只有 `read-only` 沙箱会拒绝：生成页面本质是写文件，在「禁止一切写入」的档位下只好如实拒绝。
///
/// 历史（2026-10-08 实测踩到）：曾经在 `workspace-write` 下默认落到 `<工作区>/道生一页面/`，
/// 而用户的「工作区」设的是主目录 → 产物被写进 `~/道生一页面/`，既不是约定的产物目录、
/// 也污染了主目录。现在改为**恒定落产物目录**，并由命令层把该命令的沙箱可写区收敛到输出目录
/// （见 `answer_html` 里对 `cfg.workspace` 的处理）。
pub fn resolve_out_path(
    explicit: Option<&str>,
    cfg: &sandbox::SandboxConfig,
    home: &str,
    file_name: &str,
) -> Result<PathBuf, String> {
    let mode = cfg.mode.trim().to_ascii_lowercase();
    if mode == "read-only" {
        return Err(
            "当前命令沙箱为「只读」，无法写出 HTML 文件（生成页面本质是写文件）。请在工具栏切换到「工作区可写」或关闭沙箱后重试。"
                .to_string(),
        );
    }
    if let Some(raw) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        let is_dir =
            raw.ends_with('/') || p.is_dir() || !raw.to_ascii_lowercase().ends_with(".html");
        return Ok(if is_dir { p.join(file_name) } else { p });
    }
    Ok(artifact_root(home).join(file_name))
}

/// 常见 LaTeX 命令名（用于识别草稿里的公式源码；渲染器不含数学引擎，必须提前拦下）
pub const LATEX_COMMANDS: &[&str] = &[
    "frac",
    "sqrt",
    "sum",
    "prod",
    "int",
    "oint",
    "partial",
    "nabla",
    "psi",
    "Psi",
    "phi",
    "Phi",
    "hbar",
    "alpha",
    "beta",
    "gamma",
    "Gamma",
    "delta",
    "Delta",
    "lambda",
    "Lambda",
    "mu",
    "nu",
    "sigma",
    "Sigma",
    "omega",
    "Omega",
    "theta",
    "Theta",
    "pi",
    "rho",
    "tau",
    "times",
    "cdot",
    "pm",
    "le",
    "leq",
    "ge",
    "geq",
    "ne",
    "neq",
    "approx",
    "equiv",
    "propto",
    "sim",
    "infty",
    "to",
    "rightarrow",
    "leftarrow",
    "Rightarrow",
    "langle",
    "rangle",
    "vec",
    "hat",
    "dot",
    "ddot",
    "mathbf",
    "mathrm",
    "mathbb",
    "mathcal",
    "text",
    "left",
    "right",
    "begin",
    "end",
    "otimes",
    "oplus",
    "quad",
    "qquad",
    "matrix",
    "pmatrix",
    "cases",
];

/// 草稿里的 LaTeX 数学源码（返回人读的描述；空 = 没发现）。
///
/// **为什么要在渲染前拦**：内置渲染器（上游 am.mjs）不含 KaTeX/MathJax，也不认美元符公式
/// —— 写进去就是原样显示成 `$E=h\nu$` 这种源码，用户看到一堆反斜杠与美元符。
/// 2026-10-08 实测：模型首版就是这样出的页，自己 grep 渲染器后改用 Unicode 才修好。
/// 拦下来 + 给出改写范例，比渲完再让用户看坏页面便宜得多（也省一轮重渲的 token）。
pub fn latex_hits(markdown: &str) -> Vec<String> {
    let mut hits: Vec<String> = Vec::new();
    let dollars = markdown.matches('$').count();
    if dollars >= 2 {
        hits.push(format!("美元符包裹的公式（{dollars} 个美元符）"));
    }
    if markdown.contains("\\(") || markdown.contains("\\[") {
        hits.push("反斜杠括号公式（\\( … \\) 或 \\[ … \\]）".to_string());
    }
    let mut cmds: Vec<&str> = Vec::new();
    for c in LATEX_COMMANDS {
        if markdown.contains(&format!("\\{c}")) && !cmds.contains(c) {
            cmds.push(c);
        }
    }
    if !cmds.is_empty() {
        let list = cmds
            .iter()
            .map(|c| format!("\\{c}"))
            .collect::<Vec<_>>()
            .join("、");
        hits.push(format!("LaTeX 命令：{list}"));
    }
    hits
}

/// LaTeX 命中时的可读错误（带 Unicode 改写范例）
pub fn latex_error(hits: &[String]) -> String {
    format!(
        "草稿里有 LaTeX 数学源码（{}），但内置渲染器**不含数学引擎**（无 KaTeX/MathJax）\
         —— 直接写会被原样显示成源码（用户看到一堆反斜杠和美元符）。\n\
         请改写后重试：用 **Unicode 记号**直接写公式，例如 ψ、ħ、∂、Σ、Δ、∇、√、⊗、⟨ψ|、|ψ|²、10⁻¹²、x²、aₙ、≥ ≤ ≈ ≠ ∝ ∞ → ⇒；\n\
         薛定谔方程写成：iħ ∂ψ/∂t = Ĥψ；能量量子写成：E = hν；不确定关系写成：Δx·Δp ≥ ħ/2。\n\
         （确实需要保留源码时可放进 ```text 代码块；但不要用美元符/反斜杠包裹。）",
        hits.join("；")
    )
}

/// 探测一个 node 可执行文件的版本（跑 `<bin> --version`）
async fn probe_node(bin: &Path) -> Option<(u32, u32)> {
    let fut = tokio::process::Command::new(bin).arg("--version").output();
    let out = tokio::time::timeout(Duration::from_secs(NODE_PROBE_TIMEOUT_SECS), fut)
        .await
        .ok()?
        .ok()?;
    parse_node_version(&String::from_utf8_lossy(&out.stdout))
}

/// 找到第一个可用的 node（满足版本要求），返回 (路径, 版本)
async fn locate_node(home: &str) -> Option<(PathBuf, (u32, u32))> {
    let mut tried: Vec<PathBuf> = node_candidates(home);
    // 最后再试一次 PATH 里的 node（用户可能装在别处）
    tried.push(PathBuf::from("node"));
    for bin in tried {
        if let Some(v) = probe_node(&bin).await {
            if node_version_ok(v) {
                return Some((bin, v));
            }
        }
    }
    None
}

/// 跑一次渲染：argv 形态 + 沙箱包装 + 超时 + 进程组终止，返回 (stdout, stderr, exit_code)。
///
/// 抽成独立函数有两个理由：① 命令层只剩「准备草稿/决定输出/审计」这些业务；
/// ② 真机 e2e 测试（`#[ignore]`）能跑**同一条执行路径**，而不是另写一份。
pub async fn run_render(
    node_bin: &Path,
    args: &[String],
    cwd: Option<&str>,
    cfg: &sandbox::SandboxConfig,
    timeout_secs: u64,
    envs: &[(String, String)],
) -> Result<(String, String, i32), String> {
    let prog = node_bin.to_string_lossy().to_string();
    let (exec, full_args) = match sandbox::wrap_argv_auto(cfg, &prog, args) {
        Some((p, a)) => (p, a),
        None => (prog, args.to_vec()),
    };

    let mut cmd = tokio::process::Command::new(&exec);
    cmd.args(&full_args);
    cmd.envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    // 新进程组：超时/drop 时能 kill 整个进程组（node 派生的小进程也不残留）
    #[cfg(unix)]
    cmd.process_group(0);
    if let Some(dir) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.current_dir(dir);
    }

    let run = async {
        let child = cmd.spawn().map_err(|e| format!("启动 node 失败: {e}"))?;
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| format!("等待渲染进程失败: {e}"))?;
        Ok::<std::process::Output, String>(out)
    };

    match tokio::time::timeout(Duration::from_secs(timeout_secs), run).await {
        Err(_) => Err(format!("渲染超时（{timeout_secs}s），已终止")),
        Ok(Err(e)) => Err(e),
        Ok(Ok(o)) => Ok((
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
            String::from_utf8_lossy(&o.stderr).trim().to_string(),
            o.status.code().unwrap_or(-1),
        )),
    }
}

// --- 数据图表（ECharts，内联到单文件；缺失时回退内联 SVG） ---

#[derive(Debug, Clone, PartialEq)]
pub enum ChartKind {
    Bar,
    Line,
    Area,
    Pie,
    Donut,
    Scatter,
    Radar,
    Gauge,
    Heatmap,
    Funnel,
    /// 直接写 ECharts option JSON（覆盖所有高级图表）
    Custom,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChartSeries {
    pub name: String,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChartSpec {
    pub kind: ChartKind,
    pub title: String,
    pub unit: String,
    pub labels: Vec<String>,
    pub series: Vec<ChartSeries>,
    /// 画布高度（px）
    pub height: u32,
    /// 柱状/面积图是否堆叠
    pub stack: bool,
    /// kind=Custom 时的原始 ECharts option
    pub raw: Option<serde_json::Value>,
}

fn parse_numbers(raw: &str) -> Result<Vec<f64>, String> {
    raw.split([',', '，'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let cleaned = s.trim_end_matches(['%', '％']).replace('_', "");
            cleaned
                .parse::<f64>()
                .map_err(|_| format!("`{}` 不是数字", s))
        })
        .collect()
}

fn parse_kind(value: &str) -> Result<ChartKind, String> {
    Ok(match value.to_ascii_lowercase().as_str() {
        "bar" => ChartKind::Bar,
        "line" => ChartKind::Line,
        "area" => ChartKind::Area,
        "pie" => ChartKind::Pie,
        "donut" | "ring" => ChartKind::Donut,
        "scatter" => ChartKind::Scatter,
        "radar" => ChartKind::Radar,
        "gauge" => ChartKind::Gauge,
        "heatmap" => ChartKind::Heatmap,
        "funnel" => ChartKind::Funnel,
        "option" => ChartKind::Custom,
        other => {
            return Err(format!(
                "type 不支持 `{other}`（可用 bar/line/area/pie/donut/scatter/radar/gauge/heatmap/funnel/option）"
            ))
        }
    })
}

/// 解析 ```chart 围栏块（纯函数，便于单测）。
///
/// 简写语法：
/// ```text
/// type: bar | line | area | pie | donut | scatter | radar | gauge | heatmap | funnel
/// title: 本周涨跌
/// unit: %
/// labels: 铜, 铝, 锂
/// series: 周涨跌 = -2.1, -0.8, -4.3
/// stack: true          # 可选，柱状/面积堆叠
/// height: 340          # 可选，画布高度
/// ```
///
/// 高级用法：块内直接写 ECharts `option` JSON（`type: option` 可省略，只要以 `{` 开头）。
pub fn parse_chart_block(body: &str) -> Result<ChartSpec, String> {
    let trimmed = body.trim();
    if trimmed.starts_with('{') {
        let raw: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("ECharts option JSON 解析失败：{e}"))?;
        return Ok(ChartSpec {
            kind: ChartKind::Custom,
            title: String::new(),
            unit: String::new(),
            labels: Vec::new(),
            series: Vec::new(),
            height: 340,
            stack: false,
            raw: Some(raw),
        });
    }

    let mut kind = ChartKind::Bar;
    let mut title = String::new();
    let mut unit = String::new();
    let mut labels: Vec<String> = Vec::new();
    let mut series: Vec<ChartSeries> = Vec::new();
    let mut height = 340u32;
    let mut stack = false;
    let mut custom_body: Vec<&str> = Vec::new();
    let mut in_custom = false;

    for line in body.lines() {
        let line = line.trim();
        if in_custom {
            custom_body.push(line);
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('{') {
            in_custom = true;
            custom_body.push(line);
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            return Err(format!("无法识别的一行：`{line}`（应为 `键: 值`）"));
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        match key.as_str() {
            "type" => kind = parse_kind(value)?,
            "title" => title = value.to_string(),
            "unit" => unit = value.to_string(),
            "labels" => {
                labels = value
                    .split([',', '，'])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            }
            "series" => {
                let (name, raw) = match value.split_once('=') {
                    Some((n, v)) => (n.trim().to_string(), v.trim()),
                    None => (format!("系列{}", series.len() + 1), value),
                };
                let values = parse_numbers(raw)?;
                series.push(ChartSeries {
                    name: if name.is_empty() {
                        format!("系列{}", series.len() + 1)
                    } else {
                        name
                    },
                    values,
                });
            }
            "height" => {
                height = value
                    .parse::<u32>()
                    .map_err(|_| format!("height 必须是数字，收到 `{value}`"))?
                    .clamp(180, 900)
            }
            "stack" => {
                stack = matches!(
                    value.to_ascii_lowercase().as_str(),
                    "true" | "1" | "yes" | "on"
                )
            }
            other => {
                return Err(format!(
                    "不支持的键 `{other}`（可用 type/title/unit/labels/series/height/stack）"
                ))
            }
        }
    }

    if kind == ChartKind::Custom || in_custom {
        let json = custom_body.join("\n");
        let raw: serde_json::Value = serde_json::from_str(if json.is_empty() {
            trimmed
        } else {
            json.trim()
        })
        .map_err(|e| format!("ECharts option JSON 解析失败：{e}"))?;
        return Ok(ChartSpec {
            kind: ChartKind::Custom,
            title,
            unit,
            labels,
            series,
            height,
            stack,
            raw: Some(raw),
        });
    }

    if series.is_empty() {
        return Err("缺少 series（格式：`series: 名称 = 数值1, 数值2`）".into());
    }
    let needs_labels = !matches!(kind, ChartKind::Gauge);
    if needs_labels && labels.is_empty() {
        return Err("缺少 labels（用逗号分隔的横轴标签）".into());
    }
    if needs_labels {
        for s in &series {
            if s.values.len() != labels.len() {
                return Err(format!(
                    "series `{}` 有 {} 个值，但 labels 有 {} 个（必须一一对应）",
                    s.name,
                    s.values.len(),
                    labels.len()
                ));
            }
        }
    }
    Ok(ChartSpec {
        kind,
        title,
        unit,
        labels,
        series,
        height,
        stack,
        raw: None,
    })
}

fn kind_name(kind: &ChartKind) -> &'static str {
    match kind {
        ChartKind::Bar => "bar",
        ChartKind::Line => "line",
        ChartKind::Area => "area",
        ChartKind::Pie => "pie",
        ChartKind::Donut => "donut",
        ChartKind::Scatter => "scatter",
        ChartKind::Radar => "radar",
        ChartKind::Gauge => "gauge",
        ChartKind::Heatmap => "heatmap",
        ChartKind::Funnel => "funnel",
        ChartKind::Custom => "custom",
    }
}

fn chart_title(spec: &ChartSpec) -> String {
    if spec.title.is_empty() {
        "数据图表".to_string()
    } else {
        spec.title.clone()
    }
}

fn base_option(spec: &ChartSpec) -> serde_json::Value {
    let unit_suffix = if spec.unit.is_empty() {
        String::new()
    } else {
        format!("（单位：{}）", spec.unit)
    };
    serde_json::json!({
        "title": {
            "text": format!("{}{}", chart_title(spec), unit_suffix),
            "left": 8,
            "top": 4,
            "textStyle": { "fontSize": 14, "fontWeight": 600 }
        },
        "animationDuration": 900,
        "animationEasing": "cubicOut",
        "textStyle": { "fontSize": 12 }
    })
}

/// 把图表规格转成 ECharts option（纯函数，便于单测）。
pub fn build_echarts_option(spec: &ChartSpec) -> Result<serde_json::Value, String> {
    if spec.kind == ChartKind::Custom {
        let mut raw = spec.raw.clone().ok_or_else(|| "option 为空".to_string())?;
        if let Some(obj) = raw.as_object_mut() {
            obj.insert(
                "__dsy".into(),
                serde_json::json!({ "kind": kind_name(&spec.kind) }),
            );
        }
        return Ok(raw);
    }
    let labels = &spec.labels;
    let unit = &spec.unit;
    let mut o = base_option(spec);
    let obj = o.as_object_mut().expect("base option 是对象");
    obj.insert(
        "__dsy".into(),
        serde_json::json!({ "kind": kind_name(&spec.kind) }),
    );

    match spec.kind {
        ChartKind::Bar | ChartKind::Line | ChartKind::Area | ChartKind::Scatter => {
            let series: Vec<serde_json::Value> = spec
                .series
                .iter()
                .map(|s| {
                    let mut v = serde_json::json!({
                        "name": s.name,
                        "data": s.values,
                    });
                    let ty = match spec.kind {
                        ChartKind::Bar => "bar",
                        ChartKind::Line | ChartKind::Area => "line",
                        _ => "scatter",
                    };
                    v["type"] = serde_json::json!(ty);
                    if spec.kind == ChartKind::Bar {
                        v["barMaxWidth"] = serde_json::json!(30);
                        v["itemStyle"] = serde_json::json!({ "borderRadius": [3, 3, 0, 0] });
                        v["label"] = serde_json::json!({
                            "show": labels.len() <= 10 && spec.series.len() == 1,
                            "position": "top"
                        });
                        if spec.stack {
                            v["stack"] = serde_json::json!("total");
                        }
                    }
                    if spec.kind == ChartKind::Line || spec.kind == ChartKind::Area {
                        v["smooth"] = serde_json::json!(true);
                        v["symbolSize"] = serde_json::json!(6);
                        v["lineStyle"] = serde_json::json!({ "width": 2.2 });
                        if spec.kind == ChartKind::Area {
                            v["areaStyle"] = serde_json::json!({ "opacity": 0.18 });
                            if spec.stack {
                                v["stack"] = serde_json::json!("total");
                            }
                        }
                    }
                    if spec.kind == ChartKind::Scatter {
                        v["symbolSize"] = serde_json::json!(10);
                    }
                    v
                })
                .collect();
            obj.insert(
                "tooltip".into(),
                serde_json::json!({ "trigger": "axis", "axisPointer": { "type": "shadow" } }),
            );
            obj.insert(
                "grid".into(),
                serde_json::json!({ "left": 12, "right": 20, "top": 52, "bottom": 12, "containLabel": true }),
            );
            obj.insert(
                "xAxis".into(),
                serde_json::json!({ "type": "category", "data": labels, "boundaryGap": true }),
            );
            obj.insert(
                "yAxis".into(),
                serde_json::json!({ "type": "value",
                    "splitLine": { "lineStyle": { "type": "dashed" } } }),
            );
            obj.insert("series".into(), serde_json::Value::Array(series));
        }
        ChartKind::Pie | ChartKind::Donut | ChartKind::Funnel => {
            let s = spec.series.first().expect("series 非空");
            let data: Vec<serde_json::Value> = labels
                .iter()
                .zip(s.values.iter())
                .map(|(name, v)| serde_json::json!({ "name": name, "value": v }))
                .collect();
            obj.insert(
                "tooltip".into(),
                serde_json::json!({ "trigger": "item", "formatter": "{b}: {c} ({d}%)" }),
            );
            obj.insert(
                "legend".into(),
                serde_json::json!({ "bottom": 0, "type": "scroll" }),
            );
            if spec.kind == ChartKind::Funnel {
                obj.insert(
                    "series".into(),
                    serde_json::json!([{
                        "type": "funnel",
                        "left": "8%", "right": "8%", "top": 48, "bottom": 24,
                        "label": { "formatter": "{b}: {c}" },
                        "data": data
                    }]),
                );
            } else {
                let radius = if spec.kind == ChartKind::Donut {
                    serde_json::json!(["42%", "68%"])
                } else {
                    serde_json::json!("64%")
                };
                obj.insert(
                    "series".into(),
                    serde_json::json!([{
                        "type": "pie",
                        "radius": radius,
                        "center": ["50%", "52%"],
                        "avoidLabelOverlap": true,
                        "label": { "formatter": "{b} {d}%" },
                        "data": data
                    }]),
                );
            }
        }
        ChartKind::Radar => {
            let max = spec
                .series
                .iter()
                .flat_map(|s| s.values.iter())
                .fold(0.0f64, |a, b| a.max(b.abs()))
                .max(1e-9);
            let indicators: Vec<serde_json::Value> = labels
                .iter()
                .map(|l| serde_json::json!({ "name": l, "max": (max * 1.2 * 100.0).round() / 100.0 }))
                .collect();
            let data: Vec<serde_json::Value> = spec
                .series
                .iter()
                .map(|s| serde_json::json!({ "name": s.name, "value": s.values }))
                .collect();
            obj.insert("tooltip".into(), serde_json::json!({ "trigger": "item" }));
            obj.insert(
                "legend".into(),
                serde_json::json!({ "bottom": 0, "type": "scroll" }),
            );
            obj.insert(
                "radar".into(),
                serde_json::json!({ "center": ["50%", "54%"], "radius": "62%", "indicator": indicators }),
            );
            obj.insert(
                "series".into(),
                serde_json::json!([{ "type": "radar", "data": data }]),
            );
        }
        ChartKind::Gauge => {
            let s = spec.series.first().expect("series 非空");
            let v = s.values.first().copied().unwrap_or(0.0);
            let max = (v.abs() * 1.2).max(100.0);
            obj.insert(
                "series".into(),
                serde_json::json!([{
                    "type": "gauge",
                    "min": 0,
                    "max": max,
                    "progress": { "show": true, "width": 12 },
                    "axisLine": { "lineStyle": { "width": 12 } },
                    "pointer": { "width": 4 },
                    "detail": {
                        "valueAnimation": true,
                        "formatter": format!("{{value}}{}", unit),
                        "fontSize": 22
                    },
                    "data": [{ "value": v, "name": if s.name.is_empty() { chart_title(spec) } else { s.name.clone() } }]
                }]),
            );
        }
        ChartKind::Heatmap => {
            let max = spec
                .series
                .iter()
                .flat_map(|s| s.values.iter())
                .fold(0.0f64, |a, b| a.max(*b));
            let rows: Vec<String> = spec.series.iter().map(|s| s.name.clone()).collect();
            let mut data: Vec<serde_json::Value> = Vec::new();
            for (y, s) in spec.series.iter().enumerate() {
                for (x, v) in s.values.iter().enumerate() {
                    data.push(serde_json::json!([x, y, v]));
                }
            }
            obj.insert("tooltip".into(), serde_json::json!({ "position": "top" }));
            obj.insert(
                "grid".into(),
                serde_json::json!({ "left": 12, "right": 20, "top": 52, "bottom": 56, "containLabel": true }),
            );
            obj.insert(
                "xAxis".into(),
                serde_json::json!({ "type": "category", "data": labels }),
            );
            obj.insert(
                "yAxis".into(),
                serde_json::json!({ "type": "category", "data": rows }),
            );
            obj.insert(
                "visualMap".into(),
                serde_json::json!({ "min": 0, "max": max.max(1.0), "calculable": true,
                    "orient": "horizontal", "left": "center", "bottom": 0 }),
            );
            obj.insert(
                "series".into(),
                serde_json::json!([{ "type": "heatmap", "data": data,
                    "label": { "show": true } }]),
            );
        }
        ChartKind::Custom => unreachable!(),
    }
    Ok(o)
}

/// ECharts 注入脚本：滚动进入视口再初始化（带入场动画）、主题切换重绘、resize、打印适配。
const ECHARTS_INIT_JS: &str = r#"
(function () {
  var OPTIONS = __DSY_OPTIONS__;
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var PALETTE = {
    light: ['#C2410C', '#0E7490', '#4D7C0F', '#7C3AED', '#B45309', '#0F766E'],
    dark: ['#F97316', '#22D3EE', '#A3E635', '#A78BFA', '#FBBF24', '#2DD4BF']
  };
  function isDark() {
    var m = document.documentElement.getAttribute('data-mode');
    if (m === 'dark') return true;
    if (m === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function responsive(o, width) {
    var info = o.__dsy || {};
    var kind = info.kind || '';
    var narrow = width > 0 && width < 560;
    if (o.grid) {
      o.grid = Object.assign({}, o.grid, { left: narrow ? 2 : 12, right: narrow ? 6 : 20, containLabel: true });
    }
    [].concat(o.xAxis || [], o.yAxis || []).forEach(function (ax) {
      if (!ax || typeof ax !== 'object') return;
      ax.axisLabel = Object.assign({}, ax.axisLabel, narrow ? { fontSize: 10 } : {});
    });
    if (narrow && (kind === 'bar' || kind === 'scatter' || kind === 'line' || kind === 'area')) {
      var cats = (o.xAxis && o.xAxis[0] && o.xAxis[0].data) || [];
      var crowded = cats.length > 6 || cats.some(function (x) { return String(x).length > 4; });
      if (crowded) {
        [].concat(o.xAxis || []).forEach(function (ax) {
          if (ax) ax.axisLabel = Object.assign({}, ax.axisLabel, { rotate: 30 });
        });
      }
    }
    if (o.title) o.title.textStyle = Object.assign({}, o.title.textStyle, { fontSize: narrow ? 12 : 14 });
    if (narrow && (kind === 'pie' || kind === 'donut')) {
      (o.series || []).forEach(function (s) {
        s.radius = kind === 'donut' ? ['38%', '58%'] : '58%';
        s.center = ['50%', '46%'];
        s.label = Object.assign({}, s.label, {
          show: true, position: 'inside', formatter: '{d}%', color: '#fff', fontSize: 11
        });
        s.labelLine = { show: false };
      });
    }
    if (narrow && kind === 'radar' && o.radar) o.radar.radius = '56%';
    return o;
  }

  function themed(opt, dark) {
    var o = JSON.parse(JSON.stringify(opt));
    var c = dark
      ? { text: '#E2E8F0', sub: '#94A3B8', line: 'rgba(255,255,255,.14)', axis: 'rgba(255,255,255,.32)' }
      : { text: '#0F172A', sub: '#64748B', line: 'rgba(15,23,42,.12)', axis: 'rgba(15,23,42,.30)' };
    o.color = dark ? PALETTE.dark : PALETTE.light;
    o.animation = !REDUCED;
    o.textStyle = Object.assign({}, o.textStyle, { color: c.text });
    if (o.title) o.title.textStyle = Object.assign({}, o.title.textStyle, { color: c.text });
    if (o.legend) o.legend.textStyle = Object.assign({}, o.legend.textStyle, { color: c.sub });
    if (o.tooltip) o.tooltip.textStyle = Object.assign({}, o.tooltip.textStyle, { color: c.text });
    [].concat(o.xAxis || [], o.yAxis || []).forEach(function (ax) {
      ax.axisLine = { lineStyle: { color: c.axis } };
      ax.axisLabel = Object.assign({}, ax.axisLabel, { color: c.sub });
      ax.splitLine = Object.assign({}, ax.splitLine, { lineStyle: { color: c.line } });
      if (ax.nameTextStyle) ax.nameTextStyle.color = c.sub;
    });
    if (o.radar) {
      o.radar.axisName = { color: c.sub };
      o.radar.axisLine = { lineStyle: { color: c.line } };
      o.radar.splitLine = { lineStyle: { color: c.line } };
      o.radar.splitArea = { areaStyle: { color: ['rgba(148,163,184,.08)', 'rgba(148,163,184,.03)'] } };
    }
    if (o.visualMap) o.visualMap.textStyle = { color: c.sub };
    (o.series || []).forEach(function (s) {
      if (s.type === 'pie' || s.type === 'funnel') {
        s.label = Object.assign({}, s.label, { color: c.text });
        s.itemStyle = Object.assign({}, s.itemStyle, { borderColor: dark ? '#0B1220' : '#FFFFFF', borderWidth: 2 });
      }
      if (s.type === 'gauge') {
        s.axisLabel = Object.assign({}, s.axisLabel, { color: c.sub });
        s.title = Object.assign({}, s.title, { color: c.sub });
        s.detail = Object.assign({}, s.detail, { color: c.text });
      }
    });
    return o;
  }
  var mounted = [];
  function mount(el) {
    if (el.getAttribute('data-mounted')) return;
    el.setAttribute('data-mounted', '1');
    var idx = parseInt(el.getAttribute('data-dsy-chart'), 10);
    try {
      var inst = window.echarts.init(el, null, { renderer: 'canvas' });
      var w = el.clientWidth || 0;
      inst.setOption(responsive(themed(OPTIONS[idx], isDark()), w), true);
      mounted.push({ inst: inst, idx: idx, el: el });
    } catch (err) {
      // 单个图表配置有误不应拖垮整页：保留标题文字并给出可读提示
      el.setAttribute('data-error', '1');
      el.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#94A3B8;font-size:12px">图表渲染失败（配置有误）</div>';
      if (window.console) console.error('[dsy-chart] option #' + idx, err);
    }
  }
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-dsy-chart]'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { mount(en.target); io.unobserve(en.target); }
      });
    }, { rootMargin: '160px 0px' });
    nodes.forEach(function (el) { io.observe(el); });
  } else {
    nodes.forEach(mount);
  }
  function redraw() {
    var dark = isDark();
    mounted.forEach(function (c) {
      var w = c.el.clientWidth || 0;
      c.inst.setOption(responsive(themed(OPTIONS[c.idx], dark), w), true);
      c.inst.resize();
    });
  }
  new MutationObserver(redraw).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-mode', 'data-theme']
  });
  var timer;
  function fitAll() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var dark = isDark();
      mounted.forEach(function (c) {
        var w = c.el.clientWidth || 0;
        c.inst.setOption(responsive(themed(OPTIONS[c.idx], dark), w), true);
        c.inst.resize();
      });
    }, 120);
  }
  window.addEventListener('resize', fitAll);
  if ('ResizeObserver' in window) {
    var ro = new ResizeObserver(function () { fitAll(); });
    nodes.forEach(function (el) { ro.observe(el); });
  }
  window.addEventListener('beforeprint', function () {
    nodes.forEach(mount);
    mounted.forEach(function (c) {
      var w = c.el.clientWidth || 0;
      c.inst.setOption(responsive(themed(OPTIONS[c.idx], isDark()), w), true);
      c.inst.resize();
    });
  });
})();
"#;

/// 把 ECharts（含初始化脚本）内联进页面：在 `</body>` 前插入。
/// 只在页面确实包含 chart 块时调用。
pub fn inject_echarts(html: &str, specs: &[ChartSpec], echarts_js: &str) -> Result<String, String> {
    if specs.is_empty() {
        return Ok(html.to_string());
    }
    let opts: Vec<serde_json::Value> = specs
        .iter()
        .map(build_echarts_option)
        .collect::<Result<_, _>>()?;
    let json = serde_json::to_string(&opts).map_err(|e| format!("图表配置序列化失败：{e}"))?;
    // 防止 JSON 里的 `</` 提前闭合 <script>
    let json = json.replace("</", "<\\/");
    let init = ECHARTS_INIT_JS.replace("__DSY_OPTIONS__", &json);
    let block = format!(
        "<style id=\"dsy-chart-style\">.dsy-echart{{width:100%;box-sizing:border-box}}@media (max-width:640px){{.dsy-echart{{height:280px !important}}}}</style>\n<script>/* Apache ECharts 5.5.1 (Apache-2.0) */\n{echarts_js}\n</script>\n<script>\n{init}\n</script>\n"
    );
    let at = html
        .rfind("</body>")
        .or_else(|| html.to_lowercase().rfind("</body>"));
    Ok(match at {
        Some(i) => {
            let mut out = String::with_capacity(html.len() + block.len());
            out.push_str(&html[..i]);
            out.push_str(&block);
            out.push_str(&html[i..]);
            out
        }
        None => format!("{html}\n{block}"),
    })
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn fmt_num(v: f64) -> String {
    if (v - v.round()).abs() < 0.005 {
        format!("{}", v.round() as i64)
    } else {
        let s = format!("{:.2}", v);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// 让刻度落在 1/2/2.5/5 × 10^k 上（目标约 `target` 段）。
fn nice_step(range: f64, target: usize) -> f64 {
    if range <= 0.0 || target == 0 {
        return 1.0;
    }
    let raw = range / target as f64;
    let mag = 10f64.powf(raw.log10().floor());
    let norm = raw / mag;
    let step = if norm <= 1.0 {
        1.0
    } else if norm <= 2.0 {
        2.0
    } else if norm <= 2.5 {
        2.5
    } else if norm <= 5.0 {
        5.0
    } else {
        10.0
    };
    step * mag
}

/// 兜底：ECharts 资源缺失时，把 bar/line/area 渲染成内联 SVG（其他类型明确报错）。
pub fn render_chart_svg(spec: &ChartSpec) -> Result<String, String> {
    if !matches!(
        spec.kind,
        ChartKind::Bar | ChartKind::Line | ChartKind::Area
    ) {
        return Err(format!(
            "ECharts 运行时缺失，无法渲染 {:?} 图表（仅 bar/line/area 可回退 SVG）",
            spec.kind
        ));
    }
    const W: f64 = 760.0;
    const H: f64 = 320.0;
    const LEFT: f64 = 64.0;
    const RIGHT: f64 = 24.0;
    const TOP: f64 = 58.0;
    const BOTTOM: f64 = 54.0;
    let plot_w = W - LEFT - RIGHT;
    let plot_h = H - TOP - BOTTOM;
    let colors = [
        "#C2410C", "#0E7490", "#4D7C0F", "#7C3AED", "#B45309", "#0F766E",
    ];

    let mut raw_lo = 0.0f64;
    let mut raw_hi = 0.0f64;
    for s in &spec.series {
        for &v in &s.values {
            raw_lo = raw_lo.min(v);
            raw_hi = raw_hi.max(v);
        }
    }
    let step = nice_step((raw_hi - raw_lo).max(1e-9), 5);
    let lo = (raw_lo / step).floor() * step;
    let hi = (raw_hi / step).ceil() * step;
    let hi = if (hi - lo).abs() < f64::EPSILON {
        lo + step
    } else {
        hi
    };
    let span = hi - lo;
    let ticks = ((span / step).round() as usize).clamp(1, 10);
    let y_of = |v: f64| TOP + (hi - v) / span * plot_h;
    let n = spec.labels.len().max(1);
    let slot = plot_w / n as f64;
    let x_center = |i: usize| LEFT + slot * (i as f64 + 0.5);

    let title = chart_title(spec);
    let unit_suffix = if spec.unit.is_empty() {
        String::new()
    } else {
        format!("（单位：{}）", spec.unit)
    };
    let aria = format!(
        "{}{}，{} 组数据，{} 个系列",
        title,
        unit_suffix,
        n,
        spec.series.len()
    );

    let mut svg = String::new();
    svg.push_str(&format!(
        r##"<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="{}" style="max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<style>
.c-grid{{stroke:rgba(15,23,42,.10);stroke-width:1}}
.c-axis{{stroke:rgba(15,23,42,.28);stroke-width:1}}
.c-text{{fill:#64748B;font-size:11px}}
.c-title{{fill:#0F172A;font-size:15px;font-weight:650}}
.c-value{{fill:#475569;font-size:10px}}
@media (prefers-color-scheme: dark){{
  .c-grid{{stroke:rgba(255,255,255,.10)}}
  .c-axis{{stroke:rgba(255,255,255,.28)}}
  .c-text{{fill:#94A3B8}}
  .c-title{{fill:#E2E8F0}}
  .c-value{{fill:#A8B6C4}}
}}
</style>
"##,
        xml_escape(&aria)
    ));
    svg.push_str(&format!(
        "<text class=\"c-title\" x=\"{LEFT}\" y=\"26\">{}{}</text>\n",
        xml_escape(&title),
        xml_escape(&unit_suffix)
    ));
    for i in 0..=ticks {
        let v = lo + step * i as f64;
        let y = y_of(v);
        svg.push_str(&format!(
            "<line class=\"c-grid\" x1=\"{LEFT}\" y1=\"{y:.1}\" x2=\"{:.1}\" y2=\"{y:.1}\"/>\n",
            W - RIGHT
        ));
        svg.push_str(&format!(
            "<text class=\"c-text\" x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"end\">{}</text>\n",
            LEFT - 8.0,
            y + 3.5,
            xml_escape(&fmt_num(v))
        ));
    }
    let y0 = y_of(0.0);
    svg.push_str(&format!(
        "<line class=\"c-axis\" x1=\"{LEFT}\" y1=\"{y0:.1}\" x2=\"{:.1}\" y2=\"{y0:.1}\"/>\n",
        W - RIGHT
    ));
    for (i, label) in spec.labels.iter().enumerate() {
        svg.push_str(&format!(
            "<text class=\"c-text\" x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\">{}</text>\n",
            x_center(i),
            H - BOTTOM + 20.0,
            xml_escape(label)
        ));
    }
    for (si, s) in spec.series.iter().enumerate() {
        let lx = LEFT + 2.0 + si as f64 * 112.0;
        svg.push_str(&format!(
            "<rect x=\"{lx:.1}\" y=\"33\" width=\"10\" height=\"10\" rx=\"2\" fill=\"{}\"/>\n",
            colors[si % colors.len()]
        ));
        svg.push_str(&format!(
            "<text class=\"c-text\" x=\"{lx:.1}\" y=\"52\">{}</text>\n",
            xml_escape(&s.name)
        ));
    }
    if spec.kind == ChartKind::Bar {
        let group = slot * 0.72;
        let bar_w = (group / spec.series.len() as f64).max(2.0);
        for (si, s) in spec.series.iter().enumerate() {
            for (i, &v) in s.values.iter().enumerate() {
                let x = x_center(i) - group / 2.0 + bar_w * si as f64;
                let y = y_of(v);
                let (y_rect, h_rect) = if v >= 0.0 {
                    (y, (y0 - y).max(0.5))
                } else {
                    (y0, (y - y0).max(0.5))
                };
                svg.push_str(&format!(
                    "<rect x=\"{x:.1}\" y=\"{y_rect:.1}\" width=\"{:.1}\" height=\"{h_rect:.1}\" rx=\"2\" fill=\"{}\"/>\n",
                    (bar_w - 1.5).max(1.0),
                    colors[si % colors.len()]
                ));
                if spec.series.len() == 1 && n <= 12 {
                    let ty = if v >= 0.0 { y - 5.0 } else { y + 13.0 };
                    svg.push_str(&format!(
                        "<text class=\"c-value\" x=\"{x:.1}\" y=\"{ty:.1}\" text-anchor=\"middle\">{}{}</text>\n",
                        xml_escape(&fmt_num(v)),
                        xml_escape(&spec.unit)
                    ));
                }
            }
        }
    } else {
        for (si, s) in spec.series.iter().enumerate() {
            let points: Vec<String> = s
                .values
                .iter()
                .enumerate()
                .map(|(i, &v)| format!("{:.1},{:.1}", x_center(i), y_of(v)))
                .collect();
            if spec.kind == ChartKind::Area {
                let mut area = format!("{LEFT:.1},{y0:.1} ");
                area.push_str(&points.join(" "));
                area.push_str(&format!(" {:.1},{y0:.1}", x_center(n - 1)));
                svg.push_str(&format!(
                    "<polygon fill=\"{}\" opacity=\"0.18\" points=\"{}\"/>\n",
                    colors[si % colors.len()],
                    area
                ));
            }
            svg.push_str(&format!(
                "<polyline fill=\"none\" stroke=\"{}\" stroke-width=\"2.2\" stroke-linejoin=\"round\" points=\"{}\"/>\n",
                colors[si % colors.len()],
                points.join(" ")
            ));
            for (i, &v) in s.values.iter().enumerate() {
                svg.push_str(&format!(
                    "<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"3\" fill=\"{}\"/>\n",
                    x_center(i),
                    y_of(v),
                    colors[si % colors.len()]
                ));
            }
        }
    }
    svg.push_str("</svg>");
    Ok(svg)
}

/// 把草稿里的 ```chart 围栏块替换成占位节点（ECharts）或内联 SVG（回退）。
/// 返回 (新草稿, 图表规格列表)。
pub fn expand_chart_blocks(
    markdown: &str,
    use_echarts: bool,
) -> Result<(String, Vec<ChartSpec>), String> {
    let mut out = String::new();
    let mut body = String::new();
    let mut in_chart = false;
    let mut specs: Vec<ChartSpec> = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim();
        if !in_chart {
            if trimmed.starts_with("```chart") {
                in_chart = true;
                body.clear();
            } else {
                out.push_str(line);
                out.push('\n');
            }
            continue;
        }
        if trimmed == "```" {
            let spec = parse_chart_block(&body).map_err(|e| format!("图表块解析失败：{e}"))?;
            if use_echarts {
                let idx = specs.len();
                out.push_str("```html\n");
                out.push_str(&format!(
                    "<div class=\"dsy-echart\" data-dsy-chart=\"{idx}\" style=\"width:100%;height:{}px\"></div>\n",
                    spec.height
                ));
                out.push_str("```\n");
            } else {
                let svg = render_chart_svg(&spec)?;
                out.push_str("```html\n");
                out.push_str(&svg);
                out.push_str("\n```\n");
            }
            specs.push(spec);
            in_chart = false;
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }
    if in_chart {
        return Err("图表块未闭合：缺少结尾的 ```".to_string());
    }
    Ok((out, specs))
}

/// 报告类草稿（≥ 4 个 `## 面板`）默认用 `doc` 模板：单栏阅读 + 生成目录。
pub fn pick_template(markdown: &str, explicit: Option<&str>) -> String {
    if let Some(t) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return t.to_ascii_lowercase();
    }
    let panels = markdown.lines().filter(|l| l.starts_with("## ")).count();
    if panels >= 4 {
        "doc".to_string()
    } else {
        "sheet".to_string()
    }
}

/// 是否需要 Tailwind：显式参数优先；缺省时检测草稿里是否有 `class="..."`。
pub fn wants_tailwind(markdown: &str, explicit: Option<bool>) -> bool {
    explicit.unwrap_or_else(|| markdown.contains("class=\"") || markdown.contains("class='"))
}

/// 把预编译 Tailwind CSS 内联进 `<head>`（工具类带 `!important`，可覆盖页面样式）。
pub fn inject_tailwind(html: &str, css: &str) -> String {
    let block = format!("<style id=\"dsy-tailwind\">{css}</style>\n");
    let at = html
        .rfind("</head>")
        .or_else(|| html.to_lowercase().rfind("</head>"));
    match at {
        Some(i) => format!("{}{}{}", &html[..i], block, &html[i..]),
        None => format!("{block}{html}"),
    }
}

/// 渲染后的离线自检：找外部脚本/样式/图片引用（离线页面里这些会加载失败）。
pub fn offline_warnings(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out: Vec<String> = Vec::new();
    let checks = [
        ("<script src=\"http", "外部脚本引用"),
        ("<script src='http", "外部脚本引用"),
        ("<link rel=\"stylesheet\" href=\"http", "外部样式表引用"),
        ("<link rel='stylesheet' href='http", "外部样式表引用"),
        ("<img src=\"http", "外部图片引用"),
        ("<img src='http", "外部图片引用"),
        ("url(http", "CSS 外部资源引用"),
    ];
    for (needle, label) in checks {
        if lower.contains(needle) && !out.iter().any(|w| w.contains(label)) {
            out.push(format!(
                "{label}：离线打开时可能加载失败（页面其余内容不受影响）"
            ));
        }
    }
    out
}

/// 渲染一页 HTML：草稿 → 临时文件 → node am.mjs render -o <out> --no-open。
///
/// 与其它命令型工具一致：沙箱包装 + 超时 + 审计，失败信息原样带回给模型（上游 CLI 会打印
/// `✗ L<行> [组件] …` 与 `Correct example:`，模型据此改那一行重试）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn answer_html(
    app: AppHandle,
    db: State<'_, Database>,
    markdown: String,
    title: Option<String>,
    lang: Option<String>,
    out_path: Option<String>,
    template: Option<String>,
    theme: Option<String>,
    tailwind: Option<bool>,
    cwd: Option<String>,
) -> Result<AnswerHtmlResult, String> {
    let md = markdown.trim();
    if md.is_empty() {
        return Err("answer_html 需要 markdown 参数（页面的 Markdown 草稿）".to_string());
    }
    // 渲染器不含数学引擎：LaTeX 必须在这里拦下（否则页面上会原样显示源码）
    let latex = latex_hits(md);
    if !latex.is_empty() {
        let msg = latex_error(&latex);
        let _ = db.log_tool_call("answer_html", "latex-precheck", &msg, true, 0);
        return Err(msg);
    }

    let original_md = md;
    // ```chart 围栏块 → ECharts 占位节点（模型不需要手算坐标）；
    // ECharts 资源缺失时回退内联 SVG（bar/line/area）。
    let echarts = locate_echarts(&app);
    let use_echarts = echarts.is_some();
    let (md_expanded, chart_specs) = match expand_chart_blocks(md, use_echarts) {
        Ok(v) => v,
        Err(e) => {
            let _ = db.log_tool_call("answer_html", "chart-precheck", &e, true, 0);
            return Err(e);
        }
    };
    let chart_count = chart_specs.len();
    let md = md_expanded.trim();
    let use_tailwind = wants_tailwind(original_md, tailwind);

    // 模板：显式指定优先；报告类长文（≥4 个面板）自动用 doc（带目录）
    let template = pick_template(md, template.as_deref());
    if !matches!(template.as_str(), "sheet" | "doc") {
        return Err(format!("template 只能是 sheet 或 doc，收到 `{template}`"));
    }
    let theme = theme
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase);
    if let Some(t) = theme.as_deref() {
        if !matches!(t, "auto" | "blueprint" | "shadcn" | "paper") {
            return Err(format!(
                "theme 只能是 auto / blueprint / shadcn / paper，收到 `{t}`"
            ));
        }
    }

    // 1) 内嵌 CLI
    let cli = locate_cli(&app).ok_or_else(|| {
        format!(
            "未找到内嵌渲染器 {CLI_FILE}（打包时应作为 Tauri resource 随包分发；开发态应在 src-tauri/resources/{CLI_FILE}）"
        )
    })?;

    // 2) Node 运行时（上游要求 ≥ 20；缺失/过低直接给可读提示，不让模型瞎试）
    let home = std::env::var("HOME").unwrap_or_default();
    let (node_bin, node_ver) = locate_node(&home).await.ok_or_else(|| {
        format!(
            "未找到可用的 Node.js（本功能需要 Node ≥ {MIN_NODE_MAJOR}）。请安装 Node 后重试，或改用普通 Markdown 回答（HTML 讲解页需要 Node 才能渲染）。"
        )
    })?;

    // 3) 草稿写临时文件（$TMPDIR 在沙箱里天然可写；避免 heredoc 转义问题）
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let slug = slugify(title.as_deref().unwrap_or(md.lines().next().unwrap_or("")));
    let file_name = format!("{slug}-{stamp}.html");
    let draft_path =
        std::env::temp_dir().join(format!("daoshengyi-am-{}-{}.md", std::process::id(), stamp));
    std::fs::write(
        &draft_path,
        build_draft(md, title.as_deref(), lang.as_deref()),
    )
    .map_err(|e| format!("写入临时草稿失败（{}）: {e}", draft_path.display()))?;

    // 4) 输出路径：显式路径过 P-A8 白名单，其余一律落产物目录
    let mut cfg = sandbox_config_for(
        &db,
        None,
        cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()),
    );
    let out_result = match out_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => sandbox_file_path(&db, raw)
            .and_then(|p| resolve_out_path(Some(&p), &cfg, &home, &file_name)),
        None => resolve_out_path(None, &cfg, &home, &file_name),
    };
    let out = match out_result {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&draft_path);
            return Err(e);
        }
    };
    if let Some(parent) = out.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            let _ = std::fs::remove_file(&draft_path);
            return Err(format!("创建输出目录失败（{}）: {e}", parent.display()));
        }
    }
    // 沙箱可写区收敛到**输出目录**：本命令只写这一处（草稿与 CLI 自身状态都在 TMPDIR）。
    // 这样即使用户把「工作区」设得很宽（例如主目录），产物也只落在产物目录里。
    if cfg.mode.trim().eq_ignore_ascii_case("workspace-write") {
        if let Some(dir) = out.parent() {
            cfg.workspace = Some(dir.to_string_lossy().to_string());
        }
    }

    // 5) 执行（沙箱包装 + 超时 + 审计）
    let args = render_args_with(&cli, &draft_path, &out, Some(&template), theme.as_deref());
    let display_cmd = format!("{} {}", node_bin.display(), args.join(" "));
    let workdir = cfg.workspace.clone();
    // AM_HOME 指到临时目录：CLI 自己的状态/缓存不污染用户主目录（也不受沙箱阻拦）
    let am_home = std::env::temp_dir().join("daoshengyi-am-home");
    let envs = vec![("AM_HOME".to_string(), am_home.to_string_lossy().to_string())];
    let start = std::time::Instant::now();
    let rendered = run_render(
        &node_bin,
        &args,
        workdir.as_deref(),
        &cfg,
        RENDER_TIMEOUT_SECS,
        &envs,
    )
    .await;
    let duration = start.elapsed().as_millis() as i64;
    let _ = std::fs::remove_file(&draft_path); // 草稿用完即删（失败也删）

    let (stdout, stderr, exit_code) = match rendered {
        Ok(v) => v,
        Err(e) => {
            let _ = db.log_tool_call("answer_html", &display_cmd, &e, true, duration);
            return Err(e);
        }
    };

    let detail = if stderr.is_empty() {
        stdout.clone()
    } else {
        format!("{stdout}\n{stderr}")
    };

    if exit_code != 0 || !out.exists() {
        let msg = format!(
            "渲染失败（退出码 {exit_code}）：\n{detail}\n\n请按上面的 ✗ / Correct example 只改有问题的那一行草稿，然后重试。"
        );
        let _ = db.log_tool_call("answer_html", &display_cmd, &msg, true, duration);
        return Err(msg);
    }

    // 需要 Tailwind 时内联预编译工具类（不联网、无运行时编译器）
    let mut tailwind_ok = false;
    if use_tailwind {
        match locate_tailwind(&app) {
            Some(css_path) => match std::fs::read_to_string(&css_path) {
                Ok(css) => {
                    let html = std::fs::read_to_string(&out).unwrap_or_default();
                    if let Err(e) = std::fs::write(&out, inject_tailwind(&html, &css)) {
                        let msg = format!("写入 Tailwind 样式失败：{e}");
                        let _ = db.log_tool_call("answer_html", &display_cmd, &msg, true, duration);
                        return Err(msg);
                    }
                    tailwind_ok = true;
                }
                Err(e) => {
                    let msg = format!("读取内嵌 Tailwind 失败（{}）：{e}", css_path.display());
                    let _ = db.log_tool_call("answer_html", &display_cmd, &msg, true, duration);
                    return Err(msg);
                }
            },
            None => {
                let msg = "未找到内嵌 Tailwind 样式（resources/tailwind.css）".to_string();
                let _ = db.log_tool_call("answer_html", &display_cmd, &msg, true, duration);
                return Err(msg);
            }
        }
    }

    // 有图表时把 ECharts + 初始化脚本内联进页面（单文件离线、带入场动画）
    if use_echarts && !chart_specs.is_empty() {
        if let Some(js_path) = echarts.as_deref() {
            match std::fs::read_to_string(js_path) {
                Ok(js) => {
                    let html = std::fs::read_to_string(&out).unwrap_or_default();
                    match inject_echarts(&html, &chart_specs, &js) {
                        Ok(patched) => {
                            if let Err(e) = std::fs::write(&out, patched) {
                                let msg = format!("写入图表脚本失败：{e}");
                                let _ = db.log_tool_call(
                                    "answer_html",
                                    &display_cmd,
                                    &msg,
                                    true,
                                    duration,
                                );
                                return Err(msg);
                            }
                        }
                        Err(e) => {
                            let _ =
                                db.log_tool_call("answer_html", &display_cmd, &e, true, duration);
                            return Err(e);
                        }
                    }
                }
                Err(e) => {
                    let msg = format!("读取内嵌 ECharts 失败（{}）：{e}", js_path.display());
                    let _ = db.log_tool_call("answer_html", &display_cmd, &msg, true, duration);
                    return Err(msg);
                }
            }
        }
    }

    let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    let warnings = std::fs::read_to_string(&out)
        .map(|html| offline_warnings(&html))
        .unwrap_or_default();
    let html_path = out.to_string_lossy().to_string();
    let chart_engine = if chart_count == 0 {
        "none"
    } else if use_echarts {
        "echarts"
    } else {
        "svg"
    };
    let _ = db.log_tool_call(
        "answer_html",
        &format!("title={}", title.as_deref().unwrap_or("-")),
        &format!("{html_path} ({bytes} bytes)"),
        false,
        duration,
    );
    Ok(AnswerHtmlResult {
        html_path,
        node_version: format!("{}.{}", node_ver.0, node_ver.1),
        cli: cli.to_string_lossy().to_string(),
        bytes,
        template,
        charts: chart_count,
        chart_engine: chart_engine.to_string(),
        tailwind: tailwind_ok,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mode: &str, ws: Option<&str>) -> sandbox::SandboxConfig {
        sandbox::SandboxConfig::new(mode, ws, "/Users/tester", sandbox::NetworkPolicy::Allow)
    }

    #[test]
    fn parses_and_gates_node_version() {
        assert_eq!(parse_node_version("v24.16.0\n"), Some((24, 16)));
        assert_eq!(parse_node_version("20.11.1"), Some((20, 11)));
        assert_eq!(parse_node_version("  v22.0.0"), Some((22, 0)));
        assert_eq!(parse_node_version("nonsense"), None);
        assert!(!node_version_ok((18, 20)));
        assert!(node_version_ok((20, 0)));
        assert!(node_version_ok((24, 16)));
    }

    #[test]
    fn node_candidates_prefers_absolute_paths_and_nvm() {
        let c = node_candidates("/Users/tester");
        assert!(c.iter().any(|p| p == Path::new("/opt/homebrew/bin/node")));
        assert!(c
            .iter()
            .any(|p| p == Path::new("/Users/tester/.volta/bin/node")));
        // 不依赖本机是否有 nvm：只要候选里不含相对路径即可（相对路径受启动方式影响）
        assert!(c.iter().all(|p| p.is_absolute() || p == Path::new("node")));
    }

    #[test]
    fn dev_cli_candidates_cover_src_tauri_layout() {
        let exe = Path::new("/Users/x/op/daoshengyi/src-tauri/target/debug/daoshengyi");
        let c = dev_cli_candidates(Some(exe));
        assert!(c.contains(&PathBuf::from(
            "/Users/x/op/daoshengyi/src-tauri/resources/am.mjs"
        )));
    }

    #[test]
    fn build_draft_adds_frontmatter_only_when_needed() {
        // 已有 frontmatter：原样保留（不重复追加）
        let with_fm = "---\ntitle: 原有\n---\n\n## 面板\n正文";
        assert_eq!(build_draft(with_fm, Some("新标题"), None), with_fm);
        // 无 title/lang：不加空 frontmatter
        assert_eq!(build_draft("## 只有正文", None, None), "## 只有正文");
        // 给了 title：补 frontmatter
        let d = build_draft("## 面板", Some("标题"), Some("zh"));
        assert!(d.starts_with("---\ntitle: 标题\nlang: zh\n---\n\n## 面板"));
    }

    #[test]
    fn slugify_keeps_cjk_and_drops_unsafe_chars() {
        assert_eq!(slugify("Agent 能否集成 HTML？"), "agent-能否集成-html");
        assert_eq!(slugify("../../etc/passwd"), "etc-passwd");
        assert_eq!(slugify("///"), "page");
        assert_eq!(slugify(""), "page");
        assert!(slugify(&"工".repeat(100)).chars().count() <= SLUG_MAX_CHARS);
    }

    #[test]
    fn render_args_always_disable_browser_open() {
        let a = render_args(
            Path::new("/res/am.mjs"),
            Path::new("/tmp/d.md"),
            Path::new("/tmp/o.html"),
        );
        assert_eq!(a[0], "/res/am.mjs");
        assert_eq!(a[1], "render");
        assert!(a.contains(&"--no-open".to_string()));
        assert!(a.contains(&"-o".to_string()));
    }

    #[test]
    fn out_path_defaults_to_artifacts_dir() {
        let p = resolve_out_path(None, &cfg("off", None), "/Users/tester", "a.html").unwrap();
        assert_eq!(
            p,
            PathBuf::from("/Users/tester/Documents/道生一产物/a.html")
        );
    }

    #[test]
    fn out_path_is_always_the_artifacts_dir_by_default() {
        // 用户约定：**统一生成在 `~/Documents/道生一产物/`**。
        // 回归防线：曾在 workspace-write 下改落 `<工作区>/道生一页面/`，而用户的工作区是主目录
        // → 产物被写进 `~/道生一页面/`（既不是约定位置、又污染主目录）——2026-10-08 用户实测。
        for mode in ["off", "workspace-write", "danger-full-access", ""] {
            let p = resolve_out_path(
                None,
                &cfg(mode, Some("/Users/tester")),
                "/Users/tester",
                "a.html",
            )
            .unwrap();
            assert_eq!(
                p,
                PathBuf::from("/Users/tester/Documents/道生一产物/a.html"),
                "mode={mode} 时默认输出必须是产物目录"
            );
        }
        // 显式路径仍以调用方为准（白名单在命令层校验），不再因「不在工作区内」而报错
        // （本命令的沙箱可写区会被收敛到输出目录）
        let e = resolve_out_path(
            Some("/tmp/out.html"),
            &cfg("workspace-write", Some("/ws")),
            "/Users/tester",
            "a.html",
        )
        .unwrap();
        assert_eq!(e, PathBuf::from("/tmp/out.html"));
        // read-only：明确拒绝（生成页面本质是写文件）
        assert!(
            resolve_out_path(None, &cfg("read-only", None), "/Users/tester", "a.html").is_err()
        );
        assert!(resolve_out_path(
            Some("/Users/tester/out.html"),
            &cfg("read-only", None),
            "/Users/tester",
            "a.html"
        )
        .is_err());
    }

    #[test]
    fn latex_source_is_detected_before_rendering() {
        // 渲染器无数学引擎：美元符公式 / 反斜杠括号 / 常见命令都要能识别
        assert!(!latex_hits("电磁场满足 $E = mc^2$ 的关系").is_empty());
        assert!(!latex_hits("写成 \\(x^2\\) 更清楚").is_empty());
        assert!(!latex_hits("薛定谔方程 \\frac{\\partial}{\\partial t}").is_empty());
        assert!(!latex_hits("能量子 \\hbar\\omega").is_empty());
        // 正常草稿（含单个货币美元符、普通反斜杠转义）不能被误伤
        assert!(latex_hits("价格是 5$ 一件（促销）").is_empty());
        assert!(latex_hits("用 \\n 表示换行，用 \\d 表示数字").is_empty());
        assert!(latex_hits("## 面板\n普通中文段落，含 ψ 与 ħ 这类 Unicode 记号。").is_empty());
        // 错误文案要给出可执行的改写范例
        let msg = latex_error(&latex_hits("$x$"));
        assert!(msg.contains("Unicode"));
        assert!(msg.contains("iħ ∂ψ/∂t"));
    }

    #[test]
    fn out_path_treats_dir_and_missing_extension_as_dir() {
        let d = resolve_out_path(
            Some("/Users/tester/页面/"),
            &cfg("off", None),
            "/Users/tester",
            "a.html",
        )
        .unwrap();
        assert_eq!(d, PathBuf::from("/Users/tester/页面/a.html"));
        let d2 = resolve_out_path(
            Some("/Users/tester/页面"),
            &cfg("off", None),
            "/Users/tester",
            "a.html",
        )
        .unwrap();
        assert_eq!(d2, PathBuf::from("/Users/tester/页面/a.html"));
        let f = resolve_out_path(
            Some("/Users/tester/x.html"),
            &cfg("off", None),
            "/Users/tester",
            "a.html",
        )
        .unwrap();
        assert_eq!(f, PathBuf::from("/Users/tester/x.html"));
    }

    /// **真机 e2e（默认忽略）**：用仓库内嵌的 `resources/am.mjs` 真渲染一页，
    /// 验证「内嵌 CLI + Node 探测 + argv 调用 + 产物落盘」整条链路。
    ///
    /// 跑法：`cargo test --lib answer_html -- --ignored --nocapture`
    /// 本机没有 Node ≥ 20 时**跳过并通过**（不在没装 Node 的机器上误报红）。
    /// 为什么必须真跑：单测只能钉住参数拼装，SBPL/沙箱/node 行为都只有真机能证明。
    #[tokio::test]
    #[ignore]
    async fn real_render_produces_offline_html() {
        let cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(CLI_FILE);
        assert!(cli.exists(), "内嵌 CLI 缺失：{}", cli.display());
        let home = std::env::var("HOME").unwrap_or_default();
        let Some((node, _)) = locate_node(&home).await else {
            eprintln!("跳过：本机没有 Node ≥ {MIN_NODE_MAJOR}");
            return;
        };

        let dir = std::env::temp_dir().join(format!("ds-am-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let draft = dir.join("d.md");
        let out = dir.join("page.html");
        let md = "结论：可以集成。\n\n\
                  ## 集成链路\n```flow\nA -> B: 技能指令\nB -> C: am CLI 渲染\n```\n\n\
                  ## 数据图表\n```chart\ntype: bar\ntitle: 性能对比\nunit: ms\nlabels: 旧, 新\nseries: 耗时 = 120, 45\n```\n\n\
                  ## 关键事实\n| 项目 | 值 | 状态 |\n| --- | --- | --- |\n| CLI | 471 KB 单文件 | ok 零依赖 |\n";
        let (md, specs) = expand_chart_blocks(md, true).unwrap();
        assert_eq!(specs.len(), 1);
        std::fs::write(&draft, build_draft(&md, Some("端到端渲染自检"), Some("zh"))).unwrap();

        let template = pick_template(&md, None);
        let args = render_args_with(&cli, &draft, &out, Some(&template), None);
        // AM_HOME 与生产一致（隔离到临时目录）：验证 CLI 在只有 TMPDIR 可写时也能渲染
        let am_home = dir.join("am-home");
        let envs = vec![("AM_HOME".to_string(), am_home.to_string_lossy().to_string())];
        let (stdout, stderr, code) = run_render(
            &node,
            &args,
            None,
            &cfg("off", None),
            RENDER_TIMEOUT_SECS,
            &envs,
        )
        .await
        .expect("渲染进程应能启动");
        assert_eq!(code, 0, "渲染应成功：stdout={stdout}\nstderr={stderr}");
        assert!(out.exists(), "应产出 HTML：{}", out.display());
        let html = std::fs::read_to_string(&out).unwrap();
        assert!(html.contains("<html"), "产物应是完整 HTML 文档");
        assert!(html.len() > 2000, "产物不应是空壳（{} 字节）", html.len());
        assert!(
            html.contains("data-dsy-chart"),
            "图表应渲染为 ECharts 占位节点"
        );
        // 真内联 ECharts + 初始化脚本后，页面仍是单文件离线
        let echarts = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(ECHARTS_FILE),
        )
        .expect("ECharts 资源应存在");
        let patched = inject_echarts(&html, &specs, &echarts).unwrap();
        std::fs::write(&out, &patched).unwrap();
        assert!(patched.contains("Apache ECharts"), "应内联 ECharts");
        assert!(patched.contains("echarts.init"), "应包含初始化脚本");
        assert!(
            patched.len() > 500_000,
            "内联 ECharts 后体积应明显增大（{} 字节）",
            patched.len()
        );
        assert!(
            offline_warnings(&patched).is_empty(),
            "页面应无外部资源依赖"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- 图表块（```chart → ECharts / 回退 SVG） ---

    #[test]
    fn chart_block_parses_bar_with_multiple_series() {
        let spec = parse_chart_block(
            "type: bar\ntitle: 周涨跌\nunit: %\nlabels: 铜, 铝, 锂\nseries: 本周 = -2.1, -0.8, -4.3\nseries: 上周 = 1.2, 0.4, -1.0",
        )
        .unwrap();
        assert_eq!(spec.kind, ChartKind::Bar);
        assert_eq!(spec.title, "周涨跌");
        assert_eq!(spec.unit, "%");
        assert_eq!(spec.labels, vec!["铜", "铝", "锂"]);
        assert_eq!(spec.series.len(), 2);
        assert_eq!(spec.series[0].values, vec![-2.1, -0.8, -4.3]);
        assert_eq!(spec.series[1].name, "上周");
        assert_eq!(spec.height, 340);
        assert!(!spec.stack);
    }

    #[test]
    fn chart_block_requires_matching_lengths() {
        let err = parse_chart_block("labels: A, B\nseries: x = 1, 2, 3").unwrap_err();
        assert!(err.contains("必须一一对应"), "{err}");
        assert!(
            parse_chart_block("labels: A\n").is_err(),
            "缺 series 应报错"
        );
        assert!(
            parse_chart_block("series: x = 1\n").is_err(),
            "缺 labels 应报错"
        );
        assert!(parse_chart_block("labels: A\nseries: x = abc").is_err());
        assert!(parse_chart_block("type: pie\nlabels: A\nseries: x = 1").is_ok());
        assert!(parse_chart_block("type: pie\nlabels: A,B\nseries: x = 1").is_err());
        assert!(parse_chart_block("type: gauge\nseries: x = 42").is_ok());
    }

    #[test]
    fn chart_block_accepts_percent_suffix_and_default_name() {
        let spec = parse_chart_block("type: line\nlabels: A,B\nseries: 45%,-2%").unwrap();
        assert_eq!(spec.kind, ChartKind::Line);
        assert_eq!(spec.series[0].name, "系列1");
        assert_eq!(spec.series[0].values, vec![45.0, -2.0]);
    }

    #[test]
    fn chart_block_supports_all_documented_types() {
        for (raw, want) in [
            ("bar", ChartKind::Bar),
            ("line", ChartKind::Line),
            ("area", ChartKind::Area),
            ("pie", ChartKind::Pie),
            ("donut", ChartKind::Donut),
            ("scatter", ChartKind::Scatter),
            ("radar", ChartKind::Radar),
            ("gauge", ChartKind::Gauge),
            ("heatmap", ChartKind::Heatmap),
            ("funnel", ChartKind::Funnel),
        ] {
            let body = if raw == "gauge" {
                format!("type: {raw}\nseries: 完成率 = 72")
            } else {
                format!("type: {raw}\nlabels: A,B\nseries: x = 1, 2")
            };
            assert_eq!(parse_chart_block(&body).unwrap().kind, want, "type={raw}");
        }
        assert!(parse_chart_block("type: piechart\nlabels: A\nseries: x = 1").is_err());
        assert_eq!(
            parse_chart_block("type: bar\nlabels: A\nseries: x = 1\nstack: true\nheight: 420")
                .unwrap()
                .height,
            420
        );
    }

    #[test]
    fn chart_block_accepts_raw_echarts_option_json() {
        let spec = parse_chart_block(
            r#"{"xAxis": {"type": "category", "data": ["A"]}, "series": [{"type": "bar", "data": [3]}]}"#,
        )
        .unwrap();
        assert_eq!(spec.kind, ChartKind::Custom);
        let opt = build_echarts_option(&spec).unwrap();
        assert_eq!(opt["series"][0]["type"], "bar");
        // 键值头 + JSON 混写
        let spec2 = parse_chart_block(
            "type: option\nheight: 300\n{\"title\": {\"text\": \"x\"}, \"series\": []}",
        )
        .unwrap();
        assert_eq!(spec2.height, 300);
        assert_eq!(build_echarts_option(&spec2).unwrap()["title"]["text"], "x");
    }

    #[test]
    fn expand_uses_echarts_placeholders_when_available() {
        let md =
            "## 数据\n```chart\ntype: pie\ntitle: 涨跌\nlabels: 铜,锂\nseries: 周 = 40, 60\n```\n结论。";
        let (out, specs) = expand_chart_blocks(md, true).unwrap();
        assert_eq!(specs.len(), 1);
        assert!(out.contains("data-dsy-chart=\"0\""));
        assert!(out.contains("dsy-echart"));
        assert!(!out.contains("<svg"));
        assert!(!out.contains("```chart"));
    }

    #[test]
    fn expand_falls_back_to_inline_svg_without_echarts() {
        let md = "## 数据\n```chart\ntitle: 涨跌\nlabels: 铜,锂\nseries: 周 = -2.1, -4.3\n```\n";
        let (out, specs) = expand_chart_blocks(md, false).unwrap();
        assert_eq!(specs.len(), 1);
        assert!(out.contains("<svg"));
        assert!(out.contains("<rect"));
        // 回退不支持饼图：明确报错而不是出空白
        let pie = "```chart\ntype: pie\nlabels: A\nseries: x = 1\n```";
        assert!(expand_chart_blocks(pie, false).is_err());
    }

    #[test]
    fn chart_block_must_be_closed() {
        let err = expand_chart_blocks("```chart\nlabels: A\nseries: x = 1", true).unwrap_err();
        assert!(err.contains("未闭合"), "{err}");
    }

    #[test]
    fn line_chart_svg_renders_polyline_and_escapes_title() {
        let spec = parse_chart_block(
            "type: line\ntitle: A < B & C\nlabels: 一,二,三\nseries: s = 1, 2, 3",
        )
        .unwrap();
        let svg = render_chart_svg(&spec).unwrap();
        assert!(svg.contains("<polyline"));
        assert!(svg.contains("A &lt; B &amp; C"), "标题必须 XML 转义");
        assert!(svg.contains("role=\"img\""));
        assert!(svg.contains("prefers-color-scheme: dark"), "应适配深色模式");
        // 面积图多一层 polygon
        let area = parse_chart_block("type: area\nlabels: A,B\nseries: s = 1, 2").unwrap();
        assert!(render_chart_svg(&area).unwrap().contains("<polygon"));
    }

    #[test]
    fn echarts_options_cover_non_cartesian_types() {
        let pie = parse_chart_block("type: donut\nlabels: A,B\nseries: x = 30, 70").unwrap();
        let o = build_echarts_option(&pie).unwrap();
        assert_eq!(o["series"][0]["type"], "pie");
        assert_eq!(o["series"][0]["radius"][0], "42%");
        assert_eq!(o["series"][0]["data"][1]["value"].as_f64(), Some(70.0));

        let radar =
            parse_chart_block("type: radar\nlabels: 速度, 成本, 稳定\nseries: A = 80, 60, 90")
                .unwrap();
        let o = build_echarts_option(&radar).unwrap();
        assert_eq!(o["radar"]["indicator"].as_array().unwrap().len(), 3);
        assert_eq!(o["series"][0]["type"], "radar");

        let gauge = parse_chart_block("type: gauge\nunit: %\nseries: 完成率 = 72").unwrap();
        let o = build_echarts_option(&gauge).unwrap();
        assert_eq!(o["series"][0]["type"], "gauge");
        assert_eq!(o["series"][0]["data"][0]["value"].as_f64(), Some(72.0));

        let heat = parse_chart_block(
            "type: heatmap\nlabels: 周一,周二\nseries: 上午 = 1, 2\nseries: 下午 = 3, 4",
        )
        .unwrap();
        let o = build_echarts_option(&heat).unwrap();
        assert_eq!(o["series"][0]["type"], "heatmap");
        assert_eq!(o["series"][0]["data"].as_array().unwrap().len(), 4);
        assert_eq!(o["yAxis"]["data"][1], "下午");
    }

    #[test]
    fn inject_echarts_adds_scripts_and_keeps_page_offline() {
        let spec = parse_chart_block("type: bar\nlabels: A,B\nseries: x = 1, 2").unwrap();
        let html = "<html><body><div data-dsy-chart=\"0\"></div></body></html>";
        let out = inject_echarts(html, &[spec], "window.echarts={init:function(){}};").unwrap();
        assert!(out.contains("Apache ECharts"));
        assert!(out.contains("window.echarts"));
        assert!(out.contains("data-dsy-chart"));
        assert!(
            out.contains("IntersectionObserver"),
            "滚动进入视口才初始化（带入场动画）"
        );
        assert!(out.contains("prefers-reduced-motion"), "应尊重减少动效偏好");
        assert!(offline_warnings(&out).is_empty(), "注入后仍应无外部资源");
    }

    #[test]
    fn tailwind_is_auto_enabled_by_class_attributes() {
        assert!(!wants_tailwind("## 普通 Markdown\n无 HTML", None));
        assert!(wants_tailwind(
            "<div class=\"grid grid-cols-3\"></div>",
            None
        ));
        assert!(wants_tailwind("<div class='p-4'></div>", None));
        // 显式参数优先（可关掉自动检测）
        assert!(!wants_tailwind("<div class=\"p-4\"></div>", Some(false)));
        assert!(wants_tailwind("无 HTML", Some(true)));
    }

    #[test]
    fn tailwind_is_not_enabled_by_generated_chart_placeholders() {
        let md = "## 图表\n```chart\nlabels: A,B\nseries: x = 1,2\n```";
        assert!(
            !wants_tailwind(md, None),
            "原始草稿没有 class=，不应自动开 Tailwind"
        );
        let (expanded, _) = expand_chart_blocks(md, true).unwrap();
        assert!(expanded.contains("class=\"dsy-echart\""));
        assert!(!wants_tailwind(md, None));
    }

    #[test]
    fn inject_tailwind_adds_style_before_head_end() {
        let html =
            "<html><head><style>.am{}</style></head><body><div class=\"p-4\"></div></body></html>";
        let out = inject_tailwind(html, ".p-4{padding:1rem !important}");
        assert!(out.contains("id=\"dsy-tailwind\""));
        assert!(out.contains(".p-4{padding:1rem !important}"));
        let style_at = out.find("dsy-tailwind").unwrap();
        let head_end = out.find("</head>").unwrap();
        assert!(style_at < head_end, "样式应插入 </head> 之前");
        assert!(offline_warnings(&out).is_empty());
    }

    #[test]
    fn vendored_tailwind_has_core_utilities_and_no_preflight() {
        let css = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(TAILWIND_FILE),
        )
        .expect("resources/tailwind.css 应存在");
        for cls in [".grid{", ".flex{", ".grid-cols-3{", ".bg-copper{", ".p-4{"] {
            assert!(css.contains(cls), "缺少工具类 {cls}");
        }
        assert!(css.contains("!important"), "工具类应带 !important");
        // preflight 关闭：不应出现 Tailwind 的全局 reset
        assert!(
            !css.contains("*,::after,::before{box-sizing:border-box"),
            "不应包含 preflight"
        );
    }

    #[test]
    fn template_is_doc_for_long_reports_only() {
        let short = "## 一\n内容\n## 二\n内容";
        assert_eq!(pick_template(short, None), "sheet");
        let long = "## 一\n## 二\n## 三\n## 四";
        assert_eq!(pick_template(long, None), "doc");
        // 显式指定优先
        assert_eq!(pick_template(long, Some("sheet")), "sheet");
    }

    #[test]
    fn offline_warnings_flag_external_assets_only() {
        assert!(offline_warnings("<html><body>ok</body></html>").is_empty());
        assert!(offline_warnings("<script src=\"https://cdn.example/x.js\"></script>").len() == 1);
        // 普通外链（来源引用）不算资源引用
        assert!(offline_warnings("<a href=\"https://example.com/source\">来源</a>").is_empty());
    }
}
