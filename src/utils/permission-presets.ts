// 权限预设（借鉴 DeepSeek Harness 的 `permission-presets` 子系统）。
//
// DSH 的做法（docs/subsystems/permission-presets.zh.md）：把两个**相互独立**的强制执行旋钮——
// 沙箱模式（`sandbox/mode`）与审批策略（`approval/policy`）——**捆绑成具名预设**，
// 客户端只暴露**一个** Permissions 选择器；默认表自带 `workspace-write`（workspace-write + ask）
// 与 `danger-full-access`（danger-full-access + never），`custom` 是保留的**派生**名（当前组合不匹配任何档位）。
// 预设层**不拥有执行策略**：提示词叙述与回放仍读各自旋钮的折叠结果（本项目对应 chat.ts 里按
// sandboxMode/workspace 生成的那段「命令沙箱」说明），所以这里只做「写入两个旋钮」这一件事。
//
// 与 DSH 名词的对应：我们的 `off` = DSH 的 `danger-full-access`（不加隔离）；
// `manual` ≈ DSH `ask`；`yolo` ≈ DSH `never`；`smart`（辅助模型判断）≈ DSH 的 Auto review 集成；
// `on-failure` 同名。

/** 沙箱模式（与 Rust `sandbox.rs` 的 SandboxMode 对齐） */
export type SandboxMode = "off" | "read-only" | "workspace-write";
/** 危险命令审批策略（与设置里的 approvalMode 对齐） */
export type ApprovalMode = "manual" | "smart" | "on-failure" | "yolo";

export interface PermissionPreset {
  /** 稳定 key：沿用 DSH 同名档位，便于两边对照阅读 */
  id: string;
  label: string;
  /** 一句话说明这档是什么（对应 DSH 的 `PresetSpec.description`） */
  description: string;
  sandbox: SandboxMode;
  approval: ApprovalMode;
  /** 该档位是否依赖工作区根目录——缺根目录时后端不会加沙箱，等于这档不生效，必须提示 */
  requiresWorkspace: boolean;
  /** 高风险档位（UI 上用警示色，别让人误点） */
  risky?: boolean;
}

/**
 * DSH 保留名：当前组合不匹配任何档位时的**派生**状态。
 * （DSH 还保留了 `auto`；本项目对应 `smart` 审批，已作为一个具名档位给出。）
 */
export const CUSTOM_PRESET_ID = "custom";

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: "read-only",
    label: "只读",
    description: "命令不许写文件（/tmp 除外），危险命令仍要确认——调研/分析类最稳",
    sandbox: "read-only",
    approval: "manual",
    requiresWorkspace: false,
  },
  {
    id: "workspace-write",
    label: "工作区可写",
    description: "只允许写工作区目录，越界写入被系统拒绝；危险命令仍要确认",
    sandbox: "workspace-write",
    approval: "manual",
    requiresWorkspace: true,
  },
  {
    id: "workspace-write-smart",
    label: "工作区可写 + 智能审批",
    description: "同上，但危险命令先交给辅助模型判断，安全就自动放行（少弹窗）",
    sandbox: "workspace-write",
    approval: "smart",
    requiresWorkspace: true,
  },
  {
    id: "danger-full-access",
    label: "完全放开",
    description: "不加沙箱 + 危险命令一律自动执行（DSH 的 danger-full-access + never）",
    sandbox: "off",
    approval: "yolo",
    requiresWorkspace: false,
    risky: true,
  },
];

export function presetById(id: string | null | undefined): PermissionPreset | undefined {
  if (!id) return undefined;
  return PERMISSION_PRESETS.find((p) => p.id === id);
}

/**
 * 当前两个旋钮组合命中哪个档位；不匹配任何档位 → {@link CUSTOM_PRESET_ID}。
 * 用于：所有档位都不高亮时，明确显示「自定义」而不是假装某档生效。
 */
export function matchPresetId(
  sandbox: SandboxMode | null | undefined,
  approval: ApprovalMode | null | undefined,
): string {
  const s = sandbox || "off";
  const a = approval || "manual";
  const hit = PERMISSION_PRESETS.find((p) => p.sandbox === s && p.approval === a);
  return hit ? hit.id : CUSTOM_PRESET_ID;
}

/**
 * 档位「写穿」的设置字段。
 * 注意 `yoloMode` 与 `approvalMode` 的耦合必须与设置面板里 `onApprovalModeChange` 保持一致
 * （两处 UI 写同一批字段，不一致就会出现「看着是手动确认、实际全放行」）。
 */
export function presetWrites(preset: PermissionPreset): {
  sandboxMode: SandboxMode;
  approvalMode: ApprovalMode;
  yoloMode: boolean;
} {
  return {
    sandboxMode: preset.sandbox,
    approvalMode: preset.approval,
    yoloMode: preset.approval === "yolo",
  };
}

/** 档位当前是否可真正生效（缺工作区时 `workspace-write` 后端不加沙箱）。 */
export function presetApplies(
  preset: PermissionPreset,
  workspace: string | null | undefined,
): boolean {
  return !(preset.requiresWorkspace && !(workspace ?? "").trim());
}

/**
 * 需要提醒用户时的文案（空串 = 没问题）。
 * 为什么必须说清楚：后端在「配了 workspace-write 但没设工作区」时**不会加沙箱**（sandbox.rs 实测行为），
 * 也就是用户以为受限、其实完全不受限——这种「以为安全其实没有」必须显式提示。
 */
export function presetHint(
  presetId: string,
  workspace: string | null | undefined,
  presetList: PermissionPreset[] = PERMISSION_PRESETS,
): string {
  if (presetId === CUSTOM_PRESET_ID) {
    return "当前沙箱/审批组合不在预设表里（自定义）——可在设置 → 权限里逐项调整。";
  }
  const preset = presetList.find((p) => p.id === presetId);
  if (!preset) return "";
  if (!presetApplies(preset, workspace)) {
    return "这一档需要工作区目录：现在没设工作区，后端不会加沙箱（等于这档不生效）。";
  }
  if (preset.risky) {
    return "高风险：命令不再被沙箱限制、危险命令也不询问。";
  }
  return "";
}
