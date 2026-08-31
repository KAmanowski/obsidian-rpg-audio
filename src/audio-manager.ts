import { App, Events } from "obsidian";
import {
	AudioTrackDef,
	AudioTrackState,
	PlayState,
	TrackCause,
	TrackCauseKind,
	TrackAction,
	VolumeChangeDirection,
	EVENT_TRACK_CHANGED,
	EVENT_TRACKS_UPDATED,
	EVENT_MASTER_VOLUME,
	EVENT_ALLOW_AUTOPLAY,
	EVENT_ACTIVE_SCOPE_CHANGED,
	EVENT_TIME_UPDATE,
	EVENT_REVERB_CHANGED,
	EVENT_REVERB_PRESETS_CHANGED,
	ORPHAN_CHECK_DELAY_MS,
} from "./types";
import { FadeEngine } from "./fade-engine";
import { VolumeFadeController } from "./volume-fade-controller";
import { findAudioFile } from "./audio-file-resolver";
import { isValidPlaylistIndex, resolveConfiguredRegion } from "./playlist-utils";
import { ReverbBus, REVERB_OFF, getPreset } from "./reverb-engine";

type CauseInput = {kind: TrackCauseKind; detail?: string};

interface TrackAudioGraph {
	el: HTMLAudioElement;
	gain: GainNode;
	dry: GainNode;
	send: GainNode;
}

function buildCause(action: TrackAction, input: CauseInput | undefined): TrackCause {
	return {
		action,
		kind: input?.kind ?? "user",
		detail: input?.detail,
		at: Date.now(),
	};
}

function matchesDirective(tokens: string[], otherId: string, otherType: string): boolean {
	let matched = false;
	for (const token of tokens) {
		if (token.startsWith("!")) {
			const negated = token.slice(1);
			if (negated === otherType || negated === otherId) return false;
		} else if (token === otherType || token === otherId) {
			matched = true;
		}
	}
	return matched;
}

export class AudioManager extends Events {
	private app: App;
	private tracks: Map<string, AudioTrackState> = new Map();
	private audioElements: Map<string, HTMLAudioElement> = new Map();
	private gainNodes: Map<string, GainNode> = new Map();
	private dryNodes: Map<string, GainNode> = new Map();
	private sendNodes: Map<string, GainNode> = new Map();
	private trackSends: Map<string, number> = new Map();
	private audioContext: AudioContext | null = null;
	private masterBus: GainNode | null = null;
	private limiter: DynamicsCompressorNode | null = null;
	private _limiterEnabled = true;
	private reverb: ReverbBus | null = null;
	private _reverbPreset: string = REVERB_OFF;
	private _reverbWet = 0.35;
	private _reverbBypassed = false;
	private orphanTimers: Map<string, number> = new Map();
	private unregistering: Set<string> = new Set();
	private _masterVolume = 1.0;
	private _audioFolder = "";
	private fades = new FadeEngine();
	/** Independent lane so configured volume automation cannot cancel transport fades. */
	private volumeFades = new VolumeFadeController();
	private fadeMultipliers: Map<string, number> = new Map();
	/** Tracks currently undergoing a non-region fade towards silence. */
	private fadingOut: Set<string> = new Set();
	/** Tracks currently undergoing a non-region fade towards full volume. */
	private fadingIn: Set<string> = new Set();
	private _crossfadeDuration = 0;
	private _playFadeDuration = 0;
	private _autoplayDelay = 0;
	private _allowAutoplay = false;
	private playFades: Map<string, "out" | "in"> = new Map();
	private _activeScope: Set<string> = new Set();
	private regionFadeMultipliers: Map<string, number> = new Map();
	private regionFadeInDone: Set<string> = new Set();
	private regionOverrides: Map<string, Map<number, {startTime: number | null; endTime: number | null}>> = new Map();
	private loopOverrides: Map<string, boolean> = new Map();
	private playlistVisited: Map<string, Set<number>> = new Map();
	private playlistCrossfading: Set<string> = new Set();
	private playlistCrossfadeFailed: Set<string> = new Set();
	private playlistCrossfadeMultipliers: Map<string, number> = new Map();
	private outgoingPlaylistGraphs: Map<string, TrackAudioGraph> = new Map();
	/** Invalidates stale async media-source changes after stop or a newer selection. */
	private sourceRequestVersions: Map<string, number> = new Map();

	constructor(app: App) {
		super();
		this.app = app;
	}

	private ensureAudioContext(): AudioContext {
		if (!this.audioContext) {
			this.audioContext = new AudioContext();
		}
		if (this.audioContext.state === "suspended") {
			this.audioContext.resume().catch(() => {});
		}
		return this.audioContext;
	}

	/**
	 * Everything sums here before the output, so a single limiter can catch peaks.
	 * Source material is often already mastered near full scale; adding any reverb
	 * to that has nowhere to go without a safety net.
	 */
	private ensureMasterBus(): GainNode {
		const ctx = this.ensureAudioContext();
		if (!this.masterBus) {
			this.masterBus = ctx.createGain();
			this.limiter = ctx.createDynamicsCompressor();
			this.limiter.threshold.value = -3;
			this.limiter.knee.value = 0;
			this.limiter.ratio.value = 20;
			this.limiter.attack.value = 0.003;
			this.limiter.release.value = 0.25;
			this.applyLimiterRouting();
		}
		return this.masterBus;
	}

	private applyLimiterRouting(): void {
		const ctx = this.audioContext;
		if (!ctx || !this.masterBus || !this.limiter) return;
		this.masterBus.disconnect();
		this.limiter.disconnect();
		if (this._limiterEnabled) {
			this.masterBus.connect(this.limiter);
			this.limiter.connect(ctx.destination);
		} else {
			this.masterBus.connect(ctx.destination);
		}
	}

	get limiterEnabled(): boolean { return this._limiterEnabled; }
	set limiterEnabled(value: boolean) {
		if (this._limiterEnabled === value) return;
		this._limiterEnabled = value;
		this.applyLimiterRouting();
	}

	private ensureReverbBus(): ReverbBus {
		const ctx = this.ensureAudioContext();
		if (!this.reverb) {
			this.reverb = new ReverbBus(ctx, this.ensureMasterBus());
			this.reverb.setPreset(this._reverbPreset);
		}
		return this.reverb;
	}

	/** Re-synthesize the active preset after its parameters were edited. */
	refreshReverb(): void {
		this.reverb?.refresh();
		this.applyReverbMixAll();
	}

	/** Fire after the preset list changes (add/delete/reset) so the sidebar updates. */
	notifyPresetsChanged(): void {
		this.trigger(EVENT_REVERB_PRESETS_CHANGED);
	}

	private createAudioGraph(id: string, el: HTMLAudioElement): TrackAudioGraph {
		const ctx = this.ensureAudioContext();
		const master = this.ensureMasterBus();
		const bus = this.ensureReverbBus();
		const source = ctx.createMediaElementSource(el);
		const gain = ctx.createGain();
		source.connect(gain);

		// Dry path — gain computed by applyReverbMix.
		const dry = ctx.createGain();
		gain.connect(dry);
		dry.connect(master);

		// Wet send — post-gain so track fades carry the reverb tail with them.
		const send = ctx.createGain();
		gain.connect(send);
		send.connect(bus.input);

		this.applyReverbMixToNodes(id, dry, send);
		return {el, gain, dry, send};
	}

	private installAudioGraph(id: string, graph: TrackAudioGraph): void {
		this.audioElements.set(id, graph.el);
		this.gainNodes.set(id, graph.gain);
		this.dryNodes.set(id, graph.dry);
		this.sendNodes.set(id, graph.send);
	}

