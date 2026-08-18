import { defineStore } from "pinia";
import { ref, computed, watch, reactive } from "vue";
import type { Conversation, ChatMessage, ChatTool, ApiConfig, ApiProfile, ImageAttachment, FileAttachment, MessageRole } from "@/types";
import { v4 as uuidv4 } from "./uuid";
import { formatSearchResults } from "@/api/search";
import { getPersona } from "@/data/personas-catalog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSkillStore } from "./skill";
import { MCP_CATALOG } from "@/data/mcp-catalog";
import { useMcpStore } from "./mcp";
import { useMemorySystem } from "./memory";
import { estimateMessageTokens, estimateCost } from "@/utils/tokens";
import { parseToolCall, stripToolJson, type ToolCall } from "@/utils/tool-call";
import { initSettings, updateSettings, getSettings, reloadSettings } from "@/api/appSettings";

// --- MCP 工具辅助 ---
let mcpToolsCache: { server: string; name: string; description: string; inputSchema?: Record<string, unknown> }[] = [];
export async function refreshMcpTools() {
  try {
    const servers = await invoke<[string, {name:string;description:string;inputSchema?:Record<string,unknown>}[]][]>("mcp_list_tools");
    mcpToolsCache = [];
    for (const [server, tools] of servers) {
      for (const t of tools) mcpToolsCache.push({ server, name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
  } catch { mcpToolsCache = []; }
}
/// 列出已启用但未连接的 MCP 服务器（如浏览器自动化），提示模型按需激活。
/// 浏览器等重服务器不会在日常对话中自动连接/弹窗，只有模型明确需要时才激活。
function pendingServersPrompt(): string {
  const pending = useMcpStore().servers.filter(s => s.enabled && !s.connected);
  if (pending.length === 0) return "";
  const lines = pending.map(s => {
    const cat = MCP_CATALOG.find(c => c.name === s.name || `${c.command} ${c.args}` === `${s.command} ${s.args}`);
    return `- **${s.name}**（未连接）: ${cat ? cat.description : "可用的 MCP 服务器"}`;
  });
  return (
    "\n\n## 未连接服务器（按需激活，不占用资源、不弹窗）\n" +
    lines.join("\n") +
    "\n\n若任务需要上述服务器的能力，请先调用其激活指令，收到工具列表后再选择具体工具：\n" +
    pending.map(s => `<tool_call>\n{"server":"${s.name}","tool":"__connect__","arguments":{}}\n</tool_call>`).join("\n")
  );
}

/// 子代理运行记录（供可视化面板展示）
export interface SubagentRecord {
  id: string;
  goal: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt: number;
  durationSec?: number;
  resultPreview?: string;
  error?: string;
}

function getMcpToolsPrompt(): string {
  // 内置工具：如实描述特性/优势/适用场景，由大模型根据任务自行选择，不硬编码倾向
  const builtin =
    "\n\n## 内置工具（server 填 `app`）\n" +
    "- **fetch_page** (app): 抓取网页 HTML 并转为纯文本返回。特点：快、稳定、无需浏览器；适合获取静态网页正文（新闻、天气、文档、说明等）。**注意**：JS 动态渲染的页面（数据靠脚本加载）、需登录的页面、或遇到反爬拦截（如“安全验证”）时，fetch_page 拿不到内容——此时必须改用浏览器自动化工具（puppeteer_navigate 打开 → 等待/提取/截图）。参数 {\"url\": \"完整网址\"}\n" +
    "- **web_search** (app): 网络搜索，返回相关网页标题/链接/摘要。特点：适合需要发现多个信息源、获取最新信息、或不确定具体网址时的探索。参数 {\"query\": \"关键词\"}\n" +
    "- **describe_image** (app): 用本地视觉模型描述图片内容。参数 {\"path\": \"本地图片文件路径\"}。用于理解截图/图片内容（可配合浏览器截图后使用）。\n" +
    "- **ocr_image** (app): 用本地 OCR（macOS Vision）提取图片中的文字。参数 {\"path\": \"本地图片文件路径\"}。用于从截图/图片提取文字。\n" +
    "- **subagent_delegate** (app): 委派子代理独立处理子任务（独立上下文、独立回答），返回其结论。参数 {\"goal\": \"子任务目标\", \"context\": \"可选补充上下文\"}。适合分头研究/独立验证、或需要并行推进多个子任务时使用；子代理结论会作为工具结果返回。" +
    "- **pdf_read** (app): 分段读取 PDF 文件内容（一次读一段，返回纯文本）。参数 {\"path\": \"PDF 路径\", \"offset\": 起始字符偏移, \"length\": 读取长度}。用于浏览长 PDF 时按需分段读取，避免一次性加载全部内容。" +
    "\n- **write_file** (app): **把内容写入本地文件（应用自身真实写盘并校验）**。参数 {\"path\": \"目标文件绝对路径（或以 ~/ 开头）\", \"content\": \"文件内容\"}。仅支持写入用户主目录内文件，可写 CSV/Excel 文本等任意文本格式。**写文件必须用本工具（server 填 app）**：返回真实绝对路径，回复用户时**必须原样引用**该路径，禁止改名、改目录或编造路径。" +
    "\n- **list_dir** (app): 列出本地目录内容（含子目录与文件）。参数 {\"path\": \"目录绝对路径\"}。用于查看磁盘上存在哪些文件、确认文件是否真实存在。" +
    "\n- **set_brave_api_key** (app): 保存用户提供的 Brave Search API Key（联网搜索更稳定）。仅当用户在对话中明确给出 key 时调用。参数 {\"key\": \"用户给的完整 Key\"}。";
  // 强制约束：实时/时效信息必须真实获取，严禁编造。防止模型凭训练数据"发挥"（如编造天气）。
  const realtime =
    "\n\n## 强制要求（实时/时效信息）\n" +
    "涉及任何**实时/时效性信息**（天气、新闻、股票、汇率、比分、价格、最新政策、当前现状、日期时间等）时，" +
    "**必须先调用 web_search 或 fetch_page 获取真实数据**，严禁凭记忆编造温度、数值、价格、事件或新闻。\n" +
    "若工具确实拿不到数据（搜索无结果、页面无法访问），请明确告知用户「无法获取」，不要编造。";
  // 搜索/查证类回复格式规范：整理成人类可读，禁止原样粘贴工具输出
  const searchFormat =
    "\n\n## 搜索/查证类回复规范\n" +
    "使用 web_search / fetch_page 后，**必须把结果整理成人类可读、格式美观的中文回答**，禁止原样粘贴工具返回的原始条目。\n" +
    "回答须满足：\n" +
    "1. **先给结论**：开头明确说明「共找到 N 条有用信息」或「未找到可靠的公开信息」，不要含糊。\n" +
    "2. **结构化呈现**：用 markdown 编号列表逐条给出 **信息主体 + 关键摘要 + 来源链接**，每条独立成行、条理清晰。\n" +
    "3. **查企业/实体时**：尽量给出 名称、类型/所在地、主营业务/简介、成立时间 等关键事实，并附**官方或权威来源链接**（官网、百科、工商信息等）；不同来源信息冲突时标注各来源。\n" +
    "4. **未找到**：明确说「未找到可靠的公开信息」，说明可能原因（如反爬、无公开资料），并给出可进一步核实的途径；**严禁编造**企业名、数据或来源。\n" +
    "5. **不要堆砌**：删除重复/低价值条目，按相关度排序，每条摘要控制在 1-2 行。";
  // 文件导出规范：必须用内置可信 write_file，禁止在正文模拟工具调用、编造路径
  const fileRule =
    "\n\n## 文件导出规范（重要）\n" +
    "需要把内容保存为本地文件（如 CSV 考勤表、报告、脚本等）时，**必须真实调用内置 write_file 工具（server 填 `app`）**，由应用真实写盘并校验。\n" +
    "- **调用方式只有一种**：在回复中输出 `<tool_call>{\"server\":\"app\",\"tool\":\"write_file\",\"arguments\":{\"path\":\"...\",\"content\":\"...\"}}</tool_call>`。\n" +
    "- **严禁在回复正文中模拟工具调用过程**：禁止以 `### 🔧 调用工具`、`<details>参数</details>`、`✅ 工具结果` 等卡片形式假装已调用工具或已写入文件——那只是文本，不会真正写盘。\n" +
    "- **只有 write_file 真实返回的路径才可引用**：最终回复**必须原样引用**工具返回的真实绝对路径，禁止改写文件名、目录或编造路径。\n" +
    "- **若未真实调用并成功写入，禁止给出任何文件路径**，也不要声称「已写入」或「已导出」，可如实说明无法保存文件。\n" +
    "- 禁止使用社区 filesystem MCP 服务器的写入类工具（write_file / write_text_file 等）。";
  const pending = pendingServersPrompt();

  if (mcpToolsCache.length === 0) {
    return builtin + realtime + searchFormat + fileRule + pending +
      "\n\n需要工具时只回复以下格式：\n<tool_call>\n{\"server\":\"app\",\"tool\":\"工具名\",\"arguments\":{...}}\n</tool_call>";
  }

  return builtin + realtime + searchFormat + fileRule +
    "\n\n## MCP 服务器工具（特性各异，请按需选择）\n" +
    mcpToolsCache.map(t => `- **${t.name}** (${t.server}): ${t.description}`).join("\n") +
    pending +
    "\n\n工具选择由你根据任务自行判断：静态网页正文用 fetch_page；需要打开浏览器、点击/输入/截图或抓取动态渲染内容用浏览器工具；本地文件读写用文件系统；回忆历史信息用记忆。不确定时可先用 web_search 或 fetch_page 探索。" +
    "\n\n## 浏览器自动化使用要点\n" +
    "- 打开 JS 动态渲染的页面后，**必须先等它渲染完成再提取/截图**：puppeteer_navigate 会自动等待网络空闲（waitUntil networkidle2）。\n" +
    "- 获取渲染后的页面文本，优先用 **puppeteer_evaluate** 执行 `document.body.innerText`（最可靠），不要只依赖截图。\n" +
    "- puppeteer_screenshot 截图仅用于视觉确认；若截图空白，说明页面尚未渲染或需登录，改用 puppeteer_evaluate 提取文本判断。\n" +
    "- 需要登录、或有验证码/反爬的页面（如爱企查、官方公示系统）可能无法自动获取，如实告知用户，不要编造数据。\n" +
    "\n需要工具时只回复以下格式：\n<tool_call>\n{\"server\":\"服务器名\",\"tool\":\"工具名\",\"arguments\":{...}}\n</tool_call>" +
    "\n\n完成任务后无需手动关闭浏览器：任务结束系统会自动断开浏览器（释放资源）。";
}

/// 任务完成后关闭浏览器，形成使用闭环。
/// server-puppeteer 无 puppeteer_close 工具，只能通过断开 MCP 连接
/// （kill 服务器进程，kill_on_drop）使浏览器窗口随之关闭。
async function closeBrowserIfOpen(): Promise<void> {
  const browserServers = new Set(
    mcpToolsCache.filter((t) => /^puppeteer_/i.test(t.name)).map((t) => t.server)
  );
  for (const server of browserServers) {
    try { await invoke("mcp_disconnect", { name: server }); } catch { /* 忽略 */ }
  }
  if (browserServers.size > 0) {
    // 同步清空工具缓存，并把 mcp store 中的服务器标记为未连接
    try { await refreshMcpTools(); } catch { /* 忽略 */ }
    try {
      const { useMcpStore } = await import("./mcp");
      useMcpStore().markDisconnected([...browserServers]);
    } catch { /* 忽略 */ }
  }
}
export async function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  // 内置工具（应用自带，无需 MCP 服务器）
  if (server === "app" || server === "builtin") {
    return callBuiltinTool(tool, args);
  }

  // 按需激活：模型请求 __connect__，或调用了未连接服务器的工具（未先激活）时，
  // 连接该服务器后返回工具列表，让模型重选具体工具。浏览器服务器借此才真正启动。
  const mcp = useMcpStore();

  // 关键守卫：写入类工具一律转发到内置可信 write_file（应用自身写盘+校验+返回真实绝对路径）。
  // 目的：确保文件真实落盘、并让模型拿到唯一的真实路径原样引用（防止它在回复时改写/编造路径，导致链接打不开）。
  if (/^(write_file|write_text_file|writeFile|create_file|save_file)$/i.test(tool)) {
    const path = String((args as Record<string, unknown>)?.path ?? "");
    const content = String((args as Record<string, unknown>)?.content ?? "");
    if (path) {
      try {
        return await callBuiltinTool("write_file", { path, content });
      } catch (e) {
        return `【文件写入被内置工具接管，但执行失败】${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  const target = mcp.servers.find(s => s.name === server) ?? mcp.servers.find(s => s.enabled && !s.connected);
  if (tool === "__connect__" || (target && target.enabled && !target.connected && target.name === server)) {
    if (!target) {
      return `未找到可激活的服务器「${server}」。可用工具：${mcpToolsCache.map(t => `${t.name}(${t.server})`).join(", ") || "无"}`;
    }
    if (target.connected) {
      return `服务器「${target.name}」已连接。可用工具：${mcpToolsCache.filter(t => t.server === target.name).map(t => t.name).join(", ") || "（暂无工具）"}。请选择合适的工具继续。`;
    }
    try {
      const toolNames = await mcp.connectByName(target.name);
      await refreshMcpTools();
      return `已按需连接服务器「${target.name}」，可用工具：${toolNames.join(", ")}。\n请根据工具列表选择合适的工具继续任务。`;
    } catch (e: unknown) {
      return `连接服务器「${target.name}」失败: ${e instanceof Error ? e.message : String(e)}。`;
    }
  }

  // LLM 填的 server 名可能与实际配置不一致（省略/偏差），映射到已连接服务器
  const knownServers = new Set(mcpToolsCache.map((t) => t.server));
  const effectiveServer = knownServers.has(server) ? server : (mcpToolsCache[0]?.server ?? server);
  // 增强浏览器自动化：navigate 时若模型未指定 waitUntil，默认等待网络空闲，
  // 确保 JS 动态渲染完成，避免紧跟的 screenshot 截到空白页面。
  if (tool === "puppeteer_navigate" && args && typeof args === "object" && !(args as Record<string, unknown>).waitUntil) {
    (args as Record<string, unknown>).waitUntil = "networkidle2";
  }
  const result = await invoke<{content:{type:string;text?:string;data?:string}[];isError?:boolean}>("mcp_call_tool", {
    server: effectiveServer, toolName: tool, arguments: args,
  });
  const text = result.content.map(c => c.text || "").join("\n");
  // 若返回了图片数据（如 puppeteer_screenshot 截图），保存到临时文件，
  // 并提示大模型可用 describe_image / ocr_image 分析该截图
  const images = result.content.filter(c => c.type === "image" && c.data);
  let out = text;
  for (const img of images) {
    try {
      const p = await invoke<string>("save_temp_image", { data: img.data });
      out += `\n\n截图已保存到: ${p}\n（如需理解截图内容，可调用内置工具 describe_image 描述图片 或 ocr_image 提取文字，参数 path 填该路径）`;
    } catch { /* 保存失败忽略 */ }
  }
  return out;
}

/** 调用应用内置工具（fetch_page 网页抓取、web_search 搜索） */
/// 从用户提问中提取搜索关键词（去标点、去常见请求/疑问/分析词），提升自动搜索相关度。
/// 自动搜索在发送前执行、无法先让模型给关键词，只能做轻量启发式清洗；
/// 清洗后为空则退回原始提问。
function extractSearchKeywords(text: string): string {
  const cleaned = text
    .replace(/[，。！？、；：""''（）【】《》…—·,.!?;:'"()\[\]{}<>]/g, " ")
    .replace(/(请|帮我|麻烦|请问|怎么样|什么样|为什么|怎么|如何|怎样|为啥|啥|一下|看看|查查|查|帮忙|分析|解释|介绍|总结|简述|说明|告诉我|我想知道|推荐|给)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || text.trim();
}
async function callBuiltinTool(tool: string, args: Record<string, unknown>): Promise<string> {
  switch (tool) {
    case "fetch_page": {
      const url = String(args.url || "");
      if (!url) throw new Error("fetch_page 需要 url 参数");
      const res = await invoke<{title: string; text: string; url: string}>("fetch_page", { url });
      let out = `【${res.title}】\n${res.text.slice(0, 4000)}`;
      // JS 动态渲染/反爬识别：内容过少或命中拦截词时，提示模型改用浏览器自动化（Puppeteer）
      const short = (res.text || "").trim().length < 300;
      const blocked = /安全验证|验证码|captcha|访问验证|请输入验证码|滑动验证|人机验证/i.test(`${res.title} ${res.text}`);
      if (short || blocked) {
        out += `\n\n⚠️ 页面内容过少${blocked ? "（疑似被反爬拦截）" : ""}，很可能是 JS 动态渲染、需登录或需等待加载。` +
          `请改用浏览器自动化工具获取动态内容：先调用 puppeteer_navigate 打开该 URL（可传 waitUntil: "networkidle0" 等待渲染完成），` +
          `再用 puppeteer_evaluate 执行 JS 提取页面数据（如 document.body.innerText），或 puppeteer_screenshot 截图分析。不要重复 fetch_page。`;
      }
      return out;
    }
    case "web_search": {
      const query = String(args.query || "");
      if (!query) throw new Error("web_search 需要 query 参数");
      const results = await invoke<{ title: string; url: string; snippet: string }[]>("web_search", { query, braveKey: getSettings().braveApiKey || "" });
      if (!results.length) return "（搜索无结果，请在回复中明确告知用户未找到可靠信息，不要编造）";
      return "以下是搜索结果，请整理成清晰的中文回答后再回复用户（先说明找到几条，再逐条列要点+来源，不要原样粘贴）：\n\n" +
        results.map((r, i) => `[${i + 1}] ${r.title}\n    链接: ${r.url}\n    摘要: ${r.snippet}`).join("\n\n");
    }
    case "set_brave_api_key": {
      // 让 Agent 也能帮用户配置 Brave 搜索 Key（用户把 Key 发给它后，它代填保存）
      const key = String(args.key || args.apiKey || "").trim();
      if (!key) throw new Error("set_brave_api_key 需要 key 参数（用户在对话中提供的 Brave Search API Key）");
      updateSettings({ braveApiKey: key }); // 同步更新内存缓存 + debounce 写盘；不 reload 避免读到旧值覆盖
      return `已保存 Brave Search API Key（${key.slice(0, 6)}…${key.slice(-4)}）。后续联网搜索将优先使用 Brave API。`;
    }
    case "describe_image": {
      const path = String(args.path || "");
      if (!path) throw new Error("describe_image 需要 path 参数（本地图片文件路径）");
      const desc = await invoke<string>("ollama_describe_image", { images: [`file://${path}`] });
      return desc || "（本地视觉模型无法识别该图片）";
    }
    case "ocr_image": {
      const path = String(args.path || "");
      if (!path) throw new Error("ocr_image 需要 path 参数（本地图片文件路径）");
      const ocr = await invoke<string>("ocr_image_file", { path });
      return ocr || "（未识别到文字）";
    }
    case "subagent_delegate": {
      const goal = String(args.goal || "");
      if (!goal) throw new Error("subagent_delegate 需要 goal 参数");
      const context = String(args.context || "");
      // 动态获取 chat store，避免模块循环依赖；子代理用独立上下文跑一轮 chat_once
      const { useChatStore } = await import("./chat");
      const store = useChatStore();
      const config = store.getAuxConfig();
      if (!config.baseUrl || !config.apiKey) throw new Error("请先配置 API 地址和 Key 再委派子代理");
      // 登记子代理记录（可视化面板实时显示）
      const rec = store.spawnSubagent(goal);
      const sys = "你是道生一的子代理，负责独立完成一个子任务。" +
        (context ? `\n补充上下文：${context}` : "") +
        "\n请聚焦完成该子任务并直接给出结论。不要提问、不要编造数据或来源；拿不到的信息请明确说明无法获取。";
      let finalText = "";
      try {
        const data = await chatOnce(config, [
          { role: "system", content: withMathRule(withCurrentDate(sys)) },
          { role: "user", content: `子任务：${goal}` },
        ]);
        if (!data) throw new Error("子代理执行超时或失败");
        finalText = (data.content || "（子代理未返回内容）").trim();
        store.completeSubagent(rec.id, finalText);
      } catch (e) {
        store.failSubagent(rec.id, e instanceof Error ? e.message : String(e));
        throw e;
      }
      // 子代理若也返回工具调用 JSON，则剥离展示
      const visible = finalText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim() || "（子代理未返回内容）";
      return `【子代理结论】\n${visible}`;
    }
    case "pdf_read": {
      const path = String(args.path || "");
      if (!path) throw new Error("pdf_read 需要 path 参数");
      const offset = Number(args.offset || 0);
      const length = Number(args.length || 4000);
      const text = await invoke<string>("read_pdf_part", { path, offset, length });
      return text || "（该段落无文本，可能已到文件末尾）";
    }
    case "write_file": {
      const path = String(args.path || "");
      const content = String(args.content ?? "");
      if (!path) throw new Error("write_file 需要 path 参数");
      if (!content) throw new Error("write_file 需要 content 参数");
      // 由应用自身写盘并校验真实存在，返回真实绝对路径
      const real = await invoke<string>("write_file_agent", { path, content });
      return real;
    }
    case "list_dir": {
      const path = String(args.path || "");
      if (!path) throw new Error("list_dir 需要 path 参数");
      const res = await invoke<{ dir: boolean; path: string; name: string; size?: number }[]>("read_file", { path });
      if (!Array.isArray(res)) return `（${path} 不是目录）`;
      return `目录 ${path} 内容（${res.length} 项）：\n` +
        res.map(r => (r.dir ? `📁 ${r.name}/` : `📄 ${r.name}${r.size !== undefined ? ` (${r.size} 字节)` : ""}`)).join("\n");
    }
    default:
      throw new Error(`未知内置工具: ${tool}`);
  }
}

/** 在系统提示开头注入当前日期，避免模型日期幻觉。
 *  注意用"天"粒度而非分钟：分钟级时间每次提问都会变，会打断 DeepSeek 前缀缓存
 *  导致命中率趋近 0；精确时间由调用方放进"本次补充上下文"（最新用户消息）里。 */
function withCurrentDate(sp: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const weekday = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long" });
  return (
    `【系统当前日期】今天是 ${y}年${m}月${d}日 ${weekday}（${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}）。\n` +
    `这是唯一可信的日期来源。回答任何涉及日期/时间的问题前，请先核对上面的日期；严禁使用或编造训练数据中的日期（你的训练数据已过时）。\n\n` +
    sp
  );
}

/// 数学公式书写规范：注入系统提示，从源头减少模型输出的残缺/裸公式等格式问题
/// 注意：避免在规范中显式提及易被模型模仿的字符（如 >），防止提示词反向诱导
const MATH_FORMAT_RULE = `【数学公式书写规范】回复含数学公式时，务必遵守：
1. 所有数学公式（含单个字母变量）必须用美元符成对包裹：行内公式用一个美元符包住，独立公式用两个美元符换行包裹。例如"设 G 是有限群"应写为"设 $G$ 是有限群"。
2. 美元符必须成对且正确闭合，不要把公式与中文文字混在同一个美元符对里，公式前后可留空格。
3. 公式直接写在正文中即可，无需任何额外的引用或装饰符号包裹。
4. 使用 LaTeX 语法：幂用 ^（如 $n=a^2+b^2+c^2+d^2$）、乘法用 \\cdot（如 $|G|=|H|\\cdot[G:H]$）、分数用 \\frac、根号用 \\sqrt。`;

function withMathRule(sp: string): string {
  return `${sp}\n\n${MATH_FORMAT_RULE}`;
}

/// 非流式模型请求（chat_once）带前端超时兜底：
/// 网络/服务端偶尔会无响应，超时返回 null，避免 ReAct 循环一直等待导致气泡卡死为空泡泡
const CHAT_ONCE_TIMEOUT_MS = 60000;
async function chatOnce(config: ApiConfig, convo: { role: string; content: string }[]) {
  return Promise.race([
    invoke<{ content: string; reasoning_content?: string; cache_hit?: number; cache_miss?: number }>("chat_once", {
      config: {
        base_url: config.baseUrl,
        api_key: config.apiKey,
        model: config.model || "deepseek-v4-flash",
        max_tokens: config.maxTokens,
        temperature: 0.3, // 工具决策用低温更稳定
        thinking_enabled: config.thinkingEnabled,
        reasoning_effort: config.reasoningEffort,
        system_prompt: withMathRule(withCurrentDate(config.systemPrompt || "你是道生一，一个AI桌面助手。")),
        enable_web_search: config.enableWebSearch,
      },
      messages: convo,
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), CHAT_ONCE_TIMEOUT_MS)),
  ]);
}

const DEFAULT_PROFILES: ApiProfile[] = [
  {
    id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
    apiKey: "", model: "deepseek-v4-flash", maxTokens: 8192, temperature: 0.7,
    thinkingEnabled: true, reasoningEffort: "high",
    systemPrompt: "你是道生一，一个AI桌面助手。你运行在用户的本地设备上。请用简洁、准确的中文回答。",
    enableWebSearch: false, maxContextMessages: 50,
  },
];

export const useChatStore = defineStore("chat", () => {
  // --- Rust SQLite 持久化 ---
  async function initFromDb() {
    // 等 Tauri API 就绪
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      setTimeout(initFromDb, 100);
      return;
    }
    try {
      const convs = await invoke<{id:string;title:string;model:string;created_at:number;updated_at:number}[]>("load_conversations");
      for (const c of convs) {
        const msgs = await invoke<{id:string;conversation_id:string;role:string;content:string;reasoning_content?:string;images?:string;attachments?:string;timestamp:number;tokens?:number;duration?:number;cost?:number}[]>("get_messages", { conversationId: c.id });
        conversations.value.push({
          id: c.id, title: c.title, model: c.model,
          createdAt: c.created_at, updatedAt: c.updated_at,
          messages: msgs.map(m => ({
            id: m.id, role: m.role as MessageRole, content: m.content,
            reasoning_content: m.reasoning_content,
            images: m.images ? JSON.parse(m.images) as ImageAttachment[] : undefined,
            attachments: m.attachments ? JSON.parse(m.attachments) as FileAttachment[] : undefined,
            timestamp: m.timestamp, tokens: m.tokens, duration: m.duration, cost: m.cost,
          })),
        });
      }
      // 优先从 Rust 设置读活跃对话，回退 localStorage 旧数据
      let activeId: string | null = null;
      try {
        const settings = await initSettings();
        activeId = settings.activeConversationId;
      } catch { /* ignore */ }
      if (!activeId) activeId = localStorage.getItem("daoshengyi_activeConv");
      if (activeId && conversations.value.some(c => c.id === activeId)) {
        activeConversationId.value = activeId;
      }
    } catch (e) {
      console.warn("[道生一] 数据库加载失败，使用空数据:", e);
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSave() {
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const conv = activeConversation.value;
        if (!conv) return;
        await invoke("save_conversation", {
          conv: { id: conv.id, title: conv.title, model: conv.model, created_at: conv.createdAt, updated_at: conv.updatedAt },
          messages: conv.messages.map(m => ({
            id: m.id, conversation_id: conv.id, role: m.role, content: m.content,
            reasoning_content: m.reasoning_content || null,
            images: m.images ? JSON.stringify(m.images) : null,
            attachments: m.attachments ? JSON.stringify(m.attachments) : null,
            timestamp: m.timestamp, tokens: m.tokens || null, duration: m.duration || null, cost: m.cost || null,
          })),
        });
      } catch (e) { console.warn("[道生一] 保存失败:", e); }
    }, 500);
  }

  initFromDb();

  // --- 状态 ---
  const conversations = ref<Conversation[]>([]);
  const activeConversationId = ref<string | null>(null);

  // 已归档会话 ID 集合（localStorage 持久化；归档仅从主列表隐藏，数据仍在 SQLite）
  const ARCHIVE_KEY = "daoshengyi_archived_convs";
  function loadArchivedIds(): string[] {
    try {
      const s = localStorage.getItem(ARCHIVE_KEY);
      return s ? (JSON.parse(s) as string[]) : [];
    } catch { return []; }
  }
  const archivedIds = ref<Set<string>>(new Set(loadArchivedIds()));
  function persistArchived() {
    try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...archivedIds.value])); } catch { /* ignore */ }
  }
  const profiles = ref<ApiProfile[]>(loadProfilesLegacy());
  const activeProfileId = ref<string>(profiles.value[0]?.id ?? "default");
  const isStreaming = ref(false);
  const streamingContent = ref("");
  const streamingReasoning = ref("");

  // 缓存命中统计（DeepSeek usage.prompt_cache_hit/miss_tokens）
  const cacheHitTotal = ref(0);
  const cacheMissTotal = ref(0);
  const cacheHitRate = computed<number | null>(() => {
    const total = cacheHitTotal.value + cacheMissTotal.value;
    return total > 0 ? (cacheHitTotal.value / total) * 100 : null;
  });

  // 异步加载 Rust 端配置（优先于 localStorage 旧数据）
  initSettingsFromRust();

  // --- 计算属性 ---
  const activeConversation = computed(() =>
    conversations.value.find((c) => c.id === activeConversationId.value) ?? null
  );

  const sortedConversations = computed(() =>
    [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt)
  );

  // 归档过滤：主列表只显示未归档会话；归档会话单独列出（可在归档视图恢复/删除）
  const visibleConversations = computed(() =>
    sortedConversations.value.filter((c) => !archivedIds.value.has(c.id))
  );
  const archivedConversations = computed(() =>
    sortedConversations.value.filter((c) => archivedIds.value.has(c.id))
  );

  // 当前对话统计（总 token、总费用）
  const conversationStats = computed(() => {
    const conv = activeConversation.value;
    if (!conv) return { tokens: 0, cost: 0 };
    let tokens = 0;
    let cost = 0;
    for (const m of conv.messages) {
      if (m.role === "assistant") {
        if (m.tokens) tokens += m.tokens;
        if (m.cost) cost += m.cost;
      }
    }
    return { tokens, cost };
  });

  // 对话变更时自动保存 + 标记活跃对话
  watch(conversations, scheduleSave, { deep: true });
  watch(activeConversationId, (id) => {
    if (id) updateSettings({ activeConversationId: id });
  });

  const activeProfile = computed(() =>
    profiles.value.find((p) => p.id === activeProfileId.value) ?? profiles.value[0]
  );

  const currentConfig = computed<ApiConfig>(() => {
    const p = activeProfile.value;
    return {
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      thinkingEnabled: p.thinkingEnabled ?? false,
      reasoningEffort: p.reasoningEffort ?? "high",
      systemPrompt: p.systemPrompt ?? "",
      enableWebSearch: p.enableWebSearch ?? false,
      maxContextMessages: p.maxContextMessages ?? 50,
    };
  });

  // --- Persona 人格（角色/对话风格，全局偏好） ---
  const PERSONA_KEY = "daoshengyi_persona";
  const activePersonaId = ref(localStorage.getItem(PERSONA_KEY) || "");
  function setPersona(id: string) {
    activePersonaId.value = id;
    try { localStorage.setItem(PERSONA_KEY, id); } catch { /* ignore */ }
  }

  /// 辅助任务使用的模型配置：配置了 auxiliaryProfileId 则用对应 Profile，否则跟随主模型
  function getAuxConfig(): ApiConfig {
    const auxId = getSettings().auxiliaryProfileId;
    const p = auxId ? profiles.value.find((x) => x.id === auxId) : undefined;
    if (p && p.baseUrl) {
      return {
        baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model,
        maxTokens: p.maxTokens, temperature: p.temperature,
        thinkingEnabled: p.thinkingEnabled ?? false,
        reasoningEffort: p.reasoningEffort ?? "high",
        systemPrompt: p.systemPrompt ?? "",
        enableWebSearch: false,
        maxContextMessages: 20,
      };
    }
    return currentConfig.value;
  }

  // --- 子代理可视化（记录运行中的子代理，供面板展示） ---
  const subagents = ref<SubagentRecord[]>([]);
  function spawnSubagent(goal: string): SubagentRecord {
    const rec: SubagentRecord = { id: uuidv4(), goal, status: "running", startedAt: Date.now() };
    subagents.value.push(rec);
    return rec;
  }
  function completeSubagent(id: string, resultText: string) {
    const r = subagents.value.find((x) => x.id === id);
    if (r) {
      r.status = "completed";
      r.durationSec = Number(((Date.now() - r.startedAt) / 1000).toFixed(1));
      r.resultPreview = resultText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim().slice(0, 220);
    }
  }
  function failSubagent(id: string, err: string) {
    const r = subagents.value.find((x) => x.id === id);
    if (r) {
      r.status = "failed";
      r.durationSec = Number(((Date.now() - r.startedAt) / 1000).toFixed(1));
      r.error = err.slice(0, 220);
    }
  }
  function clearFinishedSubagents() {
    subagents.value = subagents.value.filter((x) => x.status === "running");
  }

  // --- 配置组持久化（Rust 端 SQLite + 加密 API Key） ---
  // 同步兜底：先读 localStorage 旧数据（作为迁移源）
  // 移除历史代码生成的默认 OpenAI 占位配置（未填 Key）
  function stripDefaultOpenAI(list: ApiProfile[]): ApiProfile[] {
    const filtered = list.filter(
      (p) => !(p.id === "default" && p.name === "OpenAI" && !p.apiKey)
    );
    if (filtered.length === 0) return [...DEFAULT_PROFILES];
    return filtered;
  }

  function loadProfilesLegacy(): ApiProfile[] {
    try {
      const saved = localStorage.getItem("daoshengyi_profiles");
      if (saved) {
        const parsed = JSON.parse(saved) as ApiProfile[];
        // 迁移：旧数据没有 thinkingEnabled 字段，重置为默认
        if (parsed.length > 0 && parsed[0].thinkingEnabled === undefined) {
          localStorage.removeItem("daoshengyi_profiles");
          localStorage.removeItem("daoshengyi_activeProfile");
          return [...DEFAULT_PROFILES];
        }
        return stripDefaultOpenAI(parsed);
      }
    } catch { /* ignore */ }
    return [...DEFAULT_PROFILES];
  }

  function saveProfiles() {
    updateSettings({
      profiles: profiles.value,
      activeProfileId: activeProfileId.value,
    });
  }

  // 从 Rust 加载配置；无 Rust 数据但有 localStorage 旧数据时执行迁移
  async function initSettingsFromRust() {
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    try {
      const legacy = localStorage.getItem("daoshengyi_profiles");
      const settings = await initSettings();
      if (settings.profiles.length > 0) {
        profiles.value = stripDefaultOpenAI(settings.profiles);
        if (settings.activeProfileId && profiles.value.some((p) => p.id === settings.activeProfileId)) {
          activeProfileId.value = settings.activeProfileId;
        } else if (profiles.value.length > 0) {
          activeProfileId.value = profiles.value[0].id;
        }
        if (legacy) {
          localStorage.removeItem("daoshengyi_profiles");
          localStorage.removeItem("daoshengyi_activeProfile");
        }
      } else if (legacy) {
        // Rust 无数据，迁移 localStorage 旧数据
        saveProfiles();
        localStorage.removeItem("daoshengyi_profiles");
        localStorage.removeItem("daoshengyi_activeProfile");
      }
    } catch (e) {
      console.warn("[道生一] 从 Rust 加载配置失败，回退 localStorage:", e);
    }
  }

  // 一键部署后刷新配置（Rust 端可能已自动添加/切换为本地 Ollama）
  async function reloadProfilesFromRust() {
    try {
      const settings = await reloadSettings();
      if (settings.profiles.length > 0) {
        profiles.value = stripDefaultOpenAI(settings.profiles);
        // 保持用户当前的文本主模型（如 DeepSeek）——本地 Ollama 只作为图片识别的视觉辅助，
        // 不因一键部署而切换主模型
        if (settings.activeProfileId && profiles.value.some((p) => p.id === settings.activeProfileId)) {
          activeProfileId.value = settings.activeProfileId;
        } else if (profiles.value.length > 0) {
          activeProfileId.value = profiles.value[0].id;
        }
      }
    } catch (e) {
      console.warn("[道生一] 刷新配置失败:", e);
    }
  }

  // 自动保存
  watch(profiles, saveProfiles, { deep: true });
  watch(activeProfileId, (id) => {
    updateSettings({ activeProfileId: id });
  });

  /// 切换 Profile 时是否显示“切换中”提示
  const profileSwitching = ref(false);
  function switchProfile(id: string) {
    if (!profiles.value.some((p) => p.id === id)) return;
    if (id === activeProfileId.value) return;
    // 优雅切换：停止进行中的流式生成，避免旧配置的请求中断报错刷屏（借鉴 Hermes profile 切换 overlay）
    if (isStreaming.value) stopStreaming();
    activeProfileId.value = id;
    profileSwitching.value = true;
    setTimeout(() => { profileSwitching.value = false; }, 800);
  }

  function updateProfile(id: string, partial: Partial<ApiProfile>) {
    const p = profiles.value.find((p) => p.id === id);
    if (p) Object.assign(p, partial);
  }

  function addProfile(profile: ApiProfile) {
    profiles.value.push(profile);
  }

  function deleteProfile(id: string) {
    if (profiles.value.length <= 1) return;
    const idx = profiles.value.findIndex((p) => p.id === id);
    if (idx === -1) return;
    profiles.value.splice(idx, 1);
    if (activeProfileId.value === id) {
      activeProfileId.value = profiles.value[0].id;
    }
  }

  // --- 对话管理 ---
  function createConversation(title?: string): string {
    const id = uuidv4();
    const now = Date.now();
    conversations.value.push({
      id,
      title: title || "新对话",
      messages: [],
      createdAt: now,
      updatedAt: now,
      model: currentConfig.value.model,
    });
    activeConversationId.value = id;
    return id;
  }

  function deleteConversation(id: string) {
    const idx = conversations.value.findIndex((c) => c.id === id);
    if (idx === -1) return;
    conversations.value.splice(idx, 1);
    invoke("delete_conversation_cmd", { id }).catch(() => {});
    if (activeConversationId.value === id) {
      activeConversationId.value = conversations.value[0]?.id ?? null;
    }
  }

  function selectConversation(id: string) {
    if (conversations.value.some((c) => c.id === id)) {
      activeConversationId.value = id;
    }
  }

  // --- 会话归档（localStorage 记录；归档=隐藏，数据保留） ---
  function archiveConversation(id: string) {
    archivedIds.value.add(id);
    persistArchived();
    // 归档当前活跃会话时，切换到最近一个未归档会话
    if (activeConversationId.value === id) {
      activeConversationId.value = visibleConversations.value[0]?.id ?? null;
    }
  }
  function unarchiveConversation(id: string) {
    archivedIds.value.delete(id);
    persistArchived();
  }
  /** 从归档中彻底删除（连同 SQLite 数据） */
  function deleteArchived(id: string) {
    unarchiveConversation(id);
    deleteConversation(id);
  }

  // --- 消息管理 ---
  function addUserMessage(
    convId: string,
    text: string,
    images?: ImageAttachment[],
    attachments?: FileAttachment[]
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: text,
      images: images && images.length > 0 ? images : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      timestamp: Date.now(),
    };
    const conv = conversations.value.find((c) => c.id === convId);
    if (conv) {
      conv.messages.push(msg);
      conv.updatedAt = Date.now();
      if (conv.title === "新对话" && conv.messages.length === 1) {
        const titleText = text || (images?.length ? "[图片]" : "") || (attachments?.length ? "[附件]" : "");
        conv.title = titleText.slice(0, 30) + (titleText.length > 30 ? "..." : "");
      }
    }
    return msg;
  }

  // --- 图片预处理：用视觉模型描述图片（图片→文字描述→交给文本大模型） ---
  // 长任务期间防止系统休眠（macOS caffeinate；非 macOS/失败静默忽略）
  async function setPreventSleep(active: boolean): Promise<void> {
    try { await invoke("set_prevent_sleep", { active }); } catch { /* ignore */ }
  }
  async function describeImages(images: ImageAttachment[]): Promise<string> {
    const b64s = images.map((img) => img.base64);
    // 1) OCR：macOS 系统 Vision 提取文字（准确、快、离线；非 macOS 返回空）
    let ocrText = "";
    try {
      // OCR 30 秒超时兜底，避免本地 OCR 卡住阻塞图片识别
      ocrText = await Promise.race([
        invoke<string>("ocr_extract_image_text", { images: b64s }),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 30000)),
      ]);
    } catch { /* 非 macOS 或无 OCR 工具时忽略 */ }

    // 2) 语义描述：本地视觉模型（跨平台通用；Intel 无 GPU 约 1 分钟）
    let semantic = "";
    try {
      // 110 秒兜底：本地推理慢，但避免异常导致前端永久挂起
      semantic = await Promise.race([
        invoke<string>("ollama_describe_image", { images: b64s }),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 110000)),
      ]);
    } catch { /* 视觉模型不可用时忽略 */ }

    // 合并 OCR 文字 + 语义描述
    const parts: string[] = [];
    if (ocrText) parts.push(`[图片中的文字（OCR）：]\n${ocrText}`);
    if (semantic) parts.push(`[图片内容描述：]\n${semantic}`);
    if (parts.length > 0) return parts.join("\n\n");

    // 3) 回退：找一个有视觉能力的 API（非 DeepSeek，已配 Key）
    const visionProfile = profiles.value.find(
      p => p.apiKey && !p.baseUrl.includes("deepseek")
    );
    if (!visionProfile) return "";

    const baseUrl = visionProfile.baseUrl.replace(/\/+$/, "");
    const fbParts: string[] = [];
    for (const img of images) {
      try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${visionProfile.apiKey}`,
          },
          body: JSON.stringify({
            model: visionProfile.model,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "请详细描述这张图片的内容。如果图片中有文字，请逐字转录。用中文回答，简洁准确。" },
                { type: "image_url", image_url: { url: img.base64, detail: "auto" } },
              ],
            }],
            max_tokens: 500,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const desc = data.choices?.[0]?.message?.content || "";
          if (desc) fbParts.push(`[图片: ${img.fileName || "附件"}] ${desc}`);
        }
      } catch { /* 单张失败不影响其他 */ }
    }
    return fbParts.join("\n\n");
  }

  // --- 终端命令执行（/run 指令） ---
  // 解析命令行（支持引号）
  function parseCommandLine(input: string): { command: string; args: string[] } {
    const tokens = input.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
    const clean = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
    return { command: clean[0] || "", args: clean.slice(1) };
  }

  // 危险命令模式（借鉴 DeepSeek Harness 的 approval 审批理念）
  const DANGEROUS_PATTERNS: RegExp[] = [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,   // rm -rf / rm -fr
    /\brm\s+.*\s\/\s*$|\brm\s+-[a-z]*r[a-z]*f\s+\//i,
    /\bsudo\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\b:\(\)\s*\{/i,                                  // fork bomb
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\b[^\n]*--force\b/i,
    /\bchmod\s+-R\s+777\b/i,
  ];

  function isDangerous(cmdStr: string): boolean {
    return DANGEROUS_PATTERNS.some((p) => p.test(cmdStr));
  }

  /// Smart 智能审批：用当前模型判断危险命令是否可安全自动执行。
  /// 判断失败或无法调用时保守返回 false（走手动确认）。
  async function judgeCommandSafety(cmdStr: string): Promise<boolean> {
    const config = getAuxConfig();
    if (!config || !config.baseUrl || !config.apiKey) return false;
    const sys =
      "你是命令安全审查器，判断一条 shell 命令是否可以安全自动执行。\n" +
      "安全标准：不删除用户数据/系统文件（删除 /tmp 或明确临时目录且路径安全可视为安全）、不破坏系统、" +
      "不泄露敏感信息、不下载并执行不可信脚本、不关闭/重启系统、不改权限到危险状态。\n" +
      "只回答 JSON：{\"safe\": true 或 false, \"reason\": \"10字内中文理由\"}，不要输出其他内容。";
    try {
      const data = await chatOnce(config, [
        { role: "system", content: sys },
        { role: "user", content: `命令：${cmdStr}` },
      ]);
      const text = (data?.content || "").trim();
      const m = text.match(/\{\s*"safe"\s*:\s*(true|false)/i);
      if (m) return m[1].toLowerCase() === "true";
    } catch { /* 判断失败走保守确认 */ }
    return false;
  }

  async function runCommand(cmdStr: string) {
    const { command, args } = parseCommandLine(cmdStr);
    if (!command) return;

    // 危险命令审批：manual 手动确认（默认）/ smart 辅助模型智能判断 / yolo 全部自动批准
    if (isDangerous(cmdStr)) {
      const st = getSettings();
      const mode: "manual" | "smart" | "yolo" = st.approvalMode || (st.yoloMode ? "yolo" : "manual");
      if (mode === "manual") {
        const ok = window.confirm(`⚠️ 检测到危险命令：\n\n$ ${cmdStr}\n\n确定要执行吗？`);
        if (!ok) return;
      } else if (mode === "smart") {
        const safe = await judgeCommandSafety(cmdStr);
        if (!safe) {
          const ok = window.confirm(`⚠️ 智能审批判定该命令存在风险：\n\n$ ${cmdStr}\n\n确定仍要执行吗？`);
          if (!ok) return;
        }
        // 判定安全 → 自动放行
      }
      // yolo → 自动放行
    }

    let convId = activeConversationId.value;
    if (!convId) convId = createConversation();
    addUserMessage(convId, `/run ${cmdStr}`);

    const conv = conversations.value.find((c) => c.id === convId)!;
    const assistantMsg = reactive<ChatMessage>({
      id: uuidv4(), role: "assistant", content: "", timestamp: Date.now(), streaming: true,
    });
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    isStreaming.value = true;
    streamingContent.value = `$ ${cmdStr}\n⏳ 执行中...`;

    const startTime = Date.now();
    // 命令执行期间防止系统休眠（长任务可能超 30 秒）
    await setPreventSleep(true);
    try {
      const result = await invoke<{ stdout: string; stderr: string; exit_code: number; timed_out: boolean }>(
        "execute_command", {
          command,
          args,
          cwd: getSettings().workspace || null,
          timeoutSecs: 30,
        },
      );
      const out = result.stdout.trimEnd();
      const err = result.stderr.trimEnd();
      let content = `$ ${cmdStr}\n`;
      if (out) content += `\n${out}\n`;
      if (err) content += `\n[stderr]\n${err}\n`;
      content += `\n退出码: ${result.exit_code}${result.timed_out ? "（超时）" : ""}`;
      assistantMsg.content = content;
    } catch (e: unknown) {
      assistantMsg.content = `$ ${cmdStr}\n\n❌ 执行失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await setPreventSleep(false);
      assistantMsg.streaming = false;
      assistantMsg.duration = Number(((Date.now() - startTime) / 1000).toFixed(1));
      assistantMsg.tokens = estimateMessageTokens(assistantMsg.content);
      assistantMsg.cost = 0;
      streamingContent.value = "";
      isStreaming.value = false;
      conv.updatedAt = Date.now();
      scheduleSave();
    }
  }

  // 读取文件（/read 指令，借鉴 DeepSeek Harness 的文件能力）
  async function runRead(filePath: string) {
    let convId = activeConversationId.value;
    if (!convId) convId = createConversation();
    addUserMessage(convId, `/read ${filePath}`);

    const conv = conversations.value.find((c) => c.id === convId)!;
    const assistantMsg = reactive<ChatMessage>({
      id: uuidv4(), role: "assistant", content: "", timestamp: Date.now(), streaming: true,
    });
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    isStreaming.value = true;
    streamingContent.value = `📄 正在读取 ${filePath}...`;

    const startTime = Date.now();
    try {
      const content = await invoke<string>("read_file", { path: filePath });
      assistantMsg.content = `📄 **${filePath}**\n\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``;
    } catch (e: unknown) {
      assistantMsg.content = `📄 **${filePath}**\n\n❌ 读取失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      assistantMsg.streaming = false;
      assistantMsg.duration = Number(((Date.now() - startTime) / 1000).toFixed(1));
      assistantMsg.tokens = estimateMessageTokens(assistantMsg.content);
      assistantMsg.cost = 0;
      streamingContent.value = "";
      isStreaming.value = false;
      conv.updatedAt = Date.now();
      scheduleSave();
    }
  }

  // --- 流式发送 ---
  async function sendMessage(text: string, images?: ImageAttachment[], attachments?: FileAttachment[]) {
    // 命令执行指令：/run <命令>
    if (text.trim().startsWith("/run ")) {
      await runCommand(text.trim().slice(5).trim());
      return;
    }
    // 文件读取指令：/read <路径>
    if (text.trim().startsWith("/read ")) {
      await runRead(text.trim().slice(6).trim());
      return;
    }
    // 新建对话：/new
    if (text.trim() === "/new") {
      createConversation();
      return;
    }
    // 清空当前对话：/clear
    if (text.trim() === "/clear") {
      clearCurrentConversation();
      return;
    }
    // 帮助：/help
    if (text.trim() === "/help") {
      const hcId = activeConversationId.value || createConversation();
      addUserMessage(hcId, "/help");
      const helpText =
        "**可用命令：**\n" +
        "- `/run <命令>`：执行终端命令\n" +
        "- `/read <路径>`：读取本地文件\n" +
        "- `/new`：新建对话\n" +
        "- `/clear`：清空当前对话\n\n" +
        "输入 `/` 可弹出命令面板。";
      const hc = conversations.value.find((c) => c.id === hcId);
      if (hc) {
        const m = reactive<ChatMessage>({ id: uuidv4(), role: "assistant", content: helpText, timestamp: Date.now(), streaming: false });
        hc.messages.push(m);
        hc.updatedAt = Date.now();
        scheduleSave();
      }
      return;
    }

    let convId = activeConversationId.value;
    if (!convId) {
      convId = createConversation();
    }

    addUserMessage(convId, text, images, attachments);

    // 用 reactive 创建，保证 push 后对 tokens/cost 等的赋值能触发响应式更新
    const assistantMsg = reactive<ChatMessage>({
      id: uuidv4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    });
    const conv = conversations.value.find((c) => c.id === convId)!;

    // 先 push 占位消息 + 标记流式状态：界面立即显示"正在分析图片..."，
    // 避免 await 图片识别期间无任何反馈，看起来像卡死
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    isStreaming.value = true;
    streamingContent.value = "";
    streamingReasoning.value = "";
    const startTime = Date.now();

    // 图片预处理：主模型非视觉（如 DeepSeek）→ 先用本地 Ollama 识别图片转成文字描述。
    // 描述作为上下文注入 system（模型可见），不写入用户消息，避免"分析内容"污染用户对话。
    const isDS = (currentConfig.value.baseUrl || "").includes("deepseek");
    let descCtx = "";
    let ocrFailed = false;
    if (isDS && images && images.length > 0) {
      // 流式消息渲染读的是 chatStore.streamingContent（不是 message.content），
      // 写这里界面才会在 agent 气泡立即显示"正在分析图片..."，否则会一直显示"思考中..."
      streamingContent.value = "🔍 正在用本地视觉模型分析图片（首次较慢，约 1 分钟）...\n\n";
      // 用 try-catch 包住识别调用：若本地视觉模型异常（invoke 报错、参数问题等），
      // 走 ocrFailed 分支进入主流程的错误兜底，绝不让异常绕过 try/catch/finally
      // 导致气泡停留为空内容（assistantMsg.content 永不赋值）。
      // 识别可能耗时（本地推理最多约 140 秒），期间防止系统休眠。
      let desc = "";
      await setPreventSleep(true);
      try {
        desc = await describeImages(images);
      } catch (e) {
        console.warn("[道生一] 图片识别异常:", e);
      } finally {
        await setPreventSleep(false);
      }
      if (desc) {
        descCtx = `[用户上传了图片，经本地视觉模型识别，图片内容如下：]\n${desc}`;
        images = undefined;
      } else {
        ocrFailed = true;
      }
      streamingContent.value = ""; // 清空占位，交由后续流式回复填充
    }

    let unlistenFns: UnlistenFn[] = [];
    let inputTokens = 0;
    const memory = useMemorySystem();
    // 方案 B：流式工具循环的展示记录（工具卡片逐段累积，最终拼进 assistantMsg.content）
    const toolChain: string[] = [];
    const toolCards: ChatTool[] = [];

    try {
      // 本地图片识别失败/超时：明确报错，避免静默降级成空回复
      if (ocrFailed) {
        throw new Error("本地图片识别失败或超时（请确认 Ollama 服务正常运行、llava-phi3 模型已下载）后重试");
      }
      const config = currentConfig.value;
      if (!config.baseUrl || !config.apiKey) throw new Error("请先在设置中配置 API 地址和 Key");

      // 每次发送前都刷新 MCP 工具缓存（不只缓存为空时）——
      // 避免启动早期只拿到部分服务器的工具（如缺文件系统），导致模型误以为没有该工具。
      // 连接失败不阻塞发送：按需连接失败时用已有工具兜底。
      const mcpSettings = getSettings().mcpServers ?? [];
      if (mcpSettings.some((s) => s.enabled)) {
        // 按需连接：对话开始时连接启用的 MCP 服务器（启动不全连、用完即断），再刷新工具缓存
        try { await useMcpStore().connectEnabled(); } catch { /* 连接失败不阻塞 */ }
        try { await refreshMcpTools(); } catch { /* 忽略 */ }
      }

      // 注入当前日期（防止日期幻觉），作为系统提示基础。
      // 用"天"粒度：每天只变一次，system 前缀稳定 → 历史消息可整段命中缓存。
      let spBase = config.systemPrompt || "你是道生一，一个AI桌面助手。";
      // Persona 人格：作为角色前缀注入（与技能库互补）
      const persona = getPersona(activePersonaId.value);
      if (persona) spBase = `${persona.prompt}\n\n${spBase}`;
      let sp = withMathRule(withCurrentDate(spBase));

      // ---- 稳定上下文：进 system（跨消息不变，保证前缀可缓存） ----
      // 注入已启用的技能
      const skillStore = useSkillStore();
      const skillPrompts = skillStore.enabledPrompts();
      if (skillPrompts) sp = sp ? `${sp}\n\n---\n\n${skillPrompts}` : skillPrompts;

      // 注入 MCP 工具（工具描述相对稳定）
      const mcpPrompt = getMcpToolsPrompt();
      if (mcpPrompt) sp = sp ? `${sp}\n\n${mcpPrompt}` : mcpPrompt;

      // ---- 易变上下文：每次提问都不同 → 追加到最新用户消息末尾，不进 system ----
      // 若放进 system，每次提问 system 都变，会从 system 开始打断前缀缓存；
      // 放进最新 user 消息后，system+历史前缀保持不变，可整段命中缓存。
      const volatileCtx: string[] = [];
      // 精确时间（分钟级，放进本次上下文不伤缓存，模型仍能答"现在几点"）。
      // 补全完整日期：系统提示的天粒度日期对"今天"有效，但用户消息里再带一份
      // 完整日期+星期+时刻，双保险，进一步压低日期/时间幻觉。
      const nowDt = new Date();
      const todayStr = `${nowDt.getFullYear()}年${nowDt.getMonth()+1}月${nowDt.getDate()}日 ${nowDt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long" })}`;
      volatileCtx.push(`【当前时间】现在是 ${todayStr} ${nowDt.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
      })}（Asia/Shanghai）。`);
      // 图片描述作为上下文（不展示在对话里，但模型可见）
      if (descCtx) volatileCtx.push(descCtx);
      // 注入文件上下文（PDF 走"分次浏览"：只给概要预览 + pdf_read 工具提示，按需分段读取）
      if (attachments && attachments.length > 0) {
        const fileCtx = attachments
          .map((f) => {
            const isPdf = f.mimeType === "application/pdf" || /\.pdf$/i.test(f.name);
            if (isPdf && f.path) {
              return `\n--- PDF 文件: ${f.name}（共 ${f.content.length} 字符）---\n` +
                `[内容较长，先展示开头预览]\n${f.content.slice(0, 2500)}\n` +
                `[如需完整内容，请调用 pdf_read 工具分段读取：参数 path="${f.path}", offset 从 0 起按 4000 逐段]`;
            }
            return `\n--- 文件: ${f.name} ---\n${f.content.slice(0, 30000)}`;
          })
          .join("");
        volatileCtx.push(`[用户提供的文件上下文]\n${fileCtx}`);
      }
      // 联网搜索结果（enableWebSearch 开关 → 发送前自动搜索并可视化展示；非工具调用）
      if (config.enableWebSearch && text.trim()) {
        // 先展示"正在联网搜索"，让用户看到搜索过程（与图片识别占位同理）
        const autoQuery = extractSearchKeywords(text.trim());
        streamingContent.value = `🌐 正在联网搜索：${autoQuery.slice(0, 24)}...`;
        try {
          const results = await invoke<{title:string;url:string;snippet:string}[]>("web_search", { query: autoQuery, braveKey: getSettings().braveApiKey || "" });
          if (results.length > 0) {
            volatileCtx.push(formatSearchResults(autoQuery, results));
            // 搜索结果做成可见卡片（进 toolChain，随最终答案一起展示在气泡里）
            const list = results.slice(0, 5).map(r => `- [${r.title}](${r.url})\n  ${r.snippet}`).join("\n");
            toolChain.push(
              `### 🌐 联网搜索\n\n**查询**：\`${autoQuery}\`\n\n` +
              `<details><summary>共 ${results.length} 条结果</summary>\n\n${list}\n\n</details>`
            );
          } else {
            streamingContent.value = `🌐 联网搜索「${autoQuery}」未找到结果，继续回答...`;
          }
        } catch { /* 搜索暂不可用 */ }
        streamingContent.value = ""; // 清空占位，交由流式回复填充
      }
      // 注入相关记忆（语义 + 关键词混合检索）——15 秒超时兜底，避免阻塞主对话
      const memText = await Promise.race([
        memory.retrieveMemories(text, config),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 15000)),
      ]);
      if (memText) volatileCtx.push(memText);
      // 自动摘要旧消息——30 秒超时兜底，避免阻塞主对话
      const summaries = await Promise.race([
        memory.maybeSummarize(convId, conv.messages, config),
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 30000)),
      ]);
      for (const s of summaries) volatileCtx.push(`对话摘要: ${s}`);

      // 构建 Rust 格式消息
      const maxCtx = config.maxContextMessages || 50;
      const rustMsgs: { role: string; content: unknown }[] = [];
      if (sp) rustMsgs.push({ role: "system", content: sp });
      conv.messages.filter(m => m.role !== "system" && !m.streaming).slice(-maxCtx).forEach(m => {
        // DeepSeek 不支持图片：所有带图片的消息（含历史残留的图片消息）一律只发文本，
        // 避免收到 image_url 报 400；支持图片的模型才发送多模态。
        if (m.images?.length && !isDS) {
          rustMsgs.push({ role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map(img => ({ type: "image_url", image_url: { url: img.base64, detail: "auto" } }))] });
        } else {
          rustMsgs.push({ role: m.role, content: m.content });
        }
      });

      // 把本次易变上下文追加到最新一条用户消息末尾（不进 system，保证 system+历史前缀稳定可缓存）
      if (volatileCtx.length > 0) {
        const lastUser = [...rustMsgs].reverse().find(m => m.role === "user");
        if (lastUser && typeof lastUser.content === "string") {
          lastUser.content = `${lastUser.content}\n\n[本次补充上下文]\n${volatileCtx.join("\n\n")}`;
        } else {
          rustMsgs.push({ role: "user", content: `[本次补充上下文]\n${volatileCtx.join("\n\n")}` });
        }
      }

      // 估算输入 token（用于费用计算）
      inputTokens = rustMsgs.reduce((sum, m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return sum + estimateMessageTokens(text);
      }, 0);

      const rustCfg = {
        base_url: config.baseUrl, api_key: config.apiKey, model: config.model || "deepseek-v4-flash",
        max_tokens: config.maxTokens, temperature: config.temperature,
        thinking_enabled: config.thinkingEnabled, reasoning_effort: config.reasoningEffort,
        system_prompt: sp, enable_web_search: config.enableWebSearch,
      };

      // ---- 方案 B：流式优先 + <tool_call> 流式检测工具循环 ----
      // 全程走 send_message 流式（思考过程与内容都逐字输出）；
      // 流式中一旦出现完整 <tool_call>...</tool_call> 标记，则停止本轮流式、
      // 执行工具、把结果塞回上下文、再发起新一轮流式，直到模型给出最终答案。
      // 不再使用 ReAct 非流式循环（chat_once），彻底恢复"逐字输出"体验。
      const MAX_TOOL_ROUNDS = 8;

      // 一轮流式：实时逐字输出思考/内容；检测到完整工具调用标记则立即结束本轮并返回工具调用。
      // 返回 toolCall 非空 → 本轮流式输出的是一段工具调用（需执行后继续）；为 null → 最终答案。
      async function streamRound(msgs: { role: string; content: unknown }[]): Promise<{ toolCall: ToolCall | null; content: string }> {
        streamingContent.value = ""; // 只清正文；思考过程跨轮累积（多轮思考链完整展示）
        let resolveDone!: () => void;
        let rejectDone!: (e: Error) => void;
        const doneP = new Promise<void>((resolve, reject) => {
          resolveDone = resolve;
          rejectDone = reject;
        });
        const roundUnlisten: UnlistenFn[] = [];
        let toolCall: ToolCall | null = null;
        let toolBuffer = ""; // 累积本轮 content（含 tool_call 原始标记），供解析与回填

        roundUnlisten.push(
          await listen<{ reasoning_content?: string; content?: string; tokens?: number; cache_hit?: number; cache_miss?: number }>("sse-delta", e => {
            const d = e.payload;
            if (d.reasoning_content) streamingReasoning.value += d.reasoning_content;
            if (d.content) {
              streamingContent.value += d.content;
              toolBuffer += d.content;
              // 检测到完整 </tool_call> 才解析（避免把流式中途的半截 JSON 当工具调用）；
              // 解析成功 → 提前结束本轮流式，转去执行工具
              if (!toolCall && toolBuffer.includes("</tool_call>")) {
                const parsed = parseToolCall(toolBuffer);
                if (parsed) { toolCall = parsed; resolveDone(); }
              }
            }
            if (d.tokens) assistantMsg.tokens = d.tokens;
            if (d.cache_hit) cacheHitTotal.value += d.cache_hit;
            if (d.cache_miss) cacheMissTotal.value += d.cache_miss;
          }),
          await listen<string>("sse-error", e => rejectDone(new Error(e.payload))),
          await listen("sse-done", () => resolveDone()),
        );

        // 发起流式（不 await）。注意：stream_chat 失败（网络/Key/模型名错误）时 Rust 直接
        // return Err 而不会 emit sse-error，必须把 invoke 的真实错误也交给 rejectDone，
        // 否则前端只会干等到 120 秒超时；正常路径 invoke resolve、重复 reject 无害。
        invoke("send_message", { config: rustCfg, messages: msgs }).catch((e) => {
          rejectDone(e instanceof Error ? e : new Error(String(e)));
        });

        // doneP 加超时兜底：若 Rust 流式一直不返回（网络卡死），超时抛错进入外层 catch，
        // 确保 finally 一定执行、气泡不会卡死成空泡泡；
        // 无论正常结束还是抛错，都要移除本轮监听，避免事件监听泄漏
        try {
          await Promise.race([
            doneP,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("模型回复超时（120 秒）")), 120000)
            ),
          ]);
        } finally {
          roundUnlisten.forEach(f => f());
        }
        return { toolCall, content: toolBuffer };
      }

      // 主循环：发起流式；若返回工具调用则执行并把结果回填上下文后继续
      let round = 0;
      let roundResult: { toolCall: ToolCall | null; content: string } | null = null;
      do {
        roundResult = await streamRound(rustMsgs);
        const tc = roundResult.toolCall;
        if (!tc) break; // 无工具调用 → 最终答案，退出循环

        round++;
        if (round >= MAX_TOOL_ROUNDS) {
          // 达到上限：直接停止工具循环（避免模型反复调工具造成死循环），
          // 以已执行的工具卡片收尾；streamingContent 若有残留工具 JSON 由 finally 剥离
          break;
        }

        // 实时显示"正在调用工具"
        const serverName = tc.server && tc.server !== "default" ? `（${tc.server}）` : "";
        streamingContent.value = `🔧 正在调用工具：${tc.tool}${serverName}...`;
        const argsStr = JSON.stringify(tc.arguments, null, 2);
        const startTool = Date.now();
        try {
          const result = await callMcpTool(tc.server, tc.tool, tc.arguments);
          const clipped = result.length > 800 ? result.slice(0, 800) + "\n...(结果已截断)" : result;
          const card =
            `### 🔧 调用工具：\`${tc.tool}\`\n\n` +
            `<details><summary>参数</summary>\n\n\`\`\`json\n${argsStr.slice(0, 400)}\n\`\`\`\n\n</details>` +
            `\n<details><summary>✅ 工具结果</summary>\n\n\`\`\`\n${clipped}\n\`\`\`\n\n</details>`;
          toolChain.push(card);
          toolCards.push({
            name: tc.tool, server: tc.server || "app", status: "done",
            durationMs: Date.now() - startTool,
            argsPreview: argsStr.slice(0, 300),
            resultPreview: clipped.slice(0, 300),
          });
          streamingContent.value = card; // 展示卡片（下一轮流式在其后追加最终答案）
          rustMsgs.push({ role: "assistant", content: roundResult.content });
          rustMsgs.push({
            role: "user",
            content: `<tool_result>\n${result}\n</tool_result>\n\n请基于工具结果继续回答用户的问题。`,
          });
        } catch (e: unknown) {
          const err = e instanceof Error ? e.message : String(e);
          const card = `> ❌ 工具调用失败: \`${err}\``;
          toolChain.push(card);
          toolCards.push({
            name: tc.tool, server: tc.server || "app", status: "error",
            durationMs: Date.now() - startTool,
            argsPreview: argsStr.slice(0, 300),
            error: err.slice(0, 300),
          });
          streamingContent.value = card;
          rustMsgs.push({ role: "assistant", content: roundResult.content });
          rustMsgs.push({
            role: "user",
            content: `<tool_result>\n错误: ${err}\n</tool_result>\n\n工具调用失败，请直接回答或调整参数重试。`,
          });
        }
      } while (true);
      // 任务结束：断开浏览器服务器，形成使用闭环
      await closeBrowserIfOpen();

    } catch (err: unknown) {
      if (err instanceof Error) {
        let msg = err.message;
        // 图片发送失败时给出明确引导（多为模型不支持图片输入）
        if (images && images.length > 0 && /400|unsupported|not.?support|image|content_type/i.test(msg)) {
          msg += "\n\n💡 当前模型可能不支持图片输入。请在「设置 → API 配置」中添加支持视觉能力的模型（如 OpenAI、Gemini、Qwen-VL 等），或切换到支持图片的模型。";
        }
        streamingContent.value = streamingContent.value || `[错误] ${msg}`;
      }
    } finally {
      unlistenFns.forEach(f => f());
      // 流式兜底：剥离模型口头输出的工具调用 JSON；工具卡片（toolChain）逐段拼在最前
      const finalText = stripToolJson(streamingContent.value);
      assistantMsg.content = toolChain.length > 0
        ? (finalText ? toolChain.join("\n\n") + "\n\n" + finalText : toolChain.join("\n\n"))
        : finalText;
      if (toolCards.length > 0) assistantMsg.tools = toolCards;
      assistantMsg.reasoning_content = streamingReasoning.value || undefined;
      assistantMsg.duration = Number(((Date.now() - startTime) / 1000).toFixed(1));
      // Token 计数：优先使用 Rust 端返回的 usage，否则本地估算
      if (!assistantMsg.tokens) {
        assistantMsg.tokens = estimateMessageTokens(streamingContent.value, streamingReasoning.value);
      }
      // 费用估算
      try {
        assistantMsg.cost = estimateCost(currentConfig.value.model, inputTokens, assistantMsg.tokens || 0);
      } catch { /* 费用计算失败不影响主流程 */ }
      assistantMsg.streaming = false;
      // 空回复诊断：内容为空时必现可操作提示，避免静默空泡泡。
      // 只有思考过程而无内容（如模型把工具调用 JSON 当唯一输出被剥离）也算空回复。
      if (!assistantMsg.content) {
        assistantMsg.content = assistantMsg.reasoning_content
          ? "⚠️ 模型仅返回了思考过程，未生成回复内容。可点击「🔄 重试」或换个说法再问。"
          : "⚠️ 未收到模型回复。可能原因：\n- 当前模型/API 不支持该请求（模型名无效、图片输入等）\n- API 地址或 Key 配置有误\n- 网络或服务端异常\n\n请检查「设置 → API 配置」或重试。";
      }
      streamingContent.value = "";
      streamingReasoning.value = "";
      isStreaming.value = false;
      conv.updatedAt = Date.now();
      scheduleSave();

      // 对话结束：用完断开 MCP 服务器，释放资源（浏览器等子进程随之关闭）
      useMcpStore().disconnectAll().catch(() => {});

      // 后台提取关键事实
      if (currentConfig.value.apiKey) {
        memory.extractFacts(convId, conv.messages, currentConfig.value).catch(() => {});
      }
    }
  }

  function stopStreaming() {
    // Rust 后端会自然结束，前端标记超时即可
    isStreaming.value = false;
  }

  function clearCurrentConversation() {
    const conv = activeConversation.value;
    if (conv) {
      conv.messages = [];
      conv.updatedAt = Date.now();
    }
  }

  // 重试：移除最后一条 AI 回复，重新发送上一条用户消息
  function retryLast() {
    const conv = activeConversation.value;
    if (!conv || isStreaming.value) return;
    const msgs = conv.messages;
    // 找到最后一个 user 消息和它之后的 assistant 消息
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const lastUser = msgs[lastUserIdx];
    // 删除 user 消息之后的所有 assistant 消息
    conv.messages = msgs.slice(0, lastUserIdx + 1);
    // 重发
    sendMessage(lastUser.content, lastUser.images);
  }

  // 复制消息到剪贴板
  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    }
  }

  // --- 对话搜索 (Rust SQLite) ---
  async function searchConversations(query: string) {
    if (!query.trim()) return [];
    try {
      return await invoke<{conversation_id:string;conversation_title:string;message_id:string;role:string;snippet:string;timestamp:number}[]>(
        "search_conversations_cmd", { query }
      );
    } catch { return []; }
  }

  // --- 对话导出 (Rust) ---
  async function downloadExport(id: string, format: "md" | "json") {
    const conv = conversations.value.find(c => c.id === id);
    const filename = `${conv?.title || "对话"}.${format}`;
    try {
      const content = await invoke<string>("export_conversation_cmd", { id, format });
      // Tauri 桌面环境：WKWebView 不支持 <a download>，改用原生保存对话框 + Rust 写文件
      if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          defaultPath: filename,
          filters: [{ name: format === "md" ? "Markdown" : "JSON", extensions: [format] }],
        });
        if (!path) return; // 用户取消
        await invoke("write_text_file", { path, content });
        return;
      }
      // 浏览器预览：回退 <a download>
      const blob = new Blob([content], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { console.warn("[道生一] 导出失败:", e); }
  }

  return {
    conversations,
    activeConversationId,
    activeConversation,
    sortedConversations,
    visibleConversations,
    archivedConversations,
    conversationStats,
    cacheHitRate,
    cacheHitTotal,
    cacheMissTotal,
    profiles,
    activeProfileId,
    activeProfile,
    currentConfig,
    profileSwitching,
    isStreaming,
    streamingContent,
    streamingReasoning,
    switchProfile,
    updateProfile,
    addProfile,
    deleteProfile,
    reloadProfilesFromRust,
    createConversation,
    deleteConversation,
    selectConversation,
    archiveConversation,
    unarchiveConversation,
    deleteArchived,
    sendMessage,
    stopStreaming,
    getAuxConfig,
    activePersonaId,
    setPersona,
    subagents,
    spawnSubagent,
    completeSubagent,
    failSubagent,
    clearFinishedSubagents,
    clearCurrentConversation,
    retryLast,
    copyToClipboard,
    downloadExport,
    searchConversations,
  };
});
