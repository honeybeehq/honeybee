import {lstatSync, realpathSync} from "node:fs";
import {dirname, resolve} from "node:path";

export interface SocketProof {dev: number; ino: number; parentDev: number; parentIno: number}
export interface PaneScope {sessionId: string; windowId: string}
export function socketOwnership(directory: {isDirectory(): boolean; uid: number; mode: number}, socket: {isSocket(): boolean; uid: number}, uid: number): boolean {
  return directory.isDirectory() && directory.uid === uid && (directory.mode & 0o777) === 0o700 && socket.isSocket() && socket.uid === uid;
}
export function ownedSocketProof(path: string): SocketProof | null {
  try {
    if (path !== resolve(path) || realpathSync(path) !== path) return null;
    const directory = lstatSync(dirname(path)), socket = lstatSync(path);
    if (!socketOwnership(directory, socket, process.getuid?.() ?? -1)) return null;
    return {dev: socket.dev, ino: socket.ino, parentDev: directory.dev, parentIno: directory.ino};
  } catch { return null; }
}
export function sameSocketProof(a: SocketProof | null, b: SocketProof | null): boolean {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.parentDev === b.parentDev && a.parentIno === b.parentIno;
}
export function legacyPaneProof(text: string, session: string, pid: number): {paneId: string} | null {
  const rows = text.trim().split("\n");
  if (rows.length !== 1) return null;
  const fields = rows[0]!.split("\t");
  return fields.length === 4 && fields[0] === session && fields[1] === "0" && /^%[0-9]+$/.test(fields[2]!) && /^[1-9][0-9]*$/.test(fields[3]!) && Number(fields[3]) === pid ? {paneId: fields[2]!} : null;
}
export function paneScopeProof(text: string, session: string, paneId: string, pid: number): PaneScope | null {
  const fields = text.trim().split("\t");
  return fields.length === 5 && fields[0] === session && /^\$[0-9]+$/.test(fields[1]!) && /^@[0-9]+$/.test(fields[2]!) && fields[3] === paneId && fields[4] === String(pid) ? {sessionId: fields[1]!, windowId: fields[2]!} : null;
}
export function freshPaneProof(text: string, session: string, paneId: string, pid: number, scope: PaneScope): boolean {
  return /^%[0-9]+$/.test(paneId) && text.trim() === `${session}\t0\t${paneId}\t${pid}\t0\t${scope.sessionId}\t${scope.windowId}`;
}
export function socketObservation(path: string, expected: SocketProof): {kind: "present"; proof: SocketProof} | {kind: "gone"} | {kind: "unavailable"} {
  try {
    const parent = dirname(path), before = lstatSync(parent);
    if (path !== resolve(path) || realpathSync(parent) !== parent || !before.isDirectory() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o700 || before.dev !== expected.parentDev || before.ino !== expected.parentIno) return {kind: "unavailable"};
    let present: SocketProof | null;
    try { lstatSync(path); present = ownedSocketProof(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return {kind: "unavailable"}; present = null; }
    const after = lstatSync(parent);
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.mode !== before.mode) return {kind: "unavailable"};
    if (present) return {kind: "present", proof: present};
    try {lstatSync(path); return {kind: "unavailable"};} catch (error) {return (error as NodeJS.ErrnoException).code === "ENOENT" ? {kind: "gone"} : {kind: "unavailable"};}
  } catch {return {kind: "unavailable"};}
}
