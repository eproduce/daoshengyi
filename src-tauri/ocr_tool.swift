#!/usr/bin/env swift
// 本地视觉侧车（macOS Vision 框架，全部离线、零模型下载）——三种模式：
//
//   1) OCR（默认，无子命令）：提取图片/PDF 中的文字
//      用法: ocr_tool <image_or_pdf_path> [path ...]
//      输出: 每个文件的识别文字，多文件/多页之间用空行分隔；PDF 每页前带【第 N 页】标记。
//      说明: PDF 用 PDFKit 把每页渲染成图像后再走 Vision OCR（用于扫描版/图片型 PDF，如体检报告）。
//
//   2) --vision <图片> [--max N]：确定性视觉报告（JSON 打 stdout）
//      分类(imageLabels)/人脸/人体/人体姿势关键点/动物/条码二维码/视觉显著区域，均带**像素框**
//      （左上原点，与 image_inspect 的 region 参数同一坐标系）。
//      为什么值得做：这些是系统框架**算出来的**结果，毫秒级、离线、不幻觉；
//      而本地 VLM 描述慢（本机 30~120 秒）且会编。数量/位置/是否存在 → 走这里；语义描述 → 再交给 VLM。
//
//   3) --similarity <图A> <图B>：特征指纹距离（0=几乎相同，越大越不同）——视频关键帧去重的基础。
//
// 注意：使用 VNRecognizeAnimalsRequest 等 API，构建目标需 macOS 13+（CI 即 -target *-apple-macos13.0）。
// 失败时 stdout 仍输出 {"ok":false,"error":"…"} 并以退出码 2 结束，方便调用方区分「无结果」与「执行失败」。
import Foundation
import Vision
import ImageIO
import AppKit
import PDFKit

let args = Array(CommandLine.arguments.dropFirst())
guard !args.isEmpty else { exit(0) }

func ocrImage(_ cg: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([request])
        if let obs = request.results {
            return obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        }
    } catch {}
    return ""
}

func ocrPdf(_ url: URL) -> String {
    guard let doc = PDFDocument(url: url) else { return "" }
    var pages: [String] = []
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        // 约 2.5x 缩放渲染（≈250 DPI），Vision 识别准确率高
        let scale: CGFloat = 2.5
        let size = CGSize(width: max(1, bounds.width * scale),
                          height: max(1, bounds.height * scale))
        let thumb = page.thumbnail(of: size, for: .mediaBox)
        guard let tiff = thumb.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let cg = rep.cgImage else { continue }
        let t = ocrImage(cg)
        pages.append("【第 \(i + 1) 页】\n" + t)
    }
    return pages.joined(separator: "\n\n")
}

// MARK: - 视觉子命令（macOS Vision 原生能力，确定性、离线、零下载）

func round3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }

/// 报告 JSON 的哨兵前缀。
/// 起因（本机实测）：macOS 的 ML 运行时会在 **stdout** 上混入
/// `E5RT encountered an STL exception. msg = Error building plan: ...` 这类警告，
/// 直接把它当 JSON 解析会失败（实测用 python json.load 就报 Expecting value: line 1 column 1）。
/// 故所有 JSON 输出前面带哨兵，调用方从哨兵处定位 JSON。
let jsonSentinel = "VISION_JSON"

/// 统一 JSON 输出（sortedKeys 保证同一输入产出同一字节，便于对照与测试）
func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print("\(jsonSentinel) \(text)")
    } else {
        print("\(jsonSentinel) {\"ok\":false,\"error\":\"无法序列化结果\"}")
    }
}

/// 失败即输出 JSON 错误并以退出码 2 结束（调用方据此报错，而不是把空输出当成功）
func fail(_ message: String) -> Never {
    emit(["ok": false, "error": message])
    exit(2)
}

/// Vision 归一化坐标（左下原点、0~1）→ 像素坐标（**左上原点**）
/// 与 image_inspect 的 region 参数同一坐标系，报告里的框可直接拿去裁剪。
func pixelBox(_ bb: CGRect, _ w: Int, _ h: Int) -> [String: Int] {
    let left = max(0, Int((Double(bb.minX) * Double(w)).rounded()))
    let top = max(0, Int(((1.0 - Double(bb.maxY)) * Double(h)).rounded()))
    let width = max(1, Int((Double(bb.width) * Double(w)).rounded()))
    let height = max(1, Int((Double(bb.height) * Double(h)).rounded()))
    return ["left": left, "top": top, "width": width, "height": height]
}

