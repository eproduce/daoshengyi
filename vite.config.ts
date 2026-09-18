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
  // code-mode 的沙箱 Worker 引用了共享模块（`src/utils/code-format.ts`），
  // 因此必须是 **module worker**：classic worker 不能有 import，而 Vite 在 dev 下
  // 只转译不打平 import → 实测直接报 `Cannot use import statement outside a module`
  // （build 因产物是打包好的 IIFE 反而正常，形成「dev 坏、生产好」的假象）。
  worker: {
    format: "es",
  },
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
  build: {
    rollupOptions: {
      output: {
        // 大体积第三方库独立分块（长期缓存友好），业务代码留在入口 chunk：
        // katex（公式，含字体很大）/ highlight.js / marked / vue-flow / lucide / tauri API
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("katex")) return "katex";
          if (id.includes("highlight.js") || id.includes("@highlightjs")) return "hljs";
          if (id.includes("@vue-flow") || id.includes("d3-")) return "vue-flow";
          if (id.includes("/marked")) return "marked";
          if (id.includes("lucide-vue-next")) return "lucide";
          if (id.includes("@tauri-apps")) return "tauri";
          if (id.includes("/vue/") || id.includes("pinia") || id.includes("@vue"))
            return "vue-vendor";
          return undefined;
        },
      },
    },
  },
}));
