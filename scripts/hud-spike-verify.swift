// HUD spike 取证工具：判定「透明浮层」是否真的成立。
//
// ## 为什么不能只靠「前后两张整屏截图对比」
//
// 第一版就是这么做的，结果被现实打了两次脸：
//   1. 显示器睡眠时 `screencapture` 给出**纯黑图** → 结论全废；
//   2. 桌面壁纸在**轮播/切换**时整屏像素会大变（实测两次截图的整屏差异高达 83%），
//      把窗口差异彻底淹没。
// 所以主判据改成**按窗口 ID 单独抓窗口**：`CGWindowList` 找到 HUD 窗口 →
// `screencapture -l <id> -o` 抓这张窗口图 → 检查 **alpha 通道**。
// 透明窗口的窗口图在「内边距 + 圆角」处 alpha=0，内容处 alpha>0 —— 一次抓图即可定论，
// 不依赖基线、不受壁纸/屏保/其它窗口影响。
//
// 整屏前后对比模式保留着，但只作为**交叉验证**（需要静止背景，见 `docs/HUD_SPIKE.md`）。
//
// ## 用法
//
//   swift scripts/hud-spike-verify.swift --list
//       列出显示器与所有在屏窗口（排查「窗口到底在不在、在哪块屏」）
//
//   swift scripts/hud-spike-verify.swift --window <匹配串> <out.png>
//       按窗口名/标题/属主名匹配，抓该窗口并判定透明度（主判据）
//
//   swift scripts/hud-spike-verify.swift <before.png> <after.png> <x> <y> <w> <h> [scale]
//       整屏前后对比（交叉验证；x,y,w,h 为逻辑像素）

import CoreGraphics
import Foundation
import ImageIO

// ── 通用 ─────────────────────────────────────────────────────────────────────

struct Bitmap {
    let width: Int
    let height: Int
    let data: [UInt8]

    func rgba(_ x: Int, _ y: Int) -> (Int, Int, Int, Int) {
        let i = (y * width + x) * 4
        return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]), Int(data[i + 3]))
    }

    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let (r, g, b, _) = rgba(x, y)
        return (r, g, b)
    }
}

func mark(_ ok: Bool, _ text: String) -> String { (ok ? "✅ " : "❌ ") + text }

func loadBitmap(_ path: String) -> Bitmap? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        FileHandle.standardError.write("无法读取图片：\(path)\n".data(using: .utf8)!)
        return nil
    }
    let width = image.width
    let height = image.height
    var data = [UInt8](repeating: 0, count: width * height * 4)
    let ok = data.withUnsafeMutableBytes { buffer -> Bool in
        guard let ctx = CGContext(
            data: buffer.baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    guard ok else { return nil }
    return Bitmap(width: width, height: height, data: data)
}

func differs(_ a: Bitmap, _ b: Bitmap, _ x: Int, _ y: Int, threshold: Int = 24) -> Bool {
    let (r1, g1, b1) = a.rgb(x, y)
    let (r2, g2, b2) = b.rgb(x, y)
    return abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2) > threshold
}

/// 「强变化」：用来把「胶囊自身的柔和阴影」（轻微、设计效果）与
/// 「窗口铺了一层不透明底色」（强、真故障）区分开 ——
/// 两者在内边距上都会改变像素，但量级差很多（实测阴影最大 alpha 只有 14/255）。
func differsStrong(_ a: Bitmap, _ b: Bitmap, _ x: Int, _ y: Int) -> Bool {
    differs(a, b, x, y, threshold: 96)
}

@discardableResult
func run(_ launchPath: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    do {
        try p.run()
        p.waitUntilExit()
        return p.terminationStatus
    } catch {
        FileHandle.standardError.write("执行失败 \(launchPath): \(error)\n".data(using: .utf8)!)
        return -1
    }
}

/// 枚举在屏窗口
func onScreenWindows() -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []
}

func windowBounds(_ info: [String: Any]) -> CGRect {
    if let d = info[kCGWindowBounds as String] as? [String: CGFloat] {
        return CGRect(x: d["X"] ?? 0, y: d["Y"] ?? 0, width: d["Width"] ?? 0, height: d["Height"] ?? 0)
    }
    if let d = info[kCGWindowBounds as String] as? NSDictionary,
       let r = CGRect(dictionaryRepresentation: d) {
        return r
    }
    return .zero
}

