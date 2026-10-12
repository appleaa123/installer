import { APPROVAL_TOOLS } from "./approval-tools.js";
import { MEMO_TOOLS } from "./memo.js";
import { createRegistry, type ToolRegistry } from "./tools.js";

/** The tools this version serves over MCP and through `installer tool`; later plans add their groups here. */
export const DEFAULT_TOOLS: ToolRegistry = createRegistry([...APPROVAL_TOOLS, ...MEMO_TOOLS]);
