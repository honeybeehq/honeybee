import {lstatSync, realpathSync} from "node:fs";
import {dirname, resolve} from "node:path";

export interface SocketProof {dev: number; ino: number; parentDev: number; parentIno: number}
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
