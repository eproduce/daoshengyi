<script setup lang="ts">
import { ref, computed, onMounted, type Component } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useMcpStore, detectBrowsers, type BrowserInfo } from "@/stores/mcp";
import { initSettings, getSettings, updateSettings } from "@/api/appSettings";
import { MCP_CATALOG, MCP_CATEGORIES, type McpCatalogItem } from "@/data/mcp-catalog";
import { Puzzle, Globe, Trash2, RefreshCw, Folder, GitBranch, Github, Database, Server, CircleDot, Brain, Clock, FlaskConical, Circle, MonitorCog } from "lucide-vue-next";

// mcp-catalog 的 icon 字段存 lucide 图标名，这里映射为组件动态渲染
const mcpIcons: Record<string, Component> = { Folder, Globe, GitBranch, Github, Database, Server, CircleDot, Brain, Clock, FlaskConical };

const store = useMcpStore();
const activeTab = ref<"servers" | "market">("servers");
const editing = ref<string | null>(null);
const form = ref({ name: "", command: "", args: "", envText: "", enabled: true });
const error = ref("");
// 连接由 agent 自动控制（应用启动自动连接 + 发消息自动重连），
// 此处不再提供手动连接/重新连接，仅展示状态。

// --- 浏览器内核（Puppeteer 多内核适配） ---
const browserEngine = ref("auto");
const browsers = ref<BrowserInfo[]>([]);
const browserLoaded = ref(false);

const BROWSER_OPTIONS: { id: string; label: string }[] = [
  { id: "auto", label: "自动（系统默认浏览器优先）" },
  { id: "chrome", label: "Google Chrome" },
  { id: "edge", label: "Microsoft Edge" },
  { id: "chromium", label: "Chromium" },
  { id: "brave", label: "Brave Browser" },
];

// 当前生效的浏览器路径描述（供展示）
const activeBrowserDesc = computed(() => {
  if (!browserLoaded.value) return "检测中…";
  const byId = (id: string) => browsers.value.find((b) => b.id === id);
  const eng = browserEngine.value;
  let b = eng !== "auto" ? byId(eng) : undefined;
  if (!b) b = browsers.value.find((x) => x.is_default);
  if (!b && eng === "auto") b = byId("chrome") || byId("edge") || byId("chromium") || byId("brave");
  if (!b) return "未检测到浏览器（将回退 Microsoft Edge）";
  return `${b.name}${b.is_default ? "（默认）" : ""}`;
});

async function loadBrowsers() {
  browsers.value = await detectBrowsers();
  browserLoaded.value = true;
}

async function changeBrowser(e: Event) {
  browserEngine.value = (e.target as HTMLSelectElement).value;
  // 立即保存设置，后续连接浏览器服务器时按新选择应用
  await updateSettings({ browserEngine: browserEngine.value });
}

onMounted(async () => {
  try {
    await initSettings();
    browserEngine.value = getSettings().browserEngine ?? "auto";
  } catch { /* 保持默认 */ }
  await loadBrowsers();
});

/// 解析环境变量文本（每行 KEY=VALUE，# 开头为注释）
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx <= 0) continue;
    out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}

// --- 插件市场 ---
const searchKw = ref("");
const category = ref("全部");

