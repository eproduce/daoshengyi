import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "./uuid";
import { initSettings, getSettings, updateSettings, type McpServerPersist } from "@/api/appSettings";
import { pickBrowserPath } from "@/utils/browser-select";

interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  /** 透传给 MCP server 进程的环境变量（如 PUPPETEER_EXECUTABLE_PATH 指定浏览器） */
  env: Record<string, string>;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
}

const STORAGE_KEY = "daoshengyi_mcp_servers";

// ── 已知错误配置自动修正（迁移修复）────────────────────────────────────────
// npm 上的 `mcp-server-fetch`（v0.0.2）是安全研究者抢注的 canary 占位包：
// `npx -y mcp-server-fetch` 会拉取一个遥测脚本而非真正的 MCP server（启动报
// `/Applications: is a directory` / `syntax error`）。官方 Fetch server 只有
// Python 实现（PyPI mcp-server-fetch，需 uvx / Python 3.10+），而我们的应用
// 已内置 fetch_page 工具（Rust fetch_page 命令，抓网页转纯文本）与 web_search，
// 无需外部 MCP。因此把这类配置自动禁用，避免启动报错，也不引入 Python 依赖。
function migrateConfig<T extends { command: string; args: string; enabled: boolean }>(c: T): T {
  const cmd = (c.command ?? "").toLowerCase();
  const args = c.args ?? "";
  const isBrokenFetch =
    /\bmcp-server-fetch\b/.test(args) &&
    (cmd.includes("npx") || cmd.includes("uvx") || cmd.includes("pip") || cmd === "");
  if (isBrokenFetch) {
    console.warn(
      "[道生一] 已自动禁用外部 fetch MCP「" + (c as { name?: string }).name + "」：npm 上该包名被安全研究占位无法使用，" +
      "且应用已内置 fetch_page 工具（抓网页转文本），无需外部 MCP。"
    );
    return { ...c, enabled: false };
  }
  return c;
}

// ── Puppeteer 浏览器自动化：按已安装浏览器 + 系统默认浏览器选择内核 ─────────
// server-puppeteer 需要 Chromium 系浏览器。puppeteer 缓存的旧版 Chrome for Testing
// 在较新 macOS（如 26）上会被系统 SIGKILL（spawn error -88），因此改用本机已安装的
// Chromium 系浏览器（Chrome / Edge / Chromium / Brave），通过 PUPPETEER_EXECUTABLE_PATH
// 指定。选择优先级（resolveBrowserPath）：
//   1. 服务器 env 里用户手动指定的 PUPPETEER_EXECUTABLE_PATH
//   2. 设置 browserEngine（用户显式选择的浏览器）
//   3. 系统默认浏览器（若是 Chromium 系）
//   4. 推荐序：chrome > edge > chromium > brave
//   5. 兜底：维持旧 Edge 路径（跨机器都有 Edge 概率高）
export interface BrowserInfo {
  id: string;
  name: string;
  path: string;
  is_default: boolean;
}

export const PUPPETEER_EDGE_PATH = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

// server-puppeteer 默认视口 800x600 偏小，窗口放大后页面只占窗口一部分。
// 通过 PUPPETEER_LAUNCH_OPTIONS（JSON，传给 puppeteer.launch()）把页面视口与
// 窗口大小设成一致（1440x900），让页面占满窗口。用户手动配置优先。
export const PUPPETEER_DEFAULT_LAUNCH_OPTIONS =
  '{"defaultViewport":{"width":1440,"height":900},"args":["--window-size=1440,900"]}';

let browsersCache: BrowserInfo[] | null = null;
let browsersLoading: Promise<BrowserInfo[]> | null = null;

/** 探测本机已安装浏览器（带缓存，多次调用只 invoke 一次；force=true 时强制重新探测）。
 *  Tauri 环境调用 Rust 命令；非 Tauri（浏览器调试）返回空数组。 */
export function detectBrowsers(force = false): Promise<BrowserInfo[]> {
  if (!force && browsersCache) return Promise.resolve(browsersCache);
  if (!force && browsersLoading) return browsersLoading;
  const isTauri = !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (!isTauri) {
    browsersCache = [];
    return Promise.resolve(browsersCache);
  }
  browsersLoading = invoke<BrowserInfo[]>("detect_browsers")
    .then((list) => { browsersCache = list || []; return browsersCache; })
    .catch(() => { browsersCache = []; return browsersCache; })
    .finally(() => { browsersLoading = null; });
  return browsersLoading;
}

/** 根据设置 browserEngine + 系统默认浏览器 + 推荐序，选出应使用的浏览器可执行路径。
 *  返回 null 表示无可用浏览器（前端兜底用 Edge 路径）。选择逻辑见 utils/browser-select.ts。 */
export async function resolveBrowserPath(engine: string): Promise<string | null> {
  const list = await detectBrowsers();
  return pickBrowserPath(list, engine);
}

