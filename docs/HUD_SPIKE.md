# HUD 浮层 spike ① 报告（Tauri 透明窗口 / 点击穿透 / 不抢焦点）

> 日期：2026-10-14（2026-10-15 解锁补完像素级验收）｜ 性质：**实测报告**（`docs/DESKTOP_AMBIENT_UI.md` §12 开放问题 ① 的答案）
> 一句话结论：**技术上都成立，且已全部通过真机验收**——透明、无边框、置顶、点击穿透、不抢焦点、
> 多入口独立 webview 在本机（macOS 26.7.2 / Tauri 2.11.5 / WKWebView）**全部可用**，HUD 形态可以按「右上角胶囊浮层」落地。
> 但**验证这件事本身的坑比实现多**：本篇记录了 3 个把结论带偏的陷阱，以及 4 个只有真机才暴露出来的细节问题。

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
| **像素级：桌面上确实看得见** | ✅ | C：窗口图四角 alpha≤14/255（仅胶囊柔和阴影）、中心 alpha=224、透明区占 6.9%；整屏前后对比：矩形内 24.8% 有绘制、矩形外 0.2%（无溢出）。裁剪图见 §5 |
| 胶囊四周真的透出桌面 | ✅ | C：整屏截图里胶囊四周能看到背后的 VS Code 窗口内容（人工看图确认） |

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

## 4. 修掉的四个真问题

### 4.1 显示 HUD 会抢走用户正在输入的焦点（已修）

第一版用 Tauri 的 `win.show()` 显示，回读发现 **`isKeyWindow=true`**，且 `osascript` 报前台应用已变成
`daoshengyi` —— 也就是说「随口问一句」会把用户正在打字的窗口顶掉。对一个环境层来说这是致命的。

改成 macOS 的原语 **`orderFrontRegardless`**（只置前、不激活 app、不成为 key window），
回读确认 `isKeyWindow=false` ✅。这条不是可选优化，而是「浮层不打扰」的硬要求。

> 注意：这段必须跑在主线程（AppKit 约定），且**不能用 Tauri 的 `show()` 代替** ——
> 所以 `hud.rs` 里有个带超时的 `on_main()` 帮助函数，把闭包丢到主线程再取回结果。
> 另外：绕过 Tauri 的 show 之后，tao 缓存的可视状态会滞后，**不能再用 `is_visible()` 判断是否上屏**，
> 要看 AppKit 的 `isVisible`（事实快照里同时给了两个值）。

### 4.2 未上屏时报假 ❌（已修）

`apply_flags`（点击穿透 / 跨 Space）是**在 show 那一刻**才应用的，窗口刚创建、页面刚加载时
读到的是「还没设」。于是早期版本在启动瞬间会输出一堆假报警：`❌ 点击穿透不一致`、`❌ 未上屏` ——
而这堆假 ❌ 正好把真正的排查方向带跑偏了。

现在：`verdict_of` 把**只在显示后才成立的四项**（上屏/遮挡/穿透/焦点）延后 ——
未上屏时只给「创建即生效」的四项（透明/无标题栏/置顶/阴影）+ 一行 `ℹ️ 尚未上屏`，不报 ❌。
有单测钉住（`verdict_defers_shown_only_checks_before_visible`）。

### 4.3 证据文件停在旧值（已修）

两个极端都踩过：① 每次调用（含前端每秒轮询）都写盘 → 证据文件被刷成噪音；
② 只在显式动作时写 → 文件停在旧值，**读到的其实是「启动前」的快照，差点误判成「透明没生效」**。

现在按**状态指纹**刷新：只有「上屏/焦点/遮挡/穿透/位置/前端自述」这几项变了才落盘。
有单测钉住（`should_dump_only_when_state_changes`、`facts_key_tracks_the_fields_we_judge_on`）。

### 4.4 `backdrop-filter`（毛玻璃）在透明窗口上**无效**（已弃用）

HMR 现场开启后抓图对比：**与不开时几乎完全一致** —— 因为 `backdrop-filter` 只能采样
**页面内部**的内容，而浮层页面里除了胶囊空无一物，它没有任何东西可糊。真机截图请看 §5。

结论：**直接不用**（白白付出合成开销，零收益）。
真毛玻璃要走原生 `NSVisualEffectView`（Tauri 的 `windowEffects`），
它是「整个窗口」级别的效果，与「胶囊圆角内局部模糊」不是一回事，**待单独验证**。

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

### 遗留项：屏幕解锁后的像素级复验（✅ 已于 2026-10-15 完成）

锁屏时 `occlusionState` 不含 `Visible` → AppKit **停掉窗口内容渲染**，窗口图 100% 透明，
所以「像素级证明」在锁屏下**不可能**取得（这也是 §5 表格里第三个陷阱）。解锁后按下面的协议一次跑通：

```bash
caffeinate -d -u -t 1800 &                          # 1. 保持屏幕唤醒（否则截图全黑）
DAOSHENGYI_HUD_SPIKE=1 DAOSHENGYI_HUD_SPIKE_DELAY=30 npm run tauri dev   # 2. HUD 30s 后出现
# 3. 等到快照显示 visible=true 后：
swift scripts/hud-spike-verify.swift --window "道生一 HUD" /tmp/hud-win.png
swift scripts/hud-spike-verify.swift /tmp/hud-before.png /tmp/hud-after.png 1524 46 380 132 2
```

**实测结果（两项均 PASS）**：

```
窗口级：四角 alpha 2 / 2 / 14 / 14（仅胶囊柔和阴影）・中心 alpha=224・透明区 6.9%・在屏
整屏：背景稳定 0.7%・矩形内 24.8% 有绘制・最外圈强变化 0.0%・矩形外 0.2%
```

两个值得记的判据细节：

1. **四角 alpha 不是 0 而是 2/14**：那是胶囊**自身的柔和阴影**（`box-shadow: 0 10px 30px`）——
   下角 14 > 上角 2，正好对应阴影向下偏移 10px。所以判据用「alpha < 24」而不是「== 0」；
   真正要拦的失败态是「整块 alpha=255」，两者差一个数量级。
2. **整屏对比里「最外圈」允许有轻微变化**：同样是那层阴影。因此工具把内边距区分成
   「弱变化」（阈值 24，正常）与「强变化」（阈值 96，= 铺了不透明底色，必须为 0），
   PASS 只看强变化。而「矩形外」必须接近 0（实测 0.2%）：说明阴影没有溢到窗口之外。

人工看图还确认了一件事：**胶囊四周透出的确实是背后的窗口内容**（截图里能看到 VS Code 的标题栏图标），
而不是一片黑底。

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
- **`backdrop-filter`（毛玻璃）已按实测结果弃用**：它在透明窗口上**什么也糊不到**
  （只能采样页面内部，而页面里除了胶囊空无一物），真机对比与不开时几乎一致 —— 零收益、白付开销。
  要真毛玻璃得走原生 `NSVisualEffectView`（Tauri `windowEffects`），那是**整个窗口**级别的效果，
  与「胶囊局部模糊」不是一回事，**列为待验证项**（Phase A 若要玻璃质感再评估）。
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
