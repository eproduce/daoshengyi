# 道生一 · 让 Agent 控制米家（MIoT）设备：方案设计

> 问题：如何让「道生一」的 agent 能控制米家物联设备（灯、插座、空调、扫地机、传感器、场景…）？
> 调研时间：2026-09-15 · 调研方式：GitHub 源码/文档 + 官方文档站取证
> 结论可执行性判定：优先**复用已有生态**，不在 Rust 里重写小米私有协议。

---

## 一、结论摘要（TL;DR）

| 路线 | 做法 | 工作量 | 许可 | 推荐度 |
|---|---|---|---|---|
| **A. MCP 直挂（首选）** | 把第三方 `mijiaAPI` 的 **MCP server** 挂到本仓库**已有的 MCP 客户端**上 | **0.5 天**（配置级） | 外部依赖 GPL-3.0（独立进程，不链接不打包） | ★★★★★ |
| **B. Skill + CLI（低代码备选）** | 把 `mijiaAPI` 的 `SKILL.md` 做成**内置技能**，agent 用现有 `run_command` 跑 `uvx mijiaAPI …` | 0.5 天 | 同上 | ★★★★ |
| **C. Home Assistant 中台（规模化）** | HA + `hass-xiaomi-miot` 做设备抽象层，agent 走 HA 的 MCP/REST | 1-2 天（需装 HA） | Apache-2.0 + 组件 | ★★★★（设备多时最佳） |
| **D. Rust 直接实现 miio/MIoT 协议** | 自己写签名、加密、云接口 | 数周且持续维护 | — | ★（**不推荐**） |
| **E. 小米官方「云云对接」** | 小米 IoT 开发者平台 | — | 需**企业**开发者资质 | ❌ 个人不可行 |

**推荐组合**：先用 **A** 打通（今天就能用），把 **B** 作为"免 MCP 的兜底"（当用户没装 uv/MCP 出问题时），设备规模上去后再考虑 **C**。

**核心洞察**：这件事**根本不需要写米家协议代码**。本仓库已经有完整的 MCP stdio 客户端（`src-tauri/src/mcp.rs`）和技能系统，而社区已经有成熟的米家库并且**自带 MCP server**。所以正确做法是"接生态"，不是"造协议"。

---

## 二、为什么不自己实现协议（先划掉错误路线）

1. **需要逆向**：米家 App 的 API 是抓包逆向来，请求要签名（`ssecurity`/`nonce`/`signature`）+ AES 解密，参数还会变。
2. **两套协议并存**：老设备是 **miIO**（UDP 54321 + token），新设备是 **MIoT-Spec**（siid/piid/aiid 属性动作模型，属性名要从云端 spec 拉取）。自己实现等于把 `python-miio` + `micloud` 重写一遍。
3. **稳定性风险**：云端接口随时可能变（社区库会跟着修，你的自研代码不会）。
4. **项目已有更好的接入面**：MCP + 技能 + 工具审批 + 定时任务 + 工作流，全是现成的挂钩点。

---

## 三、路线 A（首选）：mijiaAPI 的 MCP Server

### 3.1 它是什么

