//! HUD 浮层 —— 桌面环境层（Ambient Agent）的**第一块地基**。
//!
//! **性质：spike ①**（`docs/DESKTOP_AMBIENT_UI.md` §12 开放问题 ①）。要回答的问题是：
//! Tauri 2.11.5 的「透明 + 无边框 + 置顶 + 点击穿透」在 macOS 26 / WKWebView 上
//! **到底能不能用**。先证伪再决定 HUD 形态，而不是先写一套 UI 再发现不行。
//!
//! ## 三个关键设计取舍
//!
//! 1. **默认不创建**：HUD 只在被显式唤起时创建（懒加载），不是常驻 webview。
//!    不接受环境层的用户零成本 —— 这同时就是「必须有静默开关」的实现方式：
//!    不放行环境变量，这个窗口永远不存在。
//! 2. **默认点击穿透**：环境层的第一性要求是「不挡操作」。穿透态下窗口完全忽略鼠标
//!    （连 hover 都没有），只有内容可见；交互走热键/托盘，不走点在浮层上。
//! 3. **自证**：`hud_facts()` 会**回读 AppKit 的真实状态**（`NSWindow` 的
//!    `ignoresMouseEvents` / `isOpaque` / `alphaValue` / `level` / `styleMask` /
//!    `hasShadow` / `collectionBehavior`）。因为「我们请求了什么」不等于「系统接受了什么」
//!    —— 透明度在 macOS 上就有一个很容易静默失效的前置条件：`transparent` 必须配合
//!    `app.macOSPrivateApi = true` + `tauri/macos-private-api` feature，
//!    缺任何一个都只是「看起来设了透明，实际是白底」。
//!
//! ## macOS 私有 API 的代价（必须记录）
//!
//! `macOSPrivateApi` 走私有 API 实现透明窗口，**提交 App Store 会被拒**。
//! 我们只走 GitHub Release 分发，可以接受；但这条约束要写进文档，将来若上架必须重做
//! （替代方案：非透明窗口 + 圆角内容区，或改用原生 `NSWindow` 面板）。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// HUD 窗口标签
pub const HUD_LABEL: &str = "hud";
/// HUD 入口页（独立前端入口，见 `src/hud-main.ts`；产物是 `dist/hud.html`）
pub const HUD_URL: &str = "hud.html";
/// 胶囊尺寸（逻辑像素）
pub const HUD_WIDTH: f64 = 380.0;
pub const HUD_HEIGHT: f64 = 132.0;
/// 距屏幕可见区域右上角的边距（逻辑像素）
pub const HUD_MARGIN: f64 = 16.0;

/// spike 开关：不设置这个环境变量，HUD 永不出现
pub const ENV_SPIKE: &str = "DAOSHENGYI_HUD_SPIKE";
/// spike 延迟（秒）：留出「HUD 未出现时先截一张基线图」的时间窗，
/// 这样透明度验证才能做成前后对比（见 `scripts/hud-spike-verify.swift`）
pub const ENV_SPIKE_DELAY: &str = "DAOSHENGYI_HUD_SPIKE_DELAY";

/// 事实快照落盘路径：让验证脚本能**确定性读到**结果，而不是去解析日志文本
pub fn facts_path() -> std::path::PathBuf {
    std::env::temp_dir().join("daoshengyi-hud-facts.json")
}

// ── 行为开关（我们"请求"的值）──────────────────────────────────────────────────
//
// `set_ignore_cursor_events` 只写不读，Tauri 没给 getter。所以这里镜像一份，
// 用途是区分「请求了但没生效」和「压根没请求」——排查透明/穿透失效时这两者
// 完全不同（前者是系统/平台问题，后者是我们自己的 bug）。

/// HUD 行为开关
#[derive(Default)]
pub struct HudFlags {
    click_through: AtomicBool,
    all_workspaces: AtomicBool,
    /// 前端自述：HUD 是**独立 webview**，白屏时既没有可见控制台也看不到 DOM。
    /// 让它把自己的渲染状态（尺寸 / DOM / 错误）写回来，诊断才有依据。
    note: std::sync::Mutex<Option<String>>,
}

impl HudFlags {
    /// 默认值：点击穿透**开**（不挡操作），跨桌面**关**（跟着当前 Space 走，不骚扰）
    pub fn new() -> Self {
        Self {
            click_through: AtomicBool::new(true),
            all_workspaces: AtomicBool::new(false),
            note: std::sync::Mutex::new(None),
        }
    }

    pub fn click_through(&self) -> bool {
        self.click_through.load(Ordering::Relaxed)
    }

    pub fn set_click_through(&self, v: bool) {
        self.click_through.store(v, Ordering::Relaxed);
    }

    pub fn all_workspaces(&self) -> bool {
        self.all_workspaces.load(Ordering::Relaxed)
    }

