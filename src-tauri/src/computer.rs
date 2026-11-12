//! computer-use：让 agent 能**看屏幕**、**动鼠标键盘**（macOS）。
//!
//! 与 `browser.rs` 的边界：浏览器自动化只覆盖 web 页面（CDP）；这里覆盖**整个桌面**——
//! 用户真正在用的那个 App、那个弹窗、那条菜单。两者互补，不是替代。
//!
//! ## 为什么这样切
//!
//! 1. **一个工具、多个 action**（`computer_use {action: …}`）而不是六个 `computer_*`：
//!    工具表是模型每轮都要读的上下文，六个条目会挤掉真正需要记住的规则。
//! 2. **截图用系统 `screencapture`**，不引 ScreenCaptureKit：一步到位、无权限对话框连锁，
//!    且 `-x` 静音、输出 PNG，与后续 `view_image` 的像素路径天然一致。
//! 3. **注入用 CGEvent**（`core-graphics`，已在依赖树里）：这是 macOS 上唯一「不是模拟 AppleScript
//!    而是真事件」的方式，坐标与焦点行为跟用户手点一致。
//! 4. **能力默认关闭**（设置里 `computerUseEnabled`）+ **必须已获辅助功能授权**：
//!    能移动用户鼠标的 agent 必须由用户显式打开，且每次动作都进审计日志。
//!
//! ## 已知边界（诚实写清楚，别让模型瞎猜）
//!
//! - 未获「屏幕录制」授权时 `screencapture` 只能拍到桌面壁纸/空白 —— 我们会把这一点写进返回值。
//! - 未获「辅助功能」授权时 CGEvent 会被系统静默丢弃（**不报错**）——所以先 `AXIsProcessTrusted`。
//! - 坐标是**全局屏幕坐标**（左上角原点，与 `screencapture` 全屏图像素一致；Retina 下逻辑点）。

use serde::Serialize;

/// 允许的 action（写死白名单：模型拼错时给可读错误，而不是静默不动）
pub const ACTIONS: &[&str] = &[
    "screenshot",
    "windows",
    "move",
    "click",
    "type",
    "key",
    "scroll",
];

/// 动作参数（前端/模型给的都是可选字段，按 action 取用）
#[derive(Debug, Default, Clone)]
pub struct Action {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub button: Option<String>,
    pub count: Option<u32>,
    pub text: Option<String>,
    pub keys: Option<String>,
    pub dx: Option<f64>,
    pub dy: Option<f64>,
    pub path: Option<String>,
}

/// 执行结果（回给模型的文本 + 供 UI 用的结构）
#[derive(Debug, Serialize)]
pub struct ActionResult {
    /// 给模型看的一句话（含关键信息：坐标/路径/失败原因）
    pub message: String,
    /// 截图路径（仅 screenshot 有）
    pub screenshot: Option<String>,
}

/// 校验 action 合法性
pub fn check_action(action: &str) -> Result<(), String> {
    if ACTIONS.contains(&action) {
        Ok(())
    } else {
        Err(format!(
            "未知 action `{action}`（可用：{}）",
            ACTIONS.join(" / ")
        ))
    }
}

/// 坐标校验：必须是有限数且在合理屏幕范围内（防止 NaN/负数把指针甩到屏幕外）
pub fn check_point(x: f64, y: f64, max: f64) -> Result<(f64, f64), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("坐标必须是有限数字".to_string());
    }
    if x < 0.0 || y < 0.0 {
        return Err(format!("坐标不能为负（收到 {x}, {y}）；左上角为原点"));
    }
    if x > max || y > max {
        return Err(format!(
            "坐标超出屏幕范围（收到 {x}, {y}，上限 {max}）；先用 screenshot 看清位置"
        ));
    }
    Ok((x, y))
}

/// 修饰键解析：`cmd+shift+4` → (flags, 主键名)
///
/// 支持 cmd/command/⌘、ctrl/control/⌃、alt/opt/option/⌥、shift/⇧。
/// 修饰键顺序无所谓（用户和模型都会写乱），主键必须是**最后一个**。
pub struct Combo {
    pub cmd: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub key: String,
}

