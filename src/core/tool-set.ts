import { ACTION_TOOLS } from "./action-tools.js";
import { APPROVAL_TOOLS } from "./approval-tools.js";
import { CHANNEL_TOOLS } from "./channel-tools.js";
import { IMPORT_TOOLS } from "./import-tools.js";
import { MEMO_TOOLS } from "./memo.js";
import { RECORD_TOOLS } from "./record-tools.js";
import { createRegistry, type ToolRegistry } from "./tools.js";

/** The tools this version serves over MCP and through `taskfollow tool`; later plans add their groups here. */
export const DEFAULT_TOOLS: ToolRegistry = createRegistry([...APPROVAL_TOOLS, ...ACTION_TOOLS, ...MEMO_TOOLS, ...RECORD_TOOLS, ...IMPORT_TOOLS, ...CHANNEL_TOOLS]);