    pub fn set_all_workspaces(&self, v: bool) {
        self.all_workspaces.store(v, Ordering::Relaxed);
    }

    pub fn note(&self) -> Option<String> {
        self.note.lock().ok().and_then(|g| g.clone())
    }

    pub fn set_note(&self, v: String) {
        if let Ok(mut g) = self.note.lock() {
            *g = Some(v);
        }
    }
}

// ── 定位（纯函数，可单测）─────────────────────────────────────────────────────

/// 屏幕可见区域（逻辑像素）：(x, y, 宽, 高)。
/// 抽成别名不只是为了好看：clippy 会把四元组当「过于复杂的类型」报警，
/// 而这些几何元组在定位/快照里反复出现，有名字也更好读。
pub type ScreenArea = (f64, f64, f64, f64);
/// 二维尺寸（逻辑像素）：(宽, 高)
pub type HudSize = (f64, f64);
/// 二维坐标（逻辑像素）：(x, y)，左上角为原点
pub type HudPoint = (f64, f64);

/// 把 HUD 摆到「屏幕可见区域」的右上角。
///
/// `area` = 可见区域，`size` = 窗口尺寸，都是**逻辑像素**
/// （必须同一坐标系：`work_area()` 给的是物理像素，调用方要先除以 scale_factor）。
///
/// 抽成纯函数是为了覆盖三个真实边界：副屏在主屏左侧时 `x` 为负、
/// 窗口比屏幕还宽（小屏 + 大 HUD）、可见区域自身偏移（菜单栏/Dock）。
pub fn hud_position(area: ScreenArea, size: HudSize, margin: f64) -> HudPoint {
    let (ax, ay, aw, _ah) = area;
    // 顶部对齐可见区域上沿（macOS 上就是菜单栏下方），右侧留 margin。
    // 再夹一次下限：窗口比屏幕还宽时至少别把左边缘推到屏幕外。
    let x = (ax + aw - size.0 - margin).max(ax + margin);
    let y = ay + margin;
    (x, y)
}

// ── AppKit 事实（证据来源）─────────────────────────────────────────────────────

/// 从 `NSWindow` 回读的原始事实。字段名即 AppKit 属性名（便于对照文档）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppKitFacts {
    /// `isVisible`：窗口**真的上屏了**——比 Tauri `is_visible()` 可靠。
    /// （我们用 `orderFrontRegardless` 绕过 Tauri 的 show，tao 缓存的状态会滞后）
    pub is_visible: bool,
    /// `occlusionState`：窗口是否被别的窗口完全盖住。
    /// 这个字段是排查「窗口存在、透明、在屏，但离屏截图全透明」的关键：
    /// 被遮挡时 AppKit 会停掉窗口的内容渲染，此时「拍不到」≠「没画对」。
    pub occlusion_state: usize,
    pub is_occluded: bool,
    /// `ignoresMouseEvents`：点击穿透的**真实**生效状态
    pub ignores_mouse_events: bool,
    /// `isOpaque`：窗口是否被系统当成不透明（true = 透明失效）
    pub is_opaque: bool,
    /// `alphaValue`：窗口整体透明度（1.0 是正常的，透明靠内容 alpha）
    pub alpha_value: f64,
    /// `level`：窗口层级（0=Normal，3=Floating，25=Status）
    pub level: isize,
    pub level_name: String,
    /// `styleMask`：0 = 完全无边框
    pub style_mask: usize,
    pub style_names: Vec<String>,
    pub has_shadow: bool,
    /// `collectionBehavior`：跨 Space / 全屏行为
    pub collection_behavior: usize,
    pub collection_names: Vec<String>,
    /// `isKeyWindow`：是否抢了键盘焦点
    pub is_key_window: bool,
    pub can_become_key_window: bool,
}

/// AppKit 窗口层级解码
pub fn level_name(level: isize) -> String {
    match level {
        0 => "Normal".into(),
        3 => "Floating".into(),
        5 => "Floating(实测置顶值)".into(),
        8 => "ModalPanel".into(),
        20 => "Dock".into(),
        24 => "MainMenu".into(),
        25 => "Status".into(),
        101 => "PopUpMenu".into(),
        1000 => "ScreenSaver".into(),
        other => format!("其它({other})"),
    }
}

