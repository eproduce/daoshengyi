# HUD 浮层 spike ① 报告（Tauri 透明窗口 / 点击穿透 / 不抢焦点）

> 日期：2026-10-14 ｜ 性质：**实测报告**（`docs/DESKTOP_AMBIENT_UI.md` §12 开放问题 ① 的答案）
> 一句话结论：**技术上全部成立**——透明、无边框、置顶、点击穿透、不抢焦点、多入口独立 webview
> 在本机（macOS 26.7.2 / Tauri 2.11.5 / WKWebView）**都能做**，HUD 形态可以按「右上角胶囊浮层」落地。
> 但**验证这件事本身的坑比实现多**：本篇记录了 3 个把结论带偏的陷阱。
> 遗留 1 项：屏幕锁定时无法做像素级取证，需在解锁状态下补一次 30 秒确认（见 §5）。

---

## 1. 结论一览（逐项 + 证据来源）

证据分三级：**A = 系统 API 回读**（AppKit / CGWindowList，最硬）＞ **B = 页面自述**（前端把自身渲染状态回写）＞ **C = 像素**。

| 判定项 | 结果 | 证据 |
| :--- | :-: | :--- |
| 窗口真透明（非白底/黑底） | ✅ | A：`NSWindow.isOpaque=false`、`hasShadow=false` |
| 无边框/无标题栏 | ✅ | A：`styleMask=32768`（仅 `FullSizeContentView`，**不含 `Titled`**） |
| 置顶 | ✅ | A：`level=5`（>0，位于普通窗口之上） |
| 点击穿透 | ✅ | A：`ignoresMouseEvents=true`，与请求一致 |
| 不抢键盘焦点 | ✅（修复后） | A：`isKeyWindow=false`；修复前为 `true`（见 §4） |
| 窗口真上屏 | ✅ | A：`isVisible=true`；CGWindowList `在屏=true` |
| 几何位置正确 | ✅ | A：CGWindowList `1524,46 380x132`，与 `hud_status` 完全一致（见 §3） |
| 页面加载 + Vue 挂载 | ✅ | B：`boot: readyState=interactive inner=380x132 dpr=2` / `mounted: capsule=364x116@8,8` |
| 胶囊内边距留白正确 | ✅ | B：窗口 380x132，胶囊 364x116@(8,8) → 四周 8pt 透明边（像素判定的前提） |
| 多入口构建（`dist/hud.html`） | ✅ | `vite build` 产出 `hud.html` + 独立 `hud-*.js` chunk |
| **像素级：桌面上确实看得见** | ⏳ | 被锁屏挡住，无法取证（见 §5） |

> 说明：第 2 行的 `FullSizeContentView` 位是 Tauri 惯例（让 webview 铺满窗口），**不是标题栏**。
> 判定规则因此改为「有 `Titled` 位才算有标题栏」，并写了单测钉住（`verdict_accepts_tauri_full_size_content_view_mask`）。

---

## 2. 实现要点（`src-tauri/src/hud.rs`）

- **懒创建**：HUD 窗口只在被唤起时创建（本例由 `DAOSHENGYI_HUD_SPIKE` 触发），不设置就**永不出现**
  —— 这同时就是「常驻浮层必须有静默开关」的落地方式：不接受环境层的用户零成本。
- **透明的前置条件（容易静默失效）**：macOS 上 `transparent: true` **必须**配合
  `tauri.conf.json → app.macOSPrivateApi = true` + `tauri` crate 的 `macos-private-api` feature。
  缺任何一个都不会报错，只是「看起来设了透明、实际是白底」。官方 config schema 原话：
  *"on `macOS` this requires the `macos-private-api` feature flag"*。
  **代价**：走私有 API，**提交 App Store 会被拒**。我们只走 GitHub Release 分发，可接受；
  将来若要上架，必须改用非透明窗口 + 圆角内容区（或原生 `NSWindow` 面板）重做。
- **零新依赖**：`objc2` 本来就在依赖树里（tauri 的传递依赖），提为直接依赖即可离线解析
  （本机 crates.io 不可达），用于回读 AppKit 真实状态。