	private getInstalledAudioGraph(id: string): TrackAudioGraph | null {
		const el = this.audioElements.get(id);
		const gain = this.gainNodes.get(id);
		const dry = this.dryNodes.get(id);
		const send = this.sendNodes.get(id);
		return el && gain && dry && send ? {el, gain, dry, send} : null;
	}

	private disposeAudioGraph(graph: TrackAudioGraph): void {
		graph.el.pause();
		graph.el.removeAttribute("src");
		graph.el.load();
		graph.gain.disconnect();
		graph.dry.disconnect();
		graph.send.disconnect();
	}

	private getOrCreateGainNode(id: string, el: HTMLAudioElement): GainNode {
		const existing = this.gainNodes.get(id);
		if (existing) return existing;
		const graph = this.createAudioGraph(id, el);
		this.installAudioGraph(id, graph);
		return graph.gain;
	}

	set audioFolder(value: string) {
		this._audioFolder = value;
	}

	get crossfadeDuration(): number {
		return this._crossfadeDuration;
	}

	set crossfadeDuration(value: number) {
		this._crossfadeDuration = value;
	}

	get playFadeDuration(): number {
		return this._playFadeDuration;
	}

	set playFadeDuration(value: number) {
		this._playFadeDuration = value;
	}

	get autoplayDelay(): number {
		return this._autoplayDelay;
	}

	set autoplayDelay(value: number) {
		this._autoplayDelay = value;
	}

	get allowAutoplay(): boolean {
		return this._allowAutoplay;
	}

	set allowAutoplay(value: boolean) {
		if (this._allowAutoplay === value) return;
		this._allowAutoplay = value;
		this.trigger(EVENT_ALLOW_AUTOPLAY, value);
	}

	get masterVolume(): number {
		return this._masterVolume;
	}

	set masterVolume(value: number) {
		this._masterVolume = Math.max(0, Math.min(1, value));
		for (const [id] of this.tracks) {
			this.applyVolume(id);
		}
		this.trigger(EVENT_MASTER_VOLUME, this._masterVolume);
	}

	get reverbPreset(): string { return this._reverbPreset; }
	set reverbPreset(id: string) {
		this._reverbPreset = id;
		if (this.reverb) this.reverb.setPreset(id);
		this.applyReverbMixAll();
		this.trigger(EVENT_REVERB_CHANGED, id, this._reverbWet);
	}

	get reverbBypassed(): boolean { return this._reverbBypassed; }
	set reverbBypassed(value: boolean) {
		if (this._reverbBypassed === value) return;
		this._reverbBypassed = value;
		if (this.reverb) {
			this.reverb.setPreset(value ? REVERB_OFF : this._reverbPreset);
		}
		this.applyReverbMixAll();
		this.trigger(EVENT_REVERB_CHANGED, this._reverbPreset, this._reverbWet);
	}

	get reverbWet(): number { return this._reverbWet; }
	set reverbWet(value: number) {
		this._reverbWet = Math.max(0, Math.min(1, value));
		this.applyReverbMixAll();
		this.trigger(EVENT_REVERB_CHANGED, this._reverbPreset, this._reverbWet);
	}

	setTrackReverbSend(id: string, value: number): void {
		this.trackSends.set(id, Math.max(0, Math.min(1, value)));
		this.applyReverbMix(id);
	}

	private applyReverbMix(id: string): void {
		const dry = this.dryNodes.get(id);
		const send = this.sendNodes.get(id);
		if (!dry || !send) return;
		this.applyReverbMixToNodes(id, dry, send);
	}

	private applyReverbMixToNodes(id: string, dry: GainNode, send: GainNode): void {

		if (this._reverbPreset === REVERB_OFF || this._reverbBypassed) {
			dry.gain.value = 1;
			send.gain.value = 0;
			return;
		}

		const preset = getPreset(this._reverbPreset);
		const trim = preset?.wetTrim ?? 1;
		const trackSend = this.trackSends.get(id) ?? 1;
		const wet = Math.max(0, Math.min(1, this._reverbWet * trackSend));

		// Send-style mix rather than equal-power. An equal-power crossfade drops the
		// dry signal to zero at full wet, which kills transients — attacks live almost
		// entirely in the dry path. Holding dry near unity keeps the punch; the master
		// limiter absorbs the extra headroom this costs.
		dry.gain.value = 1 - 0.45 * wet * wet;
		send.gain.value = wet * trim;
	}

	private applyReverbMixAll(): void {
		for (const [id] of this.tracks) this.applyReverbMix(id);
	}

	getAllTracks(): AudioTrackState[] {
		return Array.from(this.tracks.values());
	}

	get activeScope(): string[] {
		return Array.from(this._activeScope);
	}

	getCurrentTime(id: string): number {
		const el = this.audioElements.get(id);
		return el ? el.currentTime : 0;
	}

	getDuration(id: string): number {
		const el = this.audioElements.get(id);
		return el && isFinite(el.duration) ? el.duration : 0;
	}

	private beginSourceRequest(id: string): number {
		const version = (this.sourceRequestVersions.get(id) ?? 0) + 1;
		this.sourceRequestVersions.set(id, version);
		return version;
	}

	private isCurrentSourceRequest(id: string, version: number): boolean {
		return this.sourceRequestVersions.get(id) === version;
	}

	private invalidateSourceRequest(id: string): void {
		this.sourceRequestVersions.set(id, (this.sourceRequestVersions.get(id) ?? 0) + 1);
	}

	private cancelPlaylistCrossfade(id: string): void {
		this.fades.cancel(`${id}:playlist-in`);
		this.fades.cancel(`${id}:playlist-out`);
		const outgoing = this.outgoingPlaylistGraphs.get(id);
		if (outgoing) this.disposeAudioGraph(outgoing);
		this.outgoingPlaylistGraphs.delete(id);
		this.playlistCrossfading.delete(id);
		this.playlistCrossfadeFailed.delete(id);
		this.playlistCrossfadeMultipliers.delete(id);
		this.applyVolume(id);
	}

	getMissingAudioFiles(paths: string[]): string[] {
		return paths.filter(path => !findAudioFile(this.app.vault, this._audioFolder, path));
	}

	/** Whether this track is currently fading towards silence, including a region fade-out. */
	isFadingOut(id: string): boolean {
		if (this.fadingOut.has(id)) return true;
		const state = this.tracks.get(id);
		const el = this.audioElements.get(id);
		if (!state || !el || state.playState !== PlayState.Playing || this.getEffectiveLoop(id)) return false;
		const region = this.getEffectiveRegion(id);
		return region.endTime !== null && state.def.fadeOutDuration > 0
			&& el.currentTime >= region.endTime - state.def.fadeOutDuration;
	}

	/** Whether this track is currently fading towards full volume, including a region fade-in. */
	isFadingIn(id: string): boolean {
		if (this.fadingIn.has(id)) return true;
		const state = this.tracks.get(id);
		const el = this.audioElements.get(id);
		if (!state || !el || state.playState !== PlayState.Playing) return false;
		const region = this.getEffectiveRegion(id);
		return region.startTime !== null && state.def.fadeInDuration > 0
			&& !this.regionFadeInDone.has(id)
			&& el.currentTime < region.startTime + state.def.fadeInDuration;
	}

	/** Direction of the track's effective volume change for UI feedback. */
	getVolumeChangeDirection(id: string): VolumeChangeDirection {
		// Explicit outgoing fades remain red. Otherwise the configured volume
		// direction takes precedence so a downward automation never flashes green
		// merely because playback also has a short incoming fade multiplier.
		if (this.isFadingOut(id)) return "decreasing";
		const configuredDirection = this.volumeFades.getDirection(id);
		if (configuredDirection) return configuredDirection;
		return this.isFadingIn(id) ? "increasing" : null;
	}