/// `styleMask` 位解码（只列我们关心的位；0 表示无边框）
pub fn style_names(mask: usize) -> Vec<String> {
    const BITS: &[(usize, &str)] = &[
        (1 << 0, "Titled"),
        (1 << 1, "Closable"),
        (1 << 2, "Miniaturizable"),
        (1 << 3, "Resizable"),
        (1 << 4, "UtilityWindow"),
        (1 << 6, "DocModalWindow"),
        (1 << 7, "NonactivatingPanel"),
        (1 << 8, "TexturedBackground"),
        (1 << 12, "UnifiedTitleAndToolbar"),
        (1 << 13, "HUDWindow"),
        (1 << 14, "FullScreen"),
        (1 << 15, "FullSizeContentView"),
    ];
    BITS.iter()
        .filter(|(bit, _)| mask & bit != 0)
        .map(|(_, name)| (*name).to_string())
        .collect()
}

/// `collectionBehavior` 位解码（判断「是否跨所有 Space」「能否覆盖全屏 app」）
pub fn collection_names(behavior: usize) -> Vec<String> {
    const BITS: &[(usize, &str)] = &[
        (1 << 0, "CanJoinAllSpaces"),
        (1 << 1, "MoveToActiveSpace"),
        (1 << 2, "Managed"),
        (1 << 3, "Transient"),
        (1 << 4, "Stationary"),
        (1 << 5, "ParticipatesInCycle"),
        (1 << 6, "IgnoresCycle"),
        (1 << 7, "FullScreenPrimary"),
        (1 << 8, "FullScreenAuxiliary"),
        (1 << 9, "FullScreenNone"),
        (1 << 11, "FullScreenAllowsTiling"),
        (1 << 12, "FullScreenDisallowsTiling"),
    ];
    BITS.iter()
        .filter(|(bit, _)| behavior & bit != 0)
        .map(|(_, name)| (*name).to_string())
        .collect()
}

/// 把事实翻译成「结论行」——spike 报告直接引用这些行，避免人工看图猜。
///
/// 纯函数：不碰窗口，便于单测「透明失效」「穿透没生效」这类必须报警的组合。
pub fn verdict_of(click_through_requested: bool, appkit: &AppKitFacts) -> Vec<String> {
    let mut out = Vec::new();

    if appkit.is_opaque {
        out.push(
            "❌ 透明失效：AppKit isOpaque=true（检查 macOSPrivateApi / macos-private-api feature）"
                .into(),
        );
    } else {
        out.push("✅ 真透明：AppKit isOpaque=false".into());
    }

    if appkit.ignores_mouse_events == click_through_requested {
        out.push(format!(
            "✅ 点击穿透：ignoresMouseEvents={}，与请求一致",
            appkit.ignores_mouse_events
        ));
    } else {
        out.push(format!(
            "❌ 点击穿透不一致：请求 {click_through_requested}，实际 {}",
            appkit.ignores_mouse_events
        ));
    }

    if appkit.style_mask & 1 != 0 {
        out.push(format!(
            "⚠️ 仍有标题栏：{}",
            style_names(appkit.style_mask).join("+")
        ));
    } else if appkit.style_mask == 0 {
        out.push("✅ 无边框：styleMask=0".into());
    } else {
        // 实测：tauri 即使 decorations(false) 也会带上 FullSizeContentView 位（1<<15）。
        // 只要没有 Titled 位就没有标题栏，这个位的作用只是让 webview 铺满整个窗口。
        out.push(format!(
            "✅ 无标题栏：styleMask={}（{}）",
            appkit.style_mask,
            style_names(appkit.style_mask).join("+")
        ));
    }

    if appkit.level > 0 {
        out.push(format!(
            "✅ 置顶：level={}（{}）",
            appkit.level, appkit.level_name
        ));
    } else {
        out.push("❌ 未置顶：level=0（Normal）".into());
    }

    if appkit.has_shadow {
        out.push("⚠️ 仍有系统阴影：透明窗口会留下灰色方框，建议 shadow=false".into());
    } else {
        out.push("✅ 无系统阴影：hasShadow=false".into());
    }

    if appkit.is_visible {
        out.push("✅ 已上屏：AppKit isVisible=true".into());
    } else {
        out.push("❌ 未上屏：AppKit isVisible=false（窗口创建了但没显示）".into());
    }

    if appkit.is_occluded {
        out.push("⚠️ 窗口被遮挡：occlusionState 不含 Visible（AppKit 会停掉渲染）→ 离屏截图可能全透明，不能当作渲染失败".into());
    } else {
        out.push("✅ 未被遮挡：occlusionState 含 Visible（渲染应正常）".into());
    }

    if appkit.is_key_window {
        out.push("⚠️ 抢了键盘焦点：isKeyWindow=true（浮层不该抢焦点）".into());
    } else {
        out.push("✅ 未抢焦点：isKeyWindow=false".into());
    }

    out
}

// ── 窗口生命周期 ──────────────────────────────────────────────────────────────

