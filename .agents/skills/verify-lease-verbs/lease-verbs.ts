// Explicit-state checker for LeaseVerbs.tla: the same Init, actions, constants and invariants, searched
// breadth-first over every reachable state so a violation prints its shortest path. It exists because the
// satellites have no Java for TLC; keep it in step with LeaseVerbs.tla (one action here per TLA+ action).
// Run: node --experimental-strip-types .agents/skills/verify-lease-verbs/lease-verbs.ts [--break <rule>]...
// Rules (TLA+ constant each one flips): regress RegressCheck=FALSE, replay ReplayReusesReceipt=FALSE,
// authority OwnerSignsAuthority=FALSE, items ReplayChecksItems=FALSE, audit AuditReplay=FALSE,
// supersede SupersedeEnrolled=FALSE, foreign ForeignSupersedes=TRUE.

type Node = "A" | "C" | "none";
interface Payload { epoch: number; window: number; node: Node }
interface State {
  ownerEpoch: number; payloads: Payload[]; epoch: number; window: number; authority: Node; revoked: boolean; enrolled: boolean; published: boolean; ownerRefused: boolean;
  accepted: Array<[number, number]>; keyState: "none" | "recorded"; receipt: { grantWindow: number; installOk: boolean };
  installRuns: number; replayWindow: number; replayAsked: number; mints: number; audits: number;
}
interface Step { action: string; to: State }

const RULES = {
  regress: "installLease refuses a shorter window at the same epoch (RegressCheck)",
  replay: "a replayed batch key answers from its receipt (ReplayReusesReceipt)",
  authority: "account.lease.grant stamps its own node as authorityNodeId (OwnerSignsAuthority)",
  items: "a replayed key must carry the recorded items digest (ReplayChecksItems)",
  audit: "every re-mint on replay writes account.lease.granted replay:true (AuditReplay)",
  supersede: "the row's own authority republishes an enrolled row whose publication is unknown (SupersedeEnrolled)",
  foreign: "an enrolled row refuses a same-epoch payload from another node (ForeignSupersedes stays FALSE)",
} as const;
type Rule = keyof typeof RULES;
const broken = new Set<Rule>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--break") { const r = args[++i] as Rule; if (!(r in RULES)) throw new Error(`unknown rule ${r}; one of ${Object.keys(RULES).join(", ")}`); broken.add(r); }
  else throw new Error(`unknown argument ${args[i]}`);
}
const W = 2, MaxEpoch = 2, MaxMints = 3;
const RegressCheck = !broken.has("regress"), ReplayReusesReceipt = !broken.has("replay"), OwnerSignsAuthority = !broken.has("authority");
const ReplayChecksItems = !broken.has("items"), AuditReplay = !broken.has("audit"), SupersedeEnrolled = !broken.has("supersede"), ForeignSupersedes = broken.has("foreign");
const Windows = Array.from({ length: W }, (_, i) => i + 1);
const OwnerOf = (e: number): Node => (e % 2 === 1 ? "A" : "C");
const Payload = (epoch: number, window: number, node: Node = OwnerOf(epoch)): Payload => ({ epoch, window, node });
const payloadKey = (p: Payload) => `${p.epoch}:${p.window}:${p.node}`;
const withPayloads = (s: State, add: Payload[]): Payload[] => { const m = new Map(s.payloads.map(p => [payloadKey(p), p])); for (const p of add) m.set(payloadKey(p), p); return [...m.values()].sort((a, b) => payloadKey(a).localeCompare(payloadKey(b))); };
const withAccepted = (s: State, e: number, w: number): Array<[number, number]> => { const set = new Set(s.accepted.map(a => `${a[0]}:${a[1]}`)); set.add(`${e}:${w}`); return [...set].sort().map(k => k.split(":").map(Number) as [number, number]); };
const clone = (s: State): State => JSON.parse(JSON.stringify(s)) as State;
const key = (s: State): string => JSON.stringify(s);

const init: State = { ownerEpoch: 1, payloads: [], epoch: 0, window: 0, authority: "none", revoked: false, enrolled: false, published: false, ownerRefused: false, accepted: [], keyState: "none", receipt: { grantWindow: 0, installOk: false }, installRuns: 0, replayWindow: 0, replayAsked: 0, mints: 0, audits: 0 };

