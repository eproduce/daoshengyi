#!/usr/bin/env swift
// 本地 OCR 工具：用 macOS Vision 框架提取图片中的文字（准确、离线、快）。
// 用法: ocr_tool <image_path> [image_path ...]
// 输出: 每张图的识别文字，多张图之间用空行分隔。
import Foundation
import Vision
import ImageIO

let args = Array(CommandLine.arguments.dropFirst())
guard !args.isEmpty else { exit(0) }

var allText: [String] = []

for path in args {
    var text = ""
    if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
       let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        do {
            try handler.perform([request])
            if let obs = request.results as? [VNRecognizedTextObservation] {
                text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            }
        } catch {
            text = ""
        }
    }
    allText.append(text)
}

print(allText.joined(separator: "\n\n"))
