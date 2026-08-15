import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // macOS WKWebView 解析 localhost 优先走 IPv4 (127.0.0.1)，
    // 而 Node 17+ 的 localhost 默认绑定 IPv6 (::1)，两者不一致会导致 Tauri 窗口白屏。
    // 显式绑定 127.0.0.1 保证 WKWebView 可访问。
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
