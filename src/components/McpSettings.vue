<script setup lang="ts">
import { ref, computed } from "vue";
import { useMcpStore } from "@/stores/mcp";
import { MCP_CATALOG, MCP_CATEGORIES, type McpCatalogItem } from "@/data/mcp-catalog";

const store = useMcpStore();
const activeTab = ref<"servers" | "market">("servers");
const editing = ref<string | null>(null);
const form = ref({ name: "", command: "", args: "", envText: "", enabled: true });
const error = ref("");
// 连接由 agent 自动控制（应用启动自动连接 + 发消息自动重连），
// 此处不再提供手动连接/重新连接，仅展示状态。

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
  store.add({ name: item.name, command: item.command, args: item.args, env: item.env ?? {}, enabled: true });
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
      <h3>🧩 插件</h3>
      <span class="mcp-summary" v-if="store.servers.length">
        {{ store.connectedCount() }}/{{ store.servers.length }} 已连接 · {{ store.totalTools() }} 工具
      </span>
    </div>

    <!-- Tabs -->
    <div class="mcp-tabs">
      <button :class="['mcp-tab', { active: activeTab === 'servers' }]" @click="activeTab = 'servers'">
        已安装 ({{ store.servers.length }})
      </button>
      <button :class="['mcp-tab', { active: activeTab === 'market' }]" @click="activeTab = 'market'">
        🌐 插件市场
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
          <button class="mcp-btn-mini" @click="store.remove(s.id)">🗑</button>
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

      <div v-for="item in filteredCatalog" :key="item.id" class="mcp-card">
        <div class="mcp-card-icon">{{ item.icon }}</div>
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
.mcp-summary { font-size: 11px; color: #888; }
.mcp-error { padding: 8px 12px; background: #3a0d0d; border-radius: 6px; color: #f87171; font-size: 12px; margin-bottom: 10px; }
.mcp-form { margin-bottom: 12px; }
.mcp-input { width: 100%; padding: 8px 10px; margin-bottom: 6px; border: 1px solid #333; border-radius: 6px; background: #0d0d1a; color: #ddd; font-size: 12px; box-sizing: border-box; font-family: inherit; }
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