func printDisplays() {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    print("显示器（\(count) 个）")
    for id in ids.prefix(Int(count)) {
        let b = CGDisplayBounds(id)
        print("  id=\(id) 像素 \(Int(b.width))x\(Int(b.height)) 原点 \(Int(b.origin.x)),\(Int(b.origin.y)) 主屏=\(CGDisplayIsMain(id) != 0)")
    }
    print("")
}

// ── 模式 1：列出窗口 ─────────────────────────────────────────────────────────

let args = CommandLine.arguments

if args.count >= 2, args[1] == "--list" {
    printDisplays()
    let list = onScreenWindows()
    print("在屏窗口（\(list.count) 个）")
    for w in list {
        let owner = (w[kCGWindowOwnerName as String] as? String) ?? "?"
        let name = (w[kCGWindowName as String] as? String) ?? ""
        let num = (w[kCGWindowNumber as String] as? Int) ?? -1
        let layer = (w[kCGWindowLayer as String] as? Int) ?? -1
        let alpha = (w[kCGWindowAlpha as String] as? Double) ?? -1
        let b = windowBounds(w)
        print(String(format: "  #%-7d 层=%-4d alpha=%.2f  %4.0f,%-4.0f %4.0fx%-4.0f  %@  %@",
                     num, layer, alpha, b.origin.x, b.origin.y, b.width, b.height, owner, name))
    }
    exit(0)
}

// ── 模式 2：抓单个窗口并按 alpha 判定透明（主判据）─────────────────────────────