	private setFadingOut(id: string, value: boolean): void {
		const changed = value ? !this.fadingOut.has(id) : this.fadingOut.delete(id);
		if (value) this.fadingOut.add(id);
		if (changed) this.trigger(EVENT_TRACK_CHANGED, id);
	}

	private setFadingIn(id: string, value: boolean): void {
		const changed = value ? !this.fadingIn.has(id) : this.fadingIn.delete(id);
		if (value) this.fadingIn.add(id);
		if (changed) this.trigger(EVENT_TRACK_CHANGED, id);
	}

	seek(id: string, time: number): void {
		const el = this.audioElements.get(id);
		const state = this.tracks.get(id);
		if (!el || !state) return;
		const region = this.getEffectiveRegion(id);
		const lo = region.startTime ?? 0;
		const hi = region.endTime ?? (isFinite(el.duration) ? el.duration : Infinity);
		el.currentTime = Math.max(lo, Math.min(hi, time));
	}

	getEffectiveRegion(id: string): {startTime: number | null; endTime: number | null} {
		const state = this.tracks.get(id);
		if (!state) return {startTime: null, endTime: null};
		return this.getEffectiveRegionForIndex(id, state.currentIndex);
	}

	private getEffectiveRegionForIndex(id: string, index: number): {startTime: number | null; endTime: number | null} {
		const state = this.tracks.get(id);
		if (!state) return {startTime: null, endTime: null};
		const override = this.regionOverrides.get(id)?.get(index);
		if (override) return override;
		const entry = state.def.entries[index];
		return resolveConfiguredRegion(entry, state.def.startTime, state.def.endTime);
	}

	setEffectiveRegion(id: string, startTime: number | null, endTime: number | null): void {
		const el = this.audioElements.get(id);
		const state = this.tracks.get(id);
		if (!state) return;
		let overrides = this.regionOverrides.get(id);
		if (!overrides) {
			overrides = new Map();
			this.regionOverrides.set(id, overrides);
		}
		overrides.set(state.currentIndex, {startTime, endTime});
		if (el && state && state.playState === PlayState.Playing) {
			const lo = startTime ?? 0;
			const hi = endTime ?? (isFinite(el.duration) ? el.duration : Infinity);
			if (el.currentTime < lo) el.currentTime = lo;
			if (el.currentTime > hi) el.currentTime = hi;
		}
		this.trigger(EVENT_TRACK_CHANGED, id);
	}

	clearRegionOverride(id: string): void {
		const state = this.tracks.get(id);
		if (!state) return;
		const overrides = this.regionOverrides.get(id);
		overrides?.delete(state.currentIndex);
		if (overrides?.size === 0) this.regionOverrides.delete(id);
	}

	getEffectiveLoop(id: string): boolean {
		if (this.loopOverrides.has(id)) return this.loopOverrides.get(id)!;
		return this.tracks.get(id)?.def.loop ?? false;
	}

	setLoopOverride(id: string, value: boolean): void {
		this.loopOverrides.set(id, value);
		const el = this.audioElements.get(id);
		const state = this.tracks.get(id);
		if (el && state) {
			const region = this.getEffectiveRegion(id);
			const hasRegion = region.startTime !== null || region.endTime !== null;
			el.loop = value && state.def.entries.length === 1 && !hasRegion;
		}
		this.trigger(EVENT_TRACK_CHANGED, id);
	}

	clearLoopOverride(id: string): void {
		this.loopOverrides.delete(id);
	}

	private isScopeSubset(child: string[], parent: Set<string>): boolean {
		for (const s of child) {
			if (!parent.has(s)) return false;
		}
		return true;
	}

	/** Returns true if any track was crossfaded out by the transition. */
	private applyScopeTransition(triggerId: string): boolean {
		const trigger = this.tracks.get(triggerId);
		if (!trigger || trigger.def.scope.length === 0) return false;

		const newActive = new Set(trigger.def.scope);
		const changed =
			newActive.size !== this._activeScope.size ||
			!this.isScopeSubset(Array.from(newActive), this._activeScope);
		this._activeScope = newActive;

		let crossfaded = false;
		for (const [otherId, other] of this.tracks) {
			if (otherId === triggerId) continue;
			if (other.def.scope.length === 0) continue;
			if (other.playState !== PlayState.Playing) continue;
			if (this.isScopeSubset(other.def.scope, newActive)) continue;

			const scopeCause: CauseInput = {
				kind: "scope",
				detail: `scope changed to {${Array.from(newActive).join(", ")}} by ${triggerId}`,
			};
			if (this._crossfadeDuration > 0) {
				this.fadeOutAndStop(otherId, this._crossfadeDuration, scopeCause);
				crossfaded = true;
			} else {
				this.stop(otherId, scopeCause);
			}
		}

		if (changed) this.trigger(EVENT_ACTIVE_SCOPE_CHANGED, this.activeScope);
		return crossfaded;
	}

	getTrack(id: string): AudioTrackState | undefined {
		return this.tracks.get(id);
	}

	register(def: AudioTrackDef): void {
		this.clearOrphanTimer(def.id);

		const existing = this.tracks.get(def.id);
		if (existing) {
			existing.def = def;
			this.trigger(EVENT_TRACKS_UPDATED);
			return;
		}

		this.tracks.set(def.id, {
			def,
			playState: PlayState.Stopped,
			volume: def.volume,
			currentIndex: 0,
			loadingIndex: null,
			errorIndex: null,
			error: null,
			lastCause: null,
		});
		this.trigger(EVENT_TRACKS_UPDATED);
	}

	unregister(id: string): void {
		// Break the stop → cleanupIfOrphaned → unregister → stop recursion: the
		// inner unregister returns here while the outer one finishes the teardown.
		if (this.unregistering.has(id)) return;
		this.unregistering.add(id);
		try {
			this.cancelPlaylistCrossfade(id);
			this.cancelConfiguredVolumeFade(id);
			this.fades.cancel(id);
			this.setFadingOut(id, false);
			this.setFadingIn(id, false);
			this.fadeMultipliers.delete(id);
			this.regionFadeMultipliers.delete(id);
			this.regionFadeInDone.delete(id);
			this.regionOverrides.delete(id);
			this.playlistVisited.delete(id);
			this.loopOverrides.delete(id);
			this.playFades.delete(id);
			this.trackSends.delete(id);
			this.stop(id);
			const el = this.audioElements.get(id);
			if (el) {
				el.pause();
				el.removeAttribute("src");
				el.load();
				this.audioElements.delete(id);
			}
			const gain = this.gainNodes.get(id);
			if (gain) {
				gain.disconnect();
				this.gainNodes.delete(id);
			}
			const dry = this.dryNodes.get(id);
			if (dry) { dry.disconnect(); this.dryNodes.delete(id); }
			const send = this.sendNodes.get(id);
			if (send) { send.disconnect(); this.sendNodes.delete(id); }
			this.tracks.delete(id);
			this.sourceRequestVersions.delete(id);
			this.trigger(EVENT_TRACKS_UPDATED);
		} finally {
			this.unregistering.delete(id);
		}
	}

