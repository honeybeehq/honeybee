// Run with node --import tsx. All GitHub access is a plain gh api read.
import { repackPeercred } from "../src/repackPeercred.ts";
const [dist, archive, sourceHead, target, ciRun, ciJob, artifactId, ...extra] = process.argv.slice(2);
if (!dist || !archive || !sourceHead || !target || !ciRun || !ciJob || !artifactId || extra.length) throw new Error("usage: node --import tsx scripts/repack-peercred.mjs DIST CI_ZIP HEAD TARGET RUN_ID JOB_ID ARTIFACT_ID");
await repackPeercred(dist, { archive, sourceHead, target, ciRun: Number(ciRun), ciJob: Number(ciJob), artifactId: Number(artifactId) });
