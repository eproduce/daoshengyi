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
pub fn render_args(cli: &Path, draft: &Path, out: &Path) -> Vec<String> {
    vec![
        cli.to_string_lossy().to_string(),
        "render".to_string(),
        draft.to_string_lossy().to_string(),
        "-o".to_string(),
        out.to_string_lossy().to_string(),
        "--no-open".to_string(),
    ]
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

/// 渲染一页 HTML：草稿 → 临时文件 → node am.mjs render -o <out> --no-open。
///
/// 与其它命令型工具一致：沙箱包装 + 超时 + 审计，失败信息原样带回给模型（上游 CLI 会打印
/// `✗ L<行> [组件] …` 与 `Correct example:`，模型据此改那一行重试）。
#[tauri::command]
pub async fn answer_html(
    app: AppHandle,
    db: State<'_, Database>,
    markdown: String,
    title: Option<String>,
    lang: Option<String>,
    out_path: Option<String>,
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
    let args = render_args(&cli, &draft_path, &out);
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

    let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    let html_path = out.to_string_lossy().to_string();
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
                  ## 关键事实\n| 项目 | 值 | 状态 |\n| --- | --- | --- |\n| CLI | 471 KB 单文件 | ok 零依赖 |\n";
        std::fs::write(&draft, build_draft(md, Some("端到端渲染自检"), Some("zh"))).unwrap();

        let args = render_args(&cli, &draft, &out);
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
        let _ = std::fs::remove_dir_all(&dir);
    }
}
