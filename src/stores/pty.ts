// S7 交互式 PTY：会话管理 + 轮询增量输出（Codex 能力整合）
import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface PtySession {
  id: number;
  command: string;
  startedAt: number;
  running: boolean;
  offset: number;
  output: string;
}

export const usePtyStore = defineStore("pty", () => {
  const sessions = ref<PtySession[]>([]);
  const activeId = ref<number | null>(null);
  const busy = ref(false);
  const error = ref("");

  async function refreshList() {
    try {
      const list = await invoke<{ id: number; command: string; started_at: number }[]>("pty_list");
      const prev = new Map(sessions.value.map((s) => [s.id, s]));
      sessions.value = list.map((p) => prev.get(p.id) ?? {
        id: p.id,
        command: p.command,
        startedAt: p.started_at,
        running: true,
        offset: 0,
        output: "",
      });
      if (activeId.value !== null && !sessions.value.some((s) => s.id === activeId.value)) {
        activeId.value = sessions.value[0]?.id ?? null;
      }
    } catch (e) {
      error.value = String(e);
    }
  }

  async function spawn(command: string, cwd?: string) {
    busy.value = true;
    error.value = "";
    try {
      const id = await invoke<number>("pty_spawn", { command, cwd: cwd ?? null });
      await refreshList();
      activeId.value = id;
      return id;
    } catch (e) {
      error.value = String(e);
      return null;
    } finally {
      busy.value = false;
    }
  }

  /** 轮询选中会话的增量输出（由 PtyPanel 定时调用） */
  async function poll(active: boolean) {
    if (!active || activeId.value === null) return;
    const s = sessions.value.find((x) => x.id === activeId.value);
    if (!s) return;
    try {
      const r = await invoke<{ text: string; offset: number; running: boolean }>("pty_poll", {
        id: s.id,
        offset: s.offset,
      });
      if (r.offset > s.offset) {
        s.output += r.text;
        s.offset = r.offset;
      }
      s.running = r.running;
    } catch {
      const idx = sessions.value.findIndex((x) => x.id === s.id);
      if (idx !== -1) sessions.value.splice(idx, 1);
      if (activeId.value === s.id) activeId.value = sessions.value[0]?.id ?? null;
    }
  }

  async function write(id: number, input: string) {
    try {
      await invoke("pty_write", { id, input });
    } catch (e) {
      error.value = String(e);
    }
  }

  async function kill(id: number) {
    try {
      await invoke("pty_kill", { id });
    } catch (e) {
      error.value = String(e);
    }
    await refreshList();
  }

  return { sessions, activeId, busy, error, refreshList, spawn, poll, write, kill };
});
