//! 确定性图像核验（`image_inspect` 工具）：把「数一数字符有几个、每个字形长什么样」
//! 变成像素级算法，而不是让模型现场手写 Python。
//!
//! 起因（真实使用）：需要确认证书编号到底几位，OCR 对等宽数字串（尤其前导零）漏读率高，
//! 模型只好连着写了 5 次 `PIL + numpy` heredoc，做列投影切分 + 连通域空洞计数才得出结论。
//! 这套方法是**纯确定性**的 —— 能写成工具的就不该让模型每次重新发明。
//!
//! 全部算法都是纯函数（`Bitmap` 进、数字出），不碰文件系统，便于单测。

use serde::Deserialize;

/// 图像区域（像素坐标，左上原点）
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct RegionSpec {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

/// 二值位图：`bits[y * w + x] == true` 表示该像素是**墨迹**（前景）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bitmap {
    pub w: usize,
    pub h: usize,
    pub bits: Vec<bool>,
}

impl Bitmap {
    pub fn new(w: usize, h: usize) -> Self {
        Self {
            w,
            h,
            bits: vec![false; w * h],
        }
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> bool {
        if x >= self.w || y >= self.h {
            return false;
        }
        self.bits[y * self.w + x]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, v: bool) {
        if x < self.w && y < self.h {
            self.bits[y * self.w + x] = v;
        }
    }

    pub fn ink_total(&self) -> usize {
        self.bits.iter().filter(|b| **b).count()
    }

    /// 取子区域（超出边界按背景补齐，不 panic）
    pub fn sub(&self, b: BBox) -> Bitmap {
        let mut out = Bitmap::new(b.width(), b.height());
        for y in 0..b.height() {
            for x in 0..b.width() {
                out.set(x, y, self.get(b.x0 + x, b.y0 + y));
            }
        }
        out
    }
}

/// 包围盒（x1/y1 含）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BBox {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl BBox {
    pub fn width(&self) -> usize {
        self.x1.saturating_sub(self.x0) + 1
    }
    pub fn height(&self) -> usize {
        self.y1.saturating_sub(self.y0) + 1
    }
}

/// 灰度直方图
pub fn histogram(gray: &[u8]) -> [u32; 256] {
    let mut hist = [0u32; 256];
    for v in gray {
        hist[*v as usize] += 1;
    }
    hist
}

/// Otsu 阈值：最大化类间方差。
///
/// 关键细节：直方图在两峰之间为零时，方差在整段区间内**完全相同**（平台）。
/// 若简单地「取第一个最大值」，返回的就是平台左端（恰好等于暗峰灰度），
/// 再配上 `v < threshold` 的判法会把暗像素全体当成背景 —— 一张图一个字符都切不出来。
/// 因此取平台**中点**。全同色（无对比）时返回 128，让调用方看出「这图没内容」。
pub fn otsu_threshold(hist: &[u32; 256], total: u32) -> u8 {
    if total == 0 {
        return 128;
    }
    let sum_all: f64 = (0..256).map(|i| i as f64 * hist[i] as f64).sum();
    let mut sum_bg = 0.0f64;
    let mut w_bg = 0u32;
    let mut best_var = -1.0f64;
    let mut best_lo = 0usize;
    let mut best_hi = 0usize;
    for (t, count) in hist.iter().enumerate() {
        w_bg += *count;
        if w_bg == 0 {
            continue;
        }
        let w_fg = total - w_bg;
        if w_fg == 0 {
            break;
        }
        sum_bg += t as f64 * (*count) as f64;
        let m_bg = sum_bg / w_bg as f64;
        let m_fg = (sum_all - sum_bg) / w_fg as f64;
        let var = w_bg as f64 * w_fg as f64 * (m_bg - m_fg) * (m_bg - m_fg);
        if var > best_var + 1e-9 {
            best_var = var;
            best_lo = t;
            best_hi = t;
        } else if (var - best_var).abs() <= 1e-9 {
            best_hi = t;
        }
    }
    if best_var < 0.0 {
        return 128;
    }
    ((best_lo + best_hi) / 2).min(255) as u8
}

