// ESLint flat config（存量代码体检用：目标是排雷不是重构）
// 基线 eslint:recommended 抓真问题（未定义变量/重复声明/逻辑隐患）；
// 对 CLI 工具型项目的合理风格放开在下方逐条注明原因。
import js from "@eslint/js";

export default [
  {
    ignores: [
      "release/**",
      "node_modules/**",
      "books/**",
      "library/**",
      "backup/**",
      "skills/**",
      "catalog-results/**",
      "catalog-tasks/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      // 项目 .js 为 CommonJS（require/__dirname），package.json 未声明 type
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {},
  },
  {
    // 渲染进程是浏览器 ESM（index.html 用 <script type="module"> 加载），
    // 不是 Node CJS——sourceType 与全局变量都得按浏览器来
    files: ["src/renderer/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        location: "readonly",
        confirm: "readonly",
        CustomEvent: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {},
  },
  {
    files: ["src/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        fetch: "readonly", // Node 18+ 全局 fetch（fetch-wikisource 用）
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {},
  },
  {
    // .js 测试是 CommonJS（require），与 src CJS 同款 globals
    files: ["test/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "all", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // 测试文件：Node ESM（.mjs），靠 console 输出 PASS/FAIL 计数；
    // 此前 test/ 不在任何作用域内 → node globals 全 no-undef 的假阳性，纳管修掉
    files: ["test/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        global: "readonly", // renderer-graph-test 的 DOM stub 挂在 global 上
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "all", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/**/*.js", "src/**/*.mjs"],
    rules: {
      // CLI 工具靠 console 向用户输出进度/结果，人工分诊已做（MCP 协议通道内全部走 stderr），
      // 靠 lint 禁不掉真问题，故关闭。
      "no-console": "off",
      // 工具脚本大量用 args 占位/约定签名；未用形参不是 bug。只保留"已赋值却没用"的报告。
      "no-unused-vars": ["error", { args: "none", caughtErrors: "all", ignoreRestSiblings: true }],
      // lib/catalog.mjs 有三处故意的空 catch（JSON.parse 失败→用缺省值、只读连接失败→cataloged:false），
      // 属防御性吞错，非遗漏；行为基准锁定，不改代码，放开空 catch 块。
      "no-empty": ["error", { allowEmptyCatch: true }],
      // better-sqlite3 / electron 等原生与运行时 API 属性拼写错误 lint 抓不了，
      // no-undef 已由 eslint:recommended 保留，负责未声明变量。
    },
  },
];
