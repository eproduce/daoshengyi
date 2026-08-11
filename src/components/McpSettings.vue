<script setup lang="ts">
import { ref } from "vue";
import { useMcpStore } from "@/stores/mcp";

const store = useMcpStore();
const editing = ref<string | null>(null);
const form = ref({ name: "", command: "", args: "", enabled: true });
const error = ref("");
const connecting = ref<string | null>(null);

function openAdd() {
  editing.value = "";
  form.value = { name: "", command: "", args: "", enabled: true };
  error.value = "";
}

function openEdit(id: string) {
  const s = store.servers.find(x => x.id === id);
  if (s) {
    editing.value = id;
    form.value = { name: s.name, command: s.command, args: s.args, enabled: s.enabled };
    error.value = "";
  }
}

function save() {
  if (!form.value.name || !form.value.command) return;
  if (editing.value) {
    store.update(editing.value, form.value);
  } else {
    store.add(form.value);
  }
  editing.value = null;
}

async function doConnect(id: string) {
  connecting.value = id;
  error.value = "";
  try {
    await store.connect(id);
    await store.syncToChat();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  connecting.value = null;
}

function cancel() {
  editing.value = null;
  error.value = "";
}
</script>

<template>
  <div class="mcp-panel">
    <div class="mcp-header">
      <h3>🔌 MCP 服务器</h3>
      <span class="mcp-summary" v-if="store.servers.length">
        {{ store.connectedCount() }}/{{ store.servers.length }} 已连接 · {{ store.totalTools() }} 工具
      </span>
    </div>

    <div v-if="error" class="mcp-error">{{ error }}</div>

    <!-- 编辑表单 -->
    <div v-if="editing !== null" class="mcp-form">
      <input v-model="form.name" placeholder="服务器名称" class="mcp-input" />
      <input v-model="form.command" placeholder="命令 (如 npx, python, node)" class="mcp-input" />
      <input v-model="form.args" placeholder="参数 (如 -y @modelcontextprotocol/server-filesystem /tmp)" class="mcp-input" />
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
        <button
          class="mcp-btn mcp-btn-sm"
          :class="s.connected ? 'mcp-btn-sec' : 'mcp-btn-pri'"
          :disabled="connecting === s.id"
          @click="doConnect(s.id)"
        >
          {{ connecting === s.id ? "连接中…" : s.connected ? "重新连接" : "连接" }}
        </button>
        <button class="mcp-btn-mini" @click="store.remove(s.id)">🗑</button>
      </div>
    </div>

    <div v-if="store.servers.length === 0 && editing === null" class="mcp-empty">
      尚未配置 MCP 服务器。
      <br>连接 MCP 服务器后，Agent 可以使用文件系统、浏览器、网络等外部工具。
    </div>

    <button v-if="editing === null" class="mcp-btn mcp-btn-pri mcp-btn-full" @click="openAdd">
      + 添加 MCP 服务器
    </button>

    <div class="mcp-presets">
      <div class="mcp-presets-title">推荐配置</div>
      <div class="mcp-preset" @click="form = { name: 'Filesystem', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem /tmp', enabled: true }; editing = ''">
        📁 文件系统 — 读写本地文件
      </div>
      <div class="mcp-preset" @click="form = { name: 'Fetch', command: 'npx', args: '-y @anthropic/fetch-mcp', enabled: true }; editing = ''">
        🌐 网络请求 — HTTP 抓取
      </div>
      <div class="mcp-preset" @click="form = { name: 'Puppeteer', command: 'npx', args: '-y @modelcontextprotocol/server-puppeteer', enabled: true }; editing = ''">
        🌍 浏览器 — 网页自动化
      </div>
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
.mcp-btn-pri { background: #4a9eff; color: #fff; }
.mcp-btn-pri:hover { background: #3a8eef; }
.mcp-btn-sec { background: #333; color: #ccc; }
.mcp-btn-sm { padding: 4px 10px; font-size: 11px; }
.mcp-btn-full { width: 100%; margin-top: 10px; }
.mcp-btn-mini { background: none; border: none; cursor: pointer; font-size: 14px; padding: 2px; opacity: .5; }
.mcp-btn-mini:hover { opacity: 1; }
.mcp-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border: 1px solid #252540; border-radius: 8px; margin-bottom: 6px; }
.mcp-item.connected { border-color: #1a4a2a; }
.mcp-item-info { flex: 1; cursor: pointer; min-width: 0; }
.mcp-item-name { font-size: 13px; font-weight: 600; color: #ddd; display: flex; align-items: center; gap: 6px; }
.mcp-dot { width: 6px; height: 6px; border-radius: 50%; background: #555; flex-shrink: 0; }
.mcp-dot.green { background: #22c55e; }
.mcp-item-cmd { font-size: 11px; color: #666; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-item-tools { font-size: 10px; color: #4ade80; margin-top: 2px; }
.mcp-item-acts { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.mcp-empty { text-align: center; color: #555; padding: 20px; font-size: 12px; line-height: 1.7; }
.mcp-presets { margin-top: 16px; padding-top: 12px; border-top: 1px solid #1a1a2e; }
.mcp-presets-title { font-size: 12px; color: #666; margin-bottom: 8px; }
.mcp-preset { padding: 8px 10px; border-radius: 6px; font-size: 12px; color: #888; cursor: pointer; transition: all .15s; }
.mcp-preset:hover { background: #1a1a2e; color: #bbb; }
</style>