/** 应用浏览器内核到 puppeteer 服务器 env。
 *  puppeteer 服务器的 PUPPETEER_EXECUTABLE_PATH **始终**由多内核选择逻辑决定
 *  （探测已装浏览器 + 设置 browserEngine + 系统默认 + 推荐序）——即使 catalog 里
 *  硬编码了 Edge 路径（旧配置），只要本机探测到 Chrome/默认浏览器就会用探测结果，
 *  避免「本机有 Chrome 却硬用不存在的 Edge 导致启动失败」。仅当探测失败才回退。
 *  用户手动在 env 里配置的路径若真实存在，则优先尊重。 */
async function applyPuppeteerEnv<T extends { command: string; args: string; env?: Record<string, string> }>(c: T): Promise<T> {
  const cmd = (c.command ?? "").toLowerCase();
  const args = c.args ?? "";
  const isPuppeteer = cmd.includes("npx") && /\bserver-puppeteer\b/.test(args);
  if (!isPuppeteer) return { ...c, env: c.env ?? {} };
  const env = { ...(c.env ?? {}) };
  // 若用户手动配置的路径真实存在 → 尊重；否则按多内核选择覆盖（含 catalog 硬编码的 Edge 路径）
  const manualPath = env.PUPPETEER_EXECUTABLE_PATH;
  const manualPathValid = manualPath ? await isFile(manualPath) : false;
  if (!manualPathValid) {
    try {
      const engine = getSettings().browserEngine ?? "auto";
      const path = await resolveBrowserPath(engine);
      env.PUPPETEER_EXECUTABLE_PATH = path || PUPPETEER_EDGE_PATH;
    } catch {
      env.PUPPETEER_EXECUTABLE_PATH = PUPPETEER_EDGE_PATH;
    }
  }
  // 用户已显式配置启动参数则尊重；否则补默认视口=窗口大小，让页面占满窗口
  if (!env.PUPPETEER_LAUNCH_OPTIONS) env.PUPPETEER_LAUNCH_OPTIONS = PUPPETEER_DEFAULT_LAUNCH_OPTIONS;
  return { ...c, env };
}

/** 检查路径是否真实存在（判断 env 里的浏览器路径是否有效）。 */
function isFile(p: string): Promise<boolean> {
  return invoke<boolean>("file_exists", { path: p }).catch(() => false);
}

// 同步兜底：先读 localStorage 旧数据（作为迁移源）
// 注意：浏览器内核 env 由 initFromRust 异步应用（能拿到最新探测结果与设置），此处仅做格式迁移
function loadLegacy(): McpServerConfig[] {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? (JSON.parse(s) as McpServerConfig[]).map((c) => migrateConfig(c)) : [];
  } catch { return []; }
}

// 持久化形态 → 运行时形态（补运行时状态）
function toConfig(p: McpServerPersist): McpServerConfig {
  return { ...p, env: p.env ?? {}, connected: false, toolCount: 0 };
}

/// 判断是否为"重"服务器（浏览器自动化）：连接即启动真实浏览器窗口。
/// 这类服务器只在模型明确需要时按需连接，避免日常对话也弹出浏览器。
export function isBrowserServer(name: string, command: string): boolean {
  return /puppeteer|playwright|browser|chrome|浏览器/.test(`${name} ${command}`.toLowerCase());
}

