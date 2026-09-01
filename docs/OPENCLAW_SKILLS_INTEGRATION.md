# OpenClaw 官方技能库分析与道生一技能补充

> 2026-09-02 预研,明早 10:00 开发计划启动后落地。
> 来源:官方 ClawHub(openclaw/clawhub)+ 社区索引 VoltAgent/awesome-openclaw-skills(52k star,5400+ 技能,clawskills.sh)。
> 原则:**只移植"纯提示词型"技能**(形态=专家指令,不依赖 OpenClaw 运行时/scripts/MCP),**本地优先、无需外部付费 API**,**复用道生一现有工具**(read_file / git / web_search / fetch_page / kb_* / memory_* / subagent)。

## 一、官方技能库概览

- 总规模:5400+ 技能,来源于官方 ClawHub 注册表,社区索引过滤掉 spam/重复/低质/加密币/恶意后按 27 类归档。
- 主要分类(各分类数量):
  | 分类 | 数量 | | 分类 | 数量 |
  |------|-----|-|------|-----|
  | Coding Agents & IDEs | 1184 | | Productivity & Tasks | 207 |
  | Web & Frontend Dev | 920 | | AI & LLMs | 176 |
  | DevOps & Cloud | 393 | | Git & GitHub | 167 |
  | Search & Research | 342 | | Communication | 146 |
  | Browser & Automation | 323 | | PDF & Documents | 105 |
  | CLI Utilities | 180 | | Security & Passwords | 54 |
- 形态:SKILL.md(YAML frontmatter + 正文)+ 可选 references/scripts/installer specs。多数技能绑定 OpenClaw 专属工具或第三方 API,只有部分属于"纯提示词专家"可直接借鉴。

## 二、筛选标准(道生一能直接用的)

1. **纯提示词可移植**:不含 OpenClaw 专属工具调用、不依赖 scripts 运行时、不依赖 ClawHub 安装器。
2. **本地优先 / 零外部付费依赖**:用免费公开源(OpenAlex、公开 RSS、本地 git)或不依赖网络。
3. **复用道生一现有能力**:read_file / git 工具 / web_search / fetch_page / kb_* / memory_* / subagent。
4. **中文场景友好**:面向中文用户常见任务(提交说明、调研简报、会话收尾、密钥扫描)。

## 三、本次补充技能清单(已写入 src/data/skills-catalog.ts)

| id | 名称 | 借鉴方向(官方库) | 道生一依托能力 | 分类 |
|----|------|------------------|----------------|------|
| commit-msg | 提交信息规范 | Git & GitHub(Conventional Commits 类) | git diff/status + 提示词 | 开发 |
| pr-summary | 改动总结 | Git & GitHub(PR 描述生成类) | git 工具 + read_file | 开发 |
| academic-research | 学术调研 | Search & Research(OpenAlex 免费源) | web_search + fetch_page | 调研 |
| rss-brief | 资讯简报 | Search & Research(ak-rss-24h-brief 思路) | fetch_page + web_search | 调研 |
| session-wrap-up | 会话收尾 | Productivity & Tasks(alex-session-wrap-up) | git + memory + kb | 生产力 |
| secrets-scan | 密钥扫描 | Security & Passwords | read_file + 项目扫描 | 安全 |
| knowledge-notes | 知识沉淀 | Notes & PKM(2nd-brain) | kb_create/kb_add + memory | 知识管理 |

> 注:官方库中大量高价值技能需要浏览器自动化 / 渠道 / 特定 API,待道生一 O7 插件化 SDK 与 S3 技能包结构化落地后再扩展。

## 四、后续扩展方向(依赖能力建设,排期靠后)

- **浏览器自动化技能**:依赖 puppeteer MCP(已有),可做表单/采集类技能 → 待技能包结构化后。
- **会议 / 转录 / 语音**:依赖 TTS/STT 能力(O10)。
- **渠道 IM 技能**:依赖 IM 网关扩展(O5)。
- **安全审计技能栈**(arc-security-audit 等):依赖 O6 安全自检并入 HealthPanel 后。

## 五、落地步骤(明早 10:00)

1. 核对 7 个新技能在技能库面板中的展示/启用/注入正常(vue-tsc + npm test)。
2. 实测 1~2 个(如 commit-msg、secrets-scan)在真实对话中生效。
3. 继续 §3.13 OpenClaw 整合第一批:O1 上下文压缩 / O2 SSRF / O3 会话级工具。
