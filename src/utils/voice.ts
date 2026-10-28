// 语音输入（耳朵）的纯函数：草稿拼接、电平映射、相位文案。
//
// 抽出来的理由（不是洁癖）：这三件事都有明确的**边界错误**可能 ——
// 中英文混说时拼出「道生一看看」或「hello ,world」、电平条永远满格或永远不动、
// 相位文案与真实状态不一致（用户会以为还在听，其实麦克风已关）。纯函数才能钉住它们。

/** 中日韩文字（含全角标点）：中英之间要空格，汉字之间不能加空格 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** 把一段识别结果接到草稿后面。
 *
 * 规则（全部来自真实转写文本的形态）：
 * - 草稿为空 → 就是这段文本（不留前导空格）；
 * - 草稿末尾已有空白/换行 → 不重复加；
 * - 两侧都是中日韩文字 → **不加空格**（中文没有词间空格，加了就是错字）；
 * - 其余（英文/数字/混排）→ 以一个空格分隔，避免 `helloWorld` 粘成一个词。
 */
export function appendTranscript(draft: string, text: string): string {
  const add = text.trim();
  if (!add) return draft;
  if (!draft) return add;
  if (/\s$/.test(draft)) return draft + add;
  const prev = draft.slice(-1);
  const next = add.slice(0, 1);
  if (CJK_RE.test(prev) && CJK_RE.test(next)) return draft + add;
  return `${draft} ${add}`;
}

/** RMS（0~1）→ 0~1 的显示强度。
 *
 * 取平方根而不是线性：正常说话 RMS ≈ 0.02~0.15，线性映射会让波形一直趴在底部
 * （看着像没在收音）；平方根把这一段拉开，噪声（<0.005）仍接近 0。
 */
export function levelPercent(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.max(0, Math.min(1, Math.sqrt(rms) * 2.2));
}

/** 第 i 根电平柱的高度（0~1）。
 *
 * 没有频谱就不该假装有：每根柱子只取同一 RMS 的不同**幂次**，
 * 中心柱灵敏、两侧迟钝 —— 视觉上有起伏，但不会凭空造出「某频段很响」。
 */
export function levelBarHeight(rms: number, index: number, count = 5): number {
  const center = (count - 1) / 2;
  const distance = Math.abs(index - center) / Math.max(0.5, center);
  const base = levelPercent(rms);
  const shaped = Math.pow(base, 1 + distance * 0.9);
  return Math.max(0, Math.min(1, shaped));
}

/** 相位 → 中文文案（与 Rust `voice.rs` 的 phase 一一对应） */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "starting":
      return "正在打开麦克风";
    case "listening":
      return "正在聆听";
    case "thinking":
    case "transcribing":
      return "正在识别";
    case "idle":
      return "空闲";
    default:
      return phase || "空闲";
  }
}

/** 麦克风授权（macOS TCC）→ 用户能照着做的提示；`null` 表示已授权、无需提示 */
export function permissionHint(permission: string): string | null {
  switch (permission) {
    case "authorized":
      return null;
    case "denied":
      return "麦克风权限被拒绝：打开「系统设置 → 隐私与安全性 → 麦克风」，允许「道生一」后重启应用。";
    case "restricted":
      return "系统限制了这个应用使用麦克风（家长控制 / MDM 策略），无法在本机开启语音输入。";
    case "not_determined":
      return "首次使用会弹出系统权限请求，请点「允许」；没弹窗时去「系统设置 → 隐私与安全性 → 麦克风」手动勾选。";
    default:
      return "无法读取麦克风权限状态（非 macOS 或系统接口异常）。";
  }
}