- **自证优先**：`hud_status` 返回「我们请求的开关」+「系统实际接受的状态（AppKit 回读）」+「人话结论行」。
  因为**请求 ≠ 生效**，而透明/穿透恰好都是「失效了也不报错」的属性。
- **`hud_note` 前端自述**：HUD 是独立 webview，白屏时没有可见控制台、看不到 DOM。
  让前端把自己的渲染状态（`readyState`、窗口内尺寸、胶囊尺寸、错误）回写进事实快照。

---

## 3. 关键实测数据（本机）

```
显示器：1920x1080 逻辑（scale=2，截图 3840x2160），可见区域 workArea=(0,30,1920,960)
HUD：逻辑 1524,46 尺寸 380x132 像素 760x264     ← 右上角，距可见区右/上各 16pt
CGWindowList：#744 层=5 alpha=1.00 1524,46 380x132 daoshengyi 道生一 HUD
AppKit：isOpaque=false  ignoresMouseEvents=true  level=5  styleMask=32768
        hasShadow=false  isVisible=true  isKeyWindow=false  canBecomeKeyWindow=true
前端自述：[hud] boot: readyState=interactive inner=380x132 dpr=2
        [hud] mounted: children=1 capsule=364x116@8,8 bodyBg=rgba(0,0,0,0)
```

`frontendNote` 也进了事实快照文件（`$TMPDIR/daoshengyi-hud-facts.json`），供脚本 `jq` 直接判定。

---

## 4. 修掉的两个真问题

### 4.1 显示 HUD 会抢走用户正在输入的焦点（已修）

第一版用 Tauri 的 `win.show()` 显示，回读发现 **`isKeyWindow=true`**，且 `osascript` 报前台应用已变成
`daoshengyi` —— 也就是说「随口问一句」会把用户正在打字的窗口顶掉。对一个环境层来说这是致命的。

改成 macOS 的原语 **`orderFrontRegardless`**（只置前、不激活 app、不成为 key window），
回读确认 `isKeyWindow=false` ✅。这条不是可选优化，而是「浮层不打扰」的硬要求。

> 注意：这段必须跑在主线程（AppKit 约定），且**不能用 Tauri 的 `show()` 代替** ——
> 所以 `hud.rs` 里有个带超时的 `on_main()` 帮助函数，把闭包丢到主线程再取回结果。
> 另外：绕过 Tauri 的 show 之后，tao 缓存的可视状态会滞后，**不能再用 `is_visible()` 判断是否上屏**，
> 要看 AppKit 的 `isVisible`（事实快照里同时给了两个值）。

### 4.2 事实快照被每秒轮询刷爆（已修）

HUD 每秒轮询 `status` 取最新事实，而每次调用都落盘 + 打整份 JSON 到 stdout，
把 `tauri dev` 的终端刷成几万行噪音（回看日志反而更难）。现在：只有**有动作**的调用才落盘，
日志只打结论行。

---

## 5. 验证陷阱（本次最大的时间开销都在这三件事上）

这三条都不是 HUD 的问题，但**都会让你得出错误结论**，因此必须写进流程：

| 陷阱 | 现象 | 对策 |
| :--- | :--- | :--- |
| **显示器睡眠** | `screencapture` 返回**纯黑图**，看着像「窗口没渲染」 | 取证前 `caffeinate -d -u -t 1800 &`；本工具会先算整屏平均亮度，<8 直接判「截图无效」 |
| **桌面壁纸轮播** | 两次整屏截图的差异高达 **83%**，把窗口差异彻底淹没 | 前后对比模式会先算「整屏变化比例」，>15% 直接判「背景不稳定、结论不可信」并建议改用窗口级取证 |
| **锁屏遮挡** | 锁屏窗口在**层 2004** 盖住一切；HUD 的 `occlusionState` 不含 Visible → AppKit 停掉内容渲染，窗口图 100% 透明 | 先看 `occlusionState`：被遮挡时**「拍不到」≠「没画对」**。本工具 `--list` 能直接看到 `loginwindow` 那一层 |

另外一条**平台坑**：**macOS 26.7.2 上 `screencapture -R x,y,w,h` 全部失败**
（`could not create image from rect`，连 `0,0,200,200` 都失败，加 `-D 1` 也一样），而整屏抓取正常。
所以取证链路改为「整屏抓取 + 自己裁剪」，或用**窗口级抓取**（`screencapture -l <windowID> -o`，
本机实测可用，且锁屏时也能拿到窗口图）。

