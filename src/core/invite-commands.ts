import { appendAudit } from "./audit.js";
import { listChannels, type ChannelConfig } from "./channels.js";
import { InputError } from "./inputs.js";
import { createInvite, listMembers, removeMember, requireMemberName, type Member } from "./members.js";
import type { Roles } from "./types.js";

/**
 * `taskpilot invite <name>` and `taskpilot members [remove <id>]` (D77). Inviting and removing change who may
 * decide approvals, so like deciding (D61) they need a person at a terminal; an agent's attempt is refused and
 * audited. The join code is printed once, here, and never stored.
 */
export interface MemberCommand {
  readonly sub: string | undefined;
  readonly id: string | undefined;
  readonly interactive: boolean;
}

const MEMBERS_USAGE = "members needs nothing (list) or: remove <id>";

async function requireTerminal(home: string, interactive: boolean, command: string, now: string): Promise<void> {
  if (interactive) return;
  await appendAudit(home, { ts: now, actor: "agent", event: "member.refused", ref: "members", payload: { command } });
  throw new InputError(`Members are invited and removed by a person in their own terminal, not by the agent: open a terminal and run '${command}' there`);
}

function howToJoin(channel: ChannelConfig, code: string): string {
  if (channel.channel === "telegram") return `Telegram: open https://t.me/${channel.bot.username}?start=${code.replace("-", "")} and press Start, or send '/join ${code}' to @${channel.bot.username}`;
  return `Email: send an email to ${channel.address} whose first line is 'JOIN ${code}'`;
}

/** What a list shows: never the code's hash. */
const shown = ({ code_hash: _hash, ...member }: Member) => member;

export async function inviteCommand(home: string, roles: Roles | undefined, name: string | undefined, interactive: boolean, now: () => string): Promise<unknown> {
  const person = requireMemberName(name);
  await requireTerminal(home, interactive, `taskpilot invite "${person}"`, now());
  const channels = await listChannels(home);
  if (channels.length === 0) throw new InputError("No channel is set up yet: run 'taskpilot channel telegram' or 'taskpilot channel email' first");
  const { member, code } = await createInvite(home, person, roles, now());
  return {
    ...shown(member), code, join: channels.map((channel) => howToJoin(channel, code)),
    next: `Give ${person} the code privately (it works once and expires at ${member.expires_at}). Once the gateway runs, their first message with it joins them as ${member.role === "decision_maker" ? "the decision maker" : "a member"}.`,
  };
}

export async function membersCommand(home: string, command: MemberCommand, now: () => string): Promise<unknown> {
  if (command.sub === undefined) return { members: (await listMembers(home, now())).map(shown) };
  if (command.sub !== "remove" || !command.id || !/^[1-9]\d*$/.test(command.id)) throw new InputError(MEMBERS_USAGE);
  await requireTerminal(home, command.interactive, `taskpilot members remove ${command.id}`, now());
  return shown(await removeMember(home, Number(command.id), now()));
}
