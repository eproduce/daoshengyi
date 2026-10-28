# 语音自然度：诊断与优化方案（2026-10-22）

> 背景：1.0.0-alpha.13 做完语速 / 句末停顿 / 口语化清洗后，用户复听仍反馈
> 「语速和语气还是很机械，达不到正常的交互标准」。
> 本文回答三件事：**① 到底哪里机械（有实测）② 有哪些可选引擎（本机可行性）③ 怎么改才真正自然（分阶段）**。
>
> 完整调研原始报告（含全部复现命令与来源链接）：`VOICE_ENGINE_RESEARCH_2026-10-22.md`。

---

## 0. 结论先行

**机械的根因不是语速，是音源 + 整段合成。** 调语速只是让机械的声音说得快一点。

按「自然度 × 本机可行性」排序（**已用实测数据修正初稿结论**）：

| 顺位 | 方案 | 为什么 | 代价 |
| :-: | :--- | :--- | :--- |
| 🥇 | **Apple Tingting Premium（625MB）+ 常驻 `AVSpeechSynthesizer` 侧车** | 零成本、一次性下载、之后全离线；Premium 是神经音色（体积约为 compact 的 100 倍）；侧车能干掉 `say` 每次 **2.0~2.3s** 的进程启动 | 需用户手动下载；韵律控制弱（无 style） |
| 🥈 | **Azure `zh-CN-XiaoxiaoNeural` + `mstts:express-as` 风格** | 中文第一梯队；20 种 style（`chat`/`chat-casual`/`assistant` 正好适配 Agent）；流式首包 200~400ms | 联网 + Key；$15/百万字符（**每万汉字约 ¥0.11**） |
| 🥉 | **MeloTTS（sherpa-onnx 进程内，MIT）** | 离线兜底；本机实测 **RTF 0.25 / 44.1kHz**，7 字 186ms、27 字 615ms | 模型 197MB；韵律中等，无情感控制 |
| 备选 | `edge-tts`（晓晓） | 免费、热连接首包 **0.35~0.7s**，音色与 Azure 同源 | **非官方接口（ToS 灰色）**，只能当可选开关 + 降级链 |
| 别用 | Kokoro-82M-zh（本机） | **int8 量化在 x86 上比 fp32 慢 3 倍**（RTF 1.70 vs 0.52~0.65），27 字句要 3.2~10.4s | 达不到对话级延迟 |
| 别用 | 本地克隆（CosyVoice2/3、IndexTTS、F5、Spark、GPT-SoVITS） | 全需 GPU；GPT-SoVITS 的 M4 CPU 模式 RTF 0.526，本机估计 1.5~3（慢于实时） | 无 GPU 不可行 |

**两条与直觉相反、但已实测的事实**：

1. **Kokoro int8 在 Intel 上更慢**：sherpa-onnx 的 int8 算子在 x86 走反量化路径、无 VNNI 加速
   → 210MB int8 RTF **1.70**，而 311MB fp32 RTF **0.52~0.65**。Intel Mac 必须用 fp32，
   但即便如此，27 字也要 3.2~3.5s，「按句流式」勉强可用、不适合连续对话。
2. **`say` 的退出码恒为 0**：实测 `say -v 不存在的音色` 仍 exit 0 并按默认音色出声。
   现有 `speak()` 用 `exit_code != 0` 判失败 —— **这个判断永远不成立**，音色配置错了会静默走默认音色。

---

## 1. 诊断：机械感从哪来（逐条有据）