pub fn parse_combo(combo: &str) -> Result<Combo, String> {
    let raw = combo.trim();
    if raw.is_empty() {
        return Err("keys 不能为空（例如 `cmd+s`、`enter`、`cmd+shift+4`）".to_string());
    }
    // 允许 `⌘⇧4` 这种符号写法：逐个替换成加号分隔
    let normalized = raw
        .replace('⌘', "cmd+")
        .replace('⌃', "ctrl+")
        .replace('⌥', "alt+")
        .replace('⇧', "shift+");
    let parts: Vec<String> = normalized
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    let Some((key, mods)) = parts.split_last() else {
        return Err("keys 不能为空".to_string());
    };
    let mut c = Combo {
        cmd: false,
        ctrl: false,
        alt: false,
        shift: false,
        key: key.clone(),
    };
    for m in mods {
        match m.as_str() {
            "cmd" | "command" | "meta" | "super" => c.cmd = true,
            "ctrl" | "control" => c.ctrl = true,
            "alt" | "opt" | "option" => c.alt = true,
            "shift" => c.shift = true,
            other => {
                return Err(format!(
                    "不认识的修饰键 `{other}`（可用 cmd/ctrl/alt/shift）"
                ))
            }
        }
    }
    if keycode_for(&c.key).is_none() {
        return Err(format!(
            "不认识的按键 `{}`（可用字母数字、enter/tab/space/esc/backspace/delete/方向键/f1~f12，或单个字符）",
            c.key
        ));
    }
    Ok(c)
}

/// 主键名 → macOS 虚拟键码（ANSI 布局，与 Apple 的 `kVK_*` 一致）
pub fn keycode_for(key: &str) -> Option<u16> {
    let k = key.to_ascii_lowercase();
    let code = match k.as_str() {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "=" | "equal" => 24,
        "9" => 25,
        "7" => 26,
        "-" | "minus" => 27,
        "8" => 28,
        "0" => 29,
        "]" | "bracketright" => 30,
        "o" => 31,
        "u" => 32,
        "[" | "bracketleft" => 33,
        "i" => 34,
        "p" => 35,
        "enter" | "return" => 36,
        "l" => 37,
        "j" => 38,
        "'" | "quote" => 39,
        "k" => 40,
        ";" | "semicolon" => 41,
        "\\" | "backslash" => 42,
        "," | "comma" => 43,
        "/" | "slash" => 44,
        "n" => 45,
        "m" => 46,
        "." | "period" => 47,
        "tab" => 48,
        "space" => 49,
        "`" | "grave" => 50,
        "backspace" | "delete" => 51,
        "esc" | "escape" => 53,
        "left" | "arrowleft" => 123,
        "right" | "arrowright" => 124,
        "down" | "arrowdown" => 125,
        "up" | "arrowup" => 126,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "f1" => 122,
        "f2" => 120,
        "f3" => 99,
        "f4" => 118,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f8" => 100,
        "f9" => 101,
        "f10" => 109,
        "f11" => 103,
        "f12" => 111,
        _ => return None,
    };
    Some(code)
}

/// 鼠标按键名 → 规范值
pub fn parse_button(button: Option<&str>) -> Result<&'static str, String> {
    match button
        .unwrap_or("left")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "left" | "l" | "" => Ok("left"),
        "right" | "r" => Ok("right"),
        "middle" | "m" | "center" => Ok("middle"),
        other => Err(format!(
            "不认识的鼠标键 `{other}`（可用 left/right/middle）"
        )),
    }
}

/// 点击次数规范化（1=单击，2=双击；上限 3，防模型写 999 把系统点爆）
pub fn parse_count(count: Option<u32>) -> Result<u32, String> {
    match count.unwrap_or(1) {
        1..=3 => Ok(count.unwrap_or(1)),
        other => Err(format!("count 只能是 1~3（收到 {other}）")),
    }
}

// --- macOS 执行层 ---

