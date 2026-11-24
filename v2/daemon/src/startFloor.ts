import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describeStartFloor, type NodeVolumeFacts, type StartFloorDetail, type StartFloorMetric, type StartVolumeRole } from "../../core/src/index.ts";
import type { ResolvedStartFloor } from "./config.ts";

export interface StartVolumeStat {
  device: string;
  totalBytes: number;
  freeBytes: number;
  totalInodes: number | null;
  freeInodes: number | null;
}

export type StartVolumeStatfs = (path: string) => StartVolumeStat;

export interface StartVolumeRolePath {
  role: StartVolumeRole;
  path: string;
}

export type StartSubstrate = "cell" | "hsr";

export interface StartFloorReading {
  at: number;
  volumes: NodeVolumeFacts[];
  below: StartFloorDetail | null;
  blocksSessions: StartFloorDetail | null;
  blocksCells: StartFloorDetail | null;
  since: number | null;
}

export interface StartFloorRefusal {
  message: string;
  details: { reason: "start_floor" } & StartFloorDetail;
}

export interface StartFloorDeps {
  policy: ResolvedStartFloor;
  roles: () => readonly StartVolumeRolePath[];
  now: () => number;
  log: (op: string) => void;
  statfs?: StartVolumeStatfs;
  sampleMs?: number;
  belowSampleMs?: number;
}

export const DEFAULT_START_FLOOR_SAMPLE_MS = 60_000;
export const DEFAULT_START_FLOOR_BELOW_SAMPLE_MS = 5_000;

const CELL_ONLY_ROLES: ReadonlySet<StartVolumeRole> = new Set(["cells"]);

export function hostTmpPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "/private/tmp" : "/tmp";
}

