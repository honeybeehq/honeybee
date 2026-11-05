// Explicit-state model of the Champion revive / handover / fence lifecycle across two executors.
// Run: node --experimental-strip-types .agents/skills/verify-champion-lifecycle/champion-lifecycle.ts [--break <rule>] [--max-epoch 3]
// The model is TLA+-shaped (Init, Next as a list of guarded actions, invariants and per-step properties) and
// is checked by breadth-first search over every reachable state, so a violation prints its shortest path.
// Zero dependencies: this is what runs on a node with no Java, which is why it is not TLC.
//
// Code it describes (v2/daemon/src/daemon.ts unless noted):
//   startPlain / startHandover  rpcChampionStart + restoreChampionHome
//   fence                       rpcChampionFence; store.fenceChampion (v2/core/src/store.ts)
//   takeover                    store.takeoverChampion (epoch = handover + 1, fence cleared)
//   bundle                      ChampionHomeSync.syncNow (v2/daemon/src/championHomes.ts): skipped while fenced, written under the row epoch
//   export                      rpcChampionExport: refused while the incarnation is live; hands the latest pointer to the Home
//   adopt                       ChampionHomeSync.adopt + the `describe(homeRef)` check before any state change
//   stop after a fence          rpcChampionFence enqueues a `stop` command; the runtime is live until it settles ("stopping" here)
// Assumptions about the Home (Apiary), from its directory row "which executor runs it": it creates a Champion on one
// executor (A), it only hands over the current owner's exported pointer (never a pointer an older owner exported later),
// and it hands each pointer over once (handovers are serialised there). Everything else is Honeybee code.

type Inc = "none" | "live" | "stopping" | "stopped";
interface Node { epoch: number; fenced: boolean; inc: Inc; homeEpoch: number | null; homeOrigin: string | null; bundles: Array<{ epoch: number; origin: string; id: number }>; starts: number }
interface State { nodes: Record<"A" | "B", Node>; home: Array<{ node: "A" | "B"; epoch: number; origin: string; id: number }>; owner: "A" | "B"; nextId: number }
interface Step { action: string; from: State; to: State; refused: string | null }

const RULES = {
  validateBeforeMutate: "a refused champion.start leaves the row, the incarnation and the fence exactly as they were",
  handoverRefusesOlder: "a handover epoch older than the row's is champion_fenced",
  fenceRefusesOlder: "champion.fence with an older epoch is champion_fenced",
  fenceStopsLive: "champion.fence stops the live incarnation",
  startRefusedWhileFenced: "a plain champion.start on a fenced row is champion_fenced",
  bundleSkippedWhileFenced: "a fenced node writes no bundle: not at a turn end while its stop settles, and not for an export",
} as const;
type Rule = keyof typeof RULES;

const args = process.argv.slice(2);
const broken = new Set<Rule>();
let maxEpoch = 3;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--break") { const r = args[++i] as Rule; if (!(r in RULES)) throw new Error(`unknown rule ${r}; one of ${Object.keys(RULES).join(", ")}`); broken.add(r); }
  else if (args[i] === "--max-epoch") maxEpoch = Number(args[++i]);
  else throw new Error(`unknown argument ${args[i]}`);
}
const on = (rule: Rule) => !broken.has(rule);

const NODES = ["A", "B"] as const;
const init: State = { nodes: { A: fresh(), B: fresh() }, home: [], owner: "A", nextId: 1 };
function fresh(): Node { return { epoch: 0, fenced: false, inc: "none", homeEpoch: null, homeOrigin: null, bundles: [], starts: 0 }; }
const clone = (s: State): State => JSON.parse(JSON.stringify(s)) as State;
const key = (s: State): string => JSON.stringify(s);

