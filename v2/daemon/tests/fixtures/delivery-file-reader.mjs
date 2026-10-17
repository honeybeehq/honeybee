import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";

const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
emit({event: "ready", sessionId: `file-reader-${process.pid}`});
const lines = createInterface({input: process.stdin});
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.type !== "message") return;
  const path = realpathSync(message.body.slice(message.body.indexOf("full text: ") + "full text: ".length));
  if (!path.startsWith(realpathSync(process.env.FILE_READ_ROOT) + "/delivery-content/")) throw new Error("Read escaped fixture root");
  const bytes = readFileSync(path);
  let writeDenied = null;
  if (process.env.FILE_EXPECT_READONLY === "1") {
    try {writeFileSync(path, "tamper"); writeDenied = false;} catch {writeDenied = true;}
  }
  emit({event: "turn_started", messageId: message.id});
  emit({event: "text", text: JSON.stringify({sha256: createHash("sha256").update(bytes).digest("hex"), header: bytes.toString("utf8").split("\n")[0], cwd: process.cwd(), writeDenied})});
  emit({event: "turn_ended", messageId: message.id, ok: true});
});
lines.on("close", () => process.exit(0));