func loadImage(_ path: String) -> CGImage? {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// 视觉报告：每个请求**独立 try/catch**——某一个能力不可用（老系统/该图不支持）时
/// 其余能力照常返回，失败原因记进 notes，绝不整体失败。
func visionReport(path: String, maxLabels: Int) -> [String: Any] {
    guard let cg = loadImage(path) else {
        return ["ok": false, "error": "无法读取图片：\(path)", "path": path]
    }
    let w = cg.width
    let h = cg.height
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    var notes: [String] = []
    var out: [String: Any] = ["ok": true, "path": path, "width": w, "height": h]

    // ① 图像分类：Apple 内置分类器（千级类别，无需下载任何模型）
    do {
        let req = VNClassifyImageRequest()
        try handler.perform([req])
        let labels = (req.results ?? [])
            .filter { !$0.identifier.trimmingCharacters(in: .whitespaces).isEmpty }
            .filter { $0.confidence >= 0.1 }
            .sorted { $0.confidence > $1.confidence }
            .prefix(maxLabels)
            .map { ["id": $0.identifier, "confidence": round3(Double($0.confidence))] }
        out["labels"] = Array(labels)
    } catch {
        notes.append("图像分类失败：\(error.localizedDescription)")
    }

    // ② 人脸（数量 + 位置）
    do {
        let req = VNDetectFaceRectanglesRequest()
        try handler.perform([req])
        out["faces"] = (req.results ?? []).map {
            ["box": pixelBox($0.boundingBox, w, h), "confidence": round3(Double($0.confidence))]
        }
    } catch {
        notes.append("人脸检测失败：\(error.localizedDescription)")
    }

    // ③ 人体（矩形）
    do {
        let req = VNDetectHumanRectanglesRequest()
        req.upperBodyOnly = false
        try handler.perform([req])
        out["humans"] = (req.results ?? []).map {
            ["box": pixelBox($0.boundingBox, w, h), "confidence": round3(Double($0.confidence))]
        }
    } catch {
        notes.append("人体检测失败：\(error.localizedDescription)")
    }

    // ④ 人体姿势关键点：每人检出多少关节（置信度 >0.3）+ 关节包围盒
    //    「姿势是否像在挥手/举手」这类判断可以靠关节数与位置做确定性核验
    do {
        let req = VNDetectHumanBodyPoseRequest()
        try handler.perform([req])
        var poses: [[String: Any]] = []
        for obs in (req.results ?? []) {
            let pts = (try? obs.recognizedPoints(.all)) ?? [:]
            let strong = pts.values.filter { $0.confidence > 0.3 }
            guard !strong.isEmpty else { continue }
            var minX = 1.0, minY = 1.0, maxX = 0.0, maxY = 0.0
            for p in strong {
                minX = min(minX, Double(p.location.x))
                maxX = max(maxX, Double(p.location.x))
                minY = min(minY, Double(p.location.y))
                maxY = max(maxY, Double(p.location.y))
            }
            let bb = CGRect(x: minX, y: minY,
                            width: max(0.01, maxX - minX), height: max(0.01, maxY - minY))
            poses.append([
                "joints": strong.count,
                "confidence": round3(Double(obs.confidence)),
                "box": pixelBox(bb, w, h),
            ])
        }
        out["poses"] = poses
    } catch {
        notes.append("人体姿势检测失败：\(error.localizedDescription)")
    }

    // ⑤ 动物识别（macOS 13+）
    if #available(macOS 13.0, *) {
        do {
            let req = VNRecognizeAnimalsRequest()
            try handler.perform([req])
            out["animals"] = (req.results ?? []).compactMap { obs -> [String: Any]? in
                guard let top = obs.labels.first else { return nil }
                return [
                    "id": top.identifier,
                    "confidence": round3(Double(top.confidence)),
                    "box": pixelBox(obs.boundingBox, w, h),
                ]
            }
        } catch {
            notes.append("动物识别失败：\(error.localizedDescription)")
        }
    } else {
        notes.append("动物识别需要 macOS 13+，已跳过")
    }

    // ⑥ 条码 / 二维码（含内容字符串）
    do {
        let req = VNDetectBarcodesRequest()
        try handler.perform([req])
        out["barcodes"] = (req.results ?? []).map { obs -> [String: Any] in
            var item: [String: Any] = [
                "symbology": obs.symbology.rawValue,
                "box": pixelBox(obs.boundingBox, w, h),
            ]
            if let payload = obs.payloadStringValue { item["payload"] = payload }
            return item
        }
    } catch {
        notes.append("条码检测失败：\(error.localizedDescription)")
    }

    // ⑦ 视觉显著区域：模型/用户最可能关注的位置，可直接当裁剪框用（grounding）
    do {
        let req = VNGenerateAttentionBasedSaliencyImageRequest()
        try handler.perform([req])
        var boxes: [VNRectangleObservation] = []
        if let first = req.results?.first, let objs = first.salientObjects { boxes = objs }
        out["salient"] = Array(boxes.prefix(3).map { pixelBox($0.boundingBox, w, h) })
    } catch {
        notes.append("显著区域检测失败：\(error.localizedDescription)")
    }

    out["notes"] = notes
    return out
}