// installLease's origin rule for a row that already holds a lease.
const Admits = (s: State, p: Payload) => s.epoch === 0 || p.epoch > s.epoch || p.epoch === s.epoch && p.node === s.authority && (!RegressCheck || p.window >= s.window);
// The enrolment gate: an enrolled row whose publication is unknown re-proves local material; the swept material of a
// revoked row proves nothing, so only the row's own authority may republish it (SupersedeEnrolled).
const Admitted = (s: State, p: Payload) => s.enrolled
  ? Admits(s, p) && (s.published || SupersedeEnrolled && p.node === s.authority) || ForeignSupersedes && p.epoch === s.epoch && (!RegressCheck || p.window >= s.window)
  : Admits(s, p);
const apply = (t: State, p: Payload) => { t.epoch = p.epoch; t.window = p.window; t.authority = p.node; t.revoked = false; t.published = t.enrolled; t.accepted = withAccepted(t, p.epoch, p.window); };
const refuse = (s: State, t: State, p: Payload) => { t.ownerRefused = s.ownerRefused || Admits(s, p) && p.node === s.authority; };
const installInto = (s: State, t: State, p: Payload): boolean => { if (Admitted(s, p)) { apply(t, p); return true; } refuse(s, t, p); return false; };

function next(s: State): Step[] {
  const out: Step[] = [];
  for (const w of Windows) {
    // account.lease.grant on the owner (GrantWindow)
    const t = clone(s); t.payloads = withPayloads(s, [Payload(s.ownerEpoch, w), ...(OwnerSignsAuthority ? [] : [Payload(s.ownerEpoch, w, OwnerOf(s.ownerEpoch + 1))])]); t.mints += 1; t.audits += 1;
    out.push({ action: `Grant(window ${w}) by ${OwnerOf(s.ownerEpoch)} at epoch ${s.ownerEpoch}`, to: t });
    // another node's material stamped with the row's share and epoch (ForeignGrantWindow)
    if (s.epoch > 0) { const f = clone(s); f.payloads = withPayloads(s, [Payload(s.epoch, w, OwnerOf(s.epoch + 1))]); out.push({ action: `ForeignGrant(window ${w}) by ${OwnerOf(s.epoch + 1)} at epoch ${s.epoch}`, to: f }); }
  }
  // the old scheme enrols the satellite's own login under the owner's share (Enrol)
  if (s.epoch === 0) { const t = clone(s); t.epoch = s.ownerEpoch; t.window = 1; t.authority = OwnerOf(s.ownerEpoch); t.revoked = false; t.enrolled = true; t.published = true; t.accepted = withAccepted(s, s.ownerEpoch, 1); out.push({ action: `Enrol under ${OwnerOf(s.ownerEpoch)} at epoch ${s.ownerEpoch}`, to: t }); }
  // a republish whose outcome was lost: materialPublished stays false (PublishLost)
  if (s.enrolled && s.published) { const t = clone(s); t.published = false; out.push({ action: "PublishLost (materialPublished false, material swept)", to: t }); }
  // the credential handoff plane moves the share to a new owner (TakeOver)
  if (s.ownerEpoch < MaxEpoch) { const t = clone(s); t.ownerEpoch += 1; out.push({ action: `TakeOver to ${OwnerOf(s.ownerEpoch + 1)} (epoch ${s.ownerEpoch + 1})`, to: t }); }
  // account.lease.install with any payload minted so far (InstallPayload)
  for (const p of s.payloads) { const t = clone(s); const ok = installInto(s, t, p); out.push({ action: `Install(epoch ${p.epoch}, window ${p.window}, node ${p.node})${ok ? "" : " [refused]"}`, to: t }); }
  // account.lease.remove keeps the row (Release)
  if (s.epoch > 0 && !s.revoked) { const t = clone(s); t.revoked = true; out.push({ action: "Release", to: t }); }
  // account.lease.batch under the one key (BatchFirstWindow / BatchReplayWindow)
  const p11 = Payload(1, 1);
  for (const w of Windows) {
    if (s.keyState === "none" && s.payloads.some(p => payloadKey(p) === payloadKey(p11))) {
      const t = clone(s); t.keyState = "recorded"; t.installRuns += 1;
      const ok = installInto(s, t, p11); t.receipt = { grantWindow: w, installOk: ok };
      t.payloads = withPayloads(t, [Payload(s.ownerEpoch, w)]); t.mints += 1; t.audits += 1;
      out.push({ action: `BatchFirst(grant window ${w}, install epoch 1 window 1)${ok ? "" : " [install refused]"}`, to: t });
    }
    if (s.keyState === "recorded") {
      const t = clone(s);
      if (ReplayChecksItems && w !== s.receipt.grantWindow) out.push({ action: `BatchReplay(window ${w}) [idempotency_conflict items]`, to: t });
      else if (ReplayReusesReceipt) { t.replayAsked = w; t.replayWindow = s.receipt.grantWindow; t.mints += 1; if (AuditReplay) t.audits += 1; out.push({ action: `BatchReplay(window ${w}) answers the receipt`, to: t }); }
      else { t.replayAsked = w; t.replayWindow = w; t.installRuns += 1; t.mints += 1; t.audits += 1; t.payloads = withPayloads(s, [Payload(s.ownerEpoch, w)]); installInto(s, t, p11); out.push({ action: `BatchReplay(window ${w}) re-executes`, to: t }); }
    }
  }
  return out;
}