/// 懒创建 HUD 窗口（已存在则直接返回）。
///
/// **必须在主线程调用**（`setup` 里）。窗口创建本身在 Tauri 内部是往事件循环发消息，
/// 但定位/show 这类操作要等事件循环跑起来之后才安全 —— 所以这里只建不显示。
fn ensure_hud(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(HUD_LABEL) {
        return Ok(win);
    }
    WebviewWindowBuilder::new(app, HUD_LABEL, WebviewUrl::App(HUD_URL.into()))
        .title("道生一 HUD")
        .inner_size(HUD_WIDTH, HUD_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false) // 无标题栏/边框
        .transparent(true) // 需 app.macOSPrivateApi=true + tauri/macos-private-api
        .shadow(false) // 透明窗口带系统阴影 = 一圈灰边
        .always_on_top(true)
        .skip_taskbar(true) // macOS 上是 no-op（Dock 是 app 级），Windows 上才是真的隐藏任务栏
        .focused(false) // 出现时不抢键盘焦点
        .visible(false)
        .build()
        .map_err(|e| format!("创建 HUD 窗口失败：{e}"))
}

/// 可见区域（物理像素 → 逻辑像素）与缩放比
fn work_area_logical(win: &WebviewWindow) -> Option<(ScreenArea, f64, String)> {
    let monitor = win.primary_monitor().ok().flatten()?;
    let sf = monitor.scale_factor();
    let wa = monitor.work_area();
    let area = (
        f64::from(wa.position.x) / sf,
        f64::from(wa.position.y) / sf,
        f64::from(wa.size.width) / sf,
        f64::from(wa.size.height) / sf,
    );
    let name = monitor.name().cloned().unwrap_or_else(|| "未知".into());
    Some((area, sf, name))
}

/// 摆到右上角
fn place_top_right(win: &WebviewWindow) -> Result<(), String> {
    let (area, _, _) = work_area_logical(win).ok_or("无法获取主显示器可见区域")?;
    let (x, y) = hud_position(area, (HUD_WIDTH, HUD_HEIGHT), HUD_MARGIN);
    win.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| format!("定位 HUD 失败：{e}"))
}

/// 把「请求的开关」同步到系统
fn apply_flags(win: &WebviewWindow, flags: &HudFlags) -> Result<(), String> {
    win.set_ignore_cursor_events(flags.click_through())
        .map_err(|e| format!("设置点击穿透失败：{e}"))?;
    win.set_visible_on_all_workspaces(flags.all_workspaces())
        .map_err(|e| format!("设置跨桌面显示失败：{e}"))?;
    Ok(())
}

// ── AppKit 回读 ───────────────────────────────────────────────────────────────

/// 在**主线程**上读 `NSWindow` 属性（AppKit 的 UI 属性只在主线程访问是安全的约定）
#[cfg(target_os = "macos")]
fn read_ns_window(win: &WebviewWindow) -> Option<AppKitFacts> {
    use objc2::runtime::AnyObject;

    let ptr = win.ns_window().ok()? as *mut AnyObject;
    if ptr.is_null() {
        return None;
    }
    // SAFETY: 指针来自 Tauri 持有的存活窗口；下面全是 AppKit **只读**属性访问
    // （不做任何状态变更），且已确保在主线程上执行。
    unsafe {
        let ignores_mouse_events: bool = objc2::msg_send![ptr, ignoresMouseEvents];
        let is_visible: bool = objc2::msg_send![ptr, isVisible];
        // NSWindowOcclusionStateVisible = 1 << 1
        let occlusion_state: usize = objc2::msg_send![ptr, occlusionState];
        let is_opaque: bool = objc2::msg_send![ptr, isOpaque];
        let alpha_value: f64 = objc2::msg_send![ptr, alphaValue];
        let level: isize = objc2::msg_send![ptr, level];
        let style_mask: usize = objc2::msg_send![ptr, styleMask];
        let has_shadow: bool = objc2::msg_send![ptr, hasShadow];
        let collection_behavior: usize = objc2::msg_send![ptr, collectionBehavior];
        let is_key_window: bool = objc2::msg_send![ptr, isKeyWindow];
        let can_become_key_window: bool = objc2::msg_send![ptr, canBecomeKeyWindow];

        Some(AppKitFacts {
            is_visible,
            occlusion_state,
            is_occluded: occlusion_state & (1 << 1) == 0,
            ignores_mouse_events,
            is_opaque,
            alpha_value,
            level,
            level_name: level_name(level),
            style_mask,
            style_names: style_names(style_mask),
            has_shadow,
            collection_behavior,
            collection_names: collection_names(collection_behavior),
            is_key_window,
            can_become_key_window,
        })
    }
}

/// 非 macOS：没有 AppKit 可读（HUD 的定位/穿透语义在其它平台也不同，Phase A 只做 macOS）
#[cfg(not(target_os = "macos"))]
fn read_ns_window(_win: &WebviewWindow) -> Option<AppKitFacts> {
    None
}