	async play(id: string, skipPlayFadeIn = false, cause?: CauseInput, requestedIndex?: number): Promise<void> {
		const state = this.tracks.get(id);
		if (!state) return;

		const fadeMode = this.playFades.get(id);
		if (fadeMode === "out") {
			this.startPlayFadeIn(id);
			return;
		}
		if (fadeMode === "in") {
			return;
		}

		let crossfading = false;
		if (state.def.fadesout.length > 0) {
			for (const [otherId, other] of this.tracks) {
				if (otherId !== id && matchesDirective(state.def.fadesout, otherId, other.def.type) && other.playState === PlayState.Playing) {
					const directiveCause: CauseInput = {kind: "directive", detail: `fadesout from ${id}`};
					const duration = other.def.fadeOutDuration * 1000;
					if (duration > 0) {
						this.fadeOutAndStop(otherId, duration, directiveCause);
					} else {
						this.stop(otherId, directiveCause);
					}
				}
			}
		}

		if (state.def.stops.length > 0) {
			for (const [otherId, other] of this.tracks) {
				if (otherId !== id && matchesDirective(state.def.stops, otherId, other.def.type) && !matchesDirective(state.def.fadesout, otherId, other.def.type) && other.playState === PlayState.Playing) {
					const directiveCause: CauseInput = {kind: "directive", detail: `stops from ${id}`};
					if (this._crossfadeDuration > 0) {
						this.fadeOutAndStop(otherId, this._crossfadeDuration, directiveCause);
						crossfading = true;
					} else {
						this.stop(otherId, directiveCause);
					}
				}
			}
		}

		if (state.def.pauses.length > 0) {
			for (const [otherId, other] of this.tracks) {
				if (otherId !== id && matchesDirective(state.def.pauses, otherId, other.def.type) && other.playState === PlayState.Playing) {
					const directiveCause: CauseInput = {kind: "directive", detail: `pauses from ${id}`};
					if (this._crossfadeDuration > 0) {
						this.fadeOutAndPause(otherId, this._crossfadeDuration, directiveCause);
					} else {
						this.pause(otherId, false, directiveCause);
					}
				}
			}
		}

		if (state.def.resumes.length > 0) {
			for (const [otherId, other] of this.tracks) {
				if (otherId !== id && matchesDirective(state.def.resumes, otherId, other.def.type) && other.playState === PlayState.Paused) {
					const resumeCause: CauseInput = {kind: "directive", detail: `resumes from ${id}`};
					if (this._crossfadeDuration > 0) {
						this.play(otherId, true, resumeCause).then(() => {
							this.fadeIn(otherId, this._crossfadeDuration);
						}).catch((e) => {
							console.error(`RPG Audio: resumes fade-in failed for "${otherId}"`, e);
						});
					} else {
						void this.play(otherId, false, resumeCause);
					}
				}
			}
		}

		if (state.def.scope.length > 0) {
			if (this.applyScopeTransition(id)) crossfading = true;
		}

		const useCrossfadeIn = crossfading;
		const usePlayFadeIn = !crossfading && !skipPlayFadeIn && this._playFadeDuration > 0;

		if (requestedIndex !== undefined && isValidPlaylistIndex(requestedIndex, state.def.entries.length)) {
			state.currentIndex = requestedIndex;
		} else if (state.def.random && state.def.entries.length > 1 && state.playState !== PlayState.Paused) {
			state.currentIndex = Math.floor(Math.random() * state.def.entries.length);
		}

		const fileIndex = state.currentIndex;
		const filePath = state.def.entries[fileIndex]?.path;
		if (!filePath) return;

		const resourceUrl = this.resolveFile(filePath);
		if (!resourceUrl) {
			state.error = `File not found: ${filePath}`;
			state.errorIndex = fileIndex;
			state.loadingIndex = null;
			state.playState = PlayState.Stopped;
			this.trigger(EVENT_TRACK_CHANGED, id);
			return;
		}

		let el = this.audioElements.get(id);
		if (!el) {
			el = new Audio();
			this.audioElements.set(id, el);
			this.getOrCreateGainNode(id, el);
			this.setupAudioElement(id, el);
		}

		const wasPaused = state.playState === PlayState.Paused;
		const sourceRequest = this.beginSourceRequest(id);
		if (!wasPaused) {
			this.playlistVisited.set(id, new Set([fileIndex]));
			state.loadingIndex = fileIndex;
			state.error = null;
			state.errorIndex = null;
			this.trigger(EVENT_TRACK_CHANGED, id);
		}
		if (!wasPaused) {
			this.cancelConfiguredVolumeFade(id);
			state.volume = state.def.volume;
			this.applyVolume(id);
		}
		const region = this.getEffectiveRegion(id);
		if (!wasPaused || !el.src) {
			el.src = resourceUrl;
			const hasRegion = region.startTime !== null || region.endTime !== null;
			el.loop = this.getEffectiveLoop(id) && state.def.entries.length === 1 && !hasRegion;
		}

		// Chromium silently ignores currentTime changes before HAVE_METADATA, so
		// wait for loadedmetadata before seeking to the region start.
		// A per-track fade-in without a start marker applies when playback starts.
		// Region fade-ins are calculated from the playhead in computeRegionFade instead.
		const useTrackFadeIn = !wasPaused && region.startTime === null && state.def.fadeInDuration > 0;
		if (!wasPaused && region.startTime !== null) {
			if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
				await new Promise<void>((resolve) => {
					el.addEventListener("loadedmetadata", () => resolve(), {once: true});
					el.addEventListener("error", () => resolve(), {once: true});
				});
			}
			if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
			if (isFinite(el.duration) && region.startTime >= el.duration) {
				state.error = `Playback failed: ${filePath} (region start is beyond the file duration)`;
				state.errorIndex = fileIndex;
				state.loadingIndex = null;
				state.playState = PlayState.Stopped;
				this.trigger(EVENT_TRACK_CHANGED, id);
				return;
			}
			el.currentTime = region.startTime;
		}
		try {
			await el.play();
			if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
			state.playState = PlayState.Playing;
			state.loadingIndex = null;
			state.error = null;
			state.errorIndex = null;
			state.lastCause = buildCause(wasPaused ? "resume" : "play", cause);
			if (region.startTime !== null || region.endTime !== null) {
				this.regionFadeMultipliers.set(id, this.computeRegionFade(id, state.def, el.currentTime));
			}
			if (wasPaused) {
				this.resumeConfiguredVolumeFade(id);
			} else {
				this.startConfiguredVolumeFade(id);
			}
			if (useTrackFadeIn) {
				this.fadeIn(id, state.def.fadeInDuration * 1000);
			} else if (useCrossfadeIn) {
				this.fadeIn(id, this._crossfadeDuration);
			} else if (usePlayFadeIn) {
				this.fadeMultipliers.set(id, 0);
				this.applyVolume(id);
				this.startPlayFadeIn(id);
			} else {
				this.applyVolume(id);
			}
		} catch (e) {
			if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
			console.error(`RPG Audio: failed to play track "${id}"`, e);
			state.error = `Playback failed: ${filePath}`;
			state.errorIndex = fileIndex;
			state.loadingIndex = null;
			state.playState = PlayState.Stopped;
		}
		this.trigger(EVENT_TRACK_CHANGED, id);
	}

	/** Select and immediately play a configured playlist item. */
	async selectPlaylistIndex(id: string, index: number): Promise<void> {
		const state = this.tracks.get(id);
		if (!state || !isValidPlaylistIndex(index, state.def.entries.length)) return;
		// Ignore repeated activation while a source change is already pending.
		if (state.loadingIndex !== null) return;

		const filePath = state.def.entries[index]?.path;
		if (!filePath) return;
		const resourceUrl = this.resolveFile(filePath);
		if (!resourceUrl) {
			state.error = `File not found: ${filePath}`;
			state.errorIndex = index;
			state.loadingIndex = null;
			this.trigger(EVENT_TRACK_CHANGED, id);
			return;
		}

		if (state.playState === PlayState.Stopped) {
			state.currentIndex = index;
			state.loadingIndex = index;
			state.error = null;
			state.errorIndex = null;
			this.trigger(EVENT_TRACK_CHANGED, id);
			await this.play(id, false, {kind: "user", detail: `playlist item ${index + 1}`}, index);
			return;
		}

		if (state.playState === PlayState.Playing && state.def.playlistCrossfadeDuration > 0) {
			if (this.playlistCrossfading.has(id)) this.cancelPlaylistCrossfade(id);
			this.fades.cancel(id);
			this.playFades.delete(id);
			this.setFadingOut(id, false);
			this.setFadingIn(id, false);
			this.fadeMultipliers.delete(id);
			this.applyVolume(id);
			await this.startPlaylistCrossfade(id, index, {
				kind: "user",
				detail: `playlist item ${index + 1}`,
			});
			return;
		}

		const el = this.audioElements.get(id);
		if (!el) {
			state.playState = PlayState.Stopped;
			await this.play(id, false, {kind: "user", detail: `playlist item ${index + 1}`}, index);
			return;
		}

		const wasPaused = state.playState === PlayState.Paused;
		this.fades.cancel(id);
		this.playFades.delete(id);
		this.setFadingOut(id, false);
		this.setFadingIn(id, false);
		this.fadeMultipliers.delete(id);
		this.regionFadeMultipliers.delete(id);
		this.regionFadeInDone.delete(id);
		this.applyVolume(id);

		state.currentIndex = index;
		let visited = this.playlistVisited.get(id);
		if (!visited) {
			visited = new Set();
			this.playlistVisited.set(id, visited);
		}
		visited.add(index);
		state.loadingIndex = index;
		state.error = null;
		state.errorIndex = null;
		this.trigger(EVENT_TRACK_CHANGED, id);

		const sourceRequest = this.beginSourceRequest(id);
		el.src = resourceUrl;
		el.loop = false;
		try {
			const region = this.getEffectiveRegion(id);
			if (region.startTime !== null) {
				if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
					await new Promise<void>((resolve) => {
						el.addEventListener("loadedmetadata", () => resolve(), {once: true});
						el.addEventListener("error", () => resolve(), {once: true});
					});
				}
				if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
				if (isFinite(el.duration) && region.startTime >= el.duration) {
					throw new Error("Region start is beyond the file duration");
				}
				el.currentTime = region.startTime;
			}
			if (region.startTime !== null || region.endTime !== null) {
				this.regionFadeMultipliers.set(id, this.computeRegionFade(id, state.def, el.currentTime));
			}
			this.applyVolume(id);
			await el.play();
			if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
			state.playState = PlayState.Playing;
			state.loadingIndex = null;
			state.error = null;
			state.errorIndex = null;
			state.lastCause = buildCause(wasPaused ? "resume" : "play", {
				kind: "user",
				detail: `playlist item ${index + 1}`,
			});
			if (wasPaused) this.resumeConfiguredVolumeFade(id);
			this.applyVolume(id);
		} catch (e) {
			if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
			console.error(`RPG Audio: failed to play playlist item "${filePath}"`, e);
			this.cancelConfiguredVolumeFade(id);
			state.playState = PlayState.Stopped;
			state.loadingIndex = null;
			state.error = `Playback failed: ${filePath}`;
			state.errorIndex = index;
		}
		this.trigger(EVENT_TRACK_CHANGED, id);
	}

	pause(id: string, fromUserToggle = true, cause?: CauseInput): void {
		const state = this.tracks.get(id);
		if (!state) return;

		const fadeMode = this.playFades.get(id);
		if (fadeMode === "out") {
			if (fromUserToggle) this.startPlayFadeIn(id);
			return;
		}
		if (fadeMode === "in") {
			this.startPlayFadeOut(id, cause);
			return;
		}

		if (state.playState !== PlayState.Playing) return;

		if (this._playFadeDuration > 0) {
			this.startPlayFadeOut(id, cause);
		} else {
			this.applyPause(id, cause);
		}
	}

	private applyPause(id: string, cause?: CauseInput): void {
		const state = this.tracks.get(id);
		if (!state) return;

		this.cancelPlaylistCrossfade(id);
		const el = this.audioElements.get(id);
		if (el) el.pause();
		this.pauseConfiguredVolumeFade(id);

		this.playFades.delete(id);
		this.setFadingOut(id, false);
		this.setFadingIn(id, false);
		this.fadeMultipliers.delete(id);
		this.applyVolume(id);
		state.playState = PlayState.Paused;
		state.lastCause = buildCause("pause", cause);
		this.trigger(EVENT_TRACK_CHANGED, id);
	}

	private startPlayFadeOut(id: string, cause?: CauseInput): void {
		const current = this.fadeMultipliers.get(id) ?? 1;
		if (current <= 0) {
			this.applyPause(id, cause);
			return;
		}
		this.playFades.set(id, "out");
		this.setFadingIn(id, false);
		this.setFadingOut(id, true);
		const duration = this._playFadeDuration * current;
		this.fades.start(id, current, 0, duration, (value) => {
			this.fadeMultipliers.set(id, value);
			this.applyVolume(id);
		}).then((completed) => {
			if (this.playFades.get(id) !== "out") return;
			if (completed) {
				this.applyPause(id, cause);
			} else {
				this.playFades.delete(id);
			}
		}).catch((e) => {
			console.error(`RPG Audio: play fade-out failed for "${id}"`, e);
		});
	}

	private startPlayFadeIn(id: string): void {
		this.setFadingOut(id, false);
		this.setFadingIn(id, true);
		const current = this.fadeMultipliers.get(id) ?? 0;
		if (current >= 1) {
			this.playFades.delete(id);
			this.setFadingIn(id, false);
			this.fadeMultipliers.delete(id);
			this.applyVolume(id);
			return;
		}
		this.playFades.set(id, "in");
		const duration = this._playFadeDuration * (1 - current);
		this.fades.start(id, current, 1, duration, (value) => {
			this.fadeMultipliers.set(id, value);
			this.applyVolume(id);
		}).then((completed) => {
			if (this.playFades.get(id) !== "in") return;
			this.playFades.delete(id);
			if (completed) this.setFadingIn(id, false);
			if (completed) {
				this.fadeMultipliers.delete(id);
				this.applyVolume(id);
			}
		}).catch((e) => {
			console.error(`RPG Audio: play fade-in failed for "${id}"`, e);
		});
	}

	stop(id: string, cause?: CauseInput): void {
		const state = this.tracks.get(id);
		if (!state) return;

		this.invalidateSourceRequest(id);
		this.cancelPlaylistCrossfade(id);
		this.fades.cancel(id);
		this.cancelConfiguredVolumeFade(id);
		this.setFadingOut(id, false);
		this.setFadingIn(id, false);
		this.fadeMultipliers.delete(id);
		this.regionFadeMultipliers.delete(id);
		this.regionFadeInDone.delete(id);
		this.regionOverrides.delete(id);
		this.playlistVisited.delete(id);
		this.loopOverrides.delete(id);
		this.playFades.delete(id);

		const el = this.audioElements.get(id);
		if (el) {
			el.pause();
			el.currentTime = 0;
		}

		state.playState = PlayState.Stopped;
		state.currentIndex = 0;
		state.loadingIndex = null;
		state.errorIndex = null;
		state.error = null;
		state.lastCause = buildCause("stop", cause);
		this.trigger(EVENT_TRACK_CHANGED, id);
		this.cleanupIfOrphaned(id);
	}

	stopAll(): void {
		this.fades.cancelAll();
		this.volumeFades.cancelAll();
		this.fadeMultipliers.clear();
		this.playFades.clear();
		this.fadingOut.clear();
		this.fadingIn.clear();
		for (const [id] of this.tracks) {
			this.stop(id, {kind: "user", detail: "stop all"});
		}
	}

	fadeOutAll(duration: number): void {
		const cause: CauseInput = {kind: "system", detail: "fade out all"};
		for (const [id, state] of this.tracks) {
			if (state.playState === PlayState.Playing) {
				this.fadeOutAndPause(id, duration, cause);
			}
		}
	}

	fadeInAll(duration: number): void {
		const cause: CauseInput = {kind: "system", detail: "fade in all"};
		for (const [id, state] of this.tracks) {
			if (state.playState === PlayState.Paused) {
				this.fadeMultipliers.set(id, 0);
				this.applyVolume(id);
				this.play(id, true, cause).then(() => {
					this.fadeIn(id, duration);
				}).catch((e) => {
					console.error(`RPG Audio: fade-in play failed for "${id}"`, e);
				});
			}
		}
	}

	fadeOutType(type: string, duration: number): void {
		const cause: CauseInput = {kind: "system", detail: `fade out ${type}`};
		for (const [id, state] of this.tracks) {
			if (state.def.type === type && state.playState === PlayState.Playing) {
				this.fadeOutAndPause(id, duration, cause);
			}
		}
	}

	fadeInType(type: string, duration: number): void {
		const cause: CauseInput = {kind: "system", detail: `fade in ${type}`};
		for (const [id, state] of this.tracks) {
			if (state.def.type === type && state.playState === PlayState.Paused) {
				this.fadeMultipliers.set(id, 0);
				this.applyVolume(id);
				this.play(id, true, cause).then(() => {
					this.fadeIn(id, duration);
				}).catch((e) => {
					console.error(`RPG Audio: fade-in play failed for "${id}"`, e);
				});
			}
		}
	}

	setTrackVolume(id: string, volume: number): void {
		const state = this.tracks.get(id);
		if (!state) return;

		// A manual slider move takes ownership of the track volume.
		this.cancelConfiguredVolumeFade(id);
		state.volume = Math.max(0, Math.min(1, volume));
		this.applyVolume(id);
		this.trigger(EVENT_TRACK_CHANGED, id);
	}

	scheduleOrphanCheck(id: string): void {
		this.clearOrphanTimer(id);
		const timer = window.setTimeout(() => {
			this.orphanTimers.delete(id);
			const state = this.tracks.get(id);
			if (!state) return;
			if (this.hasLivePlayerElement(id)) return;
			if (state.playState === PlayState.Playing || state.playState === PlayState.Paused) {
				// Live element gone but track still in use; wait for it to stop, then
				// cleanupIfOrphaned will pick it up.
				return;
			}
			this.unregister(id);
		}, ORPHAN_CHECK_DELAY_MS);
		this.orphanTimers.set(id, timer);
	}

	private hasLivePlayerElement(id: string): boolean {
		const selector = `.rpg-audio-player[data-track-id="${CSS.escape(id)}"]`;
		const elements = document.querySelectorAll<HTMLElement>(selector);
		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			if (el && el.isConnected) return true;
		}
		return false;
	}

	private cleanupIfOrphaned(id: string): void {
		if (this.hasLivePlayerElement(id)) return;
		this.unregister(id);
	}

	private clearOrphanTimer(id: string): void {
		const timer = this.orphanTimers.get(id);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.orphanTimers.delete(id);
		}
	}

	destroyAll(): void {
		this.fades.destroy();
		this.volumeFades.destroy();
		this.fadeMultipliers.clear();
		this.fadingOut.clear();
		this.fadingIn.clear();
		this.regionFadeMultipliers.clear();
		this.regionFadeInDone.clear();
		this.regionOverrides.clear();
		this.playlistVisited.clear();
		for (const graph of this.outgoingPlaylistGraphs.values()) this.disposeAudioGraph(graph);
		this.outgoingPlaylistGraphs.clear();
		this.playlistCrossfading.clear();
		this.playlistCrossfadeFailed.clear();
		this.playlistCrossfadeMultipliers.clear();
		this.loopOverrides.clear();
		this.sourceRequestVersions.clear();
		this.playFades.clear();
		this.trackSends.clear();
		this.unregistering.clear();
		this._activeScope.clear();
		for (const [, timer] of this.orphanTimers) {
			window.clearTimeout(timer);
		}
		this.orphanTimers.clear();
		for (const [, el] of this.audioElements) {
			el.pause();
			el.removeAttribute("src");
			el.load();
		}
		this.audioElements.clear();
		for (const [, gain] of this.gainNodes) {
			gain.disconnect();
		}
		this.gainNodes.clear();
		for (const [, dry] of this.dryNodes) {
			dry.disconnect();
		}
		this.dryNodes.clear();
		for (const [, send] of this.sendNodes) {
			send.disconnect();
		}
		this.sendNodes.clear();
		this.reverb?.destroy();
		this.reverb = null;
		this.limiter?.disconnect();
		this.limiter = null;
		this.masterBus?.disconnect();
		this.masterBus = null;
		if (this.audioContext) {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}
		this.tracks.clear();
	}

	private computeRegionFade(id: string, def: AudioTrackDef, currentTime: number): number {
		const region = this.getEffectiveRegion(id);
		const startTime = region.startTime;
		const endTime = region.endTime;
		let mult = 1;

		if (startTime !== null && def.fadeInDuration > 0) {
			if (this.regionFadeInDone.has(id)) {
				// Fade-in already completed; keep multiplier at 1
			} else {
				const elapsed = currentTime - startTime;
				if (elapsed < def.fadeInDuration) {
					mult = Math.min(mult, Math.max(0, elapsed / def.fadeInDuration));
				} else {
					this.regionFadeInDone.add(id);
				}
			}
		}

		if (endTime !== null && def.fadeOutDuration > 0 && !this.getEffectiveLoop(id)) {
			const remaining = endTime - currentTime;
			if (remaining < def.fadeOutDuration) {
				mult = Math.min(mult, Math.max(0, remaining / def.fadeOutDuration));
			}
		}
		return mult;
	}

	private applyVolume(id: string): void {
		const state = this.tracks.get(id);
		const gain = this.gainNodes.get(id);
		if (!state || !gain) return;
		gain.gain.value = state.volume * this._masterVolume
			* (this.fadeMultipliers.get(id) ?? 1)
			* (this.regionFadeMultipliers.get(id) ?? 1)
			* (this.playlistCrossfadeMultipliers.get(id) ?? 1);
	}

	private getNextPlaylistIndex(id: string, completeCycle: boolean): number | null {
		const state = this.tracks.get(id);
		if (!state || state.def.entries.length < 2) return null;
		const length = state.def.entries.length;
		let nextIndex: number | null = null;

		if (state.def.random) {
			let visited = this.playlistVisited.get(id);
			if (!visited) {
				visited = new Set([state.currentIndex]);
				this.playlistVisited.set(id, visited);
			}
			let candidates = Array.from({length}, (_, index) => index)
				.filter(index => index !== state.currentIndex && (!completeCycle || !visited.has(index)));
			if (candidates.length === 0 && completeCycle && this.getEffectiveLoop(id)) {
				visited.clear();
				visited.add(state.currentIndex);
				candidates = Array.from({length}, (_, index) => index).filter(index => index !== state.currentIndex);
			}
			if (candidates.length > 0) {
				nextIndex = candidates[Math.floor(Math.random() * candidates.length)] ?? null;
			}
		} else if (state.currentIndex + 1 < length) {
			nextIndex = state.currentIndex + 1;
		} else if (this.getEffectiveLoop(id)) {
			nextIndex = 0;
		}

		return nextIndex;
	}

	private commitPlaylistIndex(id: string, nextIndex: number): void {
		const state = this.tracks.get(id);
		if (!state) return;
		state.currentIndex = nextIndex;
		let visited = this.playlistVisited.get(id);
		if (!visited) {
			visited = new Set();
			this.playlistVisited.set(id, visited);
		}
		visited.add(nextIndex);
		this.regionFadeInDone.delete(id);
		this.regionFadeMultipliers.delete(id);
	}

	private advancePlaylist(id: string, completeCycle: boolean): boolean {
		const state = this.tracks.get(id);
		if (!state) return false;
		const nextIndex = this.getNextPlaylistIndex(id, completeCycle);
		if (nextIndex === null) return false;
		if (state.def.playlistCrossfadeDuration > 0 && state.playState === PlayState.Playing
			&& !this.playlistCrossfadeFailed.has(id)) {
			void this.startPlaylistCrossfade(id, nextIndex);
			return true;
		}
		this.playlistCrossfadeFailed.delete(id);
		this.commitPlaylistIndex(id, nextIndex);
		void this.playCurrentIndex(id);
		return true;
	}

	private async startPlaylistCrossfade(id: string, nextIndex: number, cause?: CauseInput): Promise<boolean> {
		const state = this.tracks.get(id);
		const outgoing = this.getInstalledAudioGraph(id);
		if (!state || !outgoing || this.playlistCrossfading.has(id)) return false;
		const outgoingRegion = this.getEffectiveRegionForIndex(id, state.currentIndex);
		const entry = state.def.entries[nextIndex];
		if (!entry) return false;
		const resourceUrl = this.resolveFile(entry.path);
		if (!resourceUrl) {
			state.error = `File not found: ${entry.path}`;
			state.errorIndex = nextIndex;
			this.playlistCrossfadeFailed.add(id);
			this.trigger(EVENT_TRACK_CHANGED, id);
			return false;
		}

		this.cancelPlaylistCrossfade(id);
		this.playlistCrossfading.add(id);
		state.loadingIndex = nextIndex;
		state.error = null;
		state.errorIndex = null;
		this.trigger(EVENT_TRACK_CHANGED, id);
		const sourceRequest = this.beginSourceRequest(id);
		const incomingEl = new Audio();
		const incoming = this.createAudioGraph(id, incomingEl);
		incoming.gain.gain.value = 0;
		incomingEl.src = resourceUrl;
		incomingEl.loop = false;

		try {
			const region = this.getEffectiveRegionForIndex(id, nextIndex);
			if (region.startTime !== null) {
				if (incomingEl.readyState < HTMLMediaElement.HAVE_METADATA) {
					await new Promise<void>((resolve) => {
						incomingEl.addEventListener("loadedmetadata", () => resolve(), {once: true});
						incomingEl.addEventListener("error", () => resolve(), {once: true});
					});
				}
				if (!this.isCurrentSourceRequest(id, sourceRequest)) {
					this.disposeAudioGraph(incoming);
					return false;
				}
				if (isFinite(incomingEl.duration) && region.startTime >= incomingEl.duration) {
					throw new Error("Region start is beyond the file duration");
				}
				incomingEl.currentTime = region.startTime;
			}
			await incomingEl.play();
			if (!this.isCurrentSourceRequest(id, sourceRequest)) {
				this.disposeAudioGraph(incoming);
				return false;
			}

			this.installAudioGraph(id, incoming);
			this.setupAudioElement(id, incomingEl);
			this.outgoingPlaylistGraphs.set(id, outgoing);
			this.commitPlaylistIndex(id, nextIndex);
			this.playlistCrossfadeFailed.delete(id);
			state.loadingIndex = null;
			state.error = null;
			state.errorIndex = null;
			state.playState = PlayState.Playing;
			if (cause) state.lastCause = buildCause("play", cause);
			if (region.startTime !== null || region.endTime !== null) {
				this.regionFadeMultipliers.set(id, this.computeRegionFade(id, state.def, incomingEl.currentTime));
			}
			this.playlistCrossfadeMultipliers.set(id, 0);
			this.applyVolume(id);
			this.trigger(EVENT_TRACK_CHANGED, id);

			const configuredSeconds = state.def.playlistCrossfadeDuration;
			const outgoingNaturalEnd = isFinite(outgoing.el.duration) ? outgoing.el.duration : Infinity;
			const outgoingEnd = outgoingRegion.endTime === null
				? outgoingNaturalEnd
				: Math.min(outgoingRegion.endTime, outgoingNaturalEnd);
			const remainingSeconds = Math.max(0, outgoingEnd - outgoing.el.currentTime);
			const durationMs = Math.min(configuredSeconds, remainingSeconds) * 1000;
			if (durationMs <= 0) {
				this.disposeAudioGraph(outgoing);
				this.outgoingPlaylistGraphs.delete(id);
				this.playlistCrossfadeMultipliers.delete(id);
				this.playlistCrossfading.delete(id);
				this.applyVolume(id);
				return true;
			}

			const outgoingGain = outgoing.gain.gain.value;
			void this.fades.start(`${id}:playlist-in`, 0, 1, durationMs, (value) => {
				this.playlistCrossfadeMultipliers.set(id, value);
				this.applyVolume(id);
			}).then((completed) => {
				if (!completed) return;
				this.playlistCrossfadeMultipliers.delete(id);
				this.applyVolume(id);
			});
			void this.fades.start(`${id}:playlist-out`, 1, 0, durationMs, (value) => {
				outgoing.gain.gain.value = outgoingGain * value;
			}).then((completed) => {
				if (!completed || this.outgoingPlaylistGraphs.get(id) !== outgoing) return;
				this.disposeAudioGraph(outgoing);
				this.outgoingPlaylistGraphs.delete(id);
				this.playlistCrossfading.delete(id);
				const current = this.audioElements.get(id);
				const currentRegion = this.getEffectiveRegion(id);
				if (current?.ended || (currentRegion.endTime !== null && current && current.currentTime >= currentRegion.endTime)) {
					this.handleItemCompletion(id);
				}
			});
			return true;
		} catch (e) {
			this.disposeAudioGraph(incoming);
			if (!this.isCurrentSourceRequest(id, sourceRequest)) return false;
			console.error(`RPG Audio: failed to crossfade to playlist item "${entry.path}"`, e);
			this.playlistCrossfading.delete(id);
			this.playlistCrossfadeFailed.add(id);
			state.loadingIndex = null;
			state.error = `Playback failed: ${entry.path}`;
			state.errorIndex = nextIndex;
			this.trigger(EVENT_TRACK_CHANGED, id);
			return false;
		}
	}

	private restartCurrentRegion(id: string): void {
		const state = this.tracks.get(id);
		const el = this.audioElements.get(id);
		if (!state || !el) return;
		const region = this.getEffectiveRegion(id);
		const loopTo = region.startTime ?? 0;
		this.regionFadeInDone.delete(id);
		el.currentTime = loopTo;
		if (region.startTime !== null || region.endTime !== null) {
			this.regionFadeMultipliers.set(id, this.computeRegionFade(id, state.def, loopTo));
		} else {
			this.regionFadeMultipliers.delete(id);
		}
		this.applyVolume(id);
		void el.play().catch((e) => {
			console.error(`RPG Audio: failed to repeat playlist item for "${id}"`, e);
			state.error = `Playback failed: ${state.def.entries[state.currentIndex]?.path ?? id}`;
			state.errorIndex = state.currentIndex;
			state.playState = PlayState.Stopped;
			this.trigger(EVENT_TRACK_CHANGED, id);
		});
	}

	private handleItemCompletion(id: string): void {
		const state = this.tracks.get(id);
		if (!state) return;
		if (this.playlistCrossfading.has(id)) return;
		if (state.def.entries.length === 1) {
			if (this.getEffectiveLoop(id)) this.restartCurrentRegion(id);
			else this.stop(id, {kind: "ended"});
			return;
		}

		switch (state.def.playlistEndAction) {
			case "next":
				if (!this.advancePlaylist(id, true)) this.stop(id, {kind: "ended"});
				break;
			case "repeat":
				this.restartCurrentRegion(id);
				break;
			case "stop":
				this.stop(id, {kind: "ended"});
				break;
			case "auto":
			default:
				if (!this.getEffectiveLoop(id) || !this.advancePlaylist(id, false)) {
					this.stop(id, {kind: "ended"});
				}
				break;
		}
	}

	private setupAudioElement(id: string, el: HTMLAudioElement): void {
		el.addEventListener("ended", () => {
			if (this.audioElements.get(id) !== el) return;
			this.handleItemCompletion(id);
		});

		el.addEventListener("timeupdate", () => {
			if (this.audioElements.get(id) !== el) return;
			const state = this.tracks.get(id);
			if (!state || state.playState !== PlayState.Playing) return;

			const currentTime = el.currentTime;
			const duration = isFinite(el.duration) ? el.duration : 0;
			this.trigger(EVENT_TIME_UPDATE, id, currentTime, duration);

			const region = this.getEffectiveRegion(id);
			const naturalEnd = duration > 0 ? duration : Infinity;
			const effectiveEnd = region.endTime === null ? naturalEnd : Math.min(region.endTime, naturalEnd);
			if (state.def.playlistCrossfadeDuration > 0 && !this.playlistCrossfading.has(id)
				&& !this.playlistCrossfadeFailed.has(id) && Number.isFinite(effectiveEnd)) {
				let completeCycle: boolean | null = null;
				if (state.def.playlistEndAction === "next") completeCycle = true;
				else if (state.def.playlistEndAction === "auto" && this.getEffectiveLoop(id)) completeCycle = false;
				if (completeCycle !== null && effectiveEnd - currentTime <= state.def.playlistCrossfadeDuration) {
					const nextIndex = this.getNextPlaylistIndex(id, completeCycle);
					if (nextIndex !== null) void this.startPlaylistCrossfade(id, nextIndex);
				}
			}
			if (region.startTime === null && region.endTime === null) return;
			if (region.endTime !== null && currentTime >= region.endTime) {
				if (this.playlistCrossfading.has(id)) el.pause();
				else this.handleItemCompletion(id);
				return;
			}

			const mult = this.computeRegionFade(id, state.def, currentTime);
			this.regionFadeMultipliers.set(id, mult);
			this.applyVolume(id);
		});
	}

	private async playCurrentIndex(id: string): Promise<void> {
		const state = this.tracks.get(id);
		if (!state) return;

		const filePath = state.def.entries[state.currentIndex]?.path;
		if (!filePath) return;

		const resourceUrl = this.resolveFile(filePath);
		if (!resourceUrl) {
			state.error = `File not found: ${filePath}`;
			state.errorIndex = state.currentIndex;
			state.loadingIndex = null;
			state.playState = PlayState.Stopped;
			this.trigger(EVENT_TRACK_CHANGED, id);
			return;
		}

		const el = this.audioElements.get(id);
		if (!el) return;

		const sourceRequest = this.beginSourceRequest(id);
		state.loadingIndex = state.currentIndex;
		state.error = null;
		state.errorIndex = null;
		this.trigger(EVENT_TRACK_CHANGED, id);
		el.src = resourceUrl;
		el.loop = false;
		try {
			const region = this.getEffectiveRegion(id);
			if (region.startTime !== null) {
				if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
					await new Promise<void>((resolve) => {
						el.addEventListener("loadedmetadata", () => resolve(), {once: true});
						el.addEventListener("error", () => resolve(), {once: true});
					});
				}
				if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
				if (isFinite(el.duration) && region.startTime >= el.duration) {
					throw new Error("Region start is beyond the file duration");
				}
				el.currentTime = region.startTime;
			}
			if (region.startTime !== null || region.endTime !== null) {
				this.regionFadeMultipliers.set(id, this.computeRegionFade(id, state.def, el.currentTime));
			} else {
				this.regionFadeMultipliers.delete(id);
			}
			await el.play();
			if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
			state.loadingIndex = null;
			state.error = null;
			state.errorIndex = null;
			this.applyVolume(id);
		} catch (e) {
			if (!this.isCurrentSourceRequest(id, sourceRequest)) return;
			console.error(`RPG Audio: failed to play track "${id}"`, e);
			state.error = `Playback failed: ${filePath}`;
			state.errorIndex = state.currentIndex;
			state.loadingIndex = null;
			state.playState = PlayState.Stopped;
		}
		this.trigger(EVENT_TRACK_CHANGED, id);
	}

	private startConfiguredVolumeFade(id: string): void {
		const state = this.tracks.get(id);
		if (!state || state.def.volumeFadeTarget === null || state.def.volumeFadeDuration <= 0) return;

		this.volumeFades.start(
			id,
			state.volume,
			state.def.volumeFadeTarget,
			state.def.volumeFadeDuration * 1000,
			(value) => {
				const currentState = this.tracks.get(id);
				if (!currentState) return;
				currentState.volume = value;
				this.applyVolume(id);
			},
			() => this.trigger(EVENT_TRACK_CHANGED, id),
		);
	}

	private resumeConfiguredVolumeFade(id: string): void {
		this.volumeFades.resume(id);
	}

	private pauseConfiguredVolumeFade(id: string): void {
		this.volumeFades.pause(id);
	}

	private cancelConfiguredVolumeFade(id: string): void {
		this.volumeFades.cancel(id);
	}

	private fadeOutAndPause(id: string, duration: number, cause?: CauseInput): void {
		this.fadeOutThen(id, duration, () => this.applyPause(id, cause));
	}

	fadeOutAndStop(id: string, duration: number, cause?: CauseInput): void {
		this.fadeOutThen(id, duration, () => this.stop(id, cause));
	}

	private fadeOutThen(id: string, duration: number, onComplete: () => void): void {
		const current = this.fadeMultipliers.get(id) ?? 1;
		this.setFadingIn(id, false);
		this.setFadingOut(id, true);
		this.fades.start(id, current, 0, duration, (value) => {
			this.fadeMultipliers.set(id, value);
			this.applyVolume(id);
		}).then((completed) => {
			if (completed) onComplete();
		}).catch((e) => {
			console.error(`RPG Audio: fade-out failed for "${id}"`, e);
		});
	}

	private fadeIn(id: string, duration: number): void {
		this.setFadingOut(id, false);
		this.setFadingIn(id, true);
		this.fadeMultipliers.set(id, 0);
		this.applyVolume(id);
		this.fades.start(id, 0, 1, duration, (value) => {
			this.fadeMultipliers.set(id, value);
			this.applyVolume(id);
		}).then((completed) => {
			if (completed) {
				this.setFadingIn(id, false);
				this.fadeMultipliers.delete(id);
			}
		}).catch((e) => {
			console.error(`RPG Audio: fade-in failed for "${id}"`, e);
		});
	}

	private resolveFile(path: string): string | null {
		const file = findAudioFile(this.app.vault, this._audioFolder, path);
		return file ? this.app.vault.getResourcePath(file) : null;
	}
}