/// 特征指纹距离（0=几乎相同）。用于视频抽帧后**去掉重复帧**、只留关键帧。
/// 返回错误原因而不是只返回 nil：在拿不到推理上下文的环境（如无 GPU 的虚拟机）里，
/// 「图片格式不支持」是错误归因，会把人引到错方向。
func featurePrint(_ cg: CGImage) -> (VNFeaturePrintObservation?, String?) {
    let req = VNGenerateImageFeaturePrintRequest()
    do {
        try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
    } catch {
        return (nil, error.localizedDescription)
    }
    guard let obs = req.results?.first else { return (nil, "系统未返回特征指纹") }
    return (obs, nil)
}

func similarityReport(_ aPath: String, _ bPath: String) -> [String: Any] {
    guard let a = loadImage(aPath) else { return ["ok": false, "error": "无法读取图片：\(aPath)"] }
    guard let b = loadImage(bPath) else { return ["ok": false, "error": "无法读取图片：\(bPath)"] }
    let (fa, errA) = featurePrint(a)
    let (fb, errB) = featurePrint(b)
    guard let fa, let fb else {
        let reason = errA ?? errB ?? "未知原因"
        return ["ok": false, "error": "特征指纹提取失败：\(reason)"]
    }
    var distance: Float = 0
    do {
        try fa.computeDistance(&distance, to: fb)
    } catch {
        return ["ok": false, "error": "距离计算失败：\(error.localizedDescription)"]
    }
    return ["ok": true, "distance": round3(Double(distance)), "pathA": aPath, "pathB": bPath]
}

func runSubcommand(_ mode: String, _ argv: [String]) {
    switch mode {
    case "--vision":
        var path: String?
        var maxLabels = 8
        var i = 0
        while i < argv.count {
            if argv[i] == "--max", i + 1 < argv.count {
                maxLabels = max(1, min(32, Int(argv[i + 1]) ?? 8))
                i += 2
            } else if argv[i].hasPrefix("--") {
                fail("未知参数：\(argv[i])")
            } else {
                path = argv[i]
                i += 1
            }
        }
        guard let target = path else { fail("用法：ocr_tool --vision <图片路径> [--max 8]") }
        guard FileManager.default.fileExists(atPath: target) else {
            fail("文件不存在：\(target)")
        }
        let report = visionReport(path: target, maxLabels: maxLabels)
        emit(report)
        if report["ok"] as? Bool != true { exit(2) }
    case "--similarity":
        let files = argv.filter { !$0.hasPrefix("--") }
        guard files.count >= 2 else { fail("用法：ocr_tool --similarity <图A> <图B>") }
        for f in files.prefix(2) where !FileManager.default.fileExists(atPath: f) {
            fail("文件不存在：\(f)")
        }
        let report = similarityReport(files[0], files[1])
        emit(report)
        if report["ok"] as? Bool != true { exit(2) }
    default:
        fail("未知子命令：\(mode)（支持 --vision / --similarity；不带子命令时按 OCR 模式处理文件路径）")
    }
}

// 模式分派：首参以 `--` 开头视为子命令；否则保持原有「参数全是文件路径」的 OCR 行为（向后兼容）
if let mode = args.first, mode.hasPrefix("--") {
    runSubcommand(mode, Array(args.dropFirst()))
    exit(0)
}

var allText: [String] = []
for path in args {
    let url = URL(fileURLWithPath: path)
    if url.pathExtension.lowercased() == "pdf" {
        allText.append(ocrPdf(url))
    } else if let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) {
        allText.append(ocrImage(cg))
    } else {
        allText.append("")
    }
}

print(allText.joined(separator: "\n\n"))
