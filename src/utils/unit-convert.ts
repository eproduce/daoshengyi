/**
 * 单位换算（吸收自 DSH 生态的 dsh-unitverse / dsh-units / dsh-discretemath 系列）。
 *
 * 为什么要有它：模型「口算」单位换算极易出错（km/h↔m/s、斤↔kg、亩↔m²、°C↔°F），
 * 且无法自证正确。把换算下沉为纯函数表驱动，结果可复现、可核对。
 *
 * 约定：
 * - 每个类别选一个 base 单位，其它单位给出「到 base 的线性系数」；温度走特殊路径。
 * - 单位名查找：先精确匹配（区分大小写，保证 b=bit / B=byte），再小写/去空白的宽松匹配。
 * - 零依赖、纯函数。
 */

export interface UnitEntry {
  /** 规范名（输出用） */
  name: string;
  /** 别名（含中文），全部参与查找 */
  aliases: string[];
  /** 到 base 单位的线性系数：value_base = value * factor */
  factor: number;
}

export interface UnitCategory {
  id: string;
  label: string;
  base: string;
  /** temperature 走特殊换算路径 */
  special?: "temperature";
  units: UnitEntry[];
}

const u = (name: string, aliases: string[], factor: number): UnitEntry => ({ name, aliases, factor });

export const UNIT_CATEGORIES: UnitCategory[] = [
  {
    id: "length",
    label: "长度",
    base: "m",
    units: [
      u("m", ["米", "meter", "metre", "meters"], 1),
      u("km", ["千米", "公里", "kilometer", "kilometre"], 1000),
      u("cm", ["厘米", "centimeter"], 0.01),
      u("mm", ["毫米", "millimeter"], 0.001),
      u("in", ["inch", "英寸", '"'], 0.0254),
      u("ft", ["foot", "feet", "英尺", "'"], 0.3048),
      u("yd", ["yard", "码"], 0.9144),
      u("mi", ["mile", "英里"], 1609.344),
      u("nmi", ["海里", "nauticalmile"], 1852),
      u("li", ["里"], 500),
      u("chi", ["尺"], 1 / 3),
      u("cun", ["寸"], 1 / 30),
    ],
  },
  {
    id: "mass",
    label: "质量",
    base: "kg",
    units: [
      u("kg", ["千克", "公斤", "kilogram"], 1),
      u("g", ["克", "gram"], 0.001),
      u("mg", ["毫克", "milligram"], 1e-6),
      u("t", ["吨", "ton", "tonne"], 1000),
      u("lb", ["磅", "pound"], 0.45359237),
      u("oz", ["盎司", "ounce"], 0.028349523125),
      u("jin", ["斤"], 0.5),
      u("liang", ["两"], 0.05),
    ],
  },
  {
    id: "temperature",
    label: "温度",
    base: "C",
    special: "temperature",
    units: [
      u("C", ["摄氏", "摄氏度", "°c", "celsius", "℃"], 1),
      u("F", ["华氏", "华氏度", "°f", "fahrenheit", "℉"], 1),
      u("K", ["开尔文", "kelvin"], 1),
    ],
  },
  {
    id: "time",
    label: "时间",
    base: "s",
    units: [
      u("s", ["秒", "sec", "secs", "second", "seconds"], 1),
      u("ms", ["毫秒", "millisecond"], 0.001),
      u("min", ["分钟", "minute", "minutes"], 60),
      u("h", ["小时", "hour", "hours", "时"], 3600),
      u("d", ["天", "日", "day", "days"], 86400),
      u("wk", ["周", "星期", "week", "weeks"], 604800),
    ],
  },
  {
    id: "data",
    label: "数据量",
    base: "B",
    units: [
      u("bit", ["b", "位"], 0.125),
      u("B", ["byte", "字节"], 1),
      u("KB", ["千字节"], 1000),
      u("MB", [], 1e6),
      u("GB", [], 1e9),
      u("TB", [], 1e12),
      u("KiB", [], 1024),
      u("MiB", [], 1024 ** 2),
      u("GiB", [], 1024 ** 3),
      u("TiB", [], 1024 ** 4),
    ],
  },
  {
    id: "area",
    label: "面积",
    base: "m2",
    units: [
      u("m2", ["平方米", "㎡", "sqm"], 1),
      u("km2", ["平方千米", "平方公里"], 1e6),
      u("cm2", ["平方厘米"], 1e-4),
      u("ha", ["公顷"], 10000),
      u("mu", ["亩"], 2000 / 3),
      u("ft2", ["平方英尺"], 0.09290304),
      u("acre", ["英亩"], 4046.8564224),
    ],
  },
  {
    id: "volume",
    label: "体积",
    base: "L",
    units: [
      u("L", ["升", "l", "liter", "litre"], 1),
      u("mL", ["毫升", "ml"], 0.001),
      u("m3", ["立方米"], 1000),
      u("gal", ["加仑", "gallon"], 3.785411784),
    ],
  },
  {
    id: "speed",
    label: "速度",
    base: "m/s",
    units: [
      u("m/s", ["米每秒", "mps"], 1),
      u("km/h", ["千米每小时", "公里每小时", "kph", "kmh"], 1000 / 3600),
      u("mph", ["英里每小时"], 1609.344 / 3600),
      u("kn", ["节", "knot"], 1852 / 3600),
    ],
  },
  {
    id: "angle",
    label: "角度",
    base: "deg",
    units: [
      u("deg", ["度", "°", "degree"], 1),
      u("rad", ["弧度", "radian"], 180 / Math.PI),
      u("grad", ["百分度", "gon"], 0.9),
    ],
  },
  {
    id: "pressure",
    label: "压强",
    base: "Pa",
    units: [
      u("Pa", ["帕", "帕斯卡"], 1),
      u("kPa", ["千帕"], 1000),
      u("MPa", ["兆帕"], 1e6),
      u("bar", ["巴"], 100000),
      u("atm", ["标准大气压"], 101325),
      u("mmHg", ["毫米汞柱", "torr"], 133.322387415),
      u("psi", ["磅力每平方英寸"], 6894.757293168),
    ],
  },
  {
    id: "energy",
    label: "能量",
    base: "J",
    units: [
      u("J", ["焦", "焦耳", "joule"], 1),
      u("kJ", ["千焦"], 1000),
      u("cal", ["卡", "卡路里"], 4.184),
      u("kcal", ["千卡", "大卡"], 4184),
      u("Wh", ["瓦时"], 3600),
      u("kWh", ["千瓦时", "度电"], 3.6e6),
      u("eV", ["电子伏"], 1.602176634e-19),
    ],
  },
  {
    id: "power",
    label: "功率",
    base: "W",
    units: [
      u("W", ["瓦", "瓦特", "watt"], 1),
      u("kW", ["千瓦"], 1000),
      u("MW", ["兆瓦"], 1e6),
      u("hp", ["马力", "horsepower"], 735.49875),
    ],
  },
  {
    id: "frequency",
    label: "频率",
    base: "Hz",
    units: [
      u("Hz", ["赫兹", "hertz"], 1),
      u("kHz", ["千赫"], 1000),
      u("MHz", ["兆赫"], 1e6),
      u("GHz", ["吉赫"], 1e9),
    ],
  },
];

