// 阶段3：Skill 装配器 —— 标准 MCP server（stdio）
// 任何支持 MCP 的智能体都能接入。工具注册逻辑在 lib/register-tools.mjs
// 规则：stdout 只走 MCP 协议，日志一律 stderr
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerServerTools, TOOL_TIERS } from "./lib/register-tools.mjs";

const log = (...a) => console.error("[book-skill]", ...a);

const server = new McpServer({ name: "book-skill", version: "0.4.0" });
registerServerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
// V02/A-04：工具清单由定档表唯一正本生成，杜绝 18 注册 / 17 定档 / 10 日志三套数。
log(`book-skill MCP server ready (tools: ${Object.keys(TOOL_TIERS).join(", ")})`);
