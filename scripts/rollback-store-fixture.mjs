import {join} from "node:path";
import {pathToFileURL} from "node:url";
const [source, dir] = process.argv.slice(2);
const {openCoreStore} = await import(pathToFileURL(join(source, "v2/core/src/index.ts")).href);
const store = openCoreStore(join(dir, "core.sqlite3"), {ephemeral: true});
try {
  const {bee} = store.createBee({id: "rollback-bee", name: "rollback", agent: "stub", substrate: "hsr", cwd: dir});
  const runtime = store.currentRuntime(bee.id);
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", {exitCause: "clean"});
  if (store.runtimeIdentityUnresolvedSince) store.runtimeIdentityUnresolvedSince(bee.id, runtime.generation);
  console.log(JSON.stringify({runtimeCount: 1, generation: runtime.generation}));
} finally {store.close();}
