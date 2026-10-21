import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { InputFrame } from "./protocol.ts";

export interface Owner { ownerNode: string; beeId: string; generation: number; pid: number; birth: string }
export interface Pending { messageId: number; body: string }
export class BridgeState {
  private readonly lock: DatabaseSync;
  private readonly db: DatabaseSync;
  readonly epoch: number;
  private turn: number | null = null;
  private closed = false;
  readonly owner: Owner;
  constructor(home: string, owner: Owner) {
    this.owner = owner;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.lock = new DatabaseSync(join(home, "writer.sqlite"));
    try {
      this.lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch {
      this.lock.close();
      throw new Error("writer_conflict");
    }
    let opened: DatabaseSync | undefined;
    try {
      this.db = opened = new DatabaseSync(join(home, "state.sqlite"));
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0");
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (version > 1) throw new Error("state_version");
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS writer(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, owner TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY, owner_node TEXT NOT NULL, bee_id TEXT NOT NULL, message_id INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','done','held')), UNIQUE(owner_node,bee_id,message_id));
        CREATE TABLE IF NOT EXISTS evidence(seq INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, message_id INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS context(id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT, memory TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '');
        INSERT OR IGNORE INTO context(id) VALUES(1);
        PRAGMA user_version=1;
        COMMIT;`);
      const previous = this.db.prepare("SELECT epoch,owner FROM writer WHERE id=1").get();
      if (previous) {
        const prior = JSON.parse(String(previous.owner)) as Owner;
        if (prior.ownerNode !== owner.ownerNode || prior.beeId !== owner.beeId || prior.generation > owner.generation) throw new Error("writer_conflict");
      }
      this.epoch = Number(previous?.epoch ?? 0) + 1;
      this.db.prepare("INSERT INTO writer(id,epoch,owner) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,owner=excluded.owner").run(this.epoch, JSON.stringify(owner));
      this.db.prepare("UPDATE inbox SET status='pending' WHERE owner_node=? AND bee_id=? AND status='running'").run(owner.ownerNode, owner.beeId);
    } catch (error) {
      opened?.close();
      this.lock.close();
      throw error;
    }
  }
  accept(frame: Extract<InputFrame, { type: "mail" }>): void {
    if (this.closed) throw new Error("state_closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT body FROM inbox WHERE owner_node=? AND bee_id=? AND message_id=?").get(this.owner.ownerNode, this.owner.beeId, frame.messageId);
      if (prior && prior.body !== frame.body) throw new Error("message_collision");
      this.db.prepare("INSERT OR IGNORE INTO inbox(owner_node,bee_id,message_id,body,status) VALUES(?,?,?,?,'pending')").run(this.owner.ownerNode, this.owner.beeId, frame.messageId, frame.body);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  next(): Pending | null {
    if (this.closed || this.turn !== null) return null;
    const r = this.db.prepare("SELECT message_id,body FROM inbox WHERE owner_node=? AND bee_id=? AND status='pending' ORDER BY seq LIMIT 1").get(this.owner.ownerNode, this.owner.beeId);
    if (!r) return null;
    this.turn = Number(r.message_id);
    this.db.prepare("UPDATE inbox SET status='running' WHERE owner_node=? AND bee_id=? AND message_id=?").run(this.owner.ownerNode, this.owner.beeId, this.turn);
    return { messageId: this.turn, body: String(r.body) };
  }
  context(): { sessionId?: string; memory: string; summary: string } {
    const r = this.db.prepare("SELECT * FROM context WHERE id=1").get()!;
    return { ...(r.session_id ? { sessionId: String(r.session_id) } : {}), memory: String(r.memory), summary: String(r.summary) };
  }
  record(epoch: number, messageId: number, value: unknown): void {
    this.fence(epoch, messageId);
    this.db.prepare("INSERT INTO evidence(epoch,message_id,body) VALUES(?,?,?)").run(epoch, messageId, JSON.stringify(value));
  }
  session(epoch: number, messageId: number, sessionId: string): void {
    this.fence(epoch, messageId);
    this.db.prepare("UPDATE context SET session_id=? WHERE id=1").run(sessionId);
  }
  finish(epoch: number, messageId: number, success: boolean): void {
    this.fence(epoch, messageId);
    this.db.prepare("UPDATE inbox SET status=? WHERE owner_node=? AND bee_id=? AND message_id=?").run(success ? "done" : "held", this.owner.ownerNode, this.owner.beeId, messageId);
    this.turn = null;
  }
  private fence(epoch: number, messageId: number): void {
    if (this.closed || epoch !== this.epoch || this.turn !== messageId) throw new Error("stale_callback");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lock.close();
  }
}
