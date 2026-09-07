/**
 * Architecture sketch only. This file shows deltas against source baseline
 * 501710c18515c4ac077a643c50daba2ce9043958 and is not intended to compile.
 */

type DeliverOutcome =
	| { accepted: true }
	| { accepted: false; reason: "no_process" | "not_ready" };

type ResolveSpawn = (beeId: string) => unknown;

namespace CandidateARecommended {
	/** Add this field to the existing exported HsrDriverConfig. */
	export interface HsrDriverConfigDelta {
		/**
		 * Retain the latest accepted generation for each message id.
		 * Omitted or true preserves existing behavior. False allocates no history Map.
		 */
		recordDeliveryHistory?: boolean;
	}

	type AcceptedDeliveryHistory = Map<number, number> | null;

	export class HsrDriverDelta {
		private readonly consumed: AcceptedDeliveryHistory;

		constructor(cfg: HsrDriverConfigDelta) {
			// TODO: this.consumed = cfg.recordDeliveryHistory === false ? null : new Map();
			throw new Error("not implemented");
		}

		deliver(
			beeId: string,
			generation: number,
			messageId: number,
			body: string,
		): DeliverOutcome {
			// TODO: preserve the existing method byte-for-byte except for these writes:
			//   confirmed acknowledgement acceptance:
			//     if (p.confirmedDeliveries.delete(messageId)) {
			//       this.consumed?.set(messageId, generation);
			//       return { accepted: true };
			//     }
			//   direct acceptance, after writeLine succeeds:
			//     if (!p.adapter.confirmsDelivery) this.consumed?.set(messageId, generation);
			// Never derive the record from the returned DeliverOutcome.
			void beeId;
			void generation;
			void messageId;
			void body;
			throw new Error("not implemented");
		}

		consumedGeneration(messageId: number): number | undefined {
			// TODO: return this.requiredDeliveryHistory().get(messageId);
			void messageId;
			throw new Error("not implemented");
		}

		consumedCount(): number {
			// TODO: return this.requiredDeliveryHistory().size;
			throw new Error("not implemented");
		}

		private requiredDeliveryHistory(): Map<number, number> {
			// TODO: if (this.consumed === null), throw Error("HsrDriver delivery history is disabled").
			// TODO: otherwise return this.consumed.
			throw new Error("not implemented");
		}
	}

	/** Existing fields are abbreviated. CellDriverConfig itself does not change. */
	export interface HsrDriverConfig extends HsrDriverConfigDelta {
		sessionLogDir: string;
		resolve: ResolveSpawn;
		stopKillGraceMs?: number;
		adoptToleranceMs?: number;
	}

	export interface CellDriverConfig {
		// Existing Cell fields remain unchanged.
		hsr: Omit<HsrDriverConfig, "resolve">;
	}

	export function builtInDaemonHsrConfig(): Omit<HsrDriverConfig, "resolve"> {
		// TODO: construct the daemon's existing shared object with
		// recordDeliveryHistory: false. Pass it to both the direct HsrDriver and
		// CellDriverConfig.hsr. Do not add this field to the Tmux config in unit 1.
		throw new Error("not implemented");
	}
}

namespace CandidateBSeparateClasses {
	/** Module-private. Callers cannot supply a throwing or reentrant callback. */
	class AcceptedDeliveryRecorder {
		private readonly byMessageId = new Map<number, number>();

		record(messageId: number, generation: number): void {
			// TODO: this.byMessageId.set(messageId, generation).
			void messageId;
			void generation;
			throw new Error("not implemented");
		}

		generationOf(messageId: number): number | undefined {
			void messageId;
			throw new Error("not implemented");
		}

		count(): number {
			throw new Error("not implemented");
		}
	}

	/** Internal shared implementation of every current HSR runtime operation. */
	abstract class HsrDriverBase {
		protected constructor(
			cfg: unknown,
			private readonly acceptedDeliveries: AcceptedDeliveryRecorder | null,
		) {
			void cfg;
			throw new Error("not implemented");
		}

		deliver(
			beeId: string,
			generation: number,
			messageId: number,
			body: string,
		): DeliverOutcome {
			// TODO: call acceptedDeliveries?.record() at the two existing internal
			// acceptance sites. No externally supplied hook is involved.
			void beeId;
			void generation;
			void messageId;
			void body;
			throw new Error("not implemented");
		}

		// All other existing HsrDriver runtime and daemon-extension methods remain here.
	}

	/** Built-in daemon class. It owns no recorder and exposes no history queries. */
	export class HsrRuntimeDriver extends HsrDriverBase {
		constructor(cfg: unknown) {
			// TODO: super(cfg, null).
			super(cfg, null);
			throw new Error("not implemented");
		}
	}

	/** Existing exported class name and omitted-option behavior. */
	export class HsrDriver extends HsrDriverBase {
		private readonly history: AcceptedDeliveryRecorder;

		constructor(cfg: unknown) {
			const history = new AcceptedDeliveryRecorder();
			super(cfg, history);
			this.history = history;
			throw new Error("not implemented");
		}

		consumedGeneration(messageId: number): number | undefined {
			void messageId;
			throw new Error("not implemented");
		}

		consumedCount(): number {
			throw new Error("not implemented");
		}
	}

	/**
	 * Cell needs parallel compatibility and runtime-only classes because its
	 * public history methods currently delegate to a concrete inner HsrDriver.
	 */
	export class CellDriver {
		private readonly inner: HsrDriver;

		constructor(cfg: unknown) {
			void cfg;
			throw new Error("not implemented");
		}

		consumedGeneration(messageId: number): number | undefined {
			void messageId;
			throw new Error("not implemented");
		}

		consumedCount(): number {
			throw new Error("not implemented");
		}
	}

	export class CellRuntimeDriver {
		private readonly inner: HsrRuntimeDriver;

		constructor(cfg: unknown) {
			void cfg;
			throw new Error("not implemented");
		}
	}

	/** SubstrateRouter's concrete child types must widen under this design. */
	export interface SubstrateRouterConfigDelta {
		hsr: HsrDriver | HsrRuntimeDriver;
		cell: CellDriver | CellRuntimeDriver;
		// tmux stays on its existing type in unit 1.
	}
}
