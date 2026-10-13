# 技能兼容性矩阵与 O7 契约（2026-10-13）

> 问题：我们的「技能 SDK」计划还在吗？以后能不能安装主流 agent 的技能（比如 DeepSeek Harness）？
> 本文给出**兼容性事实矩阵**、**本次已落地范围**、**三条硬限制**与 **O7 契约**。
> 相关文档：`DSH_PLUGIN_COMPATIBILITY.md`（DSH 插件为何不兼容）、`OPENCLAW_SKILLS_INTEGRATION.md`（ClawHub 技能移植）、
> `ANSWER_ME_WITH_HTML_INTEGRATION.md`（带脚本的技能怎么落地）、`ROADMAP.md` §5.1（三层能力模型）。

## 0. 结论摘要

| 判断 | 内容 |
| :--- | :--- |
| **能力路线** | 三层能力模型（① 内置工具主干 ② **技能**扩展 ③ MCP 补充）。**自建插件 SDK/插件内核（O7）已在 2026-09-15 降级为远期可选项**——技能这条线一直在推进 |
| **主流 agent 技能** | **纯提示词型（SKILL.md + frontmatter）今天就能直接导入**。已支持 Claude Code / Codex / Cursor / agentskills 通用目录 / OpenClaw-ClawHub / **DSH skill 子系统** |
| **DSH** | **skill 子系统：兼容**（本次补上扫描来源）；**Cordis 插件：不兼容也不建议**（那不是独立程序，是注册进宿主上下文的对象） |
| **本次落地（🟢）** | 补 4 类扫描来源 + 扁平 `<name>.md` 支持 + 自定义技能目录设置项 + 技能来源徽标 |
| **仍然不做** | 兼容 Cordis 插件内核、社区插件市场当主入口、自动执行上游安装器（`npx skills add`） |

## 1. 兼容性矩阵

| 生态 | 形态 | 能否装 | 说明 |
| :--- | :--- | :--- | :--- |
| **Claude Code 技能** | `~/.claude/skills/<name>/SKILL.md` | ✅ 直接扫 | 只认目录包，**不认**扁平 `.md`（避免误收 README） |
| **Claude Code 命令** | `~/.claude/commands/*.md` | ✅ 直接扫 | 全部 `.md` |
| **agentskills 通用目录** | `~/.agents/skills/**`、`<项目>/.agents/skills/**` | ✅ 直接扫 | `npx skills add -a <agent>` 给「其它 agent」装的位置；**目录包与扁平 `.md` 都认**。archify / answer-me-with-html 等属此类 |
| **Codex 提示词** | `~/.codex/prompts/*.md` | ✅ 直接扫 | 全部 `.md` |
| **Cursor 规则** | `<项目>/.cursor/rules/*.mdc` | ✅ 直接扫 | 工作区级 |
| **OpenClaw / ClawHub** | `SKILL.md` + 可选 `references/`、`scripts/` | ⚠️ 部分 | 纯提示词型可直接导入（已移植 7 个）；**带 scripts/ 的导入后会「装上但用不了」** |
| **DSH · skill 子系统** | `<项目>/.dsh/skills`、`<项目>/.agents/skills`、`<dshHome>/skills`、`Config.customSkillDirs`；目录包或扁平 `.md` | ✅ 兼容 | 格式与 agentskills 同款；本次补上 `~/.dsh/skills`、`<项目>/.dsh/skills`、`<项目>/.agents/skills` 与「自定义目录」 |
| **DSH · Cordis 插件** | npm 包 `apply(ctx)`，依赖 `ctx.tools`/`ctx.llm`/… 服务图 + 事件契约 | ❌ 不兼容 | 见 `DSH_PLUGIN_COMPATIBILITY.md`；要跑起来等于把 DSH 本体搬进来。替代路径 = **移植**（改写成我们的技能或 MCP server） |
| **MCP 插件** | 独立进程 / 远程 HTTP | ✅ 天然支持 | 跨 agent 的通用契约；仍是长尾补充 |
| 带脚本/资源的技能（任意生态） | `scripts/*.mjs`、视频/配音资源等 | ❌ 不搬 | 导入只取 `SKILL.md` 正文；需要脚本的走「内嵌资源 + 专用内置工具」（answer_html 即此模式） |

### DSH 的 6 处技能根 → 我们的映射（依据 `deepseek-harness/docs/subsystems/skills.zh.md`）