if args.count >= 4, args[1] == "--window" {
    let needle = args[2].lowercased()
    let out = args[3]
    let list = onScreenWindows()
    let matches = list.filter { w in
        let owner = ((w[kCGWindowOwnerName as String] as? String) ?? "").lowercased()
        let name = ((w[kCGWindowName as String] as? String) ?? "").lowercased()
        return owner.contains(needle) || name.contains(needle)
    }
    guard let win = matches.first else {
        print("❌ 没找到匹配「\(args[2])」的在屏窗口。用 --list 看看现有窗口。")
        exit(2)
    }
    let num = (win[kCGWindowNumber as String] as? Int) ?? -1
    let b = windowBounds(win)
    let layer = (win[kCGWindowLayer as String] as? Int) ?? -1
    let winAlpha = (win[kCGWindowAlpha as String] as? Double) ?? -1
    let onscreen = (win[kCGWindowIsOnscreen as String] as? Bool) ?? false
    print("")
    print("命中窗口          #\(num)  属主 \((win[kCGWindowOwnerName as String] as? String) ?? "?")  标题 \((win[kCGWindowName as String] as? String) ?? "")")
    print("窗口几何（像素）  \(String(format: "%.0f,%.0f %.0fx%.0f", b.origin.x, b.origin.y, b.width, b.height))  在屏=\(onscreen)  层=\(layer)  窗口 alpha=\(winAlpha)")

    // `-o` 去掉系统阴影；窗口图保留 alpha 通道
    let rc = run("/usr/sbin/screencapture", ["-x", "-o", "-l", "\(num)", out])
    guard rc == 0, let bmp = loadBitmap(out) else {
        print("❌ 抓窗口失败（exit \(rc)）。若提示权限问题，需在「系统设置 → 隐私与安全性 → 屏幕录制」里授权终端。")
        exit(2)
    }

    print("抓到窗口图        \(out)  \(bmp.width)x\(bmp.height) 像素")

    // 统计 alpha：近乎透明（<24）与有内容（>8）的像素比例。
    // 阈值取 24 而不是 0：胶囊自带柔和阴影（box-shadow 0 10px 30px），
    // 它会把内边距区的 alpha 抬到个位数（实测 2~14），那是设计效果、不是不透明底色。
    // 真正要排除的失败态是「整块 alpha=255 的白底/黑底」，两者相差一个数量级。
    var lowAlpha = 0
    var solidAlpha = 0
    var total = 0
    for y in stride(from: 0, to: bmp.height, by: 1) {
        for x in stride(from: 0, to: bmp.width, by: 1) {
            let (_, _, _, a) = bmp.rgba(x, y)
            total += 1
            if a < 24 { lowAlpha += 1 } else if a > 8 { solidAlpha += 1 }
        }
    }
    let ratioTransparent = Double(lowAlpha) / Double(total)
    let ratioSolid = Double(solidAlpha) / Double(total)

    // 四角（各取 4x4 小块的平均 alpha）
    func cornerAlpha(_ cx: Int, _ cy: Int, _ n: Int = 4) -> Double {
        var sum = 0.0
        var cnt = 0
        for dy in 0..<n {
            for dx in 0..<n {
                let x = min(max(cx + dx, 0), bmp.width - 1)
                let y = min(max(cy + dy, 0), bmp.height - 1)
                sum += Double(bmp.rgba(x, y).3)
                cnt += 1
            }
        }
        return cnt > 0 ? sum / Double(cnt) : 0
    }
    let tl = cornerAlpha(0, 0)
    let tr = cornerAlpha(bmp.width - 4, 0)
    let bl = cornerAlpha(0, bmp.height - 4)
    let br = cornerAlpha(bmp.width - 4, bmp.height - 4)
    let center = cornerAlpha(bmp.width / 2, bmp.height / 2, 8)

    print(String(format: "alpha 接近 0 像素  %.1f%%（内边距 + 圆角 + 阴影过渡应计入这里）", ratioTransparent * 100))
    print(String(format: "alpha 有内容像素  %.1f%%（胶囊本体）", ratioSolid * 100))
    print(String(format: "四角 alpha        左上 %.0f / 右上 %.0f / 左下 %.0f / 右下 %.0f", tl, tr, bl, br))
    print(String(format: "中心 alpha        %.0f", center))
    print("")

    var verdicts: [String] = []
    let cornerMax = max(max(tl, tr), max(bl, br))
    let cornersTransparent = cornerMax < 24
    verdicts.append(mark(cornersTransparent, cornersTransparent
        ? "四角基本透明（最大 alpha \(Int(cornerMax))/255：胶囊外无不透明底色，残留来自柔和阴影）"
        : "四角不透明（最大 alpha \(Int(cornerMax))）：窗口有不透明底色，透明未生效"))
    verdicts.append(mark(ratioTransparent > 0.02, "存在透明区域 \(String(format: "%.1f%%", ratioTransparent * 100))（内边距 + 圆角）"))
    verdicts.append(mark(center > 8, "中心有内容（alpha=\(String(format: "%.0f", center))）：HUD 界面确实画出来了"))
    verdicts.append(mark(onscreen, onscreen ? "窗口在屏（CGWindowIsOnscreen=true）" : "窗口不在屏：显示器/空间不对"))
    print("结论")
    for v in verdicts { print("  " + v) }
    let pass = cornersTransparent && ratioTransparent > 0.02 && center > 8 && onscreen
    print("")
    print("VERDICT \(pass ? "PASS" : "FAIL")")
    exit(0)
}

// ── 模式 3：整屏前后对比（交叉验证）───────────────────────────────────────────

guard args.count >= 7 else {
    print("用法：")
    print("  swift scripts/hud-spike-verify.swift --list")
    print("  swift scripts/hud-spike-verify.swift --window <匹配串> <out.png>")
    print("  swift scripts/hud-spike-verify.swift <before.png> <after.png> <x> <y> <w> <h> [scale]")
    exit(2)
}
guard let before = loadBitmap(args[1]), let after = loadBitmap(args[2]) else {
    print("❌ 截图读取失败")
    exit(2)
}
guard before.width == after.width, before.height == after.height else {
    print("❌ 两张截图尺寸不同：\(before.width)x\(before.height) vs \(after.width)x\(after.height)")
    exit(2)
}

let scale = args.count >= 8 ? (Double(args[7]) ?? 2.0) : 2.0
let rectX = Int((Double(args[3]) ?? 0) * scale)
let rectY = Int((Double(args[4]) ?? 0) * scale)
let rectW = Int((Double(args[5]) ?? 0) * scale)
let rectH = Int((Double(args[6]) ?? 0) * scale)
let imgW = before.width
let imgH = before.height

func meanLuminance(_ b: Bitmap) -> Double {
    var sum = 0.0
    var n = 0
    for y in stride(from: 0, to: b.height, by: 16) {
        for x in stride(from: 0, to: b.width, by: 16) {
            let (r, g, bl) = b.rgb(x, y)
            sum += 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(bl)
            n += 1
        }
    }
    return n > 0 ? sum / Double(n) : 0
}