const filteredCatalog = computed(() =>
  MCP_CATALOG.filter((item) => {
    if (category.value !== "全部" && item.category !== category.value) return false;
    if (searchKw.value.trim()) {
      const kw = searchKw.value.trim().toLowerCase();
      const text = `${item.name} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
      if (!text.includes(kw)) return false;
    }
    return true;
  })
);

function isInstalled(item: { name: string }) {
  return store.servers.some((s) => s.name === item.name);
}

function installPlugin(item: McpCatalogItem) {
  if (isInstalled(item)) return;
  const env = { ...(item.env ?? {}) };
  store.add({ name: item.name, command: item.command, args: item.args, env, enabled: true });
  activeTab.value = "servers";
  // agent 自动控制：添加后自动连接该服务器
  store.connectEnabled();
  error.value = `✅ 已添加「${item.name}」，自动连接中…`;
}

function openAdd() {
  editing.value = "";
  form.value = { name: "", command: "", args: "", envText: "", enabled: true };
  error.value = "";
}

// --- 社区插件（Smithery 远程市场，免安装即用） ---
interface CommunityPlugin {
  id: string;
  name: string;
  description: string;
  source: string;
  verified: boolean;
  use_count: number;
}
const communityPlugins = ref<CommunityPlugin[]>([]);
const communitySearch = ref("");
const communityLoading = ref(false);
const communityInstalling = ref<string | null>(null);

async function loadCommunityPlugins() {
  communityLoading.value = true;
  error.value = "";
  try {
    const q = communitySearch.value.trim();
    const list = await invoke<CommunityPlugin[]>("fetch_community_plugins", { query: q || null });
    communityPlugins.value = list;
    if (list.length === 0) error.value = "没有找到匹配的社区插件";
  } catch (e: unknown) {
    error.value = `加载社区插件失败: ${e}`;
  } finally {
    communityLoading.value = false;
  }
}

function communityInstalled(id: string) {
  // 远程插件 command 是 deploymentUrl（如 https://gmail.run.tools），按 URL 是否含插件 id 判断
  return store.servers.some((s) => s.command.startsWith("http") && s.command.toLowerCase().includes(id.toLowerCase()));
}

/// 安装社区插件：查询其远程 HTTP 端点（deploymentUrl），作为 command=URL 的远程插件添加
async function installCommunity(p: CommunityPlugin) {
  if (communityInstalled(p.id) || communityInstalling.value) return;
  communityInstalling.value = p.id;
  error.value = "";
  try {
    const url = await invoke<string>("fetch_remote_plugin_endpoint", { id: p.id });
    const existing = store.servers.find((s) => s.command === url);
    if (existing) {
      error.value = `「${p.name}」已在安装列表中`;
      communityInstalling.value = null;
      return;
    }
    store.add({ name: p.name, command: url, args: "", env: {}, enabled: true });
    activeTab.value = "servers";
    // agent 自动控制：添加后自动连接（远程插件无进程，连接即建立会话）
    store.connectEnabled();
    error.value = `✅ 已添加「${p.name}」（远程），自动连接中…`;
  } catch (e: unknown) {
    error.value = `安装「${p.name}」失败: ${e}`;
  } finally {
    communityInstalling.value = null;
  }
}

function openEdit(id: string) {
  const s = store.servers.find(x => x.id === id);
  if (s) {
    editing.value = id;
    form.value = {
      name: s.name, command: s.command, args: s.args, enabled: s.enabled,
      envText: s.env ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join("\n") : "",
    };
    error.value = "";
  }
}

function save() {
  if (!form.value.name || !form.value.command) return;
  const env = parseEnv(form.value.envText);
  const payload = { name: form.value.name, command: form.value.command, args: form.value.args, env, enabled: form.value.enabled };
  if (editing.value) {
    store.update(editing.value, payload);
  } else {
    store.add(payload);
    // agent 自动控制：新增服务器后自动连接
    store.connectEnabled();
  }
  editing.value = null;
}

function cancel() {
  editing.value = null;
  error.value = "";
}
</script>

<template>
  <div class="mcp-panel">
    <div class="mcp-header">
      <h3><Puzzle :size="17" /> 插件</h3>
      <span class="mcp-summary" v-if="store.servers.length">
        {{ store.connectedCount() }}/{{ store.servers.length }} 已连接 · {{ store.totalTools() }} 工具
      </span>
    </div>

    <!-- 浏览器内核（Puppeteer 多内核适配）：按已安装浏览器 + 系统默认选择 -->
    <div class="mcp-browser">
      <div class="mcp-browser__row">
        <span class="mcp-browser__label"><MonitorCog :size="14" /> 浏览器自动化内核</span>
        <select :value="browserEngine" class="mcp-browser__select" @change="changeBrowser">
          <option v-for="o in BROWSER_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>
        <button class="mcp-btn mcp-btn-sec" title="重新检测本机浏览器" @click="loadBrowsers"><RefreshCw :size="13" /> 检测</button>
      </div>
      <div class="mcp-browser__hint">
        <template v-if="browserLoaded">
          已检测到：
          <span v-for="b in browsers" :key="b.id" class="mcp-browser__chip" :class="{ 'mcp-browser__chip--def': b.is_default }">{{ b.name }}{{ b.is_default ? "（默认）" : "" }}</span>
          <span v-if="!browsers.length" class="mcp-browser__none">无（将回退 Microsoft Edge）</span>
          · 当前生效：<b>{{ activeBrowserDesc }}</b>
        </template>
        <template v-else>正在检测本机已安装的浏览器…</template>
        <div class="mcp-browser__note">浏览器自动化（puppeteer）使用上方选定的 Chromium 系内核（Chrome/Edge/Chromium/Brave）；「自动」优先系统默认浏览器。</div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="mcp-tabs">
      <button :class="['mcp-tab', { active: activeTab === 'servers' }]" @click="activeTab = 'servers'">
        已安装 ({{ store.servers.length }})
      </button>
      <button :class="['mcp-tab', { active: activeTab === 'market' }]" @click="activeTab = 'market'">
        <Globe :size="14" /> 插件市场
      </button>
    </div>

    <div v-if="error" class="mcp-error">{{ error }}</div>

    <!-- Tab: 我的服务器 -->
    <div v-show="activeTab === 'servers'">
      <!-- 编辑表单 -->
      <div v-if="editing !== null" class="mcp-form">
        <input v-model="form.name" placeholder="插件名称" class="mcp-input" />
        <input v-model="form.command" placeholder="命令 (如 npx, python, node)" class="mcp-input" />
        <input v-model="form.args" placeholder="参数 (如 -y @modelcontextprotocol/server-filesystem /tmp)" class="mcp-input" />
        <textarea v-model="form.envText" rows="3" class="mcp-input" placeholder="环境变量（每行 KEY=VALUE，可选；如&#10;PUPPETEER_EXECUTABLE_PATH=/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge）"></textarea>
        <div class="mcp-form-acts">
          <button class="mcp-btn mcp-btn-pri" @click="save">保存</button>
          <button class="mcp-btn mcp-btn-sec" @click="cancel">取消</button>
        </div>
      </div>

      <!-- 服务器列表 -->
      <div v-for="s in store.servers" :key="s.id" class="mcp-item" :class="{ connected: s.connected }">
        <div class="mcp-item-info" @click="openEdit(s.id)">
          <div class="mcp-item-name">
            <span class="mcp-dot" :class="{ green: s.connected }"></span>
            {{ s.name }}
          </div>
          <div class="mcp-item-cmd">{{ s.command }} {{ s.args }}</div>
          <div class="mcp-item-tools" v-if="s.connected">{{ s.toolCount }} 个工具可用</div>
        </div>
        <div class="mcp-item-acts">
          <!-- 连接由 agent 自动控制，不再提供手动连接/重新连接 -->
          <button class="mcp-btn-mini" @click="store.remove(s.id)" title="移除插件"><Trash2 :size="14" /></button>
        </div>
      </div>

      <div v-if="store.servers.length === 0 && editing === null" class="mcp-empty">
        尚未安装插件。
        <br>去「插件市场」安装，或手动添加第三方插件（支持任意 MCP 服务器命令）。
      </div>

      <button v-if="editing === null" class="mcp-btn mcp-btn-pri mcp-btn-full" @click="openAdd">
        + 添加插件（第三方）
      </button>
    </div>

    <!-- Tab: 插件市场 -->
    <div v-show="activeTab === 'market'" class="mcp-market">
      <div class="mcp-market-bar">
        <input v-model="searchKw" placeholder="🔍 搜索插件..." class="mcp-input" />
        <div class="mcp-cats">
          <button
            v-for="c in MCP_CATEGORIES"
            :key="c"
            :class="['mcp-cat', { active: category === c }]"
            @click="category = c"
          >{{ c }}</button>
        </div>
      </div>

      <!-- 社区插件（Smithery 远程市场） -->
      <div class="mcp-community">
        <div class="mcp-community-head">
          <span class="mcp-community-title"><Globe :size="14" /> 社区插件 <span class="mcp-community-badge">远程 · 免安装</span></span>
          <div class="mcp-community-acts">
            <input
              v-model="communitySearch"
              placeholder="搜索社区插件..."
              class="mcp-input mcp-community-search"
              @keyup.enter="loadCommunityPlugins"
            />
            <button class="mcp-btn mcp-btn-pri" :disabled="communityLoading" @click="loadCommunityPlugins">
              <RefreshCw v-if="!communityLoading" :size="14" />{{ communityLoading ? '加载中…' : '加载' }}
            </button>
          </div>
        </div>
        <div v-if="communityPlugins.length" class="mcp-community-list">
          <div v-for="p in communityPlugins" :key="p.id" class="mcp-card">
            <div class="mcp-card-info">
              <div class="mcp-card-name">
                {{ p.name }}
                <span v-if="p.verified" class="mcp-mini-tag mcp-verified">✓ 已验证</span>
                <span class="mcp-card-cat">smithery</span>
              </div>
              <div class="mcp-card-desc">{{ p.description }}</div>
              <div class="mcp-card-tags" v-if="p.use_count > 0">
                <span class="mcp-mini-tag">🔥 {{ p.use_count }} 次使用</span>
              </div>
            </div>
            <button
              class="mcp-btn mcp-btn-sm"
              :class="communityInstalled(p.id) ? 'mcp-btn-sec' : 'mcp-btn-pri'"
              :disabled="communityInstalled(p.id) || communityInstalling !== null"
              @click="installCommunity(p)"
            >
              {{ communityInstalled(p.id) ? '已安装' : (communityInstalling === p.id ? '安装中…' : '安装') }}
            </button>
          </div>
        </div>
        <div v-else-if="!communityLoading" class="mcp-community-hint">
          点击「🔍 加载」从 Smithery 社区市场拉取可用插件（如 gmail、github 等），安装即连接远程端点，无需本地进程。
        </div>
      </div>

      <div v-for="item in filteredCatalog" :key="item.id" class="mcp-card">
        <div class="mcp-card-icon"><component :is="mcpIcons[item.icon] || Circle" :size="17" /></div>
        <div class="mcp-card-info">
          <div class="mcp-card-name">
            {{ item.name }}
            <span class="mcp-card-cat">{{ item.category }}</span>
          </div>
          <div class="mcp-card-desc">{{ item.description }}</div>
          <div class="mcp-card-tags">
            <span v-for="t in item.tags" :key="t" class="mcp-mini-tag">{{ t }}</span>
          </div>
        </div>
        <button
          class="mcp-btn mcp-btn-sm"
          :class="isInstalled(item) ? 'mcp-btn-sec' : 'mcp-btn-pri'"
          :disabled="isInstalled(item)"
          @click="installPlugin(item)"
        >
          {{ isInstalled(item) ? '已安装' : '安装' }}
        </button>
      </div>

      <div v-if="filteredCatalog.length === 0" class="mcp-empty">没有匹配的插件</div>
    </div>
  </div>
</template>

<style scoped>
.mcp-panel { padding: 8px 0; }
.mcp-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.mcp-header h3 { margin: 0; font-size: 15px; }
.mcp-summary { font-size: 11px; color: var(--text-muted); }
.mcp-error { padding: 8px 12px; background: var(--danger-bg); border-radius: 6px; color: var(--danger-color); font-size: 12px; margin-bottom: 10px; }
/* 浏览器内核（Puppeteer 多内核适配）——全部用主题变量，适配深浅色 */
.mcp-browser { margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); }
.mcp-browser__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mcp-browser__label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--text-primary); }
/* 浏览器内核下拉：现代化风格（去原生样式 + 自定义箭头 + 主题变量 + hover/focus 动效） */
.mcp-browser__select {
  width: 240px; margin-bottom: 0;
  padding: 8px 32px 8px 12px;
  border: 1.5px solid var(--border-color); border-radius: var(--radius-md, 12px);
  background: var(--bg-secondary) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center;
  color: var(--text-primary); font-size: 13px; font-family: inherit;
  appearance: none; -webkit-appearance: none; -moz-appearance: none;
  outline: none; cursor: pointer; transition: all .2s;
}
.mcp-browser__select:hover { border-color: var(--accent-color); }
.mcp-browser__select:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, .15);
}
.mcp-browser__select option { background: var(--bg-elevated); color: var(--text-primary); }
.mcp-browser__hint { margin-top: 8px; font-size: 11px; color: var(--text-secondary); line-height: 1.6; }
.mcp-browser__chip { display: inline-block; padding: 1px 8px; margin-right: 6px; border-radius: 10px; background: var(--accent-bg); color: var(--accent-color); font-size: 11px; }
.mcp-browser__chip--def { background: rgba(34, 197, 94, 0.15); color: #22c55e; font-weight: 600; }
.mcp-browser__none { color: var(--danger-color); }
.mcp-browser__note { margin-top: 4px; color: var(--text-muted); }
.mcp-form { margin-bottom: 12px; }
.mcp-input { width: 100%; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); color: var(--text-primary); font-size: 12px; box-sizing: border-box; font-family: inherit; }
.mcp-input:focus { outline: none; border-color: var(--accent-color); }
.mcp-form-acts { display: flex; gap: 6px; margin-top: 4px; }
.mcp-btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; }
.mcp-btn-pri { background: var(--accent-color); color: #fff; }
.mcp-btn-pri:hover { background: var(--accent-hover); }
.mcp-btn-sec { background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border-color); }
.mcp-btn-sm { padding: 4px 10px; font-size: 11px; }
.mcp-btn-full { width: 100%; margin-top: 10px; }
.mcp-btn-mini { background: none; border: none; cursor: pointer; font-size: 14px; padding: 2px; opacity: .5; color: var(--text-secondary); }
.mcp-btn-mini:hover { opacity: 1; }
.mcp-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 6px; }
.mcp-item.connected { border-color: #22c55e; }
.mcp-item-info { flex: 1; cursor: pointer; min-width: 0; }
.mcp-item-name { font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.mcp-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
.mcp-dot.green { background: #22c55e; }
.mcp-item-cmd { font-size: 11px; color: var(--text-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-item-tools { font-size: 10px; color: #22c55e; margin-top: 2px; }
.mcp-item-acts { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.mcp-empty { text-align: center; color: var(--text-muted); padding: 20px; font-size: 12px; line-height: 1.7; }

/* Tabs */
.mcp-tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--border-color); }
.mcp-tab {
  padding: 6px 14px; border: none; background: transparent;
  color: var(--text-muted); font-size: 12px; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px; transition: all .15s;
}
.mcp-tab:hover { color: var(--text-primary); }
.mcp-tab.active { color: var(--accent-color); border-bottom-color: var(--accent-color); font-weight: 600; }

/* 插件市场 */
.mcp-market { margin-top: 4px; }
.mcp-market-bar { margin-bottom: 12px; }
.mcp-community { margin-bottom: 18px; padding: 10px 12px; border: 1px dashed var(--border-color); border-radius: 10px; }
.mcp-community-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.mcp-community-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.mcp-community-badge { font-size: 10px; font-weight: 400; color: #4ade80; border: 1px solid #4ade80; border-radius: 10px; padding: 1px 6px; margin-left: 4px; }
.mcp-community-acts { display: flex; gap: 6px; align-items: center; }
.mcp-community-search { width: 180px; margin-bottom: 0; }
.mcp-community-list { display: flex; flex-direction: column; gap: 6px; }
.mcp-community-hint { font-size: 11px; color: var(--text-muted); padding: 6px 0; }
.mcp-verified { color: #4ade80; border-color: #4ade80; }
.mcp-cats { display: flex; flex-wrap: wrap; gap: 6px; }
.mcp-cat {
  padding: 3px 10px; border: 1px solid var(--border-color); border-radius: 12px;
  background: transparent; color: var(--text-secondary); font-size: 11px; cursor: pointer; transition: all .15s;
}
.mcp-cat:hover { border-color: var(--accent-color); color: var(--text-primary); }
.mcp-cat.active { background: var(--accent-color); border-color: var(--accent-color); color: #fff; }
.mcp-card {
  display: flex; align-items: center; gap: 12px;
  padding: 12px; border: 1px solid var(--border-color); border-radius: 10px; margin-bottom: 8px;
  background: var(--bg-elevated);
  transition: border-color .15s;
}
.mcp-card:hover { border-color: var(--accent-color); }
.mcp-card-icon { font-size: 22px; flex-shrink: 0; width: 36px; text-align: center; }
.mcp-card-info { flex: 1; min-width: 0; }
.mcp-card-name { font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.mcp-card-cat {
  font-size: 10px; color: var(--accent-color); padding: 1px 8px;
  border: 1px solid var(--accent-color); border-radius: 10px; opacity: .9;
}
.mcp-card-desc { font-size: 11px; color: var(--text-secondary); margin-top: 3px; }
.mcp-card-tags { display: flex; gap: 4px; margin-top: 6px; }
.mcp-mini-tag {
  font-size: 10px; color: var(--text-secondary); padding: 1px 6px;
  background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px;
}
</style>