export function defaultStartVolumeStatfs(path: string): StartVolumeStat {
  const st = statfsSync(path);
  const files = Number(st.files);
  const hasInodeTable = files > 0;
  return {
    device: String(statSync(path).dev),
    totalBytes: Number(st.blocks) * Number(st.bsize),
    freeBytes: Number(st.bavail) * Number(st.bsize),
    totalInodes: hasInodeTable ? files : null,
    freeInodes: hasInodeTable ? Number(st.ffree) : null,
  };
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

function metricBelow(volume: NodeVolumeFacts): StartFloorMetric | null {
  if (volume.floorBytes != null && volume.freeBytes < volume.floorBytes) return "bytes";
  if (volume.floorInodes != null && volume.freeInodes != null && volume.freeInodes < volume.floorInodes) return "inodes";
  return null;
}

function detailOf(volume: NodeVolumeFacts, roles: readonly StartVolumeRole[]): StartFloorDetail {
  const metric = volume.below!;
  return {
    role: roles[0]!,
    path: volume.path,
    metric,
    free: metric === "bytes" ? volume.freeBytes : volume.freeInodes!,
    floor: metric === "bytes" ? volume.floorBytes! : volume.floorInodes!,
  };
}

export class StartFloor {
  private readonly deps: StartFloorDeps;
  private reading: StartFloorReading | null = null;
  private blockedSince: number | null = null;
  private readonly unreadable = new Map<string, string>();
  private readonly bytesFloorSkipped = new Set<string>();

  constructor(deps: StartFloorDeps) {
    this.deps = deps;
  }

  get policy(): ResolvedStartFloor {
    return this.deps.policy;
  }

  current(): StartFloorReading {
    return this.reading ?? this.sample();
  }

  tick(): boolean {
    const previous = this.reading;
    if (previous != null) {
      const interval = previous.below != null
        ? this.deps.belowSampleMs ?? DEFAULT_START_FLOOR_BELOW_SAMPLE_MS
        : this.deps.sampleMs ?? DEFAULT_START_FLOOR_SAMPLE_MS;
      if (this.deps.now() - previous.at < interval) return false;
    }
    this.sample();
    return true;
  }

  blocking(substrate: StartSubstrate, reading: StartFloorReading = this.current()): StartFloorDetail | null {
    return substrate === "cell" ? reading.blocksCells : reading.blocksSessions;
  }

  refusal(verb: string, substrate: StartSubstrate): StartFloorRefusal | null {
    const blocking = this.blocking(substrate, this.sample());
    if (blocking == null) return null;
    return {
      message: `${verb}: this computer cannot start sessions: ${describeStartFloor(blocking)}`,
      details: { reason: "start_floor", ...blocking },
    };
  }

  sample(): StartFloorReading {
    const at = this.deps.now();
    const policy = this.deps.policy;
    const byDevice = new Map<string, { roles: StartVolumeRole[]; path: string; stat: StartVolumeStat }>();
    for (const { role, path } of this.deps.roles()) {
      let stat: StartVolumeStat;
      try {
        stat = (this.deps.statfs ?? defaultStartVolumeStatfs)(nearestExisting(path));
        this.unreadable.delete(role);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (this.unreadable.get(role) !== detail) this.deps.log(`node.start_floor.statfs_failed role=${role} path=${path} err=${JSON.stringify(detail)}`);
        this.unreadable.set(role, detail);
        continue;
      }
      const known = byDevice.get(stat.device);
      if (known) {
        if (!known.roles.includes(role)) known.roles.push(role);
      } else {
        byDevice.set(stat.device, { roles: [role], path, stat });
      }
    }
    const volumes: NodeVolumeFacts[] = [...byDevice.values()].map(({ roles, path, stat }) => {
      const bytesFloorFits = policy.minFreeBytes < stat.totalBytes;
      if (!bytesFloorFits && !this.bytesFloorSkipped.has(path)) {
        this.bytesFloorSkipped.add(path);
        this.deps.log(`node.start_floor.bytes_floor_skipped path=${path} total=${stat.totalBytes} floor=${policy.minFreeBytes}`);
      }
      const volume: NodeVolumeFacts = {
        roles,
        path,
        totalBytes: stat.totalBytes,
        freeBytes: stat.freeBytes,
        totalInodes: stat.totalInodes,
        freeInodes: stat.freeInodes,
        floorBytes: bytesFloorFits ? policy.minFreeBytes : null,
        floorInodes: stat.totalInodes == null ? null : policy.minFreeInodes,
        below: null,
      };
      volume.below = metricBelow(volume);
      return volume;
    });
    const firstBelow = volumes.find((volume) => volume.below != null);
    const below = firstBelow ? detailOf(firstBelow, firstBelow.roles) : null;
    const sessionVolume = volumes.find((volume) => volume.below != null && volume.roles.some((role) => !CELL_ONLY_ROLES.has(role)));
    const sessionDetail = sessionVolume ? detailOf(sessionVolume, sessionVolume.roles.filter((role) => !CELL_ONLY_ROLES.has(role))) : null;
    const blocksSessions = policy.enabled ? sessionDetail : null;
    const blocksCells = policy.enabled ? sessionDetail ?? below : null;
    if (blocksCells) this.blockedSince ??= at;
    else this.blockedSince = null;
    const previous = this.reading;
    const reading: StartFloorReading = { at, volumes, below, blocksSessions, blocksCells, since: this.blockedSince };
    this.reading = reading;
    this.logTransition(previous, reading);
    return reading;
  }

  private logTransition(previous: StartFloorReading | null, next: StartFloorReading): void {
    const was = previous?.below ?? null;
    const now = next.below;
    if ((was == null) === (now == null) && was?.role === now?.role && was?.metric === now?.metric) return;
    if (now) this.deps.log(`node.start_floor.below role=${now.role} path=${now.path} metric=${now.metric} free=${now.free} floor=${now.floor} refusing_sessions=${next.blocksSessions != null} refusing_cells=${next.blocksCells != null}`);
    else this.deps.log("node.start_floor.clear");
  }
}
