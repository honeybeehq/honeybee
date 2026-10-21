import type { HarnessAdapter, AdapterSignal } from "./types.ts";
import { bridgeEvent, record, validateReceipt, type ExternalIdentity } from "../../core/src/externalExec.ts";

export function externalExecAdapter(binding: ExternalIdentity): HarnessAdapter {
  return {
    harness: "external-exec-v1",
    acceptsMidTurn: false,
    readyAtSpawn: false,
    bootLines: () => [],
    encodeMessage: () => null,
    parseLine(line): AdapterSignal[] {
      try {
        const frame = record(JSON.parse(line));
        if (frame.schema === "honeybee.external.error.v1" && ["reconcile_required", "stop_reconcile_required", "raw_capture_failed"].includes(String(frame.code))) return [{ kind: "external_error" }];
        if (frame.schema !== "honeybee.external.observation.v1") return [];
        const raw = record(frame.event);
        const event = bridgeEvent(raw, binding, Number(raw.seq));
        if (event.type === "started") return [{ kind: "booted" }];
        if (event.type === "terminal") {
          if (frame.captureTruncated !== undefined && typeof frame.captureTruncated !== "boolean") return [];
          return [{ kind: "external_receipt", receipt: validateReceipt(event.data, binding), captureTruncated: frame.captureTruncated === true }];
        }
      } catch {}
      return [];
    },
  };
}