// ---- actions: each returns the successor states (zero or more) with a refusal note when the verb refused ----
function next(s: State): Step[] {
  const out: Step[] = [];
  for (const n of NODES) {
    const node = s.nodes[n];
    // stop: the incarnation runtime ends (operator stop, crash, daemon restart reconcile, or the fence's stop command settling)
    if (node.inc === "live" || node.inc === "stopping") { const t = clone(s); t.nodes[n].inc = "stopped"; out.push({ action: `stop(${n})`, from: s, to: t, refused: null }); }
    // bundle at turn end: written under the row epoch; skipped while fenced (championHomes.syncNow)
    if ((node.inc === "live" || node.inc === "stopping") && node.homeEpoch != null && node.bundles.filter((b) => b.origin.startsWith(`${n}@`)).length < 2) {
      if (node.fenced && on("bundleSkippedWhileFenced")) out.push({ action: `bundle(${n})`, from: s, to: s, refused: "push_skipped fenced" });
      else { const t = clone(s); const id = t.nextId++; t.nodes[n].bundles.push({ epoch: node.epoch, origin: `${n}@${node.epoch}#${id}`, id }); t.nodes[n].homeOrigin = `${n}@${node.epoch}#${id}`; t.nodes[n].homeEpoch = node.epoch; out.push({ action: `bundle(${n})`, from: s, to: t, refused: null }); }
    }
    // export to the Home: refused while live; otherwise rpcChampionExport bundles the quiet home now under the row epoch
    // (an unchanged home at the same epoch reuses its pointer; a fenced row bundles nothing new and answers its last pointer)
    // and the Home learns that pointer (one pointer per node kept)
    if (node.homeEpoch != null) {
      if (node.inc === "live" || node.inc === "stopping") out.push({ action: `export(${n})`, from: s, to: s, refused: "runtime_refused" });
      else {
        const own = node.bundles.filter((b) => b.origin.startsWith(`${n}@`));
        const latestOwn = own[own.length - 1];
        const t = clone(s);
        let pointer: { epoch: number; origin: string; id: number } | undefined;
        if (node.fenced) pointer = node.bundles[node.bundles.length - 1];
        else if (latestOwn && latestOwn.epoch === node.epoch) pointer = latestOwn;
        else { const id = t.nextId++; pointer = { epoch: node.epoch, origin: `${n}@${node.epoch}#${id}`, id }; t.nodes[n].bundles.push(pointer); t.nodes[n].homeOrigin = pointer.origin; t.nodes[n].homeEpoch = node.epoch; }
        if (pointer) { t.home = [...t.home.filter((p) => p.node !== n), { node: n, ...pointer }]; out.push({ action: `export(${n})`, from: s, to: t, refused: null }); }
      }
    }
    // plain start: revive / running / spawn, with the implicit latest-bundle restore on an empty home.
    // The Home creates a Champion on one executor (A here); every other executor first receives it by handover.
    if (node.starts < 2 && (n === "A" || node.epoch > 0 || node.inc !== "none")) out.push(startPlain(s, n));
    // handover start: the Home hands the pointer of the other node (or this one) with its epoch; bytes may or may not be carried
    for (const p of s.home) for (const bytes of [true, false]) if (node.epoch <= maxEpoch - 1 && p.node === s.owner) out.push(startHandover(s, n, p, bytes));
    // fence: the Home tells this node the epoch it knows (the max over the Home's pointers and the other node)
    for (const e of fenceEpochs(s, n)) if (!(node.fenced && e <= node.epoch)) out.push(fence(s, n, e));
  }
  return out;
}

function fenceEpochs(s: State, n: "A" | "B"): number[] {
  const other = NODES.find((m) => m !== n)!;
  const set = new Set<number>([s.nodes[other].epoch, ...s.home.map((p) => p.epoch + 1)]);
  if (s.nodes[n].epoch > 0) set.add(s.nodes[n].epoch - 1);
  return [...set].filter((e) => e >= 0 && e <= maxEpoch);
}

function startPlain(s: State, n: "A" | "B"): Step {
  const node = s.nodes[n];
  const action = `start(${n})`;
  if (node.fenced && on("startRefusedWhileFenced")) return { action, from: s, to: s, refused: "champion_fenced" };
  const t = clone(s);
  const nn = t.nodes[n];
  nn.starts += 1;
  if (node.inc === "live" || node.inc === "stopping") return { action, from: s, to: t, refused: null };
  if (node.inc === "stopped") { nn.inc = "live"; return { action, from: s, to: t, refused: null }; }
  // no incarnation: fresh home => restore this store's newest bundle unless it is older than the row epoch
  if (node.homeEpoch == null && node.bundles.length > 0) {
    const latest = node.bundles[node.bundles.length - 1]!;
    if (latest.epoch >= node.epoch) { nn.homeEpoch = latest.epoch; nn.homeOrigin = latest.origin; }
  }
  if (nn.homeEpoch == null) { nn.homeEpoch = node.epoch; nn.homeOrigin = `${n}@${node.epoch}#fresh`; }
  nn.inc = "live";
  return { action, from: s, to: t, refused: null };
}

