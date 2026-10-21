import { constants, openSync, closeSync, fstatSync } from "node:fs";
import { isAbsolute } from "node:path";

export function openExternalDirectory(path: string): number {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("external_exec_invalid_directory");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const component of path.split("/").filter(Boolean)) {
      if (component === "." || component === "..") throw new Error("external_exec_noncanonical_directory");
      const next = openSync(`/proc/self/fd/${fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function openExternalFile(directory: string, filename: string, write: boolean): number {
  if (!/^[A-Za-z0-9_.-]+$/.test(filename) || filename === "." || filename === "..") throw new Error("external_exec_invalid_filename");
  const parent = openExternalDirectory(directory);
  try {
    const directoryStat = fstatSync(parent);
    if (directoryStat.uid !== process.getuid!() || (directoryStat.mode & 0o022) !== 0 || write && (directoryStat.mode & 0o077) !== 0) throw new Error("external_exec_unsafe_directory");
    const fd = openSync(`/proc/self/fd/${parent}/${filename}`, constants.O_NOFOLLOW | constants.O_NONBLOCK | (write ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND : constants.O_RDONLY), 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1 || (stat.mode & (write ? 0o077 : 0o022)) !== 0) throw new Error("external_exec_unsafe_file");
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  } finally { closeSync(parent); }
}