/** 单位查找：先精确（区分大小学，b=bit/B=byte），再宽松（小写 + 去空白/下划线） */
export function findUnit(name: string): { category: UnitCategory; unit: UnitEntry } | null {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  for (const category of UNIT_CATEGORIES) {
    for (const unit of category.units) {
      if (unit.name === raw || unit.aliases.includes(raw)) return { category, unit };
    }
  }
  const loose = raw.toLowerCase().replace(/[\s_]/g, "");
  for (const category of UNIT_CATEGORIES) {
    for (const unit of category.units) {
      const cands = [unit.name, ...unit.aliases].map((x) => x.toLowerCase().replace(/[\s_]/g, ""));
      if (cands.includes(loose)) return { category, unit };
    }
  }
  return null;
}

/** 温度：任意单位 → 摄氏度 */
function tempToCelsius(value: number, unit: string): number {
  if (unit === "C") return value;
  if (unit === "F") return (value - 32) * (5 / 9);
  return value - 273.15;
}

/** 温度：摄氏度 → 任意单位 */
function celsiusToTemp(c: number, unit: string): number {
  if (unit === "C") return c;
  if (unit === "F") return c * (9 / 5) + 32;
  return c + 273.15;
}

export interface ConvertResult {
  value: number;
  category: string;
  from: string;
  to: string;
  /** 人类可读的公式说明（模型引用时可原样复述，便于核对） */
  formula: string;
}

/** 单位换算：找不到单位或跨类别时抛错（错误信息面向模型，直接可读） */
export function convertUnit(value: number, from: string, to: string): ConvertResult {
  if (!Number.isFinite(value)) throw new Error("convert_unit 的 value 必须是有限数字");
  const a = findUnit(from);
  const b = findUnit(to);
  if (!a) throw new Error(`未知单位「${from}」。可用单位见 listUnits（如 m/km/斤/lb/°C/kWh…）`);
  if (!b) throw new Error(`未知单位「${to}」。可用单位见 listUnits（如 m/km/斤/lb/°C/kWh…）`);
  if (a.category.id !== b.category.id) {
    throw new Error(
      `「${from}」属于「${a.category.label}」，「${to}」属于「${b.category.label}」，不能直接换算；` +
        `请分别换成同类别单位。`,
    );
  }
  if (a.category.special === "temperature") {
    const c = tempToCelsius(value, a.unit.name);
    const out = celsiusToTemp(c, b.unit.name);
    return {
      value: out,
      category: a.category.label,
      from: a.unit.name,
      to: b.unit.name,
      formula: `${value}${a.unit.name} → ${c.toPrecision(10)}°C → ${out}${b.unit.name}`,
    };
  }
  const base = value * a.unit.factor;
  const out = base / b.unit.factor;
  return {
    value: out,
    category: a.category.label,
    from: a.unit.name,
    to: b.unit.name,
    formula: `${value} ${a.unit.name} × ${a.unit.factor} ÷ ${b.unit.factor} = ${out} ${b.unit.name}`,
  };
}

/** 列出全部可用单位（供模型在报错/不确定时自查，避免反复猜） */
export function listUnits(): string {
  return UNIT_CATEGORIES.map(
    (c) => `- ${c.label}（${c.id}）：${c.units.map((x) => x.name).join(" / ")}`,
  ).join("\n");
}
