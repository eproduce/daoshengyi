// 定时任务界面的纯逻辑（格式化 / 预设 / 状态判定 / 校验）——与 Vue 解耦，便于单测。
//
// 交互设计参照同类 agent 的做法：用户真正要回答的只有两个问题「多久跑一次」「跑什么」，
// 所以调度只暴露少量人话预设 + 自定义；状态要一眼看懂（下次什么时候、上次成没成），
// 所以用相对时间与成功/失败徽标，而不是裸时间戳。

export type ScheduleType = "interval" | "daily";

export interface TaskLike {
  schedule_type: string;
  interval_minutes: number;
  daily_time: string;
  enabled: boolean;
  next_run_at: number;
  last_run_at: number | null;
  last_result: string | null;
  last_exit_code?: number | null;
}

export interface TaskForm {
  name: string;
  command: string;
  scheduleType: ScheduleType;
  intervalMinutes: number;
  dailyTime: string;
}

export const EMPTY_FORM: TaskForm = {
  name: "",
  command: "",
  scheduleType: "daily",
  intervalMinutes: 60,
  dailyTime: "09:00",
};

/** 「每 N 分钟」的人话写法：能整除就换算成小时/天（60 → 每小时、1440 → 每天） */
export function intervalLabel(minutes: number): string {
  const m = minutes > 0 ? Math.floor(minutes) : 60;
  if (m % 1440 === 0) return `每 ${m / 1440} 天`;
  if (m % 60 === 0) return `每 ${m / 60} 小时`;
  return `每 ${m} 分钟`;
}

/** 调度摘要（列表与卡片共用） */
export function scheduleLabel(
  t: Pick<TaskLike, "schedule_type" | "interval_minutes" | "daily_time">,
): string {
  if (t.schedule_type === "daily") return `每天 ${t.daily_time || "00:00"}`;
  return intervalLabel(t.interval_minutes);
}

/** 绝对时刻：09-24 09:00 */
export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 相对时间：未来「8 小时后」、过去「已逾期 2 分钟」 */
export function relativeTime(target: number, now: number): string {
  const diff = target - now;
  const abs = Math.abs(diff);
  const text =
    abs < 60_000
      ? `${Math.max(1, Math.round(abs / 1000))} 秒`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} 分钟`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} 小时`
          : `${Math.round(abs / 86_400_000)} 天`;
  return diff >= 0 ? `${text}后` : `已逾期 ${text}`;
}

export type RunStatus = "never" | "ok" | "fail" | "timeout" | "unknown";

/** 上次运行状态：优先用退出码；老数据没有退出码时退回输出文本的启发式判断 */
export function runStatus(t: TaskLike): RunStatus {
  if (!t.last_run_at) return "never";
  const result = t.last_result ?? "";
  if (result.startsWith("(超时")) return "timeout";
  if (typeof t.last_exit_code === "number") {
    return t.last_exit_code === 0 ? "ok" : "fail";
  }
  const m = result.match(/^\(退出码 (-?\d+)\)/);
  if (m) return m[1] === "0" ? "ok" : "fail";
  return "unknown";
}

export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  never: "尚未运行",
  ok: "上次成功",
  fail: "上次失败",
  timeout: "上次超时",
  unknown: "上次已运行",
};

export interface SchedulePreset {
  id: string;
  label: string;
  scheduleType: ScheduleType;
  intervalMinutes?: number;
  dailyTime?: string;
}

/** 常用调度：覆盖「定时巡检 / 每天固定时刻汇报」两类高频诉求 */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: "15m", label: "每 15 分钟", scheduleType: "interval", intervalMinutes: 15 },
  { id: "30m", label: "每 30 分钟", scheduleType: "interval", intervalMinutes: 30 },
  { id: "1h", label: "每小时", scheduleType: "interval", intervalMinutes: 60 },
  { id: "6h", label: "每 6 小时", scheduleType: "interval", intervalMinutes: 360 },
  { id: "9am", label: "每天 09:00", scheduleType: "daily", dailyTime: "09:00" },
  { id: "18pm", label: "每天 18:00", scheduleType: "daily", dailyTime: "18:00" },
  { id: "22pm", label: "每天 22:00", scheduleType: "daily", dailyTime: "22:00" },
];

/** 当前表单命中的预设（用于高亮）；自定义则返回 null */
export function matchPresetId(
  form: Pick<TaskForm, "scheduleType" | "intervalMinutes" | "dailyTime">,
): string | null {
  const hit = SCHEDULE_PRESETS.find((p) =>
    p.scheduleType === "interval"
      ? form.scheduleType === "interval" && p.intervalMinutes === form.intervalMinutes
      : form.scheduleType === "daily" && p.dailyTime === form.dailyTime,
  );
  return hit ? hit.id : null;
}

/** 应用预设（只改「什么时候」，不动名称与命令） */
export function applyPreset(form: TaskForm, preset: SchedulePreset): TaskForm {
  return {
    ...form,
    scheduleType: preset.scheduleType,
    intervalMinutes: preset.intervalMinutes ?? form.intervalMinutes,
    dailyTime: preset.dailyTime ?? form.dailyTime,
  };
}

/**
 * 下次运行时刻（毫秒）。与后端 `compute_next_run` 保持同一语义：
 * daily「已过 / 恰好等于 → 次日」；interval「<=0 → 60 分钟」。
 */
export function nextRunAt(
  form: Pick<TaskForm, "scheduleType" | "intervalMinutes" | "dailyTime">,
  now: number,
): number {
  if (form.scheduleType === "daily") {
    const [h, m] = (form.dailyTime || "00:00").split(":").map((v) => Number(v));
    const d = new Date(now);
    d.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const minutes = form.intervalMinutes > 0 ? Math.floor(form.intervalMinutes) : 60;
  return now + minutes * 60_000;
}

/** 创建/编辑表单里的「下次运行」预览文案 */
export function nextRunPreview(
  form: Pick<TaskForm, "scheduleType" | "intervalMinutes" | "dailyTime">,
  now: number,
): string {
  const at = nextRunAt(form, now);
  return `${fmtDateTime(at)}（${relativeTime(at, now)}）`;
}

/** 命令示例：让「任务能干什么」有具体形状（点一下填进命令框） */
export const COMMAND_EXAMPLES: { label: string; command: string }[] = [
  { label: "磁盘占用", command: "df -h /" },
  { label: "堵在前 10 的进程", command: "ps aux | sort -k3 -nr | head -10" },
  { label: "备份某个目录", command: "tar -czf ~/backup-$(date +%F).tgz ~/Documents/important" },
  { label: "清理 7 天前的日志", command: "find ~/Library/Logs -name '*.log' -mtime +7 -delete" },
  { label: "联网自检", command: "curl -sS -o /dev/null -w '%{http_code}' https://www.baidu.com" },
];

/** 表单校验：返回错误文案；null = 可以保存 */
export function validateTaskForm(form: TaskForm): string | null {
  if (!form.name.trim()) return "请填写任务名称（便于日后辨认）";
  if (!form.command.trim()) return "请填写要执行的命令";
  if (form.scheduleType === "daily") {
    if (!/^\d{1,2}:\d{2}$/.test(form.dailyTime.trim())) return "请选择每天的执行时刻";
  } else if (!(form.intervalMinutes > 0)) {
    return "间隔必须是大于 0 的分钟数";
  }
  return null;
}
