import {MarkdownRenderChild} from "obsidian";
import {AudioManager} from "../audio-manager";
import {AudioTrackDef, PlayState, EVENT_TRACK_CHANGED, EVENT_TIME_UPDATE, DETACH_POLL_INTERVAL_MS} from "../types";
import {parseAudioBlock} from "../audio-block-parser";
import {
	createTransportButtons,
	createVolumeControl,
	createSettingsButtons,
	createSeekBar,
	updatePlayPauseButton,
	updateStopFadeButton,
	updateSettingsButtons,
	updateSeekBar,
	updateVolumeChangeFeedback,
	TransportElements,
	SettingsButtonsElements,
	SeekBarElements,
} from "./player-controls";

export function formatTimestamp(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = Math.floor(secs % 60).toString().padStart(2, "0");
	return `${m}:${s}`;
}

export {parseAudioBlock};

export function renderAudioBlockErrors(containerEl: HTMLElement, errors: string[]): void {
	containerEl.empty();
	const errorEl = containerEl.createDiv({cls: "rpg-audio-error"});
	errorEl.setAttribute("role", "alert");
	errorEl.createDiv({cls: "rpg-audio-error-title", text: "RPG Audio configuration error"});
	const list = errorEl.createEl("ul", {cls: "rpg-audio-error-list"});
	for (const error of errors) list.createEl("li", {text: error});
}

export class RpgAudioCodeBlockPlayer extends MarkdownRenderChild {
	private manager: AudioManager;
	private def: AudioTrackDef;
	private transport: TransportElements | null = null;
	private volumeSlider: HTMLInputElement | null = null;
	private settingsEl: SettingsButtonsElements | null = null;
	private seekBarElements: SeekBarElements | null = null;
	private eventRef: (() => void) | null = null;
	private timeUpdateRef: (() => void) | null = null;
	private autoplayTimer: number | null = null;

	constructor(containerEl: HTMLElement, manager: AudioManager, def: AudioTrackDef) {
		super(containerEl);
		this.manager = manager;
		this.def = def;
	}

	onload(): void {
		const wasRegistered = !!this.manager.getTrack(this.def.id);
		this.manager.register(this.def);
		this.buildUI();

		const handler = (changedId: string) => {
			if (changedId === this.def.id) this.syncState();
		};
		this.manager.on(EVENT_TRACK_CHANGED, handler);
		this.eventRef = () => this.manager.off(EVENT_TRACK_CHANGED, handler);

		const timeHandler = (changedId: string, currentTime: number, duration: number) => {
			if (changedId !== this.def.id || !this.seekBarElements) return;
			const region = this.manager.getEffectiveRegion(this.def.id);
			// Time updates only fire while playing — pass PlayState.Playing for the gradient
			updateSeekBar(this.seekBarElements, currentTime, duration, region, PlayState.Playing);
			const state = this.manager.getTrack(this.def.id);
			if (state && this.volumeSlider) {
				this.volumeSlider.value = String(state.volume);
				updateVolumeChangeFeedback(this.volumeSlider, this.manager.getVolumeChangeDirection(this.def.id));
			}
			this.syncFadeOutVisualState();
		};
		this.manager.on(EVENT_TIME_UPDATE, timeHandler);
		this.timeUpdateRef = () => this.manager.off(EVENT_TIME_UPDATE, timeHandler);

		this.syncState();

		if (this.def.autoplay && !wasRegistered && this.manager.allowAutoplay) {
			const delay = this.manager.autoplayDelay;
			if (delay > 0) {
				this.autoplayTimer = window.setTimeout(() => {
					this.autoplayTimer = null;
					void this.manager.play(this.def.id, false, {kind: "autoplay"});
				}, delay);
			} else {
				void this.manager.play(this.def.id, false, {kind: "autoplay"});
			}
		}

		// Obsidian does not call onunload for MarkdownRenderChild inside
		// ![[...]] transclusions. Poll for DOM detachment as a fallback.
		this.registerInterval(window.setInterval(() => {
			if (!this.containerEl.isConnected) this.unload();
		}, DETACH_POLL_INTERVAL_MS));
	}

	onunload(): void {
		if (this.autoplayTimer !== null) {
			window.clearTimeout(this.autoplayTimer);
			this.autoplayTimer = null;
		}
		if (this.eventRef) {
			this.eventRef();
			this.eventRef = null;
		}
		if (this.timeUpdateRef) {
			this.timeUpdateRef();
			this.timeUpdateRef = null;
		}
		this.manager.scheduleOrphanCheck(this.def.id);
	}

