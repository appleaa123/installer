import { join } from "node:path";
import { InputError } from "./inputs.js";
import { createRecord, listRecords, readRecord, removeRecord, replaceRecord } from "./numbered.js";
import { idArg, onlyKeys, textArg, type ToolArgs, type ToolContext, type ToolDef } from "./tools.js";

/**
 * Memos: short internal notes kept under the engine home. A small, neutral tool set that exercises every
 * approval level before the real business tools arrive (records.* in Plan 5, channel.* in Plan 6; D63).
 */
export const MEMOS_DIR = join("data", "memos");

/** A type alias, not an interface, so a memo is also a plain tool result. */
type Memo = {
  readonly id: number;
  readonly text: string;
  readonly at: string;
};

const isMemo = (value: unknown): value is Memo =>
  typeof value === "object" && value !== null && typeof (value as Memo).id === "number" && typeof (value as Memo).text === "string" && typeof (value as Memo).at === "string";

async function requireMemo(home: string, id: number): Promise<Memo> {
  const memo = await readRecord(home, MEMOS_DIR, id, isMemo);
  if (!memo) throw new InputError(`No memo ${id}`);
  return memo;
}

const ID = { type: "integer", minimum: 1 };
const TEXT = { type: "string", minLength: 1, maxLength: 2000 };

function idOnly(tool: string) {
  return (args: ToolArgs): ToolArgs => {
    onlyKeys(args, ["id"], tool);
    return { id: idArg(args, "id", tool) };
  };
}

function idAndText(tool: string) {
  return (args: ToolArgs): ToolArgs => {
    onlyKeys(args, ["id", "text"], tool);
    return { id: idArg(args, "id", tool), text: textArg(args, "text", tool) };
  };
}

/** The memo's current text: an approval is for the text the person saw (§9.6). */
const currentText = async (ctx: ToolContext, args: ToolArgs): Promise<ToolArgs> => ({ text: (await requireMemo(ctx.home, args.id as number)).text });

export const MEMO_TOOLS: readonly ToolDef[] = [
  {
    name: "memo.list", description: "List the internal memos.", fields: {}, required: [], level: "L0",
    parse: (args) => {
      onlyKeys(args, [], "memo.list");
      return {};
    },
    run: async (ctx) => ({ memos: await listRecords(ctx.home, MEMOS_DIR, isMemo) }),
  },
  {
    name: "memo.add", description: "Add an internal memo (an internal draft: logged, no approval).", fields: { text: TEXT }, required: ["text"], level: "L1",
    parse: (args) => {
      onlyKeys(args, ["text"], "memo.add");
      return { text: textArg(args, "text", "memo.add") };
    },
    run: async (ctx, args) => createRecord<Memo>(ctx.home, MEMOS_DIR, (id) => ({ id, text: args.text as string, at: ctx.now() })),
  },
  {
    name: "memo.edit", description: "Replace a memo's text. Declares no level, so it is L2: a person approves it first.", fields: { id: ID, text: TEXT }, required: ["id", "text"],
    parse: idAndText("memo.edit"),
    expected: currentText,
    run: async (ctx, args) => {
      const memo: Memo = { ...(await requireMemo(ctx.home, args.id as number)), text: args.text as string, at: ctx.now() };
      await replaceRecord(ctx.home, MEMOS_DIR, memo);
      return memo;
    },
  },
  {
    name: "memo.delete", description: "Delete a memo. Irreversible, so it is floor level L3: the decision maker approves it.", fields: { id: ID }, required: ["id"], categories: ["irreversible"],
    parse: idOnly("memo.delete"),
    expected: currentText,
    run: async (ctx, args) => ({ deleted: await removeRecord(ctx.home, MEMOS_DIR, args.id as number), id: args.id }),
  },
];
