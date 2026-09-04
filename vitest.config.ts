import { defineConfig } from "vitest/config";

// 前端单元测试：Vitest 3（Node 环境）
// - 用例迁移自原 scripts/test-*.mts 手写 runner（见 git 历史）
// - 纯函数逻辑测试，不依赖浏览器 DOM（如需组件测试再加 happy-dom/jsdom）
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
