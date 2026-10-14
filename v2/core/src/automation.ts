import { TASK_SUPPLY_SENDER_NAME } from "./tasks.ts";
import type { MessageRow, SenderKind } from "./types.ts";

export const AUTOMATION_SENDERS: readonly string[] = [TASK_SUPPLY_SENDER_NAME, "human:pollinate"];

export function isAutomationSender(sender: string): boolean {
  return sender === "hive" || sender.startsWith("hive:") || AUTOMATION_SENDERS.includes(sender);
}

/** The sender kind delivery reports: Honeybee's own and known automation senders are automation even when the send named none. */
export function deliveredSenderKind(msg: Pick<MessageRow, "sender" | "senderKind">): SenderKind | undefined {
  return isAutomationSender(msg.sender) ? "automation" : msg.senderKind;
}