| # | 现象 | 证据（本机实测） | 影响 |
| :-: | :--- | :--- | :--- |
| 1 | 音源是 compact | `say -v '?'` 共 180 个音色，中文 19 个，其中 16 个是 `Eddy/Flo/Grandma…` 变体；真人 Tingting / Meijia / Sinji 均为 compact（`~/Library/Speech/Voices` 为空 = 未下载增强音色） | 音色本身无 F0 起伏，**决定性因素** |
| 2 | 系统其实提供 Premium，只是没装 | 读 `com_apple_MobileAsset_VoiceServicesVocalizerVoice.xml`：中文 3 条，全是 `.premium` —— tingting **625.0MB** / meijia 664.6MB / sinji 325.8MB，`state=1`（未下载） | **不换引擎就能质变**，只需下载 |
| 3 | 语速虽可调，但全局恒定 | 同一句 175 词/分 4.10s，`-r 240` 3.17s（−18%） | 只是"快慢"，不产生语调起伏 |
| 4 | 只有句末停顿 | `[[slnc]]` 在 `，` 后完全无效（音频时长一模一样），只有 `。！？` 后生效 | 句内没有呼吸与重音 |
| 5 | **整段一次性合成** | 单次 `say` 固定开销 **2.0~2.3s**（7 字短句 2.12/1.98/2.31s，与字数无关） | 首响恒定 2s+，无法边生成边念 |
| 6 | 无风格/情绪 | 模板只有 `{text}/{out}/{ref}`，没有 style 概念 | 问句、提醒、结论同一个调 |
| 7 | 只念 ≤80 字摘要 | `SPEAK_MAX_CHARS = 80`（`display-ir.ts`） | 没有连续对话的语流 |

> 第 5、7 条不是 bug，是**架构选择**：现在的语音是"回合结束后播一句结论"。
> 要做"正常交互"，必须变成"**句子级流式**"。

---

## 2. 候选引擎（本机实测）

### 2.1 延迟实测（i7-9750H / 16GB / 无 GPU，macOS 26.7.2）

| 引擎 / 模式 | 首响 | 说明 |
| :--- | :--- | :--- |
| `say -r 210`（现状） | 2.0~2.3s（进程启动） | 合成本身极快，**都是启动开销** |
| `edge-tts` CLI（冷启动） | 2.0~3.3s | 每次新起 python + 新建 WebSocket |
| `edge-tts` 热连接（流式 API） | **0.35~0.7s** | 拆成常驻侧车才拿得到 |
| 4 句 63 字 edge：串行 | 首句 2.4s，全部 12.2s | 每句各起一次连接 |
| 4 句 63 字 edge：流水线 | **首句 2.4s**，全部 5.7s | 首句合成完即播、其余并发预取 |
| MeloTTS（本地） | 7 字 186ms / 27 字 615ms | RTF 0.25 |
| Kokoro fp32（本地） | 7 字 ~1.0s / 27 字 ~3.3s | RTF 0.52~0.65 |

### 2.2 本地模型对比（sherpa-onnx 1.13.8，6 线程）

| 模型 | 体积 | 采样率 | RTF | 7 字首响 | 许可 | 结论 |
| :--- | :-: | :-: | :-: | :-: | :--- | :--- |
| **MeloTTS zh_en** | 197 MB | **44.1 kHz** | **0.25** | 186 ms | ✅ MIT | **离线首选** |
| matcha-icefall-zh-baker | 95 MB | 22.05 kHz | 0.06 | 161 ms | ⚠️ 数据集仅非商用 | 商用需替换 |
| piper zh_CN-huayan-medium | 79 MB | 22.05 kHz | 0.05 | 58 ms | ⚠️ "License: Unknown" | 商用高风险 |
| Kokoro multi-lang v1.1 **fp32** | 311 MB | 24 kHz | 0.52~0.65 | ~1.0 s | ✅ Apache-2.0 | 勉强，不适合对话 |
| Kokoro multi-lang v1.1 **int8** | 210 MB | 24 kHz | **1.70** ❌ | 3.0 s | ✅ Apache-2.0 | **Intel 上别用** |
| vits-icefall-zh-aishell3 | 209 MB | 8 kHz | 0.03 | 70 ms | — | 音质太差，仅作速度基线 |

### 2.3 云服务（查证，价格以官网为准）

| 服务 | 免费额度 | 价格量级 | 风格控制 | 备注 |
| :--- | :--- | :--- | :--- | :--- |
| **Azure Speech** | 神经音色 50 万字符/月 | S1 **$15/百万字符**（HD $22） | ✅ `mstts:express-as` 20 种 style | 中文第一梯队，Agent 场景最合适 |
| 阿里云 CosyVoice | 每模型 1 万字符（90 天） | ¥1.5/万字符（v3.5-plus） | 指令式 instruct | 国内节点低延迟 |
| 火山引擎（豆包语音） | 2 万字符 + 15 次训练 | ¥6.5/万字符 | 部分 | 多音色/方言 |
| MiniMax | — | ¥3.5/万字符（2.8-hd） | 参数式（语调/语速/音量） | — |
| OpenAI `gpt-4o-mini-tts` | — | ≈ $0.015/分钟 | ✅ 自然语言 `instructions` | 中文支持，但官方注明音色为英文优化 |
| ElevenLabs | 10k credits/月 | ≈ $180/百万字符 | 部分（audio tags） | 单价最高 |