#[cfg(target_os = "macos")]
pub mod mac {
    use super::Action;
    use core_graphics::display::CGDisplay;
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
        ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;
    use std::path::Path;
    use std::process::Command;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// 系统级「辅助功能」授权状态（未授权时 CGEvent 会被**静默丢弃**，所以必须前置检查）
        fn AXIsProcessTrusted() -> bool;
    }

    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// 主屏逻辑尺寸（点）。用于坐标上限校验：超出屏幕的点击只会打到空气。
    pub fn screen_bounds() -> (f64, f64) {
        let b = CGDisplay::main().bounds();
        (b.size.width, b.size.height)
    }

    /// 全屏截图（`screencapture -x`：静音、PNG）。返回字节数。
    ///
    /// 未获「屏幕录制」授权时系统仍会产出一张图（桌面壁纸或空白），所以调用方要结合
    /// 返回值里的提示告诉模型「图可能不全」。
    pub fn screenshot(dest: &Path) -> Result<u64, String> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
        }
        let out = Command::new("/usr/sbin/screencapture")
            .arg("-x")
            .arg("-t")
            .arg("png")
            .arg(dest)
            .output()
            .map_err(|e| format!("调用 screencapture 失败：{e}"))?;
        if !out.status.success() {
            return Err(format!(
                "截图失败：{}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        std::fs::metadata(dest)
            .map(|m| m.len())
            .map_err(|e| format!("截图文件不可读：{e}"))
    }

    fn source() -> Result<CGEventSource, String> {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "创建事件源失败（系统拒绝）".to_string())
    }

    fn point(x: f64, y: f64) -> CGPoint {
        CGPoint::new(x, y)
    }

    fn mouse_button(name: &str) -> (CGMouseButton, CGEventType, CGEventType) {
        match name {
            "right" => (
                CGMouseButton::Right,
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
            ),
            "middle" => (
                CGMouseButton::Center,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
            ),
            _ => (
                CGMouseButton::Left,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
            ),
        }
    }

    pub fn move_to(x: f64, y: f64) -> Result<(), String> {
        let src = source()?;
        let ev = CGEvent::new_mouse_event(
            src,
            CGEventType::MouseMoved,
            point(x, y),
            CGMouseButton::Left,
        )
        .map_err(|_| "创建鼠标移动事件失败".to_string())?;
        ev.post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn click(x: f64, y: f64, button: &str, count: u32) -> Result<(), String> {
        let src = source()?;
        let (btn, down, up) = mouse_button(button);
        // 先移到目标：否则某些 App 会用旧位置做命中测试（与真人操作不一致）
        move_to(x, y)?;
        for i in 1..=count {
            let d = CGEvent::new_mouse_event(src.clone(), down, point(x, y), btn)
                .map_err(|_| "创建按下事件失败".to_string())?;
            d.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
            d.post(CGEventTapLocation::HID);
            let u = CGEvent::new_mouse_event(src.clone(), up, point(x, y), btn)
                .map_err(|_| "创建抬起事件失败".to_string())?;
            u.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
            u.post(CGEventTapLocation::HID);
            if count > 1 {
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
        }
        Ok(())
    }

    /// 输入文本：逐字符写进键盘事件的 unicode 字段（不依赖输入法/键盘布局）
    pub fn type_text(text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        let src = source()?;
        // 一次事件可带多个 UTF-16 单元；分段发送，避免超长事件被系统截断
        for chunk in text.chars().collect::<Vec<_>>().chunks(16) {
            let s: String = chunk.iter().collect();
            let down = CGEvent::new_keyboard_event(src.clone(), 0, true)
                .map_err(|_| "创建键盘事件失败".to_string())?;
            down.set_string(&s);
            down.post(CGEventTapLocation::HID);
            let up = CGEvent::new_keyboard_event(src.clone(), 0, false)
                .map_err(|_| "创建键盘事件失败".to_string())?;
            up.set_string(&s);
            up.post(CGEventTapLocation::HID);
        }
        Ok(())
    }

    /// 组合键：`parse_combo` 已校验过键名，这里只负责注入
    pub fn key_combo(c: &super::Combo) -> Result<(), String> {
        let Some(code) = super::keycode_for(&c.key) else {
            return Err(format!("不认识的按键 `{}`", c.key));
        };
        let mut flags = CGEventFlags::empty();
        if c.cmd {
            flags |= CGEventFlags::CGEventFlagCommand;
        }
        if c.ctrl {
            flags |= CGEventFlags::CGEventFlagControl;
        }
        if c.alt {
            flags |= CGEventFlags::CGEventFlagAlternate;
        }
        if c.shift {
            flags |= CGEventFlags::CGEventFlagShift;
        }
        let src = source()?;
        let down = CGEvent::new_keyboard_event(src.clone(), code, true)
            .map_err(|_| "创建按键事件失败".to_string())?;
        down.set_flags(flags);
        down.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(src, code, false)
            .map_err(|_| "创建按键事件失败".to_string())?;
        up.set_flags(flags);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn scroll(dx: f64, dy: f64) -> Result<(), String> {
        let src = source()?;
        // 像素单位：正 dy = 向上滚（macOS 自然滚动下与手指方向一致）
        let ev = CGEvent::new_scroll_event(
            src,
            ScrollEventUnit::PIXEL,
            2,
            dy.round() as i32,
            dx.round() as i32,
            0,
        )
        .map_err(|_| "创建滚轮事件失败".to_string())?;
        ev.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// 可见窗口与前台 App（读操作）。走 AppleScript：AX 全量枚举要几百行 FFI，
    /// 而这条信息只用于「该点哪里」的定位，`System Events` 足够且不引入新依赖。
    pub fn windows() -> Result<String, String> {
        let script = r#"
set out to ""
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set out to "前台：" & frontApp & linefeed
  repeat with p in (every application process whose visible is true)
    set pname to name of p
    try
      repeat with w in (every window of p)
        set {wx, wy} to position of w
        set {ww, wh} to size of w
        set out to out & pname & " | " & (name of w) & " | " & wx & "," & wy & " " & ww & "x" & wh & linefeed
      end repeat
    end try
  end repeat
end tell
return out
"#;
        let out = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("调用 osascript 失败：{e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "读取窗口列表失败（通常是没有辅助功能授权）：{}",
                err.trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// 动作摘要（写审计日志用；不含用户输入的原文，只给长度，避免把密码写进库）
    pub fn audit_line(a: &Action, action: &str) -> String {
        match action {
            "type" => format!(
                "type len={}",
                a.text.as_deref().unwrap_or("").chars().count()
            ),
            "key" => format!("key {}", a.keys.as_deref().unwrap_or("")),
            "click" => format!(
                "click ({},{}) {}x{}",
                a.x.unwrap_or(-1.0),
                a.y.unwrap_or(-1.0),
                a.button.as_deref().unwrap_or("left"),
                a.count.unwrap_or(1)
            ),
            "move" => format!("move ({},{})", a.x.unwrap_or(-1.0), a.y.unwrap_or(-1.0)),
            "scroll" => format!(
                "scroll dx={} dy={}",
                a.dx.unwrap_or(0.0),
                a.dy.unwrap_or(0.0)
            ),
            "screenshot" => "screenshot".to_string(),
            _ => action.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机：截图必须产出非空 PNG（`#[ignore]`，因为它依赖真实桌面与会话权限）。
    /// 跑：`cargo test --lib computer -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_screenshot_writes_a_real_png() {
        let dir = std::env::temp_dir().join(format!("dsy-cu-{}", std::process::id()));
        let dest = dir.join("shot.png");
        let bytes = mac::screenshot(&dest).expect("截图应成功");
        assert!(
            bytes > 8 * 1024,
            "截图像素太小（{bytes} 字节），可能只有壁纸"
        );
        let head = std::fs::read(&dest).unwrap();
        assert_eq!(&head[1..4], b"PNG", "应是 PNG 文件");
        eprintln!(
            "[cu-live] 截图 {} 字节；trusted={} 屏幕={:?}",
            bytes,
            mac::trusted(),
            mac::screen_bounds()
        );
        // 窗口枚举需要「辅助功能」授权；没授权就跳过（不把环境问题当代码缺陷）
        match mac::windows() {
            Ok(list) => assert!(list.contains("前台："), "应包含前台 App：{list}"),
            Err(e) => eprintln!("[cu-live] 窗口枚举跳过：{e}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn action_whitelist_rejects_typos_with_readable_message() {
        assert!(check_action("screenshot").is_ok());
        assert!(check_action("click").is_ok());
        let e = check_action("screenshoot").unwrap_err();
        assert!(e.contains("未知 action"));
        assert!(e.contains("screenshot"), "错误里要列出可用项");
    }

    #[test]
    fn points_are_validated_before_touching_the_cursor() {
        assert_eq!(check_point(10.0, 20.0, 5000.0).unwrap(), (10.0, 20.0));
        assert!(check_point(-1.0, 0.0, 5000.0).is_err());
        assert!(check_point(0.0, 9000.0, 5000.0).is_err());
        assert!(check_point(f64::NAN, 0.0, 5000.0).is_err());
        assert!(check_point(0.0, f64::INFINITY, 5000.0).is_err());
    }

    #[test]
    fn combo_parses_modifiers_in_any_order() {
        let c = parse_combo("shift+cmd+4").unwrap();
        assert!(c.shift && c.cmd && !c.ctrl && !c.alt);
        assert_eq!(c.key, "4");
        assert_eq!(keycode_for(&c.key), Some(21));

        let c = parse_combo("⌘⇧4").unwrap();
        assert!(c.cmd && c.shift);
        assert_eq!(c.key, "4");
    }

    #[test]
    fn combo_requires_a_real_key_and_rejects_unknown_modifiers() {
        assert!(parse_combo("cmd+nope").is_err());
        assert!(parse_combo("hyper+x").is_err());
        assert!(parse_combo("").is_err());
        // `cmd+` 没有主键（`cmd` 被当成主键但它是修饰键名）→ 必须报错，而不是发出一个空按键
        assert!(parse_combo("cmd+").is_err());
    }

    #[test]
    fn keycodes_cover_the_keys_models_actually_use() {
        for (k, code) in [
            ("enter", 36),
            ("tab", 48),
            ("esc", 53),
            ("space", 49),
            ("backspace", 51),
            ("left", 123),
            ("a", 0),
            ("z", 6),
        ] {
            assert_eq!(keycode_for(k), Some(code), "键码不对：{k}");
        }
        assert!(keycode_for("不存在的键").is_none());
    }

    #[test]
    fn button_and_count_are_normalized() {
        assert_eq!(parse_button(None).unwrap(), "left");
        assert_eq!(parse_button(Some("RIGHT")).unwrap(), "right");
        assert!(parse_button(Some("wheel")).is_err());
        assert_eq!(parse_count(None).unwrap(), 1);
        assert_eq!(parse_count(Some(2)).unwrap(), 2);
        assert!(parse_count(Some(0)).is_err());
        assert!(parse_count(Some(99)).is_err());
    }
}