| DSH rank | DSH 根目录 | 道生一现状 |
| :--- | :--- | :--- |
| 100 `project-dsh` | `<项目>/.dsh/skills` | ✅ 本次新增（项目级） |
| 200 `project-agents` | `<项目>/.agents/skills` | ✅ 本次新增（项目级） |
| 300 `custom` | `Config.customSkillDirs` | ✅ 本次新增（设置里的「自定义技能目录」） |
| 400 `user-dsh` | `<dshHome>/skills`（默认 `~/.dsh`） | ✅ 本次新增（`~/.dsh/skills`；**若你改过 `DSH_HOME`，请把它填进自定义目录**） |
| 500 `user-agents` | `<agentsHome>/skills`（默认 `~/.agents`） | ✅ 早已支持（`~/.agents/skills`） |
| 600 `bundled` | 随包技能目录 | ➖ 不适用（那是 DSH 随包分发的） |

## 2. 本次落地（2026-10-13，🟢 档）

| 位置 | 改动 |
| :--- | :--- |
| `src-tauri/src/skill_import.rs` | `SkillSourceSpec` 加 `flat` 开关（指定文件名时是否**同时**接受扁平 `<name>.md`）；`is_candidate_file` / `collect_skill_files` 增参 |
| `src/utils/skill-import.ts` | `skillSourceSpecs(home, workspace, customDirs?)` 新增 4 类来源（`~/.dsh/skills`、`<项目>/.agents/skills`、`<项目>/.dsh/skills`、自定义目录）；`agents-skills` 开 `flat`；新增纯函数 `importOrigin(url)` 识别来源 |
| `src/components/SkillManager.vue` | 导入页：提示文案更新 + 「自定义技能目录」文本框（每行一个，保存进设置）；「我的技能」列表显示**来源徽标**（Claude Code / DSH / 通用技能目录 / Codex / Cursor / URL …） |
| `src/api/appSettings.ts` · `src-tauri/src/settings.rs` | 新增设置键 `customSkillDirs: string[]`（serde 默认 + `Default` + 两处测试字面量 + `frontend_settings_keys_survive_round_trip` 覆盖） |
| `tests/test-skill-import.test.ts` | 来源清单/`flat` 开关/自定义目录去重与 `~` 保留/`importOrigin` 识别（新增 5 条） |

**来源清单（改后）**

```text
主目录级  ~/.claude/skills          只收 SKILL.md
          ~/.claude/commands       全部 .md
          ~/.agents/skills          SKILL.md + 扁平 .md     ← agentskills 标准
          ~/.dsh/skills             SKILL.md + 扁平 .md     ← 本次新增
          ~/.codex/prompts          全部 .md
          ~/Documents/道生一技能     全部 .md
项目级    <工作区>/.agents/skills     SKILL.md + 扁平 .md     ← 本次新增
          <工作区>/.dsh/skills        SKILL.md + 扁平 .md     ← 本次新增
          <工作区>/.cursor/rules      .mdc
自定义    设置里的自定义技能目录        SKILL.md + 扁平 .md     ← 本次新增
```

**边界不变**：只扫**主目录内 / 工作区内**的目录（越界静默跳过）、单文件 ≤ 256KB、总条目 ≤ 200、深度 ≤ 3、跳过隐藏目录与符号链接。

## 3. 三条硬限制（装着不等于能用）

| 限制 | 表现 | 对策 |
| :--- | :--- | :--- |
| ① 只搬正文 | `scripts/`、`references/` 不落地 | 需要脚本的技能走「资源内嵌 + 专用内置工具」（`answer_html` 模式），或人工移植 |
| ② 不替换宿主变量 | `${CLAUDE_SKILL_DIR}` 之类原样保留 → 模型照着跑不存在的路径 | 导入后在技能库编辑提示词改成绝对路径；或等 O7 的变量替换表 |
| ③ 依赖别家工具名 | 技能里写着 OpenClaw/DSH 专属工具 → 指令在、工具不在 | 用技能 frontmatter 的 `requires_tools` / `requires_servers` 声明；导入后按缺失提示改写（**导入期校验见 🟡-3**） |

## 4. O7 契约（真要做「技能包结构化」时定这三条）

1. 技能可以是**目录**，可携带非 `.md` 资源（`scripts/`、`references/`），导入时一起落地；
2. **变量替换表**（`${SKILL_DIR}` 等）由宿主注入，技能文本不依赖某一家 agent 的私有变量；
3. 技能里的可执行资源**必须走统一命令管线**（审计 / 沙箱 / 审批），不允许技能自行拼接绕行。

补充两条（来自 2026-10-13 讨论）：

