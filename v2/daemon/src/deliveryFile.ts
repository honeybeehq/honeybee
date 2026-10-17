import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MULTILINE_FILE_MAX_BYTES = 8 * 1024 * 1024;
interface Bridge {
  publish(root: string, bee: string, id: string, content: Buffer): true;
  remove(root: string, bee: string, id: string): true;
}
export class DeliveryFileError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export class DeliveryFiles {
  private bridge: Bridge | undefined;
  private readonly directory: string;
  constructor(directory?: string) {
    this.directory = directory ?? join(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../dist/v2/delivery-file/" : "./delivery-file/", import.meta.url)), `${process.platform}-${process.arch}`);
  }
  private native(): Bridge {
    if (this.bridge) return this.bridge;
    try {
      const manifest = JSON.parse(readFileSync(join(this.directory, "manifest.json"), "utf8")) as Record<string, unknown>;
      const path = join(this.directory, "delivery-file.node");
      if (manifest.version !== 1 || manifest.napi !== 8 || manifest.target !== `${process.platform}-${process.arch}` || manifest.sha256 !== createHash("sha256").update(readFileSync(path)).digest("hex")) throw new Error("artifact mismatch");
      const bridge = createRequire(import.meta.url)(path) as Bridge;
      if (typeof bridge.publish !== "function" || typeof bridge.remove !== "function") throw new Error("invalid bridge");
      this.bridge = bridge;
      return bridge;
    } catch { throw new DeliveryFileError("delivery_file_helper_unavailable"); }
  }
  private location(root: string, owner: string, bee: string, id: string, worktrees: readonly string[]) {
    if (!isAbsolute(root) || root === sep || /[\x00-\x1f]/.test(root) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new DeliveryFileError("delivery_file_location_invalid");
    const canonical = realpathSync(root);
    if (canonical !== root) throw new DeliveryFileError("delivery_file_symlink_root");
    for (const worktree of worktrees) {
      const rel = relative(realpathSync(worktree), canonical);
      if (rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new DeliveryFileError("delivery_file_inside_worktree");
    }
    const directory = createHash("sha256").update(JSON.stringify([owner, bee])).digest("hex");
    return { directory, path: join(root, "delivery-content", directory, `${id}.txt`) };
  }
  publish(root: string, owner: string, bee: string, id: string, text: string, worktrees: readonly string[]): { path: string; digest: string; bytes: number } {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MULTILINE_FILE_MAX_BYTES) throw new DeliveryFileError("delivery_file_too_large");
    const location = this.location(root, owner, bee, id, worktrees);
    this.native().publish(root, location.directory, id, bytes);
    return { path: location.path, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }
  remove(root: string, owner: string, bee: string, id: string, worktrees: readonly string[]): void {
    const location = this.location(root, owner, bee, id, worktrees);
    this.native().remove(root, location.directory, id);
  }
}