export const useMcpStore = defineStore("mcp", () => {
  const servers = ref<McpServerConfig[]>(loadLegacy());

  function save() {
    updateSettings({
      mcpServers: servers.value.map((s) => ({
        id: s.id, name: s.name, command: s.command, args: s.args, enabled: s.enabled, env: s.env,
      })),
    });
  }
  watch(servers, save, { deep: true });

  // 异步从 Rust 加载；无 Rust 数据但有 localStorage 旧数据时执行迁移
  async function initFromRust() {
    // 等待 Tauri 就绪：webview 初始化时 __TAURI_INTERNALS__ 可能尚未注入，
    // 直接 return 会导致 MCP 服务器永不自动连接（对齐 chat store 的 initFromDb 重试模式）
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      setTimeout(initFromRust, 200);
      return;
    }
    try {
      const legacy = localStorage.getItem(STORAGE_KEY);
      const settings = await initSettings();
      if (settings.mcpServers.length > 0) {
        // 浏览器内核 env 异步应用（探测已装浏览器 + 按设置/默认选择）
        const applied = await Promise.all(settings.mcpServers.map((p) => applyPuppeteerEnv(migrateConfig(p))));
        servers.value = applied.map(toConfig);
        if (legacy) localStorage.removeItem(STORAGE_KEY);
      } else if (legacy) {
        save();
        localStorage.removeItem(STORAGE_KEY);
      }
      // 注意：不再启动时自动连接全部服务器（省资源）。
      // 改为对话过程中按需连接（chat store 发送前调用 connectEnabled），任务完成后断开。
    } catch (e) {
      console.warn("[道生一] 从 Rust 加载 MCP 配置失败，回退 localStorage:", e);
    }
  }
  initFromRust();

  /** 按需连接所有已启用的 MCP 服务器（并发 + 每台限时，避免某台启动慢阻塞对话发送）
   *  注意：跳过浏览器类服务器（连接即弹窗），它们由模型主动请求（__connect__）时才连接。 */
  async function autoConnectEnabled() {
    const pending = servers.value.filter((s) => s.enabled && !s.connected && !isBrowserServer(s.name, s.command));
    // 并发连接所有启用的服务器；每台限时 10 秒，失败/超时跳过不阻塞，用已连上的工具兜底
    await Promise.all(pending.map((s) =>
      Promise.race([
        connect(s.id),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时（10 秒）`)), 10000)
        ),
      ]).catch((e) => {
        console.warn(`[道生一] MCP「${s.name}」连接失败:`, e);
      })
    ));
    // 刷新 chat store 的工具缓存，使工具提示可注入
    try { await syncToChat(); } catch { /* ignore */ }
  }

  function add(config: Omit<McpServerConfig, "id" | "connected" | "toolCount">) {
    servers.value.push({ ...config, id: uuidv4(), connected: false, toolCount: 0 });
  }

  function update(id: string, patch: Partial<McpServerConfig>) {
    const s = servers.value.find(x => x.id === id);
    if (s) Object.assign(s, patch);
  }

  async function remove(id: string) {
    const s = servers.value.find(x => x.id === id);
    // 删除已连接服务器时先断开（终止进程），避免进程残留
    if (s && s.connected) {
      try { await invoke("mcp_disconnect", { name: s.name }); } catch { /* ignore */ }
    }
    servers.value = servers.value.filter(x => x.id !== id);
  }

  async function connect(id: string) {
    const s = servers.value.find(x => x.id === id);
    if (!s) return;
    // MCP 依赖 Rust 后端，仅在 Tauri 桌面环境可用
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      throw new Error("MCP 服务器需要在桌面应用中连接（当前为浏览器预览，Tauri API 不可用）");
    }
    try {
      // 浏览器自动化服务器：连接前按最新设置重新应用浏览器内核 env（用户可能改过 browserEngine）
      if (isBrowserServer(s.name, s.command) && !s.env?.PUPPETEER_EXECUTABLE_PATH) {
        const applied = await applyPuppeteerEnv(s);
        Object.assign(s, applied);
      }
      const args = s.args.split(/\s+/).filter(a => a.length > 0);
      const tools = await invoke<{ name: string; description: string }[]>("mcp_connect", {
        name: s.name, command: s.command, args, env: s.env || {},
      });
      s.connected = true;
      s.toolCount = tools.length;
    } catch (e: unknown) {
      s.connected = false;
      s.toolCount = 0;
      throw e;
    }
  }

  /// 按服务器名连接（供 chat store 按需激活未连接的服务器，如浏览器自动化）
  async function connectByName(name: string): Promise<string[]> {
    const s = servers.value.find(x => x.name === name);
    if (!s) throw new Error(`未找到 MCP 服务器「${name}」`);
    const args = s.args.split(/\s+/).filter(a => a.length > 0);
    const tools = await invoke<{ name: string; description: string }[]>("mcp_connect", {
      name: s.name, command: s.command, args, env: s.env || {},
    });
    s.connected = true;
    s.toolCount = tools.length;
    return tools.map(t => t.name);
  }

  const connectedCount = () => servers.value.filter(s => s.connected).length;
  const totalTools = () => servers.value.reduce((sum, s) => sum + s.toolCount, 0);

  // 同步到 chat store 的 MCP 缓存
  async function syncToChat() {
    try {
      const { refreshMcpTools } = await import("./chat");
      await refreshMcpTools();
    } catch { /* ignore */ }
  }

  /// 断开指定服务器（kill 进程，浏览器类服务器随之关闭浏览器，形成使用闭环）
  async function disconnect(id: string) {
    const s = servers.value.find(x => x.id === id);
    if (!s || !s.connected) return;
    try {
      await invoke("mcp_disconnect", { name: s.name });
    } finally {
      s.connected = false;
      s.toolCount = 0;
    }
  }

  /// 断开所有已连接服务器（对话完成后释放资源）
  async function disconnectAll() {
    const ids = servers.value.filter((s) => s.connected).map((s) => s.id);
    for (const id of ids) {
      try { await disconnect(id); } catch { /* ignore */ }
    }
  }

  /// 按服务器名标记为未连接（供 chat store 在任务完成后调用）
  function markDisconnected(serverNames: string[]) {
    for (const s of servers.value) {
      if (serverNames.includes(s.name)) {
        s.connected = false;
        s.toolCount = 0;
      }
    }
  }

  return {
    servers, add, update, remove, connect, connectByName,
    connectEnabled: autoConnectEnabled, disconnect, disconnectAll, markDisconnected,
    connectedCount, totalTools, syncToChat,
  };
});
