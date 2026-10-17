import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let bracketed = process.argv[2] !== "off";
process.stdout.write((bracketed ? "\x1b[?2004h" : "\x1b[?2004l") + "phone terminal ready\r\n");
let pending = "", body = "", pasting = false;
const record = value => appendFileSync(process.env.PHONE_PROVIDER_RECEIPT, JSON.stringify(value) + "\n");
record({ ready: true, bracketed });
process.stdin.on("data", chunk => {
  if (chunk === "\u0002") { bracketed = true; process.stdout.write("\x1b[?2004h"); record({ bracketedEnabled: true }); return; }
  record({ transportHex: Buffer.from(chunk).toString("hex") });
  pending += chunk;
  while (pending.length) {
    if (pending[0] === "\x1b") {
      if (pending.length < 6) break;
      if (pending.startsWith("\x1b[200~")) { pasting = true; pending = pending.slice(6); continue; }
      if (pending.startsWith("\x1b[201~")) { pasting = false; pending = pending.slice(6); continue; }
    }
    const char = Array.from(pending)[0]; pending = pending.slice(char.length);
    if ((char === "\r" || char === "\n") && !pasting) {
      if (process.env.PHONE_FALLBACK_ROOT && body.includes("full text: ")) {
        const path = realpathSync(body.slice(body.indexOf("full text: ") + "full text: ".length));
        if (!path.startsWith(realpathSync(process.env.PHONE_FALLBACK_ROOT) + "/delivery-content/")) throw new Error("Fallback escaped fixture root");
        const bytes = readFileSync(path);
        record({ fallbackRead: {sha256: createHash("sha256").update(bytes).digest("hex"), header: bytes.toString("utf8").split("\n")[0]} });
      }
      record({ submittedBody: body }); body = "";
      process.stdout.write("\r\nreceived\r\n");
    } else if (char === "\u0015" && !pasting) {
      body = ""; process.stdout.write("\r\x1b[2K");
    } else {
      body += char; process.stdout.write(char === "\n" ? "\r\n" : char);
    }
  }
});