### 遗留项：需要屏幕解锁时补一次（30 秒）

唯一还没拿到的是「**像素级证明：桌面上确实看得见、且四周透出桌面**」。
锁屏状态下 `occlusionState` 决定了这件事不可能取证（窗口被完全遮挡 → 不渲染）。

屏幕解锁后，设备旁的人只需（或让我）执行：

```bash
# 1. 保持屏幕唤醒
caffeinate -d -u -t 600 &
# 2. 起 spike（HUD 20 秒后出现）
DAOSHENGYI_HUD_SPIKE=1 DAOSHENGYI_HUD_SPIKE_DELAY=20 npm run tauri dev
# 3. 等 HUD 出现后，抓窗口本体并按 alpha 判定
swift scripts/hud-spike-verify.swift --window "道生一 HUD" /tmp/hud-win.png
#    期望：四角 alpha=0、中心 alpha>8、在屏=true → VERDICT PASS
```

肉眼只要确认一件事：**胶囊四周能看到桌面（不是白框/黑框），且点它不会抢走当前窗口的焦点。**

---

## 6. 取证工具（`scripts/hud-spike-verify.swift`）

零依赖（只用系统 CoreGraphics / ImageIO），三种模式：

| 模式 | 用途 |
| :--- | :--- |
| `--list` | 列显示器 + 所有在屏窗口（含层级/alpha/几何）→ 排查「窗口在不在、在哪块屏、被谁盖住」 |
| `--window <匹配> <out.png>` | **主判据**：按窗口 ID 抓窗口图 → 检查 alpha 通道（四角/中心/透明占比）→ 不依赖基线、不怕壁纸轮播 |
| `<before> <after> <x> <y> <w> <h> [scale]` | 交叉验证：整屏前后对比，含「整屏变化包围盒」用于识别变化另有来源 |

---

## 7. 对路线的影响（`DESKTOP_AMBIENT_UI.md` 更新）

- **Phase A 的 HUD 胶囊可以按原计划做**，形态定为：右上角、380×132、圆角 18、四周 8pt 透明边、
  默认点击穿透、出现时不抢焦点。上面这些数值与开关都已在真机上验证。
- **`backdrop-filter`（毛玻璃）暂不启用**：它要采样「窗口背后的内容」，而透明窗口在这种场景下
  能否稳定拿到背景尚未验证 —— HUD 视觉退化（变糊/变透明）属于最难查的一类问题，**没验证就不用**。
  待办：解锁状态下单独验证 `backdrop-filter` 与本机 Tauri `windowEffects` 两条路线。
- **点击穿透的取舍**：当前是**全局穿透**（窗口完全忽略鼠标）。要做「局部可点」需要
  「区域级穿透」或「全局穿透 + 热键唤起交互态」；本报告的建议是**后者**（更稳），
  与 §12 开放问题 ③ 的判断一致。
- **多屏**：目前固定摆在主屏可见区右上角；跟随鼠标所在屏/可拖拽记忆位置仍待做。

---

## 8. 顺带落地的东西

- `hud.html` + `src/hud-main.ts` + `src/components/HudSpike.vue`：**独立前端入口**
  （不复用主入口：主入口会拉起 Pinia/MCP/Ollama/托盘同步一整套启动副作用，
  而浮层要求「热键按下即刻可见」，且需要与主窗口互相隔离 —— HUD 崩了不能带走主窗口）。
  对应 `vite.config.ts` 配了多入口，并有 Rust 单测钉住「入口页存在 + vite 已配置」
  （指向不存在的页面在 Tauri 里是**静默白窗**，从日志里几乎看不出原因）。
- `src-tauri/capabilities/hud.json`：HUD 窗口的**最小权限**能力（只给 `core:default` +
  显式声明要用到的 window 权限），与主窗口权限分离。
- 单测 16 个：定位纯函数（含副屏负坐标、窗口比屏幕宽）、层级/位域解码、
  结论行生成（透明失效/穿透不一致/抢焦点/被遮挡/未上屏都会报警）。