	private buildUI(): void {
		const el = this.containerEl;
		el.empty();
		el.addClass("rpg-audio-player");
		el.dataset.trackId = this.def.id;

		const topRow = el.createDiv({cls: "rpg-audio-player-top"});

		// Transport buttons (play/stop) — leftmost
		this.transport = createTransportButtons(topRow, {
			onPlay: () => { this.ensureActive(); void this.manager.play(this.def.id); },
			onPause: () => { this.ensureActive(); this.manager.pause(this.def.id); },
			onStop: () => { this.ensureActive(); this.manager.stop(this.def.id); },
			onFadeOut: () => { this.ensureActive(); this.manager.fadeOutAndStop(this.def.id, this.def.fadeOutDuration * 1000); },
		}, this.def.fadeOutDuration > 0);

		// Name + type badge
		const nameEl = topRow.createSpan({cls: "rpg-audio-name", text: this.def.name});
		nameEl.setAttribute("title", this.def.name);

		const badge = topRow.createSpan({cls: "rpg-audio-badge"});
		badge.setText(this.def.type.toUpperCase());
		badge.dataset.type = this.def.type.toLowerCase();

		// Settings buttons (loop toggle + fade indicator) + volume — right-aligned
		const currentState = this.manager.getTrack(this.def.id);
		const initialVolume = currentState ? currentState.volume : 1.0;

		this.settingsEl = createSettingsButtons(topRow, this.def, (newLoop) => {
			this.ensureActive();
			this.manager.setLoopOverride(this.def.id, newLoop);
		});

		this.volumeSlider = createVolumeControl(
			topRow,
			(v) => { this.ensureActive(); this.manager.setTrackVolume(this.def.id, v); },
			initialVolume,
		);

		// Seek bar (hidden in stopped state via CSS)
		this.seekBarElements = createSeekBar(el, {
			onSeek: (time) => { this.ensureActive(); this.manager.seek(this.def.id, time); },
			onRegionChange: (start, end) => {
				this.ensureActive();
				this.manager.setEffectiveRegion(this.def.id, start, end);
			},
		});
	}

	/** Re-register track and event listeners if orphaned (e.g. in embedded notes). */
	private ensureActive(): void {
		if (!this.manager.getTrack(this.def.id)) {
			this.manager.register(this.def);
		}
		if (!this.eventRef) {
			const handler = (changedId: string) => {
				if (changedId === this.def.id) this.syncState();
			};
			this.manager.on(EVENT_TRACK_CHANGED, handler);
			this.eventRef = () => this.manager.off(EVENT_TRACK_CHANGED, handler);
		}
		if (!this.timeUpdateRef) {
			const timeHandler = (changedId: string, currentTime: number, duration: number) => {
				if (changedId !== this.def.id || !this.seekBarElements) return;
				const region = this.manager.getEffectiveRegion(this.def.id);
				updateSeekBar(this.seekBarElements, currentTime, duration, region, PlayState.Playing);
				const state = this.manager.getTrack(this.def.id);
				if (state && this.volumeSlider) {
					this.volumeSlider.value = String(state.volume);
					updateVolumeChangeFeedback(this.volumeSlider, this.manager.getVolumeChangeDirection(this.def.id));
				}
				this.syncFadeOutVisualState();
			};
			this.manager.on(EVENT_TIME_UPDATE, timeHandler);
			this.timeUpdateRef = () => this.manager.off(EVENT_TIME_UPDATE, timeHandler);
		}
	}

	private syncState(): void {
		const state = this.manager.getTrack(this.def.id);
		if (!state || !this.transport) return;

		updatePlayPauseButton(this.transport.playPauseBtn, state.playState);
		const isFadingOut = this.manager.isFadingOut(this.def.id);
		const isFadingIn = this.manager.isFadingIn(this.def.id) && !isFadingOut;
		updateStopFadeButton(this.transport.stopBtn, isFadingOut, this.def.fadeOutDuration > 0);
		if (this.volumeSlider) {
			this.volumeSlider.value = String(state.volume);
			updateVolumeChangeFeedback(this.volumeSlider, this.manager.getVolumeChangeDirection(this.def.id));
		}

		this.containerEl.toggleClass("is-playing", state.playState === PlayState.Playing);
		this.containerEl.toggleClass("is-paused", state.playState === PlayState.Paused);
		this.containerEl.toggleClass("is-stopped", state.playState === PlayState.Stopped);
		this.containerEl.toggleClass("is-fading-out", isFadingOut);
		this.containerEl.toggleClass("is-fading-in", isFadingIn);

		if (this.settingsEl) {
			updateSettingsButtons(this.settingsEl, this.manager.getEffectiveLoop(this.def.id));
		}

		if (this.seekBarElements) {
			const currentTime = this.manager.getCurrentTime(this.def.id);
			const duration = this.manager.getDuration(this.def.id);
			const region = this.manager.getEffectiveRegion(this.def.id);
			updateSeekBar(this.seekBarElements, currentTime, duration, region, state.playState);
		}
	}

	private syncFadeOutVisualState(): void {
		if (!this.transport) return;
		const isFadingOut = this.manager.isFadingOut(this.def.id);
		const isFadingIn = this.manager.isFadingIn(this.def.id) && !isFadingOut;
		this.containerEl.toggleClass("is-fading-out", isFadingOut);
		this.containerEl.toggleClass("is-fading-in", isFadingIn);
		updateStopFadeButton(this.transport.stopBtn, isFadingOut, this.def.fadeOutDuration > 0);
	}

}
