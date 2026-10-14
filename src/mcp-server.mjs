// 阶段3：Skill 装配器 —— 标准 MCP server（stdio）
// 任何支持 MCP 的智能体都能接入。工具注册逻辑在 lib/register-tools.mjs
// 规则：stdout 只走 MCP 协议，日志一律 stderr
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerServerTools } from "./lib/register-tools.mjs";

const log = (...a) => console.error("[book-skill]", ...a);

const server = new McpServer({ name: "book-skill", version: "0.4.0" });
registerServerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
log("book-skill MCP server ready (tools: list_books, list_catalog, get_person, get_theme, query_book, query_library, similar_chunks, save_skill, read_skill, list_skills)");
