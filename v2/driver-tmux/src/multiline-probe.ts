import type { TmuxServer } from "./tmux.ts";

export class MultilinePasteProbe {
  private cached: { identity: string; version: string; supported: boolean } | null = null;

  refusal(server: Pick<TmuxServer, "try">, identity: string, paneId: string): string | null {
    let flag: string;
    if (this.cached?.identity !== identity) {
      const probe = server.try(["display-message", "-p", "-t", paneId, "#{version}|#{pane_id}|#{bracket_paste_flag}"]);
      const fields = probe.stdout.trim().split("|");
      if (probe.status !== 0 || fields.length !== 3 || !fields[0] || fields[1] !== paneId || !["", "0", "1"].includes(fields[2]!)) {
        return "multiline_bracketed_paste_unknown";
      }
      flag = fields[2]!;
      this.cached = { identity, version: fields[0], supported: flag !== "" };
    } else if (!this.cached.supported) {
      return "multiline_bracketed_paste_version_unsupported";
    } else {
      const state = server.try(["display-message", "-p", "-t", paneId, "#{bracket_paste_flag}"]);
      flag = state.status === 0 ? state.stdout.trim() : "";
    }
    if (!this.cached.supported) return "multiline_bracketed_paste_version_unsupported";
    return flag === "1" ? null : flag === "0" ? "multiline_bracketed_paste_disabled" : "multiline_bracketed_paste_unknown";
  }
}