const invariants: Record<string, (s: State) => string | null> = {
  TypeOK: s => s.epoch >= 0 && s.epoch <= MaxEpoch && s.window >= 0 && s.window <= W && s.ownerEpoch >= 1 && s.ownerEpoch <= MaxEpoch && (s.enrolled || !s.published) ? null : `epoch ${s.epoch}, window ${s.window}, owner epoch ${s.ownerEpoch}`,
  WindowNeverShrinks: s => { if (s.epoch === 0) return null; const max = Math.max(...s.accepted.filter(a => a[0] === s.epoch).map(a => a[1])); return s.window === max ? null : `the row holds window ${s.window} at epoch ${s.epoch} after accepting window ${max}`; },
  EpochNeverFalls: s => s.accepted.every(a => a[0] <= s.epoch) ? null : `the row is at epoch ${s.epoch} after accepting epoch ${Math.max(...s.accepted.map(a => a[0]))}`,
  AuthorityMatchesEpoch: s => s.epoch === 0 || s.authority === OwnerOf(s.epoch) ? null : `the row names ${s.authority} as authority at epoch ${s.epoch}, which ${OwnerOf(s.epoch)} owns`,
  ReplayIsQuiet: s => s.installRuns <= 1 && (s.replayWindow === 0 || s.replayWindow === s.receipt.grantWindow) ? null : `install item ran ${s.installRuns} times, replay answered window ${s.replayWindow} against receipt window ${s.receipt.grantWindow}`,
  ReplayAnswersOwnItems: s => s.replayWindow === 0 || s.replayAsked === s.receipt.grantWindow ? null : `the key answered a replay that asked for window ${s.replayAsked} with its recorded window ${s.receipt.grantWindow}`,
  EveryMintAudited: s => s.audits === s.mints ? null : `${s.mints} mints, ${s.audits} account.lease.granted rows`,
  OwnerRenews: s => s.ownerRefused ? "the row refused a payload from its own share and authority that the ordering rule admits" : null,
};

const seen = new Map<string, { parent: string | null; via: string | null }>();
const queue: State[] = [init];
seen.set(key(init), { parent: null, via: null });
let violations = 0;
const failed = new Set<string>();
const report = (name: string, detail: string, at: State) => {
  violations += 1;
  const path: string[] = [];
  let k: string | null = key(at);
  while (k) { const e = seen.get(k)!; if (e.via) path.unshift(e.via); k = e.parent; }
  console.log(`\nVIOLATION ${name}: ${detail}\n  shortest path (${path.length} steps):\n    ${path.join("\n    ")}`);
};
while (queue.length > 0 && violations < 1) {
  const s = queue.shift()!;
  for (const [name, check] of Object.entries(invariants)) { const d = check(s); if (d && !failed.has(name)) { failed.add(name); report(name, d, s); } }
  if (s.mints > MaxMints) continue;
  for (const st of next(s)) {
    const k = key(st.to);
    if (!seen.has(k)) { seen.set(k, { parent: key(s), via: st.action }); queue.push(st.to); }
  }
}
console.log(`\n${violations === 0 ? "Model checking completed. No error has been found." : `Model checking found ${violations} violation(s).`}\n  distinct states: ${seen.size}; W ${W}, MaxEpoch ${MaxEpoch}, at most ${MaxMints} mints; broken rules: ${broken.size ? [...broken].join(", ") : "none"}`);
process.exit(violations === 0 ? 0 : 12);
