// ESLint flat config（ESLint 9 + typescript-eslint 8 + eslint-plugin-vue 10）
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "coverage/**",
      "scripts/**",
      "*.md",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],
  {
    files: ["**/*.{ts,mts,vue}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // 允许显式 any：聊天流式/工具参数等动态数据场景使用广泛，收紧会大量改型
      "@typescript-eslint/no-explicit-any": "off",
      // 存量未使用变量较多，作为提示而非阻断，新代码应尽量清理
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      // 单文件组件命名不强制 multi-word（历史组件名大量为单/双词）
      "vue/multi-word-component-names": "off",
      // 模板中允许 v-html（聊天消息渲染模型输出，内容经内置清洗）
      "vue/no-v-html": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    rules: {
      // 中文文案常用全角空格做排版分隔（字符串/注释内），跳过以保留展示语义
      "no-irregular-whitespace": ["error", { skipStrings: true, skipComments: true }],
    },
  },
  prettier,
);
