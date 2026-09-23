//! macOS Vision 原生视觉层（`vision_inspect` / `image_similarity`）。
//!
//! 命名说明：与 `pick_vision_backend`（本地 VLM 后端选择：ollama / llamacpp）**不是一回事**——
//! 那些是「用哪个模型看懂图」，这里是「系统框架直接算出图里有什么、在哪」。
//!
//! 定位（对齐 `docs/VOICE_VIDEO_INPUT_PLAN.md` 的三层视觉栈）：
//! - 第 ① 层「确定性像素/几何」已有 `img_inspect`（切字符、空洞、点阵）；
//! - **第 ② 层就是本模块**：系统框架自带的检测能力——图像分类 / 人脸 / 人体 / 人体姿势 /
//!   动物 / 条码二维码 / 视觉显著区域。**零模型下载、完全离线、毫秒级**，也不依赖
//!   ONNX Runtime（本机 x86_64-apple-darwin 无预编译包，Rust 侧 ONNX 路线不可走）；
//! - 第 ③ 层是本地 VLM（`describe_image`）：慢（本机实测 30~120 秒）且会幻觉，
//!   所以只在第 ② 层给出「看哪儿」之后，**按需裁剪**喂给它，而不是整图硬看。
//!
//! 分工原则：**数量/位置/是否存在**这类可判定问题走系统框架（算出来的）；
//! 语义描述才交给 VLM。报告里的像素框与 `image_inspect` 的 `region` 参数同一坐标系
//! （左上原点像素），可以直接串起来用。
//!
//! 本模块只有纯函数：解析侧车 JSON → 结构化报告 → 人类/模型可读文本。跑进程在 `lib.rs`。
//!
//! 踩坑记录（本机实测）：macOS 的 ML 运行时会在 **stdout** 上混入
//! `E5RT encountered an STL exception. msg = Error building plan: …` 这类警告，
//! 直接 `json.load` 会失败（`Expecting value: line 1 column 1`）。所以侧车输出带
//! 哨兵前缀 [`JSON_SENTINEL`]，解析时从哨兵处取；老二进制/无哨兵时用候选位置回退。

use serde::{Deserialize, Serialize};

/// 侧车 JSON 输出的哨兵前缀（用于在 stdout 噪声中定位 JSON）
pub const JSON_SENTINEL: &str = "VISION_JSON";
/// 分类标签保留上限（噪声太大的列表反而干扰判断）
pub const MAX_LABELS: usize = 8;
/// 低于该置信度的分类标签直接丢弃
pub const MIN_LABEL_CONFIDENCE: f64 = 0.1;
/// 显著区域最多保留几处
pub const MAX_SALIENT: usize = 3;
/// notes 最多保留几条
pub const MAX_NOTES: usize = 8;

/// 像素框（**左上原点**，与 `image_inspect` 的 region 参数同一坐标系）
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct PixelBox {
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub height: i64,
}

impl PixelBox {
    /// 面积（像素²）：裁剪/去重时用来挑「最值得看的那块」
    pub fn area(&self) -> i64 {
        self.width.max(0).saturating_mul(self.height.max(0))
    }

    /// 可直接粘进 `image_inspect` 的 region 参数
    pub fn region_json(&self) -> String {
        format!(
            "{{\"left\":{},\"top\":{},\"width\":{},\"height\":{}}}",
            self.left, self.top, self.width, self.height
        )
    }

    fn text(&self) -> String {
        format!(
            "left={} top={} width={} height={}",
            self.left, self.top, self.width, self.height
        )
    }
}

/// 分类标签
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct LabelHit {
    pub id: String,
    pub confidence: f64,
}

/// 带框的检测结果（人脸/人体/姿势/动物共用）
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct BoxHit {
    /// 侧车字段名是 `box`，`box` 在 Rust 里是保留关键字
    #[serde(rename = "box")]
    pub bbox: PixelBox,
    pub confidence: f64,
    /// 动物识别才有类别名（人脸/人体/姿势没有）
    pub id: Option<String>,
    /// 人体姿势才有：置信度 >0.3 的关节数
    pub joints: Option<u32>,
}

/// 条码/二维码
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct BarcodeHit {
    pub symbology: String,
    pub payload: Option<String>,
    #[serde(rename = "box")]
    pub bbox: PixelBox,
}