### 2.4 工程前提（已复核）

- **`index.crates.io` 现已可访问**（实测 200，`cargo search sherpa-onnx` 正常）→
  `VOICE_INTERACTION_PLAN.md` 里"必须先配 `~/.cargo/config.toml` 镜像"的结论**作废**。
- sherpa-onnx v1.13.8 提供 **macOS x86_64 预编译**（`-shared-lib` 10.0MB / `-shared` 22.8MB），
  也有 universal2 版本；Rust 侧可用 crate `sherpa-rs 0.6.8` 或 `ort 2.0.0-rc.15`。
  官方示例只覆盖 ASR，TTS 需自己接（sidecar 或 FFI）。

---

## 3. 目标架构：Provider + 句子流水线 + 缓存 + 打断

```
present() ──► plan.speechText ──► 句子切分（。！？；+ 超长句按逗号二次切）
                                        │
                                        ▼
                              ┌──────────────────┐
                              │ 合成队列（并发 2）│──► 缓存命中？直接用
                              └──────────────────┘      （sha256(text+voice+rate+style)）
                                        │ 保持顺序
                                        ▼
                              ┌──────────────────┐
                              │ 播放队列（单实例）│──► AVAudioPlayer / afplay
                              └──────────────────┘
                                        │
                     新回合 / 热键 / 静音 ─┴─► 立即 kill 播放 + 清空队列
```

**按优先级路由（含失败回退）**

```
1) Apple Premium（AVSpeechSynthesizer 侧车，离线，零成本）   ← 有 Premium 就默认走它
2) MeloTTS / sherpa-onnx（离线兜底，MIT）
3) Azure Xiaoxiao + style（联网增强，用于"重要播报"）
✗ edge-tts：仅作可选实验开关（合规风险）
✗ 系统 say：仅当上面都不可用时的最后兜底
```

**表达力参数（按 provider 能力降级）**

| 参数 | Apple Premium | Azure | MeloTTS | edge | say |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 语速 | `rate` | `prosody rate` | `speed` | `--rate` | `-r` |
| 音高 | 弱 | `prosody pitch` | ✗ | `--pitch` | `[[pbas]]` |
| 风格/情绪 | ✗ | ✅ `express-as` 20 种 | ✗ | ✗ | ✗ |
| 真流式 | ✅ PCM 回调 | ✅ WebSocket | ✅ 进程内 | ✅（需常驻连接） | ✗ |

---

## 4. 分阶段落地

| 阶段 | 内容 | 人日 | 前置 | 验收（真机） |
| :-: | :--- | :-: | :--- | :--- |
| **P0**（用户 2 分钟，零代码） | 下载 Tingting Premium + 设置页选 edge 晓晓做对照 | 0 | 联网 625MB | A/B 听出差别 |
| **P1** | **`speak_tool.swift` 侧车**（`AVSpeechSynthesizer`）：干掉 2s 启动、拿 PCM 流、可精确 stop；音色质量检测（`say -v '?'` 的 `(Premium)` 后缀）+ 未安装时深链引导 | 1 | 无 | 首响 ≤300ms；朗读中 100ms 内停止；Premium 未装时提示可点 |
| **P2** | **句子流水线 + 播放队列 + 磁盘缓存 + 打断**（引擎无关的底座） | 1 | P1 | 4 句回复首句 ≤2.5s 出声；新回合 300ms 内静音；无重叠播放 |
| **P3** | 本地离线 provider：MeloTTS（MIT，RTF 0.25）走 sherpa-onnx sidecar/FFI | 1~1.5 | 197MB 模型下载 | 断网可用；CPU <30%；27 字句 ≤700ms |
| **P4** | 云 provider：Azure `express-as`（`chat` / `assistant` / `calm`）+ `prosody` | 1 | Key | 「用轻松的语气念结论」能听出差异；失败回退 P1 |
| **P5**（可选） | 真流式：Azure WebSocket / edge 常驻连接，边生成边播 | 2~3 | P2 | 首响 ≤1s；朗读中可直接打断并追问 |