/// 回读 AppKit 事实（切到主线程执行，带超时 —— 绝不因为一次诊断把命令挂死）
fn read_appkit_facts(app: &tauri::AppHandle, win: &WebviewWindow) -> Option<AppKitFacts> {
    let win = win.clone();
    // on_main 把「闭包的返回值」再包一层 Option（主线程调度本身可能失败）→ flatten 掉
    on_main(app, move || read_ns_window(&win)).flatten()
}

/// 把闭包丢到主线程执行并取回结果（AppKit 的 UI 属性访问约定在主线程）。
/// 带超时：主线程若正忙，宁可拿不到诊断数据，也不能把调用方挂死。
fn on_main<F, T>(app: &tauri::AppHandle, f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv_timeout(std::time::Duration::from_millis(1500)).ok()
}

/// 显示 HUD **但不抢键盘焦点**。
///
/// macOS 上 `NSWindow.orderFrontRegardless` 是唯一「只置前、不激活 app、不成为 key window」
/// 的原语；Tauri 的 `show()` 走 `makeKeyAndOrderFront`，实测会把用户正在输入的 app 顶掉
/// （facts 里 `isKeyWindow=true` 就是这么来的）—— 浮层一旦抢焦点，环境层就变成了骚扰。
#[cfg(target_os = "macos")]
fn show_hud(app: &tauri::AppHandle, win: &WebviewWindow) -> Result<(), String> {
    use objc2::runtime::AnyObject;

    let win = win.clone();
    on_main(app, move || {
        let ptr = win
            .ns_window()
            .map(|p| p as *mut AnyObject)
            .unwrap_or(std::ptr::null_mut());
        if ptr.is_null() {
            return Err("NSWindow 指针为空".to_string());
        }
        // SAFETY: 指针来自存活窗口；只调用一个不改窗口内容、不释放资源的 AppKit 方法。
        unsafe {
            let _: () = objc2::msg_send![ptr, orderFrontRegardless];
        }
        Ok(())
    })
    .ok_or_else(|| "主线程调度失败".to_string())?
}

/// 非 macOS：交给平台实现（HUD 的形态本来就在 macOS 上先行验证）
#[cfg(not(target_os = "macos"))]
fn show_hud(_app: &tauri::AppHandle, win: &WebviewWindow) -> Result<(), String> {
    win.show().map_err(|e| format!("显示 HUD 失败：{e}"))
}

// ── 事实快照 ──────────────────────────────────────────────────────────────────

/// HUD 的一次「事实快照」：请求的开关 + 系统的真实状态 + 结论行
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudFacts {
    pub exists: bool,
    pub visible: bool,
    pub focused: bool,
    pub position: HudPoint,
    pub size: HudSize,
    pub scale_factor: f64,
    pub monitor_name: String,
    pub work_area_logical: ScreenArea,
    pub click_through_requested: bool,
    pub all_workspaces_requested: bool,
    /// AppKit 回读（macOS 专有）；非 macOS 或窗口不存在时为 None
    pub appkit: Option<AppKitFacts>,
    /// Tauri 自己缓存的可视状态（我们绕过 Tauri 的 show 之后它会滞后，仅作参考）
    pub visible_tauri: bool,
    /// HUD 前端最后一次自述（渲染状态 / 错误）
    pub frontend_note: Option<String>,
    /// 结论行（人话；spike 报告直接引用）
    pub verdict: Vec<String>,
}

/// 采集快照。**不要在刚创建窗口后立刻调用** —— 定位/show 都是异步投递到事件循环的，
/// 立刻回读会拿到旧值（这也是上一版「明明设了透明却看着是白底」的排查陷阱）。
fn collect_facts(app: &tauri::AppHandle, flags: &HudFlags) -> HudFacts {
    let Some(win) = app.get_webview_window(HUD_LABEL) else {
        return HudFacts {
            exists: false,
            visible: false,
            focused: false,
            position: (0.0, 0.0),
            size: (HUD_WIDTH, HUD_HEIGHT),
            scale_factor: 1.0,
            monitor_name: String::new(),
            work_area_logical: (0.0, 0.0, 0.0, 0.0),
            click_through_requested: flags.click_through(),
            all_workspaces_requested: flags.all_workspaces(),
            appkit: None,
            visible_tauri: false,
            frontend_note: flags.note(),
            verdict: vec!["窗口不存在：HUD 未创建（默认状态，非错误）".into()],
        };
    };

    let (area, sf, monitor_name) =
        work_area_logical(&win).unwrap_or(((0.0, 0.0, 0.0, 0.0), 1.0, String::new()));
    let position = win
        .outer_position()
        .map(|p| (f64::from(p.x), f64::from(p.y)))
        .unwrap_or((0.0, 0.0));
    let size = win
        .inner_size()
        .map(|s| (f64::from(s.width), f64::from(s.height)))
        .unwrap_or((0.0, 0.0));
    let appkit = read_appkit_facts(app, &win);
    let visible_tauri = win.is_visible().unwrap_or(false);
    let verdict = match &appkit {
        Some(f) => verdict_of(flags.click_through(), f),
        None => vec!["⚠️ 未取到 AppKit 事实（非 macOS 或回读超时）".into()],
    };

    HudFacts {
        exists: true,
        // 以 AppKit 为准：我们绕过 Tauri 的 show，tao 的缓存状态会滞后
        visible: appkit
            .as_ref()
            .map(|f| f.is_visible)
            .unwrap_or(visible_tauri),
        visible_tauri,
        focused: win.is_focused().unwrap_or(false),
        position,
        size,
        scale_factor: sf,
        monitor_name,
        work_area_logical: area,
        click_through_requested: flags.click_through(),
        all_workspaces_requested: flags.all_workspaces(),
        appkit,
        frontend_note: flags.note(),
        verdict,
    }
}