[`Do1e/mijia-api`](https://github.com/Do1e/mijia-api)（798★，Python ≥3.10）——"米家 API，可以使用代码、CLI、MCP 直接控制米家设备"。**v4.0.0 起内置 MCP server**，v4.1.0 起还提供 Agent Skill。

### 3.2 启动与配置

```bash
uvx mijiaAPI mcp                          # 默认认证文件 ~/.config/mijia-api/auth.json
uvx mijiaAPI mcp -p /path/to/auth.json    # 指定认证文件
```

对应到本仓库 MCP 配置（`command` + `args` + 可选 `env`）：

```
command: uvx
args:    mijiaAPI mcp -p /path/to/auth.json
```

### 3.3 暴露给模型的工具（已核实清单）

| 工具 | 作用 |
|---|---|
| `login` / `login_status` | **二维码登录**：返回二维码图片链接，**后台线程长轮询等待扫码（不阻塞）**；`login_status` 查 pending/success/error |
| `list_devices` / `list_homes` | 列设备（含共享设备，可按家庭过滤）/ 家庭与房间层级 |
| `list_scenes` / `run_scene` | 列手动场景 / 按名称或 ID 运行场景 |
| `list_consumables` | 耗材信息（滤芯等） |
| `get_device_spec` | 取设备规格（可用**属性名/动作名**，无需 siid/piid） |
| `get_device_properties` / `set_device_property` | **按属性名**读/写（高层封装） |
| `run_device_action` | 按动作名执行（如 `toggle`） |
| `get_statistics` | 统计数据（耗电量、使用时长；`key`/`data_type` 依型号） |
| `run_speaker_command` | **通过小爱音箱执行自然语言指令**（万能旁路，见 §3.5） |

关键优势：**工具是语义化的**（按属性名而不是 siid/piid），模型不需要背协议细节，`get_device_spec` 还能让它自己先查能力再动手 —— 这正好匹配我们已有的"工具自省 → 再执行"的 agent 循环。

### 3.4 会话内登录（非常适合桌面 App）

凭证过期时**不需要重启 server、不需要用户开终端**：
1. 模型调 `login` → server 尝试刷新 token；失败则生成二维码并返回**图片链接**
2. 用户在米家 App 扫码（2 分钟内）
3. 模型轮询 `login_status` → `success` 后自动切换新凭证

→ 在道生一里可以直接**把二维码图片渲染到聊天流或面板里**，扫码即完成，体验闭环。

### 3.5 `run_speaker_command`：兜底神器

通过小爱音箱说自然语言（如"关灯"），能控制**米家 App 里支持的任意设备**，包括那些**没有开放 MIoT 属性**的老设备/第三方设备。代价：依赖有小爱音箱、延迟高、执行结果不可靠（是"说给音箱听"，不是"读返回值"）。
→ 定位：**兜底手段**，仅在 `set_device_property` 对该设备无效时使用，并在提示词里明确标注这个定位。

### 3.6 许可红线（必须遵守）

`mijiaAPI` 是 **GPL-3.0**，作者明确声明强传染性。因此：

- ✅ **允许**：把它作为**外部独立进程**（`uvx`/`pipx` 按需拉取、用户自己安装）调用 —— 只是进程间的 MCP/CLI 交互，不构成衍生作品
- ❌ **禁止**：把它的源码 copy 进本仓库、把它的代码打包进安装包/安装器一起分发（那会让整个项目受 GPL 约束）
- ⚠️ 若未来要"内置且合规"，改用 **MIT 的 `MiService`** 自写一个薄 MCP server（见 §五）

---

## 四、路线 B：Agent Skill + CLI（低代码兜底）

`mijiaAPI` 官方提供了 `skills/SKILL.md`，思路是"给 LLM 一份操作指南，让它用 bash 跑 `uvx mijiaAPI …`"。这**几乎可以原样搬进道生一的技能系统**（`src/data/skills-catalog.ts` + `SkillManager`），因为我们的 agent 本来就有 `run_command` 工具。

CLI 命令面（已核实）：

| 命令 | 用途 |
|---|---|
| `-l` / `--list_devices` | 列出所有设备（含共享） |
| `--list_homes` / `--list_scenes` / `--list_consumable_items` | 家庭与房间 / 场景 / 耗材 |
| `--run_scene 名称` | 运行场景 |
| `--get_device_info MODEL` | 按型号查规格（**免登录**） |
| `get` / `set` | `get --dev_name "卧室台灯" --prop_name "brightness"`、`set … --value 60` |
| `action` | `action --dev_name "卧室台灯" --action_name toggle` |
| `statistics` | 统计数据 |
| `run` | 通过小爱音箱执行自然语言命令 |

**官方明确的两条禁令（必须写进我们的技能提示词）**：
1. **禁止调用 `login`** —— 它会在终端打印二维码并**阻塞等待扫码**，会把会话卡死；应提示用户自己执行 `uvx mijiaAPI login -p <path>`
2. **禁止调用 `mcp`** —— 它是长期运行的 stdio server，会永久阻塞

（这正是"技能里必须写清行为边界"的典型案例，和我们已有技能的路由/渐进披露机制天然契合。）

---

## 五、路线 C：Home Assistant 做设备抽象层（设备多时最佳）

[`al-one/hass-xiaomi-miot`](https://github.com/al-one/hass-xiaomi-miot)（Apache-2.0，6.1k★）是 HA 里最成熟的米家集成：**自动把 MIoT 设备接入 HA**，支持 WiFi/BLE/ZigBee，三种连接模式（`local` / `cloud` / `automatic`），并有 `set_property` / `set_miot_property` / `call_action` / `get_properties` / `send_command` 等服务。

要点：
- **自动模式**会优先走局域网本地连接（更稳、更快、断网可用），不支持的才回落云端 → 这是"本地优先"理念的正解
- 仓库内 `.mcp.json` 里已配了 **miot-spec 的 MCP server**（官方生态也在走 MCP）
- 设备支持列表极广（灯/插座/空调/风扇/浴霸/摄像头/门铃/电视/投影/音箱/红外遥控/门锁/洗衣机/冰箱/净水器/空气净化器/窗帘/扫地机/温湿度/烟感/宠物喂食器…）；**轮询式**，所以无线开关/人体/门窗传感器**无法实时监听事件**
- HA 还有 `xiaomi_miot.intelligent_speaker` —— 与 `run_speaker_command` 同思路的小爱旁路

**适用场景**：家里设备多、想要统一抽象 + 本地优先 + 离线可用 + 未来接入非米家品牌（HA 生态）。代价是要维护一个 HA 实例（可在本机 Docker 跑）。

安全提醒：若让 agent 直连 HA REST，需要在 `appSettings` 的 `allow_private_hosts` 里放行 HA 所在内网地址（当前 SSRF 策略只默认放行**环回**，私有网段仍拦）。注意这是**用户显式放行**，不要让默认值变宽。

---

## 六、底层库对比（若决定自研 MCP server）

| 库 | 许可 | 认证方式 | 亮点 | 适合 |
|---|---|---|---|---|
| **`mijiaAPI`（Do1e）** | ⚠️ GPL-3.0 | **扫码登录**（最省事，无密码落库） | 自带 MCP server + Agent Skill；按属性名的高层封装 | 首选（外部调用） |
| **`MiService`（Yonsm）** | ✅ **MIT** | 账号密码 + SMS/Email OTP | **零硬依赖**（`aiohttp`/`pycryptodome` 可选，缺了自动回退纯 Python）；**MiNA 小爱音箱 TTS/音量/播放控制/取 AI 应答**；**`MI_LOCAL=<IP>:<token>` 局域网直连免云账号** | **自研 MCP server 的基座**（许可友好 + 含小爱语音） |
| `python-miio`（rytilahti） | ⚠️ GPL-3.0 | `miiocli cloud` 从云取 token | 官方 HA 在用；`genericmiot` 通用支持现代 MIoT 设备；**自带设备模拟器**（无设备也能开发） | 需要模拟器测试时 |
| `hass-xiaomi-miot`（al-one） | ✅ Apache-2.0 | 米家账号 / host+token | 设备覆盖最广、本地/云模式可切、HA 设备抽象 | 走路线 C |

> 注意：`python-miio` 的 `genericmiot`（现代 MIoT 设备）目前需要 **git 版本**（0.6.0 尚未发布）：`pip install --pre python-miio`。

---

## 七、与道生一的集成设计（具体改动点）

### 7.1 最小可用：MCP 目录条目

在 `src/data/mcp-catalog.ts` 增加一条（结构已确认：`id/name/icon/description/category/command/args/env?/tags`）：

```
id: "mijia", name: "米家智能家居", icon: "House"/"Lightbulb", category: "智能家居",
command: "uvx", args: "mijiaAPI mcp -p ~/.config/mijia-api/auth.json"
tags: ["米家", "小米", "IoT", "智能家居", "灯", "插座", "空调"]
```

需要处理的细节：
1. **`uvx` 路径探测**：GUI 启动的进程 `PATH` 常常不含 `~/.local/bin` → 启动前探测 `uv`（`which uv` / `~/.local/bin/uv` / `/opt/homebrew/bin/uv` / `/usr/local/bin/uv`），探测不到就在 UI 里给出安装引导（`curl -LsSf https://astral.sh/uv/install.sh | sh`）
2. **认证文件路径**：默认 `~/.config/mijia-api/auth.json`，建议在设置里可覆盖（`-p` 参数）
3. **首次登录引导**：直接告诉用户跑一次 `uvx mijiaAPI login`；或在会话内让模型调 `login` 拿二维码（见 7.2）

### 7.2 登录二维码内联渲染（体验关键）

`login` 工具返回**二维码图片 URL** → 在聊天流/面板里渲染 `<img>`，用户手机扫一下就完成。实现上不需要改 MCP 协议：工具返回内容里已含 URL，只要让**内置工具结果渲染支持图片 URL**（现有 `ChatMessage.vue` 已有图片/链接渲染能力，扩展一处即可）。
若 `login` 不可用，退化路径：面板给一个"复制登录命令"按钮 + 说明。

### 7.3 危险动作确认（必须做）

智能家居是**有物理后果**的：门锁、燃气阀、电暖器、洗衣机启动、窗帘全开。
→ 复用现有审批机制（`manual` / `smart` / `YOLO`）+ 权限系统：
- 维护一个"高风险工具/动作"清单（`lock`/`unlock`、`gas`/`valve`、`heater`、`wash` 启动、以及**所有 `run_speaker_command`**）
- 高风险动作强制二次确认（即便是 smart 档），并在卡片里显示"设备 + 动作 + 参数"三要素，让用户一眼看清要干什么

### 7.4 提示词层：教会模型正确流程

在系统提示/技能里加入固定流程（这是"准确"的关键）：

```
1. 不确定设备名 → 先 list_devices（拿准确 dev_name/model/did）
2. 不确定属性名 → 先 get_device_spec(model)（拿 prop_name/action_name）
3. 再 get_device_properties 读、set_device_property 写、run_device_action 执行
4. 场景类需求 → list_scenes + run_scene（比逐设备操作更可靠）
5. 若 set_device_property 对该设备无效 → 才考虑 run_speaker_command 兜底，并说明"结果不可靠"
6. 不猜测属性名；属性名报错就回到第 2 步
```

### 7.5 语义层：设备别名与房间（把"聪明"做在对齐上）

用户会说"把**客厅的灯**关一下"、"**主卧**空调调到 26 度"。做法：
- `list_homes` / `list_devices` 的返回里天然有**家庭/房间/设备名**，让模型自己做匹配即可（它擅长这个）
- 增强：把用户的**口语别名**（"小台灯"→`yeelink.light.lamp4` / 具体 DID）写成一条记忆（`fact_type` 可复用现有 `memory` 系统），下次直接命中，减少一次 `list_devices` 往返

### 7.6 与其他已有能力的联动（这是道生一的差异化）

| 已有能力 | 与米家结合 |
|---|---|
| **定时任务**（`ScheduledTasks`） | "每天 22:30 关客厅灯" → `run_scene` 或 `set_device_property`，本地定时，不耗 token |
| **工作流**（可视化编排） | 把"回家模式"沉淀成工作流：开灯 + 空调 26 度 + 音箱播报（`workflow_save` 已有 upsert 语义） |
| **记忆系统** | 设备别名、常用场景、偏好温度（如"我一般开 26 度"） |
| **技能系统** | 把 `SKILL.md` 里的流程做成内置技能，按需注入（渐进披露） |
| **审批三档** | 高风险设备动作走确认（见 7.3） |
| **日程 + 语音**（若落地语音方案） | "小爱，关灯"式自然语言 → agent 解析 → 米家工具执行，形成本地语音管家闭环 |

---

## 八、分阶段落地计划

### 阶段 1（0.5 天）· 手动验证闭环
1. 装 `uv`，跑 `uvx mijiaAPI login`（扫码）
2. `uvx mijiaAPI -l` 确认能列设备；`uvx mijiaAPI --get_device_info <model>` 确认能查规格
3. 在道生一 MCP 面板里手动加 `uvx mijiaAPI mcp` → 连接成功、`tools/list` 出现 §3.3 的工具
4. 对话测试："列出我家所有设备"→"把客厅灯打开"→"亮度调到 60"
- **验收**：全程不需要写代码，agent 能准确控制至少 1 个真实设备

### 阶段 2（1-2 天）· 产品化
1. `mcp-catalog.ts` 加"米家智能家居"条目（含 uv 探测 + 安装引导）
2. 登录体验：把 `login` 返回的二维码渲染进聊天流；加"重新登录"入口
3. 工具说明与提示词：写入 §7.4 的流程；高风险动作确认（§7.3）
4. 失败提示：认证过期 → 明确引导"会话内调 login 扫码"或"重跑 login 命令"
- **验收**：新用户从零到控制设备 ≤ 3 分钟；认证过期能自助恢复；门锁/燃气类动作必弹确认

### 阶段 3（2-3 天）· 语义与联动
1. 设备别名/房间记忆；常用场景快捷指令
2. 与定时任务/工作流打通（"回家模式"、"睡前模式"）
3. 可选：自研 MIT 版 MCP server（基于 `MiService`），加入**小爱音箱 TTS 播报**（把 agent 回复念出来，与语音输出方案合流）+ **局域网直连**（断网可用）
- **验收**：一句话触发多设备场景；断网时局域网设备仍可控

---

## 九、风险与坑

| 风险 | 说明 | 对策 |
|---|---|---|
| **GPL-3.0 传染** | `mijiaAPI` / `python-miio` 都是 GPL-3.0 | 只作为**外部进程**调用；不 copy 代码、不打包分发；要内置就用 MIT 的 `MiService` 自写 |
| **登录态过期** | 云端 token 会失效；小米可能风控（异地/多端登录） | 用 MCP 的 `login`/`login_status` 做会话内自助扫码；失败给明确引导 |
| **云接口是逆向的** | 小米随时可能改，库也可能短期失效 | 关注上游 issue；保底：局域网 token 直连（`MI_LOCAL`）或走 HA |
| **轮询非实时** | 部分 ZigBee 传感器（人体/门窗/无线开关）拿不到实时事件 | 不承诺"事件触发"，只做"状态查询 + 主动控制"；实时需求走 HA/网关 |
| **物理后果** | 门锁、燃气、电暖、大功率电器 | 高风险动作强制确认 + 审计日志（复用 `security.rs` 审计） |
| **凭证安全** | `auth.json` 含小米账号凭证 | 文件权限 `600`；不要写进对话/日志；若自研，用项目已有的 `aes-gcm` 加密存储 |
| **SSRF 策略** | MCP server 是独立进程，不受本项目 SSRF 约束；但**内置** `fetch_page`/HTTP 工具访问内网设备会被拦（私有网段默认拦） | 若确需直连局域网设备，让用户**显式**把该地址加入 `allow_private_hosts` 白名单，不放宽默认值 |
| **误操作面变大** | 家里设备全暴露给 agent，提示注入/模型幻觉可能造成误动作 | 限权：只挂必要的家庭/设备；破坏性动作确认；提示词明确"不确定就问，不要猜属性名" |
| **依赖 `uv`** | 用户机器上可能没有 uv / PATH 不含 `~/.local/bin` | 启动探测 + UI 安装引导；提供 `pipx install mijiaAPI` 备用命令 |
| **`login`/`mcp` 阻塞陷阱** | 若走 CLI/Skill 路线，这两个命令会卡死会话 | 技能提示词里明确列为**禁止调用**（官方 SKILL.md 也是这么规定的）；改走 MCP 的 `login`/`login_status` |

---

## 十、推荐动作

1. **今天**：按阶段 1 手动跑通（`uv install` → `uvx mijiaAPI login` → 挂 `uvx mijiaAPI mcp` → 对话控制一盏灯）。
2. **确认可行后**：做阶段 2 的产品化（目录条目 + 二维码登录 + 高风险确认 + 提示词流程）。
3. **再看**：是否需要阶段 3 的自研 MIT 版 MCP server（含小爱 TTS 播报与局域网直连），以及是否与语音输出方案合流。

---

## 十一、参考链接

- **mijiaAPI（首选，含 MCP server 与 Agent Skill）**：https://github.com/Do1e/mijia-api
  - MCP 用法与工具清单：https://mijia-api.do1e.com/usage/mcp
  - Agent Skill（含禁令与命令总览）：https://mijia-api.do1e.com/usage/skill
- **MiService（MIT，自研基座；含小爱 TTS 与局域网直连）**：https://github.com/Yonsm/MiService
- **python-miio（官方 HA 在用，含设备模拟器）**：https://github.com/rytilahti/python-miio
- **hass-xiaomi-miot（HA 集成，Apache-2.0）**：https://github.com/al-one/hass-xiaomi-miot
- MIoT-Spec 规范与设备能力查询：https://home.miot-spec.com/ · https://iot.mi.com/new/doc/design/spec/overall