/// 侧车 `--vision` 的完整报告
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct VisionReport {
    pub ok: bool,
    pub error: Option<String>,
    pub path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub labels: Vec<LabelHit>,
    pub faces: Vec<BoxHit>,
    pub humans: Vec<BoxHit>,
    pub poses: Vec<BoxHit>,
    pub animals: Vec<BoxHit>,
    pub barcodes: Vec<BarcodeHit>,
    pub salient: Vec<PixelBox>,
    pub notes: Vec<String>,
}

/// 侧车 `--similarity` 的输出（只关心 ok/error/distance）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SimilarityReport {
    pub ok: bool,
    pub error: Option<String>,
    pub distance: f64,
}

/// 从侧车输出里切出 JSON。两层防护：
/// ① 优先哨兵（`VISION_JSON` 之后的内容）—— 挡 stdout 上的 ML 运行时警告；
/// ② 无哨兵时（老二进制/别的实现）从每个 `{` 起试解析，取第一个「像报告」的（含 `ok` 字段）。
fn extract_json(raw: &str) -> Option<&str> {
    if let Some(pos) = raw.rfind(JSON_SENTINEL) {
        let tail = raw[pos + JSON_SENTINEL.len()..].trim();
        if tail.starts_with('{') && tail.ends_with('}') {
            return Some(tail);
        }
    }
    let end = raw.rfind('}')?;
    raw.match_indices('{')
        .map(|(i, _)| i)
        .filter(|&i| i < end)
        .map(|i| &raw[i..=end])
        .find(|cand| {
            serde_json::from_str::<serde_json::Value>(cand)
                .map(|v| v.get("ok").is_some())
                .unwrap_or(false)
        })
}

/// 出错时把原始输出截一段带上，便于定位（不把整段噪声塞进错误信息）
fn preview(raw: &str) -> String {
    let one_line: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut s: String = one_line.chars().take(200).collect();
    if one_line.chars().count() > 200 {
        s.push('…');
    }
    s
}

fn clean_confidence(c: f64) -> f64 {
    if c.is_nan() {
        0.0
    } else {
        c.clamp(0.0, 1.0)
    }
}

fn clean_box(b: &mut PixelBox) {
    b.left = b.left.max(0);
    b.top = b.top.max(0);
    b.width = b.width.max(1);
    b.height = b.height.max(1);
}

/// 按置信度降序（NaN 已在清洗阶段消掉，不会再出现不可比较的情况）
fn sort_by_confidence(hits: &mut [BoxHit]) {
    hits.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
}

/// 规范化：清洗越界值、去重、排序、截断、丢掉落在图外的框。
/// 目的：让模型看到的是**可直接使用**的框与标签，而不是原始噪声。
fn normalize(r: &mut VisionReport) {
    // 分类：去空白 → 清洗置信度 → 丢掉空 id/低分 → 同 id 保留最高分 → 降序 → 截断
    let mut labels: Vec<LabelHit> = Vec::new();
    for mut l in std::mem::take(&mut r.labels) {
        l.id = l.id.trim().to_string();
        l.confidence = clean_confidence(l.confidence);
        if l.id.is_empty() || l.confidence < MIN_LABEL_CONFIDENCE {
            continue;
        }
        match labels
            .iter_mut()
            .find(|x| x.id.eq_ignore_ascii_case(l.id.as_str()))
        {
            Some(prev) => prev.confidence = prev.confidence.max(l.confidence),
            None => labels.push(l),
        }
    }
    labels.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    labels.truncate(MAX_LABELS);
    r.labels = labels;

    // 检测框：清洗 → 丢图外 → 降序
    let (w, h) = (r.width as i64, r.height as i64);
    for group in [&mut r.faces, &mut r.humans, &mut r.poses, &mut r.animals] {
        for hit in group.iter_mut() {
            hit.confidence = clean_confidence(hit.confidence);
            clean_box(&mut hit.bbox);
        }
        group.retain(|hit| {
            hit.bbox.left < w
                && hit.bbox.top < h
                && hit
                    .id
                    .as_deref()
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(true)
        });
        sort_by_confidence(group);
    }

    // 条码：清洗 → 丢空类型/图外 → 按 (类型, 内容) 去重（同一条码可能被重复上报）
    let mut barcodes: Vec<BarcodeHit> = Vec::new();
    for mut b in std::mem::take(&mut r.barcodes) {
        b.symbology = b.symbology.trim().to_string();
        clean_box(&mut b.bbox);
        if b.symbology.is_empty() || b.bbox.left >= w || b.bbox.top >= h {
            continue;
        }
        b.payload = b.payload.map(|p| p.trim().to_string());
        let dup = barcodes
            .iter()
            .any(|x| x.symbology == b.symbology && x.payload.as_deref() == b.payload.as_deref());
        if !dup {
            barcodes.push(b);
        }
    }
    r.barcodes = barcodes;

    // 显著区域：清洗 → 丢图外 → 按面积降序（先看最大的那块）→ 截断
    let mut salient: Vec<PixelBox> = std::mem::take(&mut r.salient)
        .into_iter()
        .map(|mut b| {
            clean_box(&mut b);
            b
        })
        .filter(|b| b.left < w && b.top < h)
        .collect();
    salient.sort_by_key(|b| std::cmp::Reverse(b.area()));
    salient.truncate(MAX_SALIENT);
    r.salient = salient;

    // notes：去空白 → 去空串 → 去重 → 截断
    let mut notes: Vec<String> = Vec::new();
    for n in std::mem::take(&mut r.notes) {
        let n = n.trim().to_string();
        if n.is_empty() || notes.contains(&n) {
            continue;
        }
        notes.push(n);
    }
    notes.truncate(MAX_NOTES);
    r.notes = notes;
}