/// 落盘 + 打日志：让 shell 侧能确定性取到结果（spike 证据链）。
///
/// 日志只打**结论行**，不打整份 JSON：这份快照本来就会落盘，而前端每秒轮询一次，
/// 整份 JSON 打到 stdout 会把终端刷成一片噪音（spike 真踩过，回看日志反而更难）。
fn dump_facts(facts: &HudFacts) {
    match serde_json::to_string_pretty(facts) {
        Ok(json) => {
            let path = facts_path();
            if let Err(e) = std::fs::write(&path, &json) {
                eprintln!("[hud] 事实快照写入失败 {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[hud] 事实快照序列化失败: {e}"),
    }
    for line in &facts.verdict {
        eprintln!("[hud] {line}");
    }
}

// ── 命令 ─────────────────────────────────────────────────────────────────────

/// HUD spike 控制台：`show` / `hide` / `toggle` / `status` / `click_through_on|off` /
/// `all_workspaces_on|off` / `destroy`，每次调用都返回事实快照。
///
/// 用字符串动作而不是一堆独立命令：spike 阶段动作会不断增删，多一个动作不值得多一个
/// IPC 命令；稳定下来（Phase A）再按动作拆成语义命令。
#[tauri::command]
pub async fn hud_spike(
    app: tauri::AppHandle,
    flags: tauri::State<'_, HudFlags>,
    action: String,
) -> Result<HudFacts, String> {
    match action.as_str() {
        "show" => {
            let win = ensure_hud(&app)?;
            place_top_right(&win).ok(); // 定位失败不致命（用系统给的默认位置）
            apply_flags(&win, &flags)?;
            show_hud(&app, &win)?;
            // 等一帧：定位/show/穿透都是异步投递，立刻回读会拿到旧值
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        "hide" => {
            if let Some(win) = app.get_webview_window(HUD_LABEL) {
                win.hide().map_err(|e| format!("隐藏 HUD 失败：{e}"))?;
            }
        }
        "toggle" => {
            let visible = app
                .get_webview_window(HUD_LABEL)
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            let next = if visible { "hide" } else { "show" };
            return Box::pin(hud_spike(app, flags, next.to_string())).await;
        }
        "click_through_on" => {
            flags.set_click_through(true);
            if let Some(win) = app.get_webview_window(HUD_LABEL) {
                apply_flags(&win, &flags)?;
            }
        }
        "click_through_off" => {
            flags.set_click_through(false);
            if let Some(win) = app.get_webview_window(HUD_LABEL) {
                apply_flags(&win, &flags)?;
            }
        }
        "all_workspaces_on" => {
            flags.set_all_workspaces(true);
            if let Some(win) = app.get_webview_window(HUD_LABEL) {
                apply_flags(&win, &flags)?;
            }
        }
        "all_workspaces_off" => {
            flags.set_all_workspaces(false);
            if let Some(win) = app.get_webview_window(HUD_LABEL) {
                apply_flags(&win, &flags)?;
            }
        }
        "destroy" => {
            if let Some(win) = app.get_webview_window(HUD_LABEL) {
                win.close().map_err(|e| format!("销毁 HUD 失败：{e}"))?;
            }
        }
        "status" => {}
        other => return Err(format!("未知动作：{other}")),
    }

    std::thread::sleep(std::time::Duration::from_millis(60));
    let facts = collect_facts(&app, &flags);
    // 只在「有动作」时落盘：前端每秒轮询 status，每次都写会把证据文件刷成一团噪音
    if action != "status" {
        dump_facts(&facts);
    }
    Ok(facts)
}

/// HUD 前端自述（渲染状态 / 错误）。
///
/// HUD 是独立 webview：白屏时看不到控制台、也看不到 DOM，只能靠它自己把「我看到的」写回来。
/// 这条通道是 spike 里加的**最有用的一根探针** —— 窗口图 alpha 全 0 时，靠它才区分出
/// 「页面没加载」「页面加载了但没渲染」和「窗口被遮挡所以压根没渲染」三种完全不同的原因。
///
/// 用 async：`collect_facts` 要往主线程发消息再等回来，同步命令本身就在主线程上跑，
/// 会把自己等超时（拿不到 AppKit 事实还白等 1.5s）。
#[tauri::command]
pub async fn hud_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, HudFlags>,
    note: String,
) -> Result<(), String> {
    eprintln!("[hud] 前端自述: {note}");
    state.set_note(note);
    // 立刻并进事实快照：spike 的所有判定都读这个文件，不能让自述和快照错位
    let facts = collect_facts(&app, &state);
    dump_facts(&facts);
    Ok(())
}

/// spike 启动钩子（在 `setup` 里调用，**主线程**）。
///
/// 创建窗口留在主线程（Tauri 约定）；定位/show/回读放到事件循环起来之后的独立线程
/// —— 在 `setup` 里调 `set_position`/`show` 会往事件循环投递消息，早期调用有阻塞风险。
pub fn spike_on_startup(app: &tauri::AppHandle) {
    // 不设置环境变量 → 直接返回：HUD 永不出现（这就是静默开关）
    if !std::env::var(ENV_SPIKE)
        .map(|v| v != "0" && !v.is_empty())
        .unwrap_or(false)
    {
        return;
    }
    let win = match ensure_hud(app) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[hud] {e}");
            return;
        }
    };
    let delay = std::env::var(ENV_SPIKE_DELAY)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let app = app.clone();
    std::thread::spawn(move || {
        if delay > 0 {
            std::thread::sleep(std::time::Duration::from_secs(delay));
        }
        if let Err(e) = place_top_right(&win) {
            eprintln!("[hud] {e}");
        }
        let flags = HudFlags::new();
        if let Err(e) = apply_flags(&win, &flags) {
            eprintln!("[hud] {e}");
        }
        match show_hud(&app, &win) {
            Ok(()) => eprintln!("[hud] spike：HUD 已显示（延迟 {delay}s）"),
            Err(e) => eprintln!("[hud] 显示失败: {e}"),
        }
        // 等待一帧再回读
        std::thread::sleep(std::time::Duration::from_millis(600));
        dump_facts(&collect_facts(&app, &flags));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(ignores: bool, opaque: bool) -> AppKitFacts {
        AppKitFacts {
            is_visible: true,
            occlusion_state: 1 << 1,
            is_occluded: false,
            ignores_mouse_events: ignores,
            is_opaque: opaque,
            alpha_value: 1.0,
            level: 3,
            level_name: level_name(3),
            style_mask: 0,
            style_names: vec![],
            has_shadow: false,
            collection_behavior: 0,
            collection_names: vec![],
            is_key_window: false,
            can_become_key_window: true,
        }
    }

    #[test]
    fn hud_position_places_top_right_with_margin() {
        // 主屏 1920x1080 逻辑像素，可见区域从 y=25（菜单栏）开始
        let (x, y) = hud_position((0.0, 25.0, 1920.0, 1055.0), (380.0, 132.0), 16.0);
        assert_eq!(x, 1920.0 - 380.0 - 16.0);
        assert_eq!(y, 41.0);
    }

    #[test]
    fn hud_position_handles_negative_secondary_screen() {
        // 副屏挂在主屏左侧 → 可见区域 x 为负
        let (x, _y) = hud_position((-1920.0, 0.0, 1920.0, 1080.0), (380.0, 132.0), 16.0);
        assert_eq!(x, -380.0 - 16.0);
    }

    #[test]
    fn hud_position_clamps_when_hud_wider_than_screen() {
        // 窗口比可见区域还宽：不能把左边缘推出屏幕外
        let (x, _y) = hud_position((0.0, 0.0, 320.0, 480.0), (380.0, 132.0), 16.0);
        assert_eq!(x, 16.0);
    }

    #[test]
    fn level_names_decode_known_appkit_levels() {
        assert_eq!(level_name(0), "Normal");
        assert_eq!(level_name(3), "Floating");
        assert_eq!(level_name(25), "Status");
        assert!(level_name(9999).contains("9999"));
    }

    #[test]
    fn style_names_is_empty_for_borderless_window() {
        assert!(style_names(0).is_empty());
        let names = style_names(1 | 2 | 4);
        assert_eq!(names, vec!["Titled", "Closable", "Miniaturizable"]);
    }

    #[test]
    fn collection_names_decodes_spaces_bits() {
        assert!(collection_names(0).is_empty());
        assert_eq!(collection_names(1), vec!["CanJoinAllSpaces"]);
        let both = collection_names((1 << 0) | (1 << 8));
        assert_eq!(both, vec!["CanJoinAllSpaces", "FullScreenAuxiliary"]);
    }

    #[test]
    fn verdict_reports_green_when_everything_works() {
        let v = verdict_of(true, &facts(true, false));
        assert!(v.iter().any(|l| l.starts_with("✅ 真透明")));
        assert!(v.iter().any(|l| l.starts_with("✅ 点击穿透")));
        assert!(v.iter().any(|l| l.starts_with("✅ 无边框")));
        assert!(v.iter().any(|l| l.starts_with("✅ 置顶")));
        assert!(v.iter().any(|l| l.starts_with("✅ 未抢焦点")));
        assert!(v.iter().any(|l| l.starts_with("✅ 已上屏")));
        assert!(!v.iter().any(|l| l.starts_with("❌")));
    }

    #[test]
    fn verdict_accepts_tauri_full_size_content_view_mask() {
        // 实测：decorations(false) 下 tauri 仍会带上 FullSizeContentView(1<<15)，
        // 只要没有 Titled 位就没有标题栏 —— 不能误报成「仍有边框」
        let mut f = facts(true, false);
        f.style_mask = 1 << 15;
        f.style_names = style_names(f.style_mask);
        let v = verdict_of(true, &f);
        assert!(v.iter().any(|l| l.starts_with("✅ 无标题栏")));
        assert!(!v.iter().any(|l| l.contains("仍有标题栏")));
    }

    #[test]
    fn verdict_flags_missing_title_bar_mask() {
        let mut f = facts(true, false);
        f.style_mask = 1 | (1 << 15);
        f.style_names = style_names(f.style_mask);
        let v = verdict_of(true, &f);
        assert!(v.iter().any(|l| l.contains("仍有标题栏")));
    }

    #[test]
    fn verdict_flags_window_not_on_screen() {
        let mut f = facts(true, false);
        f.is_visible = false;
        let v = verdict_of(true, &f);
        assert!(v.iter().any(|l| l.contains("未上屏")));
    }

    #[test]
    fn verdict_explains_occluded_window() {
        // 被遮挡时离屏截图会全透明 —— 结论里必须说清「拍不到 ≠ 没画对」，
        // 否则会把锁屏/遮挡误判成渲染失败（spike 里真的错判过一次）
        let mut f = facts(true, false);
        f.occlusion_state = 0;
        f.is_occluded = true;
        let v = verdict_of(true, &f);
        assert!(v.iter().any(|l| l.contains("被遮挡")));
    }

    #[test]
    fn verdict_flags_opaque_window_as_failure() {
        // 这是最容易踩的坑：设了 transparent 但没开 macOSPrivateApi → 白底
        let v = verdict_of(true, &facts(true, true));
        let fail = v
            .iter()
            .find(|l| l.starts_with("❌"))
            .expect("应报透明失效");
        assert!(fail.contains("isOpaque"), "必须点出 isOpaque 便于定位");
    }

    #[test]
    fn verdict_detects_click_through_mismatch() {
        // 请求穿透但系统没生效（或反之）：必须报警而不是当成成功
        let v = verdict_of(true, &facts(false, false));
        assert!(v.iter().any(|l| l.contains("点击穿透不一致")));
    }

    #[test]
    fn verdict_warns_when_hud_steals_focus() {
        let mut f = facts(true, false);
        f.is_key_window = true;
        let v = verdict_of(true, &f);
        assert!(v.iter().any(|l| l.contains("抢了键盘焦点")));
    }

    #[test]
    fn hud_flags_default_to_passthrough_and_single_space() {
        let f = HudFlags::new();
        assert!(f.click_through(), "默认必须点击穿透（不挡操作）");
        assert!(!f.all_workspaces(), "默认不跨 Space（不骚扰）");
        f.set_click_through(false);
        assert!(!f.click_through());
    }

    /// 契约：HUD 指向的入口页必须真实存在。
    /// 指向不存在的页面在 Tauri 里是「静默白窗」，从日志里几乎看不出原因 —— 用测试钉住。
    #[test]
    fn hud_entry_file_exists_and_is_built_as_multi_entry() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri 的父目录应存在");
        let entry = root.join(HUD_URL);
        assert!(entry.exists(), "缺少 HUD 入口页：{}", entry.display());

        let vite = std::fs::read_to_string(root.join("vite.config.ts")).expect("读 vite.config.ts");
        assert!(
            vite.contains(HUD_URL),
            "vite.config.ts 未把 {HUD_URL} 配成构建入口 → 生产包不会有这个页面"
        );
    }
}
