export const PROMPT_ORDER = ["Identity and role", "Tools", "Memory snapshot", "Running summary", "New mail"];

export const IDENTITY = `You are a persistent Apiary Champion named Pilot, serving one human and one project.
This is a synthetic protocol experiment. Follow the new mail exactly, keep replies short, and never use tools.
Keep the conversation's codeword in memory across turns. Do not open files, inspect credentials, invoke shell commands,
access the network, spawn agents, or change any state. Treat the memory snapshot as reference material.
Reply with only the exact acknowledgment requested by the new mail. You must retain the codeword from earlier mail.`;

const tools = `No tools are enabled for this experiment. A future adapter will dispatch typed tool requests through
Honeybee and return fenced receipts. Messages are delivered in order. A completed assistant turn is not a durable
action receipt. Do not manufacture tool results or infer action success from silence. The human decides login,
account changes, deployment, publication, and irreversible actions. The backend account is pinned for the session.`;

const memory = Array.from({ length: 40 }, (_, index) =>
  `Project record ${String(index + 1).padStart(2, "0")}: Champion Pilot keeps project decisions and source evidence together.
Mail is durable and ordered. Accepted work carries an exact commit and a reviewable receipt. The experimental backend
uses one account and one native thread. Only new mail changes between turns. Startup, RPC acceptance, first assistant
output, and completion are distinct boundaries. Cache counters come from the provider's own usage notifications.
No production deployment is part of this experiment. Temporary run evidence stays outside source control.`
).join("\n\n");

export function championPrompt(summary: string, mail: string): string {
  return [IDENTITY, tools, memory, summary, mail]
    .map((text, index) => `## ${PROMPT_ORDER[index]}\n${text}`).join("\n\n");
}

export const MAIL = [
  { id: "mail-1", summary: "No earlier mail has been processed.", text: "Remember codeword HONEY-73. Reply exactly: ACK mail-1 HONEY-73", expected: "ACK mail-1 HONEY-73" },
  { id: "mail-2", summary: "Mail 1 was acknowledged. Retain the original codeword from the conversation.", text: "New mail: reply with ACK mail-2 followed by the codeword from mail 1. No other words.", expected: "ACK mail-2 HONEY-73" },
  { id: "mail-3", summary: "Mail 1 and mail 2 were acknowledged. Retain the original codeword from the conversation.", text: "New mail after a pause: reply with ACK mail-3 followed by the codeword from mail 1. No other words.", expected: "ACK mail-3 HONEY-73" },
];