/// 解析 `--vision` 报告。`ok:false`、无 JSON、尺寸为 0 都返回**明确错误**，
/// 绝不返回「空报告」让调用方误以为「图里什么都没有」。
pub fn parse_vision_report(raw: &str) -> Result<VisionReport, String> {
    let json = extract_json(raw)
        .ok_or_else(|| format!("视觉工具未返回 JSON（原始输出：{}）", preview(raw)))?;
    let mut report: VisionReport = serde_json::from_str(json)
        .map_err(|e| format!("视觉报告解析失败：{}（原始输出：{}）", e, preview(raw)))?;
    if !report.ok {
        let msg = report
            .error
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("视觉工具报告失败但未给出原因");
        return Err(format!("视觉检查失败：{}", msg));
    }
    if report.width == 0 || report.height == 0 {
        return Err("视觉报告尺寸为 0（图片可能已损坏）".to_string());
    }
    normalize(&mut report);
    Ok(report)
}

/// 解析 `--similarity` 距离
pub fn parse_similarity(raw: &str) -> Result<f64, String> {
    let json = extract_json(raw)
        .ok_or_else(|| format!("相似度工具未返回 JSON（原始输出：{}）", preview(raw)))?;
    let report: SimilarityReport = serde_json::from_str(json)
        .map_err(|e| format!("相似度结果解析失败：{}（原始输出：{}）", e, preview(raw)))?;
    if !report.ok {
        let msg = report
            .error
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("特征距离计算失败但未给出原因");
        return Err(format!("图像相似度计算失败：{}", msg));
    }
    if !report.distance.is_finite() {
        return Err("特征距离不是有限数（工具输出异常）".to_string());
    }
    Ok(report.distance)
}

fn boxes_block(title: &str, hits: &[BoxHit]) -> String {
    if hits.is_empty() {
        return format!("【{}】未检出\n", title);
    }
    let items: Vec<String> = hits
        .iter()
        .map(|hit| {
            let name = hit
                .id
                .as_deref()
                .map(|id| format!("{id} "))
                .unwrap_or_default();
            let joints = hit
                .joints
                .map(|j| format!("关节 {j} 个 "))
                .unwrap_or_default();
            format!(
                "[{}]{}{}(置信 {:.2})",
                hit.bbox.text(),
                name,
                joints,
                hit.confidence
            )
        })
        .collect();
    format!("【{}】{} 个：{}\n", title, hits.len(), items.join(" ｜ "))
}