**建议顺序**：P0（立刻听出差别）→ **P1 + P2**（交互底座，2 人日）→ P3（离线兜底）→ P4（表达力上限）→ P5。

> 注意：P1 的侧车不只是"为 Premium 服务"。**`say` 的 2s 启动开销本身就是交互硬伤**，
> 换任何本地引擎都建议走常驻进程。

---

## 5. 风险与取舍

| 风险 | 影响 | 对策 |
| :--- | :--- | :--- |
| **`say` 退出码恒为 0** | 音色名写错会静默用默认音色，用户以为改了没生效 | P1 起改用侧车实时状态；短期在 `speak()` 里校验音色是否在 `say -v '?'` 列表内 |
| Apple Premium 需手动下载 | 没下载就仍是 compact | 启动/设置页检测 `state`，给深链接 `x-apple.systempreferences:com.apple.preference.universalaccess?SpeakableItems` |
| `edge-tts` 非官方接口 | 随时可能失效 / ToS 灰色 | 只作可选开关，不做默认；P3 提供离线兜底 |
| 联网 = 文本出本机 | 隐私 | 明确开关 + 文案；静默模式/勿扰时段照旧生效；默认走本地 |
| 云服务计费 | 花钱 | 复用预算护栏；语音侧加"每日播报字符数"上限 |
| 模型体积 | 安装包变大 | 模型不打进 dmg，首次按需下载（进度/校验/可取消），失败回退 |
| CPU 抢占（6 核） | 与 LLM 流式抢核 | 合成并发限 2；本地模型限线程；短句优先 |
| 流水线"抢跑" | 与 HUD 淡出不同步 | 复用呈现协议 `sync` 单元（P-A6）：语音与浮层同起同收 |
| 许可：Matcha 非商用 / Piper 未标注 | 商用合规 | 商用走 MeloTTS（MIT）或 Kokoro（Apache-2.0，接受其延迟） |

---

## 6. 现在就能做的三件事（2 分钟，不改代码）

1. **下载中文 Premium 音色**：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音 →
   中文（中国大陆）→ 勾选「婷婷（Premium）」（625MB，一次性，之后离线）。
2. **对照测试 edge**（本机已装好 `edge-tts`）：设置 → 人机交互 → 自定义音色 → 预设
   「Edge 神经语音 · 晓晓」→ 试听。
3. 二选一留下更喜欢的那个；两个都嫌不够，就等 P1~P4。

对比音频（同文本 63 字，本机生成，见会话文件 `tts-v2/`）：
`say-Tingting-210.aiff`（现状 compact）、`zh-CN-XiaoxiaoNeural.mp3`、`zh-CN-XiaoyiNeural.mp3`、
`zh-CN-YunxiNeural.mp3`、`zh-CN-YunjianNeural.mp3`、`zh-CN-YunyangNeural.mp3`。

---

## 7. 附录：实测方法与关键命令

```bash
# ① 系统音色与可下载的 Premium 资产
say -v '?' | grep -E 'zh_|cmn'          # 已安装（带 (Enhanced)/(Premium) 后缀才是高质量档）
ls ~/Library/Speech/Voices              # 空 = 未下载增强音色
plutil -p /System/Library/AssetsV2/com_apple_MobileAsset_VoiceServicesVocalizerVoice/*.xml \
  | grep -i -A2 premium                 # 3 条中文 .premium（625/665/326 MB）

# ② say 的退出码靠不住（配置错也 exit 0）
say -v 根本不存在 -o /tmp/x.aiff -- "测试"; echo "exit=$?"   # → exit=0

# ③ 首字节 / 端到端（edge 流式 API）
python3 -c "...edge_tts.Communicate(text, voice, rate='-10%').stream()..."  # 记录首个 audio chunk

# ④ 走现有模板机制直连 edge（无需改代码，已验证）
python3 -m edge_tts --voice zh-CN-XiaoxiaoNeural --rate=-10% \
        --text '{text}' --write-media '{out}'            # 实测 2.07~2.96s 落盘，afplay 正常

# ⑤ 本地模型 RTF（sherpa-onnx 1.13.8，6 线程）
#   matcha-icefall-zh-baker / vits-melo-tts-zh_en / vits-piper-zh_CN-huayan-medium /
#   kokoro-{int8,fp32}-multi-lang-v1_1
```
