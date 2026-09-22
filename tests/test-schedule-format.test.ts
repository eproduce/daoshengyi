import { it, expect, describe } from "vitest";
import {
  intervalLabel,
  scheduleLabel,
  relativeTime,
  runStatus,
  matchPresetId,
  applyPreset,
  nextRunAt,
  nextRunPreview,
  validateTaskForm,
  SCHEDULE_PRESETS,
  EMPTY_FORM,
  type TaskLike,
  type TaskForm,
} from "../src/utils/schedule-format.ts";

// 本地时间构造（与实现里的 Date.setHours 同一时区语义，断言不受 CI 时区影响）
const at = (h: number, m: number, day = 20): number => new Date(2026, 8, day, h, m, 0, 0).getTime();

const task = (over: Partial<TaskLike> = {}): TaskLike => ({
  schedule_type: "interval",
  interval_minutes: 60,
  daily_time: "",
  enabled: true,
  next_run_at: 0,
  last_run_at: null,
  last_result: null,
  ...over,
});

const form = (over: Partial<TaskForm> = {}): TaskForm => ({ ...EMPTY_FORM, ...over });

describe("定时任务界面纯逻辑", () => {
  it("间隔人话化：能整除就换算成小时/天", () => {
    expect(intervalLabel(15)).toBe("每 15 分钟");
    expect(intervalLabel(60)).toBe("每 1 小时");
    expect(intervalLabel(90)).toBe("每 90 分钟");
    expect(intervalLabel(360)).toBe("每 6 小时");
    expect(intervalLabel(1440)).toBe("每 1 天");
    expect(intervalLabel(4320)).toBe("每 3 天");
    // 脏数据（0 / 负数）按后端语义回退 60 分钟，不显示「每 0 分钟」
    expect(intervalLabel(0)).toBe("每 1 小时");
    expect(intervalLabel(-5)).toBe("每 1 小时");
  });

  it("调度摘要", () => {
    expect(scheduleLabel(task({ schedule_type: "interval", interval_minutes: 30 }))).toBe(
      "每 30 分钟",
    );
    expect(scheduleLabel(task({ schedule_type: "daily", daily_time: "09:30" }))).toBe("每天 09:30");
    // 历史脏数据：daily 但时刻为空 → 不显示空白
    expect(scheduleLabel(task({ schedule_type: "daily", daily_time: "" }))).toBe("每天 00:00");
  });

  it("相对时间：未来/过去/秒级边界", () => {
    const now = at(8, 0);
    expect(relativeTime(now + 30_000, now)).toBe("30 秒后");
    expect(relativeTime(now + 3 * 60_000, now)).toBe("3 分钟后");
    expect(relativeTime(now - 2 * 60_000, now)).toBe("已逾期 2 分钟");
    expect(relativeTime(now + 8 * 3_600_000, now)).toBe("8 小时后");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("已逾期 2 天");
    // 不足 1 秒也不显示「0 秒」
    expect(relativeTime(now + 200, now)).toBe("1 秒后");
  });

  it("上次运行状态：退出码优先，老数据回退文本启发式", () => {
    expect(runStatus(task())).toBe("never");
    expect(runStatus(task({ last_run_at: 1, last_exit_code: 0, last_result: "ok" }))).toBe("ok");
    expect(runStatus(task({ last_run_at: 1, last_exit_code: 3, last_result: "boom" }))).toBe(
      "fail",
    );
    // 超时优先于退出码（超时时退出码是非 0，但「超时」更有信息量）
    expect(
      runStatus(
        task({
          last_run_at: 1,
          last_exit_code: 137,
          last_result: "(超时 300s 未结束，已终止进程组)\n",
        }),
      ),
    ).toBe("timeout");
    // 老数据（没有 last_exit_code 列）→ 从结果文本里读
    expect(runStatus(task({ last_run_at: 1, last_result: "(退出码 0)" }))).toBe("ok");
    expect(runStatus(task({ last_run_at: 1, last_result: "(退出码 7)" }))).toBe("fail");
    expect(runStatus(task({ last_run_at: 1, last_result: "hello world" }))).toBe("unknown");
  });

  it("预设：命中高亮、未命中为 null、套用不影响名称与命令", () => {
    expect(matchPresetId(form({ scheduleType: "interval", intervalMinutes: 60 }))).toBe("1h");
    expect(matchPresetId(form({ scheduleType: "daily", dailyTime: "09:00" }))).toBe("9am");
    expect(matchPresetId(form({ scheduleType: "daily", dailyTime: "06:33" }))).toBeNull();

    const preset = SCHEDULE_PRESETS.find((p) => p.id === "15m")!;
    const applied = applyPreset(form({ name: "巡检", command: "df -h" }), preset);
    expect(applied.scheduleType).toBe("interval");
    expect(applied.intervalMinutes).toBe(15);
    expect(applied.name).toBe("巡检");
    expect(applied.command).toBe("df -h");
  });

  it("下次运行时刻：daily 未到点→今天、已过/恰好等于→次日、跨午夜", () => {
    const daily = { scheduleType: "daily" as const, intervalMinutes: 60, dailyTime: "09:00" };
    expect(nextRunAt(daily, at(8, 0))).toBe(at(9, 0));
    expect(nextRunAt(daily, at(9, 0))).toBe(at(9, 0, 21)); // 恰好等于 → 次日（否则立刻再跑一遍）
    expect(nextRunAt(daily, at(9, 1))).toBe(at(9, 0, 21));
    // 跨午夜：23:59 参考、目标 00:05 → 次日
    expect(nextRunAt({ ...daily, dailyTime: "00:05" }, at(23, 59))).toBe(at(0, 5, 21));
    // 非法时刻回退 00:00，仍然落在将来
    const bogus = nextRunAt({ ...daily, dailyTime: "abc" }, at(8, 0));
    expect(bogus).toBeGreaterThan(at(8, 0));
  });

  it("下次运行时刻：interval 与脏数据", () => {
    const now = at(8, 0);
    expect(nextRunAt({ scheduleType: "interval", intervalMinutes: 30, dailyTime: "" }, now)).toBe(
      now + 30 * 60_000,
    );
    expect(nextRunAt({ scheduleType: "interval", intervalMinutes: 0, dailyTime: "" }, now)).toBe(
      now + 60 * 60_000,
    );
    expect(nextRunAt({ scheduleType: "interval", intervalMinutes: -5, dailyTime: "" }, now)).toBe(
      now + 60 * 60_000,
    );
  });

  it("预览文案同时给出绝对与相对时间", () => {
    const now = at(8, 0);
    const text = nextRunPreview(
      { scheduleType: "daily", intervalMinutes: 60, dailyTime: "09:00" },
      now,
    );
    expect(text).toContain("09:00");
    expect(text).toContain("1 小时后");
  });

  it("表单校验：名称/命令/时刻/间隔", () => {
    expect(validateTaskForm(form())).toContain("任务名称");
    expect(validateTaskForm(form({ name: "x" }))).toContain("命令");
    expect(
      validateTaskForm(
        form({ name: "x", command: "ls", scheduleType: "interval", intervalMinutes: 0 }),
      ),
    ).toContain("间隔");
    expect(
      validateTaskForm(form({ name: "x", command: "ls", scheduleType: "daily", dailyTime: "9:5" })),
    ).toContain("时刻");
    expect(validateTaskForm(form({ name: "x", command: "ls" }))).toBeNull();
  });
});
