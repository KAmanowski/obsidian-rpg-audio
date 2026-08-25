import {FadeEngine} from "./fade-engine";
import {VolumeChangeDirection} from "./types";

interface ActiveVolumeFade {
	target: number;
	current: number;
	remainingMs: number;
	startedAt: number | null;
	runFrom: number;
	runDurationMs: number;
	onTick: (value: number) => void;
	onComplete: () => void;
}

/**
 * Owns pausable, per-track volume automation independently of transport fades.
 */
export class VolumeFadeController {
	private engine = new FadeEngine();
	private active: Map<string, ActiveVolumeFade> = new Map();

	start(
		id: string,
		from: number,
		to: number,
		durationMs: number,
		onTick: (value: number) => void,
		onComplete: () => void,
	): boolean {
		this.cancel(id);
		if (durationMs <= 0 || from === to) return false;

		const fade: ActiveVolumeFade = {
			target: to,
			current: from,
			remainingMs: durationMs,
			startedAt: null,
			runFrom: from,
			runDurationMs: durationMs,
			onTick,
			onComplete,
		};
		this.active.set(id, fade);
		this.run(id, fade);
		return true;
	}

	pause(id: string): void {
		const fade = this.active.get(id);
		if (!fade || fade.startedAt === null) return;

		const elapsed = Math.max(0, Math.min(fade.runDurationMs, performance.now() - fade.startedAt));
		const progress = fade.runDurationMs > 0 ? elapsed / fade.runDurationMs : 1;
		fade.current = fade.runFrom + (fade.target - fade.runFrom) * progress;
		fade.onTick(fade.current);
		fade.remainingMs = Math.max(0, fade.runDurationMs - elapsed);
		fade.startedAt = null;
		this.engine.cancel(id);
		if (fade.remainingMs <= 0) this.complete(id, fade);
	}

	resume(id: string): void {
		const fade = this.active.get(id);
		if (fade && fade.startedAt === null && fade.remainingMs > 0) this.run(id, fade);
	}

	getDirection(id: string): VolumeChangeDirection {
		const fade = this.active.get(id);
		if (!fade || fade.startedAt === null || fade.current === fade.target) return null;
		return fade.target > fade.current ? "increasing" : "decreasing";
	}

	cancel(id: string): void {
		this.engine.cancel(id);
		this.active.delete(id);
	}

	cancelAll(): void {
		this.engine.cancelAll();
		this.active.clear();
	}

	destroy(): void {
		this.engine.destroy();
		this.active.clear();
	}

	private run(id: string, fade: ActiveVolumeFade): void {
		fade.runFrom = fade.current;
		fade.runDurationMs = fade.remainingMs;
		fade.startedAt = performance.now();
		void this.engine.start(id, fade.current, fade.target, fade.remainingMs, (value) => {
			if (this.active.get(id) !== fade) return;
			fade.current = value;
			fade.onTick(value);
		}).then((completed) => {
			if (completed && this.active.get(id) === fade) this.complete(id, fade);
		}).catch((error) => {
			console.error(`RPG Audio: configured volume fade failed for "${id}"`, error);
		});
	}

	private complete(id: string, fade: ActiveVolumeFade): void {
		fade.current = fade.target;
		fade.onTick(fade.target);
		this.active.delete(id);
		fade.onComplete();
	}
}