let lumBefore = meanLuminance(before)
let lumAfter = meanLuminance(after)

let insetPx = max(2, Int(8.0 * scale) - 2)
let outsidePx = Int(16.0 * scale)

var insideChanged = 0, insideTotal = 0
var insetChanged = 0, insetTotal = 0
var insetStrongChanged = 0
var outsideChanged = 0, outsideTotal = 0
var minX = Int.max, minY = Int.max, maxX = Int.min, maxY = Int.min

for y in (rectY - outsidePx)..<(rectY + rectH + outsidePx) {
    guard y >= 0, y < imgH else { continue }
    for x in (rectX - outsidePx)..<(rectX + rectW + outsidePx) {
        guard x >= 0, x < imgW else { continue }
        let changed = differs(before, after, x, y)
        let insideRect = x >= rectX && x < rectX + rectW && y >= rectY && y < rectY + rectH
        let inInset = insideRect
            && (x < rectX + insetPx || x >= rectX + rectW - insetPx
                || y < rectY + insetPx || y >= rectY + rectH - insetPx)
        if insideRect {
            insideTotal += 1
            if changed {
                insideChanged += 1
                minX = min(minX, x); minY = min(minY, y)
                maxX = max(maxX, x); maxY = max(maxY, y)
            }
            if inInset {
                insetTotal += 1
                if changed { insetChanged += 1 }
                if differsStrong(before, after, x, y) { insetStrongChanged += 1 }
            }
        } else {
            outsideTotal += 1
            if changed { outsideChanged += 1 }
        }
    }
}

// 整屏变化包围盒：一旦「矩形内没变、矩形外大变」，立刻能看出变化另有来源
var gMinX = Int.max, gMinY = Int.max, gMaxX = Int.min, gMaxY = Int.min
var globalChanged = 0
for y in stride(from: 0, to: imgH, by: 2) {
    for x in stride(from: 0, to: imgW, by: 2) {
        if differs(before, after, x, y) {
            globalChanged += 1
            gMinX = min(gMinX, x); gMinY = min(gMinY, y)
            gMaxX = max(gMaxX, x); gMaxY = max(gMaxY, y)
        }
    }
}
let ratioGlobal = Double(globalChanged) * 4.0 / Double(imgW * imgH)

let ratioInside = insideTotal > 0 ? Double(insideChanged) / Double(insideTotal) : 0
let ratioInset = insetTotal > 0 ? Double(insetChanged) / Double(insetTotal) : 0
let ratioInsetStrong = insetTotal > 0 ? Double(insetStrongChanged) / Double(insetTotal) : 0
let ratioOutside = outsideTotal > 0 ? Double(outsideChanged) / Double(outsideTotal) : 0

func writeCrop(_ src: Bitmap, _ path: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int) {
    let cx = max(0, min(x, src.width - 1))
    let cy = max(0, min(y, src.height - 1))
    let cw = min(w, src.width - cx)
    let ch = min(h, src.height - cy)
    guard cw > 0, ch > 0 else { return }
    var out = [UInt8](repeating: 0, count: cw * ch * 4)
    for row in 0..<ch {
        let srcStart = ((cy + row) * src.width + cx) * 4
        let dstStart = row * cw * 4
        out.replaceSubrange(dstStart..<(dstStart + cw * 4), with: src.data[srcStart..<(srcStart + cw * 4)])
    }
    guard let ctx = CGContext(data: &out, width: cw, height: ch, bitsPerComponent: 8,
                             bytesPerRow: cw * 4, space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let img = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                    "public.png" as CFString, 1, nil)
    else { return }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
}

let cropPad = Int(12.0 * scale)
let base = (args[1] as NSString).deletingLastPathComponent
let beforeCrop = "\(base)/hud-spike-crop-before.png"
let afterCrop = "\(base)/hud-spike-crop-after.png"
writeCrop(before, beforeCrop, rectX - cropPad, rectY - cropPad, rectW + cropPad * 2, rectH + cropPad * 2)
writeCrop(after, afterCrop, rectX - cropPad, rectY - cropPad, rectW + cropPad * 2, rectH + cropPad * 2)

