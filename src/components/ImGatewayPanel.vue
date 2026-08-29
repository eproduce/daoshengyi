<script setup lang="ts">
// 即时聊天（IM 网关）设置面板：钉钉 / 飞书 / 企业微信。
// - 配置：平台选择 + 各平台凭据 + 白名单 + 触发前缀 + 系统提示词（存 settings.imConfig，加密落盘）
// - 控制：启动 / 停止后台网关；状态 / 日志 / 最近消息实时展示
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, updateSettings } from "@/api/appSettings";

interface ImConfigObj {
  platform?: string;
  enabled?: boolean;
  whitelist?: string[];
  trigger?: string;
  system_prompt?: string;
  max_context?: number;
  dingtalk_client_id?: string;
  dingtalk_client_secret?: string;
  dingtalk_robot_code?: string;
  feishu_app_id?: string;
  feishu_app_secret?: string;
  feishu_receive_id_type?: string;
  wecom_corp_id?: string;
  wecom_corp_secret?: string;
  wecom_agent_id?: string;
  wecom_touser?: string;
}
interface ImStatus {
  running: boolean;
  platform: string;
  platform_label: string;
  started_at: number;
  last_error: string;
  handled: number;
  logs: string[];
  messages: { ts: number; chat: string; sender: string; text: string; reply: string }[];
}

const raw = (getSettings().imConfig || {}) as ImConfigObj;
const platform = ref(raw.platform || "");
const enabled = ref(raw.enabled ?? false);
const whitelist = ref((raw.whitelist || []).join("\n"));
const trigger = ref(raw.trigger || "");
const systemPrompt = ref(raw.system_prompt || "");
const maxContext = ref(raw.max_context || 12);
const dClientId = ref(raw.dingtalk_client_id || "");
const dClientSecret = ref(raw.dingtalk_client_secret || "");
const dRobotCode = ref(raw.dingtalk_robot_code || "");
const fAppId = ref(raw.feishu_app_id || "");
const fAppSecret = ref(raw.feishu_app_secret || "");
const fReceiveType = ref(raw.feishu_receive_id_type || "chat_id");
const wCorpId = ref(raw.wecom_corp_id || "");
const wCorpSecret = ref(raw.wecom_corp_secret || "");
const wAgentId = ref(raw.wecom_agent_id || "");
const wTouser = ref(raw.wecom_touser || "");

const status = ref<ImStatus | null>(null);
const busy = ref(false);
const saveMsg = ref("");
let timer: ReturnType<typeof setInterval> | null = null;

function buildConfig(): Record<string, unknown> {
  return {
    platform: platform.value,
    enabled: enabled.value,
    whitelist: whitelist.value.split("\n").map((s) => s.trim()).filter(Boolean),
    trigger: trigger.value,
    system_prompt: systemPrompt.value,
    max_context: maxContext.value,
    dingtalk_client_id: dClientId.value,
    dingtalk_client_secret: dClientSecret.value,
    dingtalk_robot_code: dRobotCode.value,
    feishu_app_id: fAppId.value,
    feishu_app_secret: fAppSecret.value,
    feishu_receive_id_type: fReceiveType.value,
    wecom_corp_id: wCorpId.value,
    wecom_corp_secret: wCorpSecret.value,
    wecom_agent_id: wAgentId.value,
    wecom_touser: wTouser.value,
  };
}

function save() {
  updateSettings({ imConfig: buildConfig() });
  saveMsg.value = "✅ 已保存";
  setTimeout(() => (saveMsg.value = ""), 2000);
}

async function refresh() {
  try {
    status.value = await invoke<ImStatus>("im_status");
  } catch { /* 后端暂不可用 */ }
}

