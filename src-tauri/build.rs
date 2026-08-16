fn main() {
    // 重新构建触发：ocr_tool.swift 变更时重跑本脚本
    println!("cargo:rerun-if-changed=ocr_tool.swift");

    // macOS：自动编译 Vision OCR 工具（ocr_tool.swift → ocr_tool），
    // 确保打包时 ocr_tool 存在。非 macOS 或缺少 swiftc 时跳过——
    // OCR 层会自动回退到视觉模型语义描述，不影响构建。
    #[cfg(target_os = "macos")]
    {
        let swift_path = std::path::Path::new("ocr_tool.swift");
        let bin_path = std::path::Path::new("ocr_tool");
        let modified = |p: &std::path::Path| p.metadata().and_then(|m| m.modified()).ok();
        let need_build = !bin_path.exists()
            || swift_path.exists() && modified(swift_path) > modified(bin_path);
        if need_build {
            match std::process::Command::new("swiftc")
                .args(["-O", "ocr_tool.swift", "-o", "ocr_tool"])
                .status()
            {
                Ok(s) if s.success() => println!("ocr_tool 编译完成"),
                _ => eprintln!(
                    "警告: swiftc 编译 ocr_tool 失败，OCR 功能将不可用。\n\
                     可手动执行: swiftc -O ocr_tool.swift -o ocr_tool"
                ),
            }
        }
    }

    tauri_build::build()
}