print("")
print("截图尺寸          \(imgW)x\(imgH) 像素（scale=\(scale)）")
print("窗口矩形（像素）  \(rectX),\(rectY) \(rectW)x\(rectH)")
print("整屏平均亮度      前 \(String(format: "%.1f", lumBefore)) / 后 \(String(format: "%.1f", lumAfter))   (>8 才算截图有效)")
print("整屏变化比例      \(String(format: "%.1f%%", ratioGlobal * 100))   ← 越大越说明「除了 HUD 还有别的东西在变」")
if globalChanged > 0 {
    print("整屏变化包围盒    像素 \(gMinX),\(gMinY)→\(gMaxX),\(gMaxY)")
}
print("矩形内差异比例    \(String(format: "%.1f%%", ratioInside * 100))")
print("最外圈弱变化      \(String(format: "%.1f%%", ratioInset * 100))   ← 允许非 0：胶囊自身柔和阴影会让内边距轻微变化")
print("最外圈强变化      \(String(format: "%.1f%%", ratioInsetStrong * 100))   ← 应为 0：强变化才意味着铺了不透明底色")
print("矩形外差异比例    \(String(format: "%.1f%%", ratioOutside * 100))   ← 应为 0：无阴影/边框溢出窗口")
print("裁剪图            \(beforeCrop) / \(afterCrop)")
print("")

let cols = 40
let rows = 14
print("窗口矩形内差异图（X=变化 . =一致）")
for r in 0..<rows {
    var line = ""
    for c in 0..<cols {
        var hits = 0, samples = 0
        let x0 = rectX + c * rectW / cols
        let x1 = max(x0 + 1, rectX + (c + 1) * rectW / cols)
        let y0 = rectY + r * rectH / rows
        let y1 = max(y0 + 1, rectY + (r + 1) * rectH / rows)
        for y in stride(from: y0, to: y1, by: 2) {
            for x in stride(from: x0, to: x1, by: 2) {
                guard x < imgW, y < imgH else { continue }
                samples += 1
                if differs(before, after, x, y) { hits += 1 }
            }
        }
        let frac = samples > 0 ? Double(hits) / Double(samples) : 0
        line += frac > 0.5 ? "X" : (frac > 0.1 ? "+" : ".")
    }
    print("  " + line)
}
print("")

var verdicts: [String] = []
let screenOk = lumBefore > 8 && lumAfter > 8
let backgroundOk = ratioGlobal < 0.15
verdicts.append(mark(screenOk, screenOk ? "截图有效（非全黑）" : "截图接近全黑：显示器可能已睡眠"))
verdicts.append(mark(backgroundOk, backgroundOk
    ? "背景稳定（整屏变化 \(String(format: "%.1f%%", ratioGlobal * 100))）"
    : "背景不稳定（整屏变化 \(String(format: "%.1f%%", ratioGlobal * 100))）：壁纸轮播/屏保/其它窗口在动，本次前后对比不可信 → 改用 --window 模式"))
if screenOk && backgroundOk {
    verdicts.append(mark(ratioInside > 0.05, "窗口矩形内已绘制内容（\(String(format: "%.1f%%", ratioInside * 100))）"))
    if ratioInsetStrong < 0.02 {
        verdicts.append(mark(true, ratioInset > 0.01
            ? "窗口最外圈无强变化（弱变化 \(String(format: "%.1f%%", ratioInset * 100)) 来自胶囊自身柔和阴影）"
            : "窗口最外圈无任何绘制：透明"))
    } else {
        verdicts.append(mark(false, "窗口最外圈有 \(String(format: "%.1f%%", ratioInsetStrong * 100)) 强变化：疑似铺了不透明底色"))
    }
    verdicts.append(mark(ratioOutside < 0.005, ratioOutside < 0.005
        ? "窗口外侧无阴影溢出"
        : "窗口外侧有 \(String(format: "%.1f%%", ratioOutside * 100)) 像素变化：疑似阴影溢出"))
}
print("结论")
for v in verdicts { print("  " + v) }
let pass = screenOk && backgroundOk && ratioInside > 0.05 && ratioInsetStrong < 0.02 && ratioOutside < 0.005
print("")
print("VERDICT \(pass ? "PASS" : "FAIL")")
