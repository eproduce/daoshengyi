#!/usr/bin/env swift
// 本地 OCR 工具：用 macOS Vision 框架提取图片/PDF 中的文字（准确、离线、快）。
// 用法: ocr_tool <image_or_pdf_path> [path ...]
// 输出: 每个文件的识别文字，多文件/多页之间用空行分隔；PDF 每页前带【第 N 页】标记。
// 说明: PDF 用 PDFKit 把每页渲染成图像后再走 Vision OCR（用于扫描版/图片型 PDF，如体检报告）。
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