/// 把报告排成「模型能直接引用」的文本：数量、像素框、可执行的下一步，缺一不可。
pub fn format_vision_report(r: &VisionReport) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "【图片】{}  {}×{} px\n",
        r.path.as_deref().unwrap_or("（未提供路径）"),
        r.width,
        r.height
    ));
    out.push_str(&format!(
        "【检测汇总】分类 {} 项 · 人脸 {} · 人体 {} · 姿势 {} · 动物 {} · 条码 {} · 显著区域 {}\n",
        r.labels.len(),
        r.faces.len(),
        r.humans.len(),
        r.poses.len(),
        r.animals.len(),
        r.barcodes.len(),
        r.salient.len()
    ));

    if r.labels.is_empty() {
        out.push_str("【分类】无置信度 ≥0.1 的类别\n");
    } else {
        let items: Vec<String> = r
            .labels
            .iter()
            .map(|l| format!("{} {:.3}", l.id, l.confidence))
            .collect();
        out.push_str(&format!("【分类】{}\n", items.join(" ｜ ")));
    }

    out.push_str(&boxes_block("人脸", &r.faces));
    out.push_str(&boxes_block("人体", &r.humans));
    out.push_str(&boxes_block("姿势", &r.poses));
    out.push_str(&boxes_block("动物", &r.animals));

    if r.barcodes.is_empty() {
        out.push_str("【条码】未检出\n");
    } else {
        let items: Vec<String> = r
            .barcodes
            .iter()
            .map(|b| {
                format!(
                    "{}：{} [{}]",
                    b.symbology,
                    b.payload.as_deref().unwrap_or("（无内容串）"),
                    b.bbox.text()
                )
            })
            .collect();
        out.push_str(&format!("【条码】{}\n", items.join(" ｜ ")));
    }

    if r.salient.is_empty() {
        out.push_str("【显著区域】未检出\n");
    } else {
        let items: Vec<String> = r.salient.iter().map(PixelBox::text).collect();
        out.push_str(&format!("【显著区域】{}\n", items.join(" ｜ ")));
    }

    // 「看哪儿」直接给成可执行的下一步（借鉴 ocr-advice：结论之外必须给下一步）
    if let Some(b) = r
        .salient
        .first()
        .or_else(|| r.faces.first().map(|f| &f.bbox))
    {
        out.push_str(&format!(
            "【怎么用】上面的像素框可直接裁剪复用：`image_inspect` 传 region={} 做像素级核验；\
             需要语义描述时先裁出该区域再交 `describe_image`（只让本地 VLM 看局部，比整图更快也更少编）。\n",
            b.region_json()
        ));
    }

    out.push_str(
        "【注意】检测不到 ≠ 不存在：这些结果来自 Apple 内置模型，小目标/极端角度/低对比会漏检；\
         涉及数量、位数这类结论请再用 `image_inspect` 做像素核验交叉验证。\n",
    );

    if !r.notes.is_empty() {
        out.push_str(&format!("【说明】{}\n", r.notes.join("；")));
    }
    out
}

