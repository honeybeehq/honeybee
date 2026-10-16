import { createInterface } from "node:readline";
const emit = row => process.stdout.write(JSON.stringify(row) + "\n");
const sessionId = "quiet-lab-root";
let initialized = false;
let timer;
const assistant = (text, scope = {}) => emit({ type: "assistant", session_id: sessionId, ...scope, message: { role: "assistant", model: "fixture", content: [{ type: "text", text }] } });
createInterface({ input: process.stdin }).on("line", raw => {
  const row = JSON.parse(raw);
  if (row.type === "control_request") {
    clearTimeout(timer);
    emit({ type: "control_response", response: { subtype: "success", request_id: row.request_id } });
    emit({ type: "result", is_error: false, result: "interrupted", session_id: sessionId });
    return;
  }
  if (row.type !== "user") return;
  if (!initialized) {
    initialized = true;
    emit({ type: "system", subtype: "init", session_id: sessionId });
  }
  const text = row.message.content[0].text;
  const root = text.includes("@root-sub") ? "Please review the root reply" : text.includes("@restart") ? "restart ready <quiet/>" : "done <quiet/>";
  assistant(root);
  if (text.includes("@root-sub")) {
    assistant("child done <quiet/>", { isSidechain: true });
    assistant("other child done <quiet/>", { parent_tool_use_id: "child-tool" });
  }
  const finish = () => emit({ type: "result", subtype: text.includes("@quiet-error") ? "error_during_execution" : "success", is_error: text.includes("@quiet-error"), result: text.includes("@quiet-error") ? "fixture failure" : root, session_id: sessionId });
  if (text.includes("@restart") || text.includes("@interrupt")) timer = setTimeout(finish, 5000);
  else finish();
});