function startHandover(s: State, n: "A" | "B", p: State["home"][number], bytes: boolean): Step {
  const node = s.nodes[n];
  const action = `start(${n}, handover ${p.origin} epoch ${p.epoch}${bytes ? " +bytes" : ""})`;
  if (p.epoch < node.epoch && on("handoverRefusesOlder")) return { action, from: s, to: s, refused: "champion_fenced (older handover)" };
  const objectPresent = bytes || node.bundles.some((b) => b.id === p.id);
  if (on("validateBeforeMutate")) {
    if (!objectPresent) return { action, from: s, to: s, refused: "invalid_request (object not in store; hand it over as homeBytes)" };
    return { action, from: s, to: applyHandover(s, n, p), refused: null };
  }
  // broken variant: the stale incarnation is stopped and archived and the epoch taken before the object check
  const t = applyHandover(s, n, p);
  if (!objectPresent) { t.nodes[n].inc = "none"; t.nodes[n].homeEpoch = node.homeEpoch; t.nodes[n].homeOrigin = node.homeOrigin; return { action, from: s, to: t, refused: "invalid_request (object not in store) AFTER takeover" }; }
  return { action, from: s, to: t, refused: null };
}

function applyHandover(s: State, n: "A" | "B", p: State["home"][number]): State {
  const t = clone(s);
  const nn = t.nodes[n];
  nn.starts += 1;
  nn.epoch = p.epoch + 1; // store.takeoverChampion
  nn.fenced = false;
  nn.inc = "live"; // the stale incarnation (live or stopped) is stopped, archived, unbound; a new one spawns
  nn.homeEpoch = p.epoch; // the pointed bundle is restored into a fresh home (a non-empty home is set aside)
  nn.homeOrigin = p.origin;
  if (!nn.bundles.some((b) => b.id === p.id)) nn.bundles.push({ epoch: p.epoch, origin: p.origin, id: p.id });
  t.home = t.home.filter((q) => q.id !== p.id); // the Home hands a pointer over once
  t.owner = n; // the directory row now names this executor
  return t;
}

function fence(s: State, n: "A" | "B", e: number): Step {
  const node = s.nodes[n];
  const action = `fence(${n}, epoch ${e})`;
  if (e < node.epoch && on("fenceRefusesOlder")) return { action, from: s, to: s, refused: "champion_fenced (older epoch)" };
  const t = clone(s);
  t.nodes[n].epoch = Math.max(e, node.epoch);
  t.nodes[n].fenced = true;
  if (node.inc === "live" && on("fenceStopsLive")) t.nodes[n].inc = "stopping";
  return { action, from: s, to: t, refused: null };
}