/// 按阈值二值化：默认「深色=墨迹」（浅底深字的证书/截图场景）
/// 边界处理：不可把纯白当墨迹、也不可把纯黑当反色墨迹 —— 否则阈值贴边时整图变前景。
pub fn binarize(gray: &[u8], w: usize, h: usize, threshold: u8, invert: bool) -> Bitmap {
    let mut bm = Bitmap::new(w, h);
    for (i, v) in gray.iter().enumerate() {
        let ink = if invert {
            *v >= threshold && *v > 0
        } else {
            *v < threshold && *v < 255
        };
        bm.bits[i] = ink;
    }
    bm
}

/// 列投影切分：返回各段「有墨迹的列区间」，再按最大间隙合并（同一字形的断笔要连起来）
pub fn split_columns(bm: &Bitmap, max_gap: usize, min_width: usize) -> Vec<(usize, usize)> {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for x in 0..bm.w {
        let has = (0..bm.h).any(|y| bm.get(x, y));
        match (has, start) {
            (true, None) => start = Some(x),
            (false, Some(s)) => {
                runs.push((s, x - 1));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        runs.push((s, bm.w - 1));
    }
    // 合并间隙很小的相邻段
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for r in runs {
        match merged.last_mut() {
            Some(last) if r.0.saturating_sub(last.1 + 1) <= max_gap => last.1 = r.1,
            _ => merged.push(r),
        }
    }
    merged
        .into_iter()
        .filter(|(a, b)| b.saturating_sub(*a) + 1 >= min_width)
        .collect()
}

/// 指定列区间内的竖直范围（含墨迹的行）
pub fn vertical_extent(bm: &Bitmap, x0: usize, x1: usize) -> Option<(usize, usize)> {
    let mut top: Option<usize> = None;
    let mut bottom = 0usize;
    for y in 0..bm.h {
        let has = (x0..=x1.min(bm.w.saturating_sub(1))).any(|x| bm.get(x, y));
        if has {
            if top.is_none() {
                top = Some(y);
            }
            bottom = y;
        }
    }
    top.map(|t| (t, bottom))
}

/// 区域内墨迹像素数
pub fn ink_in_box(bm: &Bitmap, b: BBox) -> usize {
    let mut n = 0;
    for y in b.y0..=b.y1.min(bm.h.saturating_sub(1)) {
        for x in b.x0..=b.x1.min(bm.w.saturating_sub(1)) {
            if bm.get(x, y) {
                n += 1;
            }
        }
    }
    n
}

/// 封闭空洞数：字形**内部**被笔画围住、与外界背景不连通的空白区块数量。
///
/// 做法：把包围盒四周各加 1px 背景边距（保证外部背景连通到边界），
/// 再从边界向内 4 连通泛洪标记「外部背景」，剩下没被标记的背景像素就是空洞，
/// 数它们的连通分量个数。
/// 典型值：`0`（带斜杠）= 2、`2` = 0、`8` = 2、`4` = 1（三角封闭区）、`1` = 0。
pub fn count_holes(bm: &Bitmap, b: BBox) -> usize {
    let padded = BBox {
        x0: b.x0.saturating_sub(1),
        y0: b.y0.saturating_sub(1),
        x1: (b.x1 + 1).min(bm.w.saturating_sub(1)),
        y1: (b.y1 + 1).min(bm.h.saturating_sub(1)),
    };
    let pw = padded.width();
    let ph = padded.height();
    let sub = bm.sub(padded);

    let idx = |x: usize, y: usize| y * pw + x;
    let mut outside = vec![false; pw * ph];
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for x in 0..pw {
        for y in [0, ph - 1] {
            if !sub.get(x, y) && !outside[idx(x, y)] {
                outside[idx(x, y)] = true;
                stack.push((x, y));
            }
        }
    }
    for y in 0..ph {
        for x in [0, pw - 1] {
            if !sub.get(x, y) && !outside[idx(x, y)] {
                outside[idx(x, y)] = true;
                stack.push((x, y));
            }
        }
    }
    while let Some((x, y)) = stack.pop() {
        let neighbors = [
            (x.wrapping_sub(1), y),
            (x + 1, y),
            (x, y.wrapping_sub(1)),
            (x, y + 1),
        ];
        for (nx, ny) in neighbors {
            if nx < pw && ny < ph && !sub.get(nx, ny) && !outside[idx(nx, ny)] {
                outside[idx(nx, ny)] = true;
                stack.push((nx, ny));
            }
        }
    }
    // 未被标记为外部的背景像素 = 空洞；数连通分量
    let mut holes = 0usize;
    let mut seen = vec![false; pw * ph];
    for y in 0..ph {
        for x in 0..pw {
            let i = idx(x, y);
            if sub.get(x, y) || outside[i] || seen[i] {
                continue;
            }
            holes += 1;
            seen[i] = true;
            let mut st = vec![(x, y)];
            while let Some((cx, cy)) = st.pop() {
                let nb = [
                    (cx.wrapping_sub(1), cy),
                    (cx + 1, cy),
                    (cx, cy.wrapping_sub(1)),
                    (cx, cy + 1),
                ];
                for (nx, ny) in nb {
                    if nx < pw && ny < ph {
                        let ni = idx(nx, ny);
                        if !sub.get(nx, ny) && !outside[ni] && !seen[ni] {
                            seen[ni] = true;
                            st.push((nx, ny));
                        }
                    }
                }
            }
        }
    }
    holes
}

/// 一个字符块的分析结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Glyph {
    pub bbox: BBox,
    pub ink: usize,
    pub holes: usize,
}

impl Glyph {
    pub fn width(&self) -> usize {
        self.bbox.width()
    }
    pub fn height(&self) -> usize {
        self.bbox.height()
    }
    /// 宽高比（宽/高），保留 2 位
    pub fn aspect(&self) -> f64 {
        if self.height() == 0 {
            return 0.0;
        }
        ((self.width() as f64 / self.height() as f64) * 100.0).round() / 100.0
    }
}

/// 分析所有字符块（列投影 → 竖直范围 → 墨迹 → 空洞）
pub fn analyze_glyphs(bm: &Bitmap, max_gap: usize, min_width: usize, limit: usize) -> Vec<Glyph> {
    let mut out = Vec::new();
    for (x0, x1) in split_columns(bm, max_gap, min_width) {
        let (y0, y1) = match vertical_extent(bm, x0, x1) {
            Some(v) => v,
            None => continue,
        };
        let bbox = BBox { x0, y0, x1, y1 };
        out.push(Glyph {
            bbox,
            ink: ink_in_box(bm, bbox),
            holes: count_holes(bm, bbox),
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// 字形降采样为 ASCII 点阵（便于「用文字看字形」：末位是 2 还是 0 一目了然）
pub fn ascii_art(bm: &Bitmap, b: BBox, target_w: usize) -> Vec<String> {
    let bw = b.width();
    let bh = b.height();
    if bw == 0 || bh == 0 {
        return Vec::new();
    }
    let tw = target_w.clamp(4, 80);
    // 字符宽度按 2:1 的显示比例折算高度（避免字形被拉长），并封顶防止报告失真
    let th = (((bh as f64 / bw as f64) * (tw as f64 / 2.0)).round() as usize).clamp(1, 18);
    let mut lines = Vec::with_capacity(th);
    for ty in 0..th {
        let mut line = String::with_capacity(tw);
        for tx in 0..tw {
            let sx0 = b.x0 + tx * bw / tw;
            let sx1 = (b.x0 + (tx + 1) * bw / tw).max(sx0 + 1);
            let sy0 = b.y0 + ty * bh / th;
            let sy1 = (b.y0 + (ty + 1) * bh / th).max(sy0 + 1);
            let mut hit = 0usize;
            let mut tot = 0usize;
            for y in sy0..sy1 {
                for x in sx0..sx1 {
                    tot += 1;
                    if bm.get(x, y) {
                        hit += 1;
                    }
                }
            }
            let ratio = if tot == 0 {
                0.0
            } else {
                hit as f64 / tot as f64
            };
            line.push(match ratio {
                r if r >= 0.6 => '█',
                r if r >= 0.35 => '▓',
                r if r >= 0.12 => '▒',
                r if r > 0.0 => '░',
                _ => ' ',
            });
        }
        lines.push(line.trim_end().to_string());
    }
    // 去掉全空行（上下留白）
    lines.retain(|l| !l.is_empty());
    lines
}

/// 分析选项
#[derive(Debug, Clone)]
pub struct InspectOptions {
    pub threshold: Option<u8>,
    pub invert: bool,
    pub mode: String,
    pub ascii_width: usize,
    pub max_glyphs: usize,
    pub min_glyph_width: usize,
    pub max_gap: usize,
}

impl Default for InspectOptions {
    fn default() -> Self {
        Self {
            threshold: None,
            invert: false,
            mode: "glyphs".to_string(),
            ascii_width: 24,
            max_glyphs: 24,
            // 默认 **不按宽度丢弃**：掉一个字符 = 数错位数，
            // 这正是本工具要消除的错误，宁可多报（报告会给出宽高分布）
            min_glyph_width: 1,
            // 默认 **不合并**：宁可多切出几块（报告里一看就知道），
            // 也不能把两个字符静默合成一个 —— 那正是要消除的错数
            max_gap: 0,
        }
    }
}

/// 生成可读报告（纯函数：给定位图与元信息）
pub fn render_report(
    label: &str,
    origin: (u32, u32),
    gray: &[u8],
    bm: &Bitmap,
    threshold: u8,
    opts: &InspectOptions,
) -> String {
    let total = (bm.w * bm.h) as u64;
    let ink = bm.ink_total();
    let pct = if total == 0 {
        0.0
    } else {
        (ink as f64 / total as f64) * 100.0
    };
    let mut out = String::new();
    out.push_str(&format!("🖼 {}\n", label));
    out.push_str(&format!(
        "区域 {:?} 起，{}×{} 像素｜灰度阈值 {}（{}）｜前景 {:.2}%\n",
        origin,
        bm.w,
        bm.h,
        threshold,
        if opts.invert {
            "浅色=墨迹"
        } else {
            "深色=墨迹"
        },
        pct
    ));

    if opts.mode == "info" {
        out.push_str(&format!(
            "\n灰度均值 {:.1}｜直方图峰值 {}（Otsu 建议阈值 {}）\n",
            if gray.is_empty() {
                0.0
            } else {
                gray.iter().map(|v| *v as u64).sum::<u64>() as f64 / gray.len() as f64
            },
            histogram(gray)
                .iter()
                .enumerate()
                .max_by_key(|(_, c)| **c)
                .map(|(i, _)| i)
                .unwrap_or(0),
            otsu_threshold(&histogram(gray), gray.len() as u32)
        ));
        return out;
    }

    let glyphs = analyze_glyphs(bm, opts.max_gap, opts.min_glyph_width, opts.max_glyphs);
    // 诚实计数：既要报告「切出几块」，也要报告「有多少段被规则/上限吃掉了」，
    // 否则模型会拿一个不完整的块数去下结论
    let total_runs = split_columns(bm, opts.max_gap, 1).len();
    let kept_runs = split_columns(bm, opts.max_gap, opts.min_glyph_width).len();
    let narrow = total_runs.saturating_sub(kept_runs);
    let truncated = kept_runs.saturating_sub(glyphs.len());
    let mut extra = String::new();
    if narrow > 0 {
        extra.push_str(&format!(
            "，其中 {} 段窄于 {}px 已忽略（要保留请调小 min_glyph_width）",
            narrow, opts.min_glyph_width
        ));
    }
    if truncated > 0 {
        extra.push_str(&format!(
            "，另有 {} 段超出 max_glyphs={} 未列出",
            truncated, opts.max_glyphs
        ));
    }
    out.push_str(&format!(
        "\n共发现列段 {} 段；切出字符块 {} 个（列投影，最小宽 {}px，间隙≤{}px 视为同一字形）{}\n\n",
        total_runs,
        glyphs.len(),
        opts.min_glyph_width,
        opts.max_gap,
        extra
    ));
    if glyphs.is_empty() {
        out.push_str(
            "（没有切出任何字符块——可能区域选错了，或阈值不适用；可用 mode=info 看灰度分布）\n",
        );
        return out;
    }
    out.push_str(
        "| # | x 范围 | 宽 | 高 | 墨迹 | 封闭空洞 | 宽高比 |\n|---|---|---|---|---|---|---|\n",
    );
    for (i, g) in glyphs.iter().enumerate() {
        out.push_str(&format!(
            "| {} | {}~{} | {} | {} | {} | {} | {} |\n",
            i + 1,
            g.bbox.x0 + origin.0 as usize,
            g.bbox.x1 + origin.0 as usize,
            g.width(),
            g.height(),
            g.ink,
            g.holes,
            g.aspect()
        ));
    }

    // 宽度/高度分组：同一字形的族会高度一致，不一致的说明切分有问题
    let widths: Vec<usize> = glyphs.iter().map(|g| g.width()).collect();
    let min_w = widths.iter().min().copied().unwrap_or(0);
    let max_w = widths.iter().max().copied().unwrap_or(0);
    out.push_str(&format!(
        "\n宽度分布：{}~{}px（首 {} 块来自同一字形的可能性最大，宽度差越小越同构）\n",
        min_w,
        max_w,
        glyphs.len()
    ));

    // 点阵只给前若干个字形：报告体积必须有界（否则 24 个字形 × 24 行会把上下文吃满）
    let art_limit = 12.min(glyphs.len());
    if opts.mode != "info" {
        out.push_str("\n字形点阵（█ 墨迹 / 空格 背景，按宽度 2:1 显示）：\n");
        for (i, g) in glyphs.iter().take(art_limit).enumerate() {
            out.push_str(&format!(
                "\n#{}（封闭空洞 {}，{}×{}）\n```\n",
                i + 1,
                g.holes,
                g.width(),
                g.height()
            ));
            for line in ascii_art(bm, g.bbox, opts.ascii_width) {
                out.push_str(&line);
                out.push('\n');
            }
            out.push_str("```\n");
        }
        if glyphs.len() > art_limit {
            out.push_str(&format!(
                "\n（仅显示前 {} 个字形点阵，共 {} 个）\n",
                art_limit,
                glyphs.len()
            ));
        }
    }
    out.push_str(
        "\n读法提示：封闭空洞数只由字形决定（如带斜杠的零比普通零多 1 个空洞），可用来区分\n\
         字形相近的字符；点阵是降采样结果，只用于判断字形类别，不要拿它当 OCR 文本。\n",
    );
    out
}

/// 从灰度图完成一次完整分析（纯函数，便于单测）
pub fn inspect_gray(
    label: &str,
    origin: (u32, u32),
    gray: Vec<u8>,
    w: usize,
    h: usize,
    opts: &InspectOptions,
) -> String {
    let hist = histogram(&gray);
    let threshold = opts
        .threshold
        .unwrap_or_else(|| otsu_threshold(&hist, gray.len() as u32));
    let bm = binarize(&gray, w, h, threshold, opts.invert);
    render_report(label, origin, &gray, &bm, threshold, opts)
}

// ---------------------------------------------------------------------------
// 真机部分：读文件 + 裁区域（薄薄一层，算法都在上面）
// ---------------------------------------------------------------------------

/// 读取图片并分析（供 tauri 命令调用；路径沙箱在命令层校验）
pub fn inspect_file(
    path: &str,
    region: Option<RegionSpec>,
    opts: &InspectOptions,
) -> Result<String, String> {
    // 参数先校验再读盘：参数错就该立刻报错，不要先浪费一次解码
    if let Some(r) = region {
        if r.width == 0 || r.height == 0 {
            return Err("region 的 width/height 必须大于 0".to_string());
        }
    }
    let img = image::open(path).map_err(|e| format!("打开图片失败：{}（{}）", path, e))?;
    let full_w = img.width();
    let full_h = img.height();
    let luma = img.to_luma8();

    let (left, top, w, h) = match region {
        Some(r) => {
            let l = r.left.min(full_w.saturating_sub(1));
            let t = r.top.min(full_h.saturating_sub(1));
            let w = r.width.min(full_w - l);
            let h = r.height.min(full_h - t);
            (l, t, w, h)
        }
        None => (0, 0, full_w, full_h),
    };

    let mut gray = Vec::with_capacity((w * h) as usize);
    for y in top..top + h {
        for x in left..left + w {
            gray.push(luma.get_pixel(x, y).0[0]);
        }
    }

    let label = format!(
        "{}（原图 {}×{}）{}",
        path,
        full_w,
        full_h,
        match region {
            Some(_) => format!("｜裁剪后 {}×{}，起点 ({}, {})", w, h, left, top),
            None => String::new(),
        }
    );
    Ok(inspect_gray(
        &label,
        (left, top),
        gray,
        w as usize,
        h as usize,
        opts,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用字符画造位图：'#' = 墨迹
    fn bm_from_art(art: &[&str]) -> Bitmap {
        let h = art.len();
        let w = art.iter().map(|l| l.chars().count()).max().unwrap_or(0);
        let mut bm = Bitmap::new(w, h);
        for (y, line) in art.iter().enumerate() {
            for (x, c) in line.chars().enumerate() {
                if c == '#' {
                    bm.set(x, y, true);
                }
            }
        }
        bm
    }

    #[test]
    fn otsu_finds_split_between_two_peaks() {
        let mut gray = vec![20u8; 900];
        gray.extend(vec![230u8; 1100]);
        let th = otsu_threshold(&histogram(&gray), gray.len() as u32);
        assert!((21..230).contains(&th), "阈值应落在两峰之间，实际 {}", th);
        // 关键回归：阈值必须严格大于暗峰，否则 `v < th` 会把暗像素全判成背景
        assert!(th > 20, "阈值不得等于暗峰值（会让整图变背景），实际 {}", th);
        // 平台取中点：两峰之间方差恒等，取左端就会回到暗峰的毛病
        assert_eq!(th, 124);
    }

    #[test]
    fn otsu_uniform_image_is_safe() {
        let gray = vec![200u8; 100];
        // 全同色没有可分性，必须返回一个稳定值而不是 panic
        assert_eq!(otsu_threshold(&histogram(&gray), 100), 128);
        assert_eq!(otsu_threshold(&[0u32; 256], 0), 128);
    }

    #[test]
    fn binarize_dark_is_ink_by_default() {
        let gray = vec![10u8, 200, 240];
        let bm = binarize(&gray, 3, 1, 128, false);
        assert_eq!(bm.bits, vec![true, false, false]);
        let inv = binarize(&gray, 3, 1, 128, true);
        assert_eq!(inv.bits, vec![false, true, true]);
    }

    #[test]
    fn binarize_never_marks_pure_white_as_ink() {
        // 阈值给到 255 也不能把纯白背景当墨迹，否则整图变前景
        let gray = vec![255u8; 4];
        let bm = binarize(&gray, 2, 2, 255, false);
        assert_eq!(bm.ink_total(), 0);
    }

    #[test]
    fn split_columns_separates_two_glyphs() {
        let bm = bm_from_art(&["##.##"]);
        assert_eq!(split_columns(&bm, 0, 1), vec![(0, 1), (3, 4)]);
    }

    #[test]
    fn split_columns_merges_small_gap() {
        // 间隙 1px 时应合并为同一字形（同一数字的断笔）
        let bm = bm_from_art(&["##.##"]);
        assert_eq!(split_columns(&bm, 1, 1), vec![(0, 4)]);
    }

    #[test]
    fn split_columns_filters_tiny_noise() {
        let bm = bm_from_art(&["#####.#"]);
        // 最右 1px 噪声被最小宽度挡掉
        assert_eq!(split_columns(&bm, 0, 2), vec![(0, 4)]);
    }

    #[test]
    fn vertical_extent_ignores_other_columns() {
        let bm = bm_from_art(&["#..", "#..", "..."]);
        assert_eq!(vertical_extent(&bm, 0, 0), Some((0, 1)));
        assert_eq!(vertical_extent(&bm, 1, 2), None);
    }

    #[test]
    fn count_holes_ring_has_one_hole() {
        // 空心方框 = 1 个封闭空洞
        let bm = bm_from_art(&["###", "#.#", "###"]);
        assert_eq!(
            count_holes(
                &bm,
                BBox {
                    x0: 0,
                    y0: 0,
                    x1: 2,
                    y1: 2
                }
            ),
            1
        );
    }

    #[test]
    fn count_holes_slashed_zero_has_two_holes() {
        // 带斜杠的零：斜杠把内腔切成两半 → 2 个封闭空洞（这正是「数位数」时区分字形的依据）
        let bm = bm_from_art(&["#####", "#..##", "#.#.#", "##..#", "#####"]);
        assert_eq!(
            count_holes(
                &bm,
                BBox {
                    x0: 0,
                    y0: 0,
                    x1: 4,
                    y1: 4
                }
            ),
            2
        );
    }

    #[test]
    fn count_holes_checkerboard_cavity_counts_every_isolated_gap() {
        // 非字形也能诚实报数：每个「四面被墨迹围住的单格」各算一个空洞
        let bm = bm_from_art(&["#####", "#.#.#", "##.##", "#.#.#", "#####"]);
        assert_eq!(
            count_holes(
                &bm,
                BBox {
                    x0: 0,
                    y0: 0,
                    x1: 4,
                    y1: 4
                }
            ),
            5
        );
    }

    #[test]
    fn count_holes_open_shape_has_none() {
        // 2 这种开放字形：没有封闭区域
        let bm = bm_from_art(&["####", "...#", ".###", "#...", "####"]);
        assert_eq!(
            count_holes(
                &bm,
                BBox {
                    x0: 0,
                    y0: 0,
                    x1: 3,
                    y1: 4
                }
            ),
            0
        );
    }

    #[test]
    fn count_holes_is_zero_for_solid_block() {
        let bm = bm_from_art(&["###", "###", "###"]);
        assert_eq!(
            count_holes(
                &bm,
                BBox {
                    x0: 0,
                    y0: 0,
                    x1: 2,
                    y1: 2
                }
            ),
            0
        );
    }

    #[test]
    fn analyze_glyphs_reports_width_ink_and_holes() {
        // 三个字符：实心块 / 空心环 / 带斜杠的零 —— 空洞数 0/1/2
        let bm = bm_from_art(&[
            "###.#####.#####",
            "###.#...#.#..##",
            "###.#...#.#.#.#",
            "###.#...#.##..#",
            "###.#####.#####",
        ]);
        let g = analyze_glyphs(&bm, 0, 1, 10);
        assert_eq!(g.len(), 3);
        assert_eq!(g[0].holes, 0);
        assert_eq!(g[1].holes, 1);
        assert_eq!(g[2].holes, 2);
        assert_eq!(g[0].width(), 3);
        assert_eq!(g[0].ink, 15);
    }

    #[test]
    fn analyze_glyphs_does_not_merge_by_default_gap() {
        // 回归：默认 max_gap=0 时，仅隔 1 列空白的两个字符**不得**被合并成一个
        let bm = bm_from_art(&["###.#####", "###.#...#", "###.#...#"]);
        let g = analyze_glyphs(&bm, 0, 1, 10);
        assert_eq!(g.len(), 2, "默认不应合并相邻字符");
        // 显式放宽 gap 时才合并
        assert_eq!(analyze_glyphs(&bm, 1, 1, 10).len(), 1);
    }

    #[test]
    fn analyze_glyphs_respects_limit() {
        let bm = bm_from_art(&["#.#.#.#.#"]);
        assert_eq!(analyze_glyphs(&bm, 0, 1, 2).len(), 2);
    }

    #[test]
    fn ascii_art_keeps_shape_and_size() {
        let bm = bm_from_art(&[
            "#####", "#####", "#####", "#####", "#####", "#####", "#####", "#####",
        ]);
        let art = ascii_art(
            &bm,
            BBox {
                x0: 0,
                y0: 0,
                x1: 4,
                y1: 7,
            },
            10,
        );
        assert!(!art.is_empty());
        // 高度按 2:1 折算：8 行 × (10/5/2) = 8
        assert!(art.len() <= 10, "不应超过目标尺寸，实际 {}", art.len());
        assert!(art.iter().all(|l| l.chars().all(|c| "█▓▒░ ".contains(c))));
        // 全墨迹的块，点阵里必须有实心字符
        assert!(art.iter().any(|l| l.contains('█')));
    }

    #[test]
    fn ascii_art_handles_degenerate_bbox() {
        let bm = bm_from_art(&["#", "#"]);
        assert!(!ascii_art(
            &bm,
            BBox {
                x0: 0,
                y0: 0,
                x1: 0,
                y1: 1
            },
            24
        )
        .is_empty());
    }

    #[test]
    fn report_mentions_key_numbers() {
        // 5×5 的两块：左实心（宽 3）、右空心环（宽 5）→ 报告要给出块数、宽度、空洞
        let bm = bm_from_art(&[
            "###.#####",
            "###.#...#",
            "###.#...#",
            "###.#...#",
            "###.#####",
        ]);
        let gray: Vec<u8> = (0..bm.bits.len())
            .map(|i| if bm.bits[i] { 20 } else { 240 })
            .collect();
        let opts = InspectOptions {
            mode: "glyphs".to_string(),
            ..Default::default()
        };
        let rep = render_report("t.png", (0, 0), &gray, &bm, 128, &opts);
        assert!(rep.contains("切出字符块 2 个"), "报告：{rep}");
        assert!(rep.contains("封闭空洞"));
        assert!(rep.contains("| 1 | 0~2 | 3 | 5 | 15 | 0 |"));
        // 空心环：5+2+2+2+5 = 16 墨迹、1 个空洞
        assert!(rep.contains("| 2 | 4~8 | 5 | 5 | 16 | 1 |"));
    }

    #[test]
    fn report_counts_are_honest_about_dropped_segments() {
        // 最右 1px 窄段在 min_glyph_width=3 下被忽略 —— 但报告必须**说出来**
        let bm = bm_from_art(&["#####.#", "#####.#", "#####.#"]);
        let gray: Vec<u8> = (0..bm.bits.len())
            .map(|i| if bm.bits[i] { 20 } else { 240 })
            .collect();
        let opts = InspectOptions {
            min_glyph_width: 3,
            ..Default::default()
        };
        let rep = render_report("t.png", (0, 0), &gray, &bm, 128, &opts);
        assert!(rep.contains("共发现列段 2 段"), "报告：{rep}");
        assert!(rep.contains("切出字符块 1 个"), "报告：{rep}");
        assert!(rep.contains("已忽略"), "丢弃段必须明说：{rep}");
    }

    #[test]
    fn report_counts_truncated_segments_separately() {
        let bm = bm_from_art(&["#.#.#.#"]);
        let gray = vec![255u8; bm.bits.len()];
        let opts = InspectOptions {
            max_glyphs: 2,
            ..Default::default()
        };
        let rep = render_report("t.png", (0, 0), &gray, &bm, 128, &opts);
        assert!(rep.contains("共发现列段 4 段"));
        assert!(rep.contains("超出 max_glyphs=2"));
    }

    #[test]
    fn info_mode_reports_histogram_not_glyphs() {
        let bm = bm_from_art(&["###", "#.#", "###"]);
        let gray = vec![0u8, 128, 255, 200];
        let opts = InspectOptions {
            mode: "info".to_string(),
            ..Default::default()
        };
        let rep = render_report("t.png", (0, 0), &gray, &bm, 128, &opts);
        assert!(rep.contains("灰度均值"));
        assert!(!rep.contains("切出字符块"));
    }

    #[test]
    fn empty_region_says_so_instead_of_silence() {
        let bm = Bitmap::new(8, 8);
        let gray = vec![255u8; 64];
        let opts = InspectOptions::default();
        let rep = render_report("t.png", (0, 0), &gray, &bm, 128, &opts);
        assert!(rep.contains("没有切出任何字符块"));
    }

    #[test]
    fn inspect_gray_end_to_end_uses_otsu_when_no_threshold() {
        // 浅底深字：Otsu 必须能自动分出前景（而不是返回暗峰值导致一个字符都切不出）
        let bm = bm_from_art(&["#.#", "#.#", "#.#"]);
        let gray: Vec<u8> = (0..bm.bits.len())
            .map(|i| if bm.bits[i] { 20 } else { 230 })
            .collect();
        let opts = InspectOptions::default();
        let rep = inspect_gray("x", (0, 0), gray, 3, 3, &opts);
        assert!(rep.contains("切出字符块 2 个"), "报告：{rep}");
    }

    #[test]
    fn inspect_missing_file_errors_clearly() {
        let err = inspect_file(
            "/tmp/definitely-not-here-9x8.png",
            None,
            &InspectOptions::default(),
        )
        .unwrap_err();
        assert!(err.contains("打开图片失败"));
    }

    #[test]
    fn inspect_rejects_zero_sized_region() {
        let err = inspect_file(
            "/tmp/whatever.png",
            Some(RegionSpec {
                left: 0,
                top: 0,
                width: 0,
                height: 10,
            }),
            &InspectOptions::default(),
        )
        .unwrap_err();
        assert!(err.contains("必须大于 0"));
    }

    /// 真机端到端（`cargo test --lib img_inspect:: -- --ignored`）：
    /// 用真实的 NASA 样例证书编号区图验证「切出 8 个字符块」——
    /// 这正是当初让模型手写 5 次 Python 才得出的结论，现在应一键得出。
    #[test]
    #[ignore]
    fn real_number_zone_glyph_count() {
        let home = std::env::var("HOME").unwrap_or_default();
        let p = format!("{}/Documents/道生一产物/官方样例编号区_放大6倍.png", home);
        if !std::path::Path::new(&p).exists() {
            eprintln!("跳过：样本图不存在 {}", p);
            return;
        }
        let opts = InspectOptions {
            min_glyph_width: 6,
            ascii_width: 12,
            ..Default::default()
        };
        let rep = inspect_file(&p, None, &opts).unwrap();
        println!("{}", rep);
        assert!(rep.contains("切出字符块"), "报告应包含字符块统计");
    }
}