/// 特征距离的可读解读。
/// **阈值只是经验值、尚未用本机素材标定**——所以这里只给量级提示，
/// 供视频关键帧去重时人工确认后再定阈值，不假装是硬判定。
pub fn format_similarity(distance: f64, path_a: &str, path_b: &str) -> String {
    let hint = if distance < 0.3 {
        "同场景/近似同帧"
    } else if distance < 0.6 {
        "同题材但画面有变化"
    } else {
        "基本是不同画面"
    };
    format!(
        "【特征指纹距离】{:.3}（0=几乎相同，越大越不同）\n\
         【对比】A：{}\n       B：{}\n\
         【判读】量级上像「{}」。**阈值仅为经验值、尚未用本机素材标定**：\
         做视频关键帧去重前应先用真实素材标定，不要直接当硬判定。\n",
        distance, path_a, path_b, hint
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机真实观测到的噪声前缀（不是编的）：直接 json.load 会 Expecting value
    const REAL_NOISE: &str = "E5RT encountered an STL exception. msg = Error building plan: \
                              Espresso exception: \"Network translation error\": \
                              Weights are not set for given kernel..";

    fn report_json(body: &str) -> String {
        format!("{JSON_SENTINEL} {}", body)
    }

    #[test]
    fn parse_minimal_report_keeps_size_and_labels() {
        let raw = report_json(
            r#"{"ok":true,"path":"/tmp/a.png","width":800,"height":600,
                "labels":[{"id":"screenshot","confidence":0.941}]}"#,
        );
        let r = parse_vision_report(&raw).unwrap();
        assert_eq!((r.width, r.height), (800, 600));
        assert_eq!(r.path.as_deref(), Some("/tmp/a.png"));
        assert_eq!(r.labels.len(), 1);
        assert_eq!(r.labels[0].id, "screenshot");
        assert!((r.labels[0].confidence - 0.941).abs() < 1e-6);
        // 缺失的字段全部按空处理，不 panic、不报错
        assert!(r.faces.is_empty() && r.barcodes.is_empty() && r.notes.is_empty());
    }

    #[test]
    fn parse_survives_real_apple_ml_noise_on_stdout() {
        // 回归测试：实测 macOS 会在 stdout 混入 ML 运行时警告（曾让 python json.load 直接失败）
        let raw = format!(
            "{REAL_NOISE}{{\"ok\":true,\"width\":2560,\"height\":1640,\
             \"labels\":[{{\"id\":\"document\",\"confidence\":0.878}}]}}"
        );
        let r = parse_vision_report(&raw).unwrap();
        assert_eq!(r.width, 2560);
        assert_eq!(r.labels.len(), 1);
    }

    #[test]
    fn parse_falls_back_to_candidate_scan_without_sentinel() {
        // 老二进制/别的实现没带哨兵：从 `{` 起试解析，噪声里出现花括号也不会中招
        let raw = "warning {not json} and more noise {\"ok\":true,\"width\":10,\"height\":20}";
        let r = parse_vision_report(raw).unwrap();
        assert_eq!((r.width, r.height), (10, 20));
    }

    #[test]
    fn parse_rejects_output_without_json() {
        let err = parse_vision_report("E5RT encountered an STL exception.").unwrap_err();
        assert!(
            err.contains("未返回 JSON"),
            "错误信息应说明拿不到 JSON：{err}"
        );
    }

    #[test]
    fn parse_surfaces_tool_declared_failure() {
        let err = parse_vision_report(&report_json(
            r#"{"ok":false,"error":"文件不存在：/tmp/x.png"}"#,
        ))
        .unwrap_err();
        assert!(err.contains("文件不存在"), "应转述工具给出的原因：{err}");
        // 工具没给原因时也不能返回空错误
        let vague = parse_vision_report(&report_json(r#"{"ok":false}"#)).unwrap_err();
        assert!(vague.contains("未给出原因"), "应给出兜底说明：{vague}");
    }

    #[test]
    fn parse_rejects_zero_sized_image() {
        let err =
            parse_vision_report(&report_json(r#"{"ok":true,"width":0,"height":10}"#)).unwrap_err();
        assert!(err.contains("尺寸为 0"), "应明确报尺寸异常：{err}");
    }

    #[test]
    fn parse_drops_low_confidence_and_blank_labels_then_sorts() {
        let raw = report_json(
            r#"{"ok":true,"width":10,"height":10,"labels":[
                {"id":"screenshot","confidence":0.4},
                {"id":"  ","confidence":0.9},
                {"id":"noise","confidence":0.05},
                {"id":"document","confidence":0.88}]}"#,
        );
        let r = parse_vision_report(&raw).unwrap();
        let ids: Vec<&str> = r.labels.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, vec!["document", "screenshot"], "降序且丢掉低分/空 id");
    }

    #[test]
    fn parse_dedupes_labels_and_clamps_confidence() {
        let raw = report_json(
            r#"{"ok":true,"width":10,"height":10,"labels":[
                {"id":"Screenshot","confidence":1.7},
                {"id":"screenshot","confidence":0.5}]}"#,
        );
        let r = parse_vision_report(&raw).unwrap();
        assert_eq!(r.labels.len(), 1, "同 id 只留一条");
        assert!(
            (r.labels[0].confidence - 1.0).abs() < 1e-9,
            "置信度必须夹到 0~1"
        );
    }

    #[test]
    fn parse_truncates_label_explosion() {
        let labels: Vec<String> = (0..30)
            .map(|i| format!("{{\"id\":\"l{i}\",\"confidence\":0.9}}"))
            .collect();
        let raw = report_json(&format!(
            "{{\"ok\":true,\"width\":10,\"height\":10,\"labels\":[{}]}}",
            labels.join(",")
        ));
        let r = parse_vision_report(&raw).unwrap();
        assert_eq!(r.labels.len(), MAX_LABELS);
    }

    #[test]
    fn parse_cleans_boxes_and_drops_out_of_image() {
        let raw = report_json(
            r#"{"ok":true,"width":100,"height":50,
                "faces":[{"box":{"left":-5,"top":-3,"width":0,"height":20},"confidence":0.9},
                         {"box":{"left":200,"top":10,"width":30,"height":30},"confidence":0.8}],
                "poses":[{"box":{"left":1,"top":2,"width":3,"height":4},"confidence":0.7,"joints":14}]}"#,
        );
        let r = parse_vision_report(&raw).unwrap();
        assert_eq!(r.faces.len(), 1, "完全在图外的框要丢掉");
        assert_eq!(r.faces[0].bbox.left, 0, "负坐标夹到 0");
        assert_eq!(r.faces[0].bbox.width, 1, "零宽至少算 1 像素，避免除零");
        assert_eq!(r.poses[0].joints, Some(14));
    }

    #[test]
    fn parse_sorts_salient_by_area_and_keeps_top_three() {
        let raw = report_json(
            r#"{"ok":true,"width":100,"height":100,"salient":[
                {"left":0,"top":0,"width":10,"height":10},
                {"left":0,"top":0,"width":50,"height":50},
                {"left":0,"top":0,"width":30,"height":30},
                {"left":0,"top":0,"width":20,"height":20}]}"#,
        );
        let r = parse_vision_report(&raw).unwrap();
        assert_eq!(r.salient.len(), MAX_SALIENT);
        assert_eq!(r.salient[0].area(), 2500, "面积最大的排最前");
    }

    #[test]
    fn parse_dedupes_barcodes_and_notes() {
        let raw = report_json(
            r#"{"ok":true,"width":100,"height":100,
                "barcodes":[{"symbology":"QR","payload":"https://a","box":{"left":1,"top":1,"width":5,"height":5}},
                            {"symbology":"QR","payload":"https://a","box":{"left":1,"top":1,"width":5,"height":5}},
                            {"symbology":"   ","payload":"x","box":{"left":1,"top":1,"width":5,"height":5}}],
                "notes":["  动物识别失败：x  ","动物识别失败：x",""]}"#,
        );
        let r = parse_vision_report(&raw).unwrap();
        assert_eq!(r.barcodes.len(), 1, "同类型同内容的条码只留一条");
        assert_eq!(r.notes, vec!["动物识别失败：x"]);
    }

    #[test]
    fn format_marks_empty_detections_explicitly() {
        let raw = report_json(r#"{"ok":true,"path":"/tmp/a.png","width":800,"height":600}"#);
        let text = format_vision_report(&parse_vision_report(&raw).unwrap());
        assert!(text.contains("800×600"), "要给出尺寸：{text}");
        assert!(
            text.contains("【人脸】未检出"),
            "空结果必须显式写出来：{text}"
        );
        assert!(text.contains("【条码】未检出"));
        assert!(text.contains("检测不到 ≠ 不存在"), "必须带漏检免责说明");
        // 没有任何位置信息时不该硬凑「怎么用」
        assert!(!text.contains("【怎么用】"));
    }

    #[test]
    fn format_gives_actionable_crop_hint_with_pixel_region() {
        let raw = report_json(
            r#"{"ok":true,"path":"/tmp/a.png","width":1000,"height":800,
                "labels":[{"id":"document","confidence":0.94}],
                "faces":[{"box":{"left":10,"top":20,"width":30,"height":40},"confidence":0.99}],
                "salient":[{"left":100,"top":200,"width":300,"height":400}]}"#,
        );
        let text = format_vision_report(&parse_vision_report(&raw).unwrap());
        assert!(text.contains("【分类】document 0.940"), "{text}");
        assert!(text.contains("【人脸】1 个"), "{text}");
        // 显著区域优先作为裁剪建议，且必须给出可直接粘进 image_inspect 的 region
        assert!(
            text.contains("region={\"left\":100,\"top\":200,\"width\":300,\"height\":400}"),
            "应给出可执行的下一步：{text}"
        );
        assert!(text.contains("describe_image"), "应说明裁剪后交给谁");
    }

    #[test]
    fn format_includes_tool_notes() {
        let raw = report_json(
            r#"{"ok":true,"width":10,"height":10,"notes":["动物识别需要 macOS 13+，已跳过"]}"#,
        );
        let text = format_vision_report(&parse_vision_report(&raw).unwrap());
        assert!(text.contains("【说明】动物识别需要 macOS 13+"), "{text}");
    }

    #[test]
    fn parse_similarity_reads_distance_and_reports_failure() {
        let d = parse_similarity(&report_json(
            r#"{"ok":true,"distance":0.568,"pathA":"/a.png","pathB":"/b.png"}"#,
        ))
        .unwrap();
        assert!((d - 0.568).abs() < 1e-9);
        let err = parse_similarity(&report_json(
            r#"{"ok":false,"error":"无法读取图片：/b.png"}"#,
        ))
        .unwrap_err();
        assert!(err.contains("无法读取图片"), "{err}");
    }

    #[test]
    fn format_similarity_does_not_pretend_thresholds_are_calibrated() {
        let text = format_similarity(0.02, "/a.png", "/b.png");
        assert!(text.contains("0.020"));
        assert!(text.contains("同场景"), "{text}");
        assert!(
            text.contains("尚未用本机素材标定"),
            "阈值必须标明未标定：{text}"
        );
    }

    #[test]
    fn extract_json_prefers_sentinel_over_earlier_braces() {
        let raw = "noise { \"stray\": 1 } then VISION_JSON {\"ok\":true,\"width\":1,\"height\":1}";
        assert_eq!(
            extract_json(raw),
            Some(r#"{"ok":true,"width":1,"height":1}"#)
        );
    }

    #[test]
    fn parse_tolerates_unknown_fields_from_future_sidecar() {
        // 侧车以后新增字段不应让旧后端解析失败（前向兼容）
        let raw = report_json(
            r#"{"ok":true,"width":10,"height":10,"futureField":{"a":[1,2]},"text_blocks":[{"x":1}]}"#,
        );
        assert!(parse_vision_report(&raw).is_ok());
    }

    // ---- 真机契约测试：侧车真实输出 ↔ 解析器 ----
    // 为什么必须跑真的：解析器要挡的是「运行期才出现的 stdout 噪声 + Apple 平台差异」，
    // 假数据永远测不出这类问题（本机实测就是被 E5RT 噪声打了一次脸）。
    // 侧车由 build.rs 用 swiftc 编译；若编译不了（缺 swiftc）则跳过——
    // 与本项目「OCR/视觉层可降级」的定位一致。

    #[cfg(target_os = "macos")]
    fn sidecar_and_image() -> Option<(std::path::PathBuf, std::path::PathBuf)> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let tool = root.join("ocr_tool");
        if !tool.exists() {
            eprintln!(
                "跳过真机测试：未找到视觉侧车 {}（需先编译 ocr_tool.swift）",
                tool.display()
            );
            return None;
        }
        let shots = root.join("../docs/assets/screenshots");
        let image = std::fs::read_dir(&shots)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "png").unwrap_or(false))?;
        Some((tool, image))
    }

    #[cfg(target_os = "macos")]
    fn run_sidecar(tool: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new(tool)
            .args(args)
            .output()
            .expect("侧车执行失败");
        assert!(
            out.status.success(),
            "侧车应以 0 退出，实际 {:?}：{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_sidecar_vision_report_matches_parser_contract() {
        let Some((tool, image)) = sidecar_and_image() else {
            return;
        };
        let path = image.to_string_lossy().to_string();
        let raw = run_sidecar(&tool, &["--vision", &path, "--max", "8"]);
        let report = parse_vision_report(&raw).expect("真机报告必须能解析");
        assert!(report.width > 0 && report.height > 0, "应拿到真实尺寸");
        assert!(
            !report.labels.is_empty(),
            "真实截图应有分类标签（这条挂了说明系统分类器行为变了）原始输出：{raw}"
        );
        let text = format_vision_report(&report);
        assert!(
            text.contains("【检测汇总】") && text.contains("【注意】"),
            "{text}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_sidecar_similarity_is_zero_for_identical_images() {
        let Some((tool, image)) = sidecar_and_image() else {
            return;
        };
        let path = image.to_string_lossy().to_string();
        let raw = run_sidecar(&tool, &["--similarity", &path, &path]);
        let distance = parse_similarity(&raw).expect("真机相似度结果必须能解析");
        assert!(
            distance.abs() < 1e-6,
            "同一张图的特征距离必须是 0，实际 {distance}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_sidecar_missing_file_becomes_readable_error() {
        let Some((tool, _)) = sidecar_and_image() else {
            return;
        };
        let out = std::process::Command::new(&tool)
            .args(["--vision", "/tmp/daoshengyi-does-not-exist.png"])
            .output()
            .expect("侧车执行失败");
        assert!(!out.status.success(), "不存在的文件应以非零码结束");
        let raw = String::from_utf8_lossy(&out.stdout).to_string();
        let err = parse_vision_report(&raw).unwrap_err();
        assert!(err.contains("文件不存在"), "应转述侧车给出的原因：{err}");
    }
}