4. **能力声明校验**：导入时解析 `requires_tools` / `requires_servers`，缺失就明确提示降级，而不是让模型空转；
5. **装前静态安全扫描**：第三方技能是提示词注入/供应链的新入口（参考 NVIDIA SkillSpector 的思路），至少要能扫出可疑外泄/危险命令模式。

## 5. 明确不做

- 不兼容 Cordis 插件内核（替代 = 移植能力；DSH 生态的能力类插件我们已在 `DSH_ABSORPTION_PLAN` 吸收完毕）；
- 不自动执行上游安装器（`npx skills add` / `am update`）——供应链与网络限制；
- 不把「社区技能数量」当目标：技能是**能力补丁**，主干仍是内置工具 + 确定性下沉。

## 6. 后续（🟡 / 🔵）

| 档 | 事项 | 状态 |
| :--- | :--- | :--- |
| 🟡 | 技能包（.zip 批量导入导出 + `references/` 落地 + 冲突策略） | ✅ 2026-10-13 落地（见 §7） |
| 🟡 | 变量替换表（`${SKILL_DIR}` 等宿主注入） | ⬜ 待做 |
| 🟡 | 导入期能力声明校验 + 缺失工具降级提示 | ⬜ 待做（manifest 已带 `requires`，只是还没校验） |
| 🟡 | 装前安全扫描（危险命令 / 外泄域名模式） | ⬜ 待做 |
| 🔵 | 技能包来源哈希 / 许可证 / 更新检查 | ⬜ 待做（manifest 已留字段位） |
| 🔵 | 兼容 Cordis 插件 | **不做**（除非产品定位改变） |

**验收方式**：`npm test`（技能导入 20 条 + 技能包 10 条）+ `cargo test --lib`（扫描/技能包/设置 **286 条**）+ `npm run ci:local` 八门禁；
真机验证路径 = 技能库 → 导入 → 「扫描并导入」，观察「扫到 N 个文件」里出现新来源 label。

## 7. 技能包（批量导入导出，2026-10-13 落地）

### 包格式（v1，**同时就是上游 agentskills 目录形态**）

```text
manifest.json                   # format/version/exportedAt/count + 每个技能的路由/能力声明
<slug>/SKILL.md                 # 技能正文（带 frontmatter）
<slug>/references/<ref>.md      # 可选：参考资料
```

用 `<slug>/SKILL.md` 而不是扁平的 `<slug>.md`，是为了让包**可以直接丢进 `~/.agents/skills/` 或
`~/.claude/skills/`** 被 Claude Code / Codex / DSH 原样读走——导出即互操作，而不是只能我们自己读回。
纯中文技能名会得到空 slug → 退化成 `skill`、`skill-2`…（真名在 frontmatter 与 manifest 里）。

### 入口与实现

| 位置 | 内容 |
| :--- | :--- |
| `src-tauri/src/skill_pack.rs` | `export_skill_pack(skills, file_name?)` 写入 `~/Documents/道生一产物/*.zip` 并返回真实路径；`import_skill_pack(path)` 解包回内存（`manifest` + `entries` + `ignored`）+ 6 单测 |
| `src/utils/skill-pack.ts` | 纯映射：`packInputsFromSkills`（技能→打包入参）、`readPack`（解包结果→可导入文件 + slug→元数据含 references 正文）、`packSlugOf` |
| `src/utils/skill-import.ts` | `planSkillImport(files, existing, { onNameConflict: skip \| overwrite \| rename })`：**默认仍为 skip**（行为向后兼容）；`overwrite` 可覆盖 import/catalog 来源，**手写技能依旧受保护**；`rename` 改名成 `原名 (2)` 新增 |
| `src/components/SkillManager.vue` | 导入页：「同名冲突处理」下拉 + 「导入技能包 (.zip)」+ 多选/多拖 `.md`；「我的技能」页：逐条勾选 + 全选 + 「导出为技能包 (.zip)」，并显示已选数量 |

### 安全（解包当不可信输入处理）

- 条目路径必须在包内：拒绝绝对路径、反斜杠、空段、`.`、`..`、超过 3 层（**防 zip slip**）
- 只认 `manifest.json` / `<dir>/SKILL.md` / `<dir>/references/<file>`，其余条目忽略并计数
- 条目数 ≤ 200（另有「异常包」硬阀值）、单条目 ≤ 256KB、总量 ≤ 8MB、非 UTF-8 跳过
- Rust **只读进内存**，不往技能目录落任何文件：落盘与冲突决策全在前端（可测、可回滚）
- zip 文件名与 ref 文件名都做清洗（路径字符→`-`），导出目录固定为产物目录