async function start() {
  save();
  busy.value = true;
  try {
    status.value = await invoke<ImStatus>("im_start");
  } catch (e) {
    saveMsg.value = `❌ ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
    refresh();
  }
}
async function stop() {
  busy.value = true;
  try {
    status.value = await invoke<ImStatus>("im_stop");
  } finally {
    busy.value = false;
    refresh();
  }
}
function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
const PLATFORMS = [
  { id: "dingtalk", label: "钉钉（stream 长连接）", desc: "机器人 Client ID/Secret，无需公网" },
  { id: "feishu", label: "飞书（应用长连接）", desc: "自建应用 App ID/Secret，无需公网" },
  { id: "wecom", label: "企业微信（只推不接）", desc: "应用消息主动推送；接收需公网回调，桌面端不适用" },
];

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 3000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="im-panel">
    <h3 class="im-title">💬 即时聊天（IM 网关）</h3>
    <p class="im-desc">在钉钉 / 飞书 / 企业微信里发消息 → Agent 自动思考并回复，实现「远程驱动」。配置并保存后点「启动」，网关后台常驻监听（钉钉/飞书长连接无需公网；企微只推不接）。</p>

    <div class="im-form">
      <label class="im-toggle">
        <input type="checkbox" v-model="enabled" /> 启用 IM 网关
      </label>

      <div class="im-field">
        <span>平台</span>
        <select v-model="platform">
          <option value="">— 选择平台 —</option>
          <option v-for="p in PLATFORMS" :key="p.id" :value="p.id">{{ p.label }}（{{ p.desc }}）</option>
        </select>
      </div>

      <template v-if="platform === 'dingtalk'">
        <div class="im-field"><span>Client ID（AppKey）</span><input v-model="dClientId" type="password" placeholder="钉钉开放平台机器人 Client ID" /></div>
        <div class="im-field"><span>Client Secret（AppSecret）</span><input v-model="dClientSecret" type="password" placeholder="钉钉机器人 Client Secret" /></div>
        <div class="im-field"><span>Robot Code（可选，机器人发送用）</span><input v-model="dRobotCode" placeholder="钉钉机器人的 robotCode" /></div>
      </template>
      <template v-else-if="platform === 'feishu'">
        <div class="im-field"><span>App ID</span><input v-model="fAppId" type="password" placeholder="飞书自建应用 App ID" /></div>
        <div class="im-field"><span>App Secret</span><input v-model="fAppSecret" type="password" placeholder="飞书应用 App Secret（32 字节）" /></div>
        <div class="im-field">
          <span>回复接收人类型</span>
          <select v-model="fReceiveType">
            <option value="chat_id">chat_id（群聊）</option>
            <option value="open_id">open_id（用户）</option>
            <option value="user_id">user_id（用户）</option>
          </select>
        </div>
      </template>
      <template v-else-if="platform === 'wecom'">
        <div class="im-field"><span>Corp ID</span><input v-model="wCorpId" type="password" placeholder="企业微信企业 ID" /></div>
        <div class="im-field"><span>Corp Secret</span><input v-model="wCorpSecret" type="password" placeholder="应用 Secret" /></div>
        <div class="im-field"><span>AgentId</span><input v-model="wAgentId" placeholder="应用 AgentId（数字）" /></div>
        <div class="im-field"><span>默认接收人 touser（可选，留空用会话 id）</span><input v-model="wTouser" placeholder="如 @all 或成员 UserID" /></div>
      </template>

      <div class="im-field">
        <span>白名单 chat_id（每行一个；留空=全部会话）</span>
        <textarea v-model="whitelist" rows="3" placeholder="如：cid12345&#10;oc_xxxxx" />
      </div>
      <div class="im-field">
        <span>触发前缀（留空=处理所有消息；填如 @ai 只处理带此前缀的）</span>
        <input v-model="trigger" placeholder="如 @ai " />
      </div>
      <div class="im-field">
        <span>会话上下文条数（默认 12）</span>
        <input v-model.number="maxContext" type="number" min="1" max="50" />
      </div>
      <div class="im-field">
        <span>系统提示词（可选，留空用内置）</span>
        <textarea v-model="systemPrompt" rows="3" placeholder="回答简洁、友好、直接给结论…" />
      </div>

      <div class="im-actions">
        <button class="im-btn" @click="save">保存配置</button>
        <button class="im-btn im-btn--primary" @click="start" :disabled="busy">▶ 启动网关</button>
        <button class="im-btn im-btn--danger" @click="stop" :disabled="busy">⏹ 停止</button>
        <span v-if="saveMsg" class="im-savemsg">{{ saveMsg }}</span>
      </div>
    </div>

    <div class="im-status">
      <div class="im-status__head">
        <b>运行状态</b>
        <span class="im-status__dot" :class="status?.running ? 'on' : 'off'">{{ status?.running ? "运行中" : "已停止" }}</span>
        <span v-if="status?.running" class="im-status__meta">平台：{{ status.platform_label }} · 已处理 {{ status.handled }} 条</span>
      </div>
      <div v-if="status?.last_error" class="im-status__err">⚠️ {{ status.last_error }}</div>
      <div class="im-status__cols">
        <div class="im-status__col">
          <b>日志</b>
          <pre class="im-status__log">{{ (status?.logs || []).join("\n") || "（空）" }}</pre>
        </div>
        <div class="im-status__col">
          <b>最近消息</b>
          <div v-if="!(status?.messages || []).length" class="im-status__empty">暂无消息</div>
          <div v-for="(m, i) in (status?.messages || []).slice(-8).reverse()" :key="i" class="im-status__msg">
            <span class="im-status__msg-meta">{{ fmtTime(m.ts) }} [{{ m.chat }}] {{ m.sender }}</span>
            <div class="im-status__msg-text">{{ m.text }}</div>
            <div v-if="m.reply" class="im-status__msg-reply">→ {{ m.reply }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.im-panel { display: flex; flex-direction: column; gap: 10px; }
.im-title { font-size: 15px; font-weight: 700; margin: 0; }
.im-desc { font-size: 12px; color: var(--text-secondary, #777); line-height: 1.6; margin: 0; }
.im-form { display: flex; flex-direction: column; gap: 8px; background: var(--bg-soft, #f6f6f6); border-radius: 8px; padding: 10px; }
.im-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.im-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--text-secondary, #666); }
.im-field input, .im-field textarea {
  padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd);
  background: var(--bg-input, #fff); color: var(--text, #222); font-size: 13px; font-family: inherit;
}
/* select 单独处理：走主题变量 + background-color（不覆盖全局箭头），与设置面板统一 */
.im-field select {
  padding: 6px 28px 6px 8px; border-radius: 6px; border: 1px solid var(--border-color);
  background-color: var(--bg-secondary); color: var(--text-primary); font-size: 13px; font-family: inherit;
}
.im-actions { display: flex; gap: 8px; align-items: center; }
.im-btn { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); cursor: pointer; font-size: 13px; }
.im-btn:hover { border-color: #4c8dff; color: #4c8dff; }
.im-btn:disabled { opacity: .5; cursor: default; }
.im-btn--primary { background: #2e7d32; color: #fff; border-color: #2e7d32; }
.im-btn--danger { color: #c62828; border-color: #c6282866; }
.im-savemsg { font-size: 12px; }
.im-status { display: flex; flex-direction: column; gap: 6px; }
.im-status__head { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.im-status__dot { padding: 2px 8px; border-radius: 10px; font-size: 11px; }
.im-status__dot.on { background: #2e7d3222; color: #2e7d32; }
.im-status__dot.off { background: #99999922; color: #777; }
.im-status__meta { font-size: 12px; color: var(--text-secondary, #888); }
.im-status__err { font-size: 12px; color: #c62828; }
.im-status__cols { display: flex; gap: 12px; }
.im-status__col { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.im-status__col b { font-size: 12px; }
.im-status__log { font-size: 11px; white-space: pre-wrap; word-break: break-word; background: var(--bg-soft, #f5f5f5); border-radius: 6px; padding: 6px 8px; margin: 0; max-height: 140px; overflow-y: auto; color: var(--text, #222); }
.im-status__empty { font-size: 12px; color: var(--text-secondary, #888); }
.im-status__msg { font-size: 11px; border-left: 2px solid var(--border, #ddd); padding-left: 6px; margin-bottom: 4px; }
.im-status__msg-meta { color: var(--text-secondary, #999); }
.im-status__msg-text { word-break: break-word; }
.im-status__msg-reply { color: #2e7d32; word-break: break-word; }
</style>
