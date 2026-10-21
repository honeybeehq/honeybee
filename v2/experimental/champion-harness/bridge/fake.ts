import type { SdkQuery } from "./sdk.ts";
export const fakeSdk: SdkQuery = {
  async *run(request) {
    yield { type: "session", sessionId: "fixture-session" };
    yield { type: "loaded", tools: [], servers: [] };
    if (request.prompt.includes("fixture:hold")) {
      await new Promise<void>(resolve => {
        if (request.signal.signal.aborted) resolve();
        else request.signal.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    if (request.prompt.includes("fixture:auth")) {
      yield { type: "boundary", boundary: "auth" };
      yield { type: "private", value: "OAuth token revoked", served: false };
      yield { type: "result", success: true, usage: { input_tokens: 0, output_tokens: 0 } };
      return;
    }
    yield { type: "token" };
    yield { type: "private", value: "PRIVATE MODEL TEXT MUST NEVER REACH STDOUT", served: true };
    if (request.prompt.includes("fixture:visible")) yield { type: "human_output", id: "fixture-model-first-reply", kind: "tell", origin: "human", content: "ok" };
    yield { type: "result", success: true, usage: { input_tokens: 5, output_tokens: 2 } };
  },
};