// ---- properties ----
const invariants: Record<string, (s: State) => string | null> = {
  FencedHasNoLiveIncarnation: (s) => { for (const n of NODES) if (s.nodes[n].fenced && s.nodes[n].inc === "live") return `${n} is fenced at epoch ${s.nodes[n].epoch} with a live incarnation and no stop on its way`; return null; },
  BundleEpochsHaveOneWriter: (s) => { const writers = new Map<number, Set<string>>(); for (const n of NODES) for (const b of s.nodes[n].bundles) if (b.origin.startsWith(`${n}@`)) { const set = writers.get(b.epoch) ?? new Set(); set.add(n); writers.set(b.epoch, set); } for (const [epoch, set] of writers) if (set.size > 1) return `both executors wrote bundles under epoch ${epoch} (${[...set].join(", ")}); the Home cannot tell whose home is current`; return null; },
  BundlesNeverAboveRowEpoch: (s) => { for (const n of NODES) for (const b of s.nodes[n].bundles) if (b.epoch > s.nodes[n].epoch) return `${n} holds bundle ${b.origin} above its row epoch ${s.nodes[n].epoch}`; return null; },
  HomeNeverOlderThanOwnBundles: (s) => { for (const n of NODES) { const node = s.nodes[n]; if (node.inc === "live" && node.homeEpoch != null && node.bundles.some((b) => b.epoch > node.homeEpoch!)) return `${n} runs on home content from epoch ${node.homeEpoch} while it holds a newer bundle (${node.bundles.map((b) => b.origin).join(", ")})`; } return null; },
};
const stepProperties: Record<string, (st: Step) => string | null> = {
  EpochMonotone: (st) => { for (const n of NODES) if (st.to.nodes[n].epoch < st.from.nodes[n].epoch) return `${n} epoch ${st.from.nodes[n].epoch} -> ${st.to.nodes[n].epoch}`; return null; },
  RefusedStartIsQuiet: (st) => { if (!st.action.startsWith("start(") || st.refused == null) return null; const n = st.action[6] as "A" | "B"; const a = st.from.nodes[n], b = st.to.nodes[n]; if (a.epoch !== b.epoch || a.fenced !== b.fenced || a.inc !== b.inc || a.homeOrigin !== b.homeOrigin) return `${st.action} refused (${st.refused}) but ${n} changed: epoch ${a.epoch}->${b.epoch} fenced ${a.fenced}->${b.fenced} inc ${a.inc}->${b.inc}`; return null; },
  FencedStaysFencedUntilNewerHandover: (st) => { for (const n of NODES) { const a = st.from.nodes[n], b = st.to.nodes[n]; if (a.fenced && !b.fenced && !(st.action.startsWith(`start(${n}, handover`) && b.epoch > a.epoch)) return `${n} lost its fence through ${st.action} (epoch ${a.epoch} -> ${b.epoch})`; } return null; },
  StaleFenceIsQuiet: (st) => { const m = /^fence\((.), epoch (\d+)\)$/.exec(st.action); if (!m) return null; const n = m[1] as "A" | "B"; if (Number(m[2]) < st.from.nodes[n].epoch && key(st.to) !== key(st.from)) return `${st.action} changed ${n} although its row is at epoch ${st.from.nodes[n].epoch} (inc ${st.from.nodes[n].inc} -> ${st.to.nodes[n].inc})`; return null; },
  TakeoverOwnsNextEpoch: (st) => { if (!/^start\(., handover/.test(st.action) || st.refused != null) return null; const n = st.action[6] as "A" | "B"; const m = /epoch (\d+)/.exec(st.action)!; if (st.to.nodes[n].epoch !== Number(m[1]) + 1 || st.to.nodes[n].fenced) return `${st.action} left ${n} at epoch ${st.to.nodes[n].epoch} fenced=${st.to.nodes[n].fenced}`; return null; },
};

// ---- breadth-first search ----
const seen = new Map<string, { parent: string | null; via: string | null }>();
const queue: State[] = [init];
seen.set(key(init), { parent: null, via: null });
let violations = 0;
const report = (name: string, detail: string, at: State, via?: string) => {
  violations += 1;
  const path: string[] = [];
  let k: string | null = key(at);
  while (k) { const e = seen.get(k)!; if (e.via) path.unshift(e.via); k = e.parent; }
  if (via) path.push(via);
  console.log(`\nVIOLATION ${name}: ${detail}\n  shortest path (${path.length} steps):\n    ${path.join("\n    ")}`);
};
const failed = new Set<string>();
while (queue.length > 0 && violations < 1) {
  const s = queue.shift()!;
  for (const [name, check] of Object.entries(invariants)) { const d = check(s); if (d && !failed.has(name)) { failed.add(name); report(name, d, s); } }
  for (const st of next(s)) {
    if (st.to.epoch !== undefined) continue;
    for (const [name, check] of Object.entries(stepProperties)) { const d = check(st); if (d && !failed.has(name)) { failed.add(name); report(name, d, s, st.action + (st.refused ? ` [refused: ${st.refused}]` : "")); } }
    const k = key(st.to);
    if (!seen.has(k)) { seen.set(k, { parent: key(s), via: st.action + (st.refused ? ` [refused: ${st.refused}]` : "") }); queue.push(st.to); }
  }
}
console.log(`\n${violations === 0 ? "Model checking completed. No error has been found." : `Model checking found ${violations} violation(s).`}\n  distinct states: ${seen.size}, max epoch ${maxEpoch}, two executors, one Champion, at most 2 bundles per node and 2 plain starts per node, broken rules: ${broken.size ? [...broken].join(", ") : "none"}`);
process.exit(violations === 0 ? 0 : 12);
