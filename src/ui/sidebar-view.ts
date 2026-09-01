import {ItemView, WorkspaceLeaf, setIcon} from "obsidian";
import {AudioManager} from "../audio-manager";
import type RpgAudioPlugin from "../main";
import {
	PlayState,
	SIDEBAR_VIEW_TYPE,
	EVENT_TRACK_CHANGED,
	EVENT_TRACKS_UPDATED,
	EVENT_MASTER_VOLUME,
	EVENT_ALLOW_AUTOPLAY,
	EVENT_ACTIVE_SCOPE_CHANGED,
	EVENT_TIME_UPDATE,
	EVENT_REVERB_CHANGED,
	EVENT_REVERB_PRESETS_CHANGED,
	AudioTrackState,
	TrackCause,
	MIN_FADE_DURATION_MS,
	VolumeChangeDirection,
} from "../types";
import {getAllPresets, getDefaultWetLevel, REVERB_OFF} from "../reverb-engine";
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
	SettingsButtonsElements,
	SeekBarElements,
} from "./player-controls";
import {formatTimestamp} from "./code-block-player";
import {preserveScrollPosition} from "./scroll-preservation";

function formatCause(cause: TrackCause): string {
	const kindLabel = cause.kind === "user" ? "" : ` (${cause.kind})`;
	const detail = cause.detail ? ` — ${cause.detail}` : "";
	return `${cause.action}${kindLabel}${detail}`;
}

interface TypeColorSet {
	bg: string;
	border: string;
	text: string;
	dim: string;
}

const TYPE_COLOR_MAP: Record<string, TypeColorSet> = {
	music: {
		bg: "rgba(124,92,191,0.06)",
		border: "rgba(124,92,191,0.4)",
		text: "#b8a0e0",
		dim: "rgba(124,92,191,0.6)",
	},
	ambience: {
		bg: "rgba(56,189,176,0.06)",
		border: "rgba(56,189,176,0.4)",
		text: "#5ecec7",
		dim: "rgba(56,189,176,0.6)",
	},
	sfx: {
		bg: "rgba(232,168,84,0.06)",
		border: "rgba(232,168,84,0.4)",
		text: "#e8a854",
		dim: "rgba(232,168,84,0.6)",
	},
};

const DEFAULT_COLORS: TypeColorSet = {
	bg: "rgba(124,92,191,0.06)",
	border: "rgba(124,92,191,0.4)",
	text: "#b8a0e0",
	dim: "rgba(124,92,191,0.6)",
};

function getTypeColors(type: string): TypeColorSet {
	return TYPE_COLOR_MAP[type.toLowerCase()] ?? DEFAULT_COLORS;
}

interface TrackRowData {
	rowEl: HTMLElement;
	playPauseBtn: HTMLButtonElement;
	stopFadeBtn: HTMLButtonElement;
	volumeSlider: HTMLInputElement;
	statusEl: HTMLElement;
	debugEl: HTMLElement;
	scopeEl: HTMLElement;
	seekBar: SeekBarElements;
	settings?: SettingsButtonsElements;
}

export class RpgAudioSidebarView extends ItemView {
	private plugin: RpgAudioPlugin;
	private manager: AudioManager;
	private trackRows: Map<string, TrackRowData> = new Map();
	private contentArea: HTMLElement | null = null;
	private masterSlider: HTMLInputElement | null = null;
	private reverbSelect: HTMLSelectElement | null = null;
	private reverbWetSlider: HTMLInputElement | null = null;
	private reverbWetReadout: HTMLElement | null = null;
	private reverbCueEl: HTMLElement | null = null;
	private reverbCollapsed = false;
	private wetAnimFrame: number | null = null;
	private autoplayBtn: HTMLElement | null = null;
	private collapsedGroups: Set<string> = new Set();
	private globalFadeBtn: HTMLElement | null = null;
	private reverbBypassBtn: HTMLElement | null = null;
	private typeFadeBtns: Map<string, HTMLElement> = new Map();
	private debugToggleBtn: HTMLElement | null = null;
	private activeScopeEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: RpgAudioPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.manager = plugin.audioManager;
	}

	getViewType(): string {
		return SIDEBAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		return "RPG Audio";
	}

	getIcon(): string {
		return "music";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("rpg-audio-sidebar");

		this.buildHeader(container);
		this.contentArea = container.createDiv({cls: "rpg-audio-sidebar-content"});
		this.renderAll();
		this.buildFooter(container);

		this.registerEvent(
			this.manager.on(EVENT_TRACKS_UPDATED, () => this.renderAll())
		);
		this.registerEvent(
			this.manager.on(EVENT_TRACK_CHANGED, (id: string) => {
				this.updateTrackRow(id);
				this.updateFadeButtons();
			})
		);
		this.registerEvent(
			this.manager.on(EVENT_MASTER_VOLUME, (vol: number) => {
				if (this.masterSlider) this.masterSlider.value = String(vol);
			})
		);
		this.registerEvent(
			this.manager.on(EVENT_ALLOW_AUTOPLAY, () => this.updateAutoplayBtn())
		);
		this.registerEvent(
			this.manager.on(EVENT_ACTIVE_SCOPE_CHANGED, () => this.updateActiveScope())
		);
		this.registerEvent(
			this.manager.on(EVENT_TIME_UPDATE, (id: string, currentTime: number, duration: number) => {
				const row = this.trackRows.get(id);
				if (!row) return;
				const region = this.manager.getEffectiveRegion(id);
				updateSeekBar(row.seekBar, currentTime, duration, region, PlayState.Playing);
				const state = this.manager.getTrack(id);
				if (state) {
					row.volumeSlider.value = String(state.volume);
					updateVolumeChangeFeedback(row.volumeSlider, this.manager.getVolumeChangeDirection(id));
				}
				this.updateFadingState(row, id);
				this.updateFadeButtons();
			})
		);
		this.registerEvent(
			this.manager.on(EVENT_REVERB_PRESETS_CHANGED, () => this.refreshReverbSelect())
		);
		this.registerEvent(
			this.manager.on(EVENT_REVERB_CHANGED, () => this.updateReverbBypassBtn())
		);
	}

	async onClose(): Promise<void> {
		this.trackRows.clear();
		this.contentArea = null;
		this.masterSlider = null;
		this.reverbSelect = null;
		this.reverbWetSlider = null;
		this.reverbWetReadout = null;
		this.reverbCueEl = null;
		if (this.wetAnimFrame !== null) {
			cancelAnimationFrame(this.wetAnimFrame);
			this.wetAnimFrame = null;
		}
		this.reverbBypassBtn = null;
		this.autoplayBtn = null;
		this.globalFadeBtn = null;
		this.typeFadeBtns.clear();
		this.debugToggleBtn = null;
		this.activeScopeEl = null;
	}

	private buildHeader(container: HTMLElement): void {
		const header = container.createDiv({cls: "rpg-audio-sidebar-header"});

		const titleRow = header.createDiv({cls: "rpg-audio-sidebar-title-row"});
		titleRow.createSpan({cls: "rpg-audio-sidebar-title", text: "RPG Audio"});

		const fadeDuration = () => Math.max(this.manager.crossfadeDuration, MIN_FADE_DURATION_MS);

		const globalControls = titleRow.createDiv({cls: "rpg-audio-global-controls"});

		this.autoplayBtn = globalControls.createEl("button", {cls: "rpg-audio-btn clickable-icon"});
		this.autoplayBtn.addEventListener("click", () => void this.toggleAutoplay());
		this.updateAutoplayBtn();

		this.globalFadeBtn = globalControls.createEl("button", {cls: "rpg-audio-btn clickable-icon"});
		this.globalFadeBtn.addEventListener("click", () => {
			if (this.hasPlayingTracks()) {
				this.manager.fadeOutAll(fadeDuration());
			} else {
				this.manager.fadeInAll(fadeDuration());
			}
		});
		this.updateFadeToggle(
			this.globalFadeBtn,
			this.hasPlayingTracks(),
			this.hasPausedTracks(),
			this.getVolumeChangeDirection(),
		);

		const stopAllBtn = globalControls.createEl("button", {cls: "rpg-audio-btn rpg-audio-stop-all-btn clickable-icon"});
		setIcon(stopAllBtn, "square");
		stopAllBtn.setAttribute("aria-label", "Stop all");
		stopAllBtn.addEventListener("click", () => this.manager.stopAll());

		this.reverbBypassBtn = globalControls.createEl("button", {cls: "rpg-audio-btn clickable-icon"});
		this.reverbBypassBtn.addEventListener("click", () => {
			if (this.manager.reverbPreset === REVERB_OFF) return;
			this.manager.reverbBypassed = !this.manager.reverbBypassed;
		});
		this.updateReverbBypassBtn();

		const volumeRow = header.createDiv({cls: "rpg-audio-sidebar-volume-row"});
		const volLabel = volumeRow.createSpan({cls: "rpg-audio-sidebar-vol-label"});
		setIcon(volLabel, "volume-2");

		this.masterSlider = volumeRow.createEl("input", {
			cls: "rpg-audio-volume rpg-audio-master-volume",
			type: "range",
		});
		this.masterSlider.min = "0";
		this.masterSlider.max = "1";
		this.masterSlider.step = "0.01";
		this.masterSlider.value = String(this.manager.masterVolume);
		this.masterSlider.addEventListener("input", () => {
			this.manager.masterVolume = parseFloat(this.masterSlider!.value);
		});

		// Reverb section — collapsible, matching the track-type section pattern
		const reverbSection = header.createDiv({cls: "rpg-audio-sidebar-section rpg-audio-reverb-section"});

		const reverbHeader = reverbSection.createDiv({cls: "rpg-audio-sidebar-section-header"});
		const chevron = reverbHeader.createSpan({cls: "rpg-audio-section-chevron"});
		setIcon(chevron, "chevron-down");
		reverbHeader.createSpan({text: "Reverb"});

		const reverbBody = reverbSection.createDiv({cls: "rpg-audio-sidebar-section-body"});
		reverbHeader.addEventListener("click", () => {
			this.reverbCollapsed = !this.reverbCollapsed;
			reverbHeader.toggleClass("is-collapsed", this.reverbCollapsed);
			reverbBody.toggleClass("is-hidden", this.reverbCollapsed);
		});

		const presetRow = reverbBody.createDiv({cls: "rpg-audio-sidebar-reverb-row"});
		const select = presetRow.createEl("select", {cls: "rpg-audio-reverb-preset dropdown"});
		this.reverbSelect = select;
		this.populateReverbSelect(select);
		select.value = this.manager.reverbPreset;
		select.addEventListener("change", () => {
			this.manager.reverbPreset = select.value;
			this.plugin.settings.reverbPreset = select.value;
			this.animateWetTo(this.getWetForPreset(select.value));
			void this.plugin.saveSettings();
			this.updateReverbBypassBtn();
		});

		const wetRow = reverbBody.createDiv({cls: "rpg-audio-sidebar-reverb-row"});
		wetRow.createSpan({cls: "rpg-audio-reverb-wet-label", text: "Wet"});

		const wetSlider = wetRow.createEl("input", {cls: "rpg-audio-volume rpg-audio-reverb-wet-slider", type: "range"});
		this.reverbWetSlider = wetSlider;
		wetSlider.min = "0";
		wetSlider.max = "1";
		wetSlider.step = "0.01";
		const initialWet = this.getWetForPreset(this.manager.reverbPreset);
		wetSlider.value = String(initialWet);

		this.reverbWetReadout = wetRow.createSpan({cls: "rpg-audio-reverb-wet-readout"});
		this.updateWetReadout(initialWet);

		wetSlider.addEventListener("input", () => {
			const value = parseFloat(wetSlider.value);
			this.manager.reverbWet = value;
			this.updateWetReadout(value);
		});
		wetSlider.addEventListener("change", () => {
			this.plugin.settings.reverbWetByPreset[this.manager.reverbPreset] = parseFloat(wetSlider.value);
			void this.plugin.saveSettings();
		});

		this.reverbCueEl = reverbBody.createDiv({cls: "rpg-audio-reverb-cue"});
	}

	private getWetForPreset(id: string): number {
		return this.plugin.settings.reverbWetByPreset[id] ?? getDefaultWetLevel(id);
	}

	private updateWetReadout(value: number): void {
		if (this.reverbWetReadout) this.reverbWetReadout.setText(`${Math.round(value * 100)}%`);
	}

	/**
	 * Eases the slider to a recalled preset's saved level rather than snapping,
	 * so switching presets reads as a deliberate recall instead of a jump cut.
	 */
	private animateWetTo(target: number): void {
		const slider = this.reverbWetSlider;
		if (!slider) {
			this.manager.reverbWet = target;
			return;
		}
		if (this.wetAnimFrame !== null) {
			cancelAnimationFrame(this.wetAnimFrame);
			this.wetAnimFrame = null;
		}

		const start = parseFloat(slider.value);
		const diff = target - start;
		const duration = 280;
		const startTime = performance.now();
		const ease = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

		const step = (now: number) => {
			const elapsed = now - startTime;
			const progress = Math.min(elapsed / duration, 1);
			const value = start + diff * ease(progress);
			slider.value = String(value);
			this.manager.reverbWet = value;
			this.updateWetReadout(value);

			if (progress < 1) {
				this.wetAnimFrame = requestAnimationFrame(step);
			} else {
				slider.value = String(target);
				this.manager.reverbWet = target;
				this.updateWetReadout(target);
				this.wetAnimFrame = null;
				this.flashReverbCue();
			}
		};
		this.wetAnimFrame = requestAnimationFrame(step);
	}

	private flashReverbCue(): void {
		const cue = this.reverbCueEl;
		if (!cue) return;
		cue.addClass("is-active");
		window.setTimeout(() => cue.removeClass("is-active"), 400);
	}

	private populateReverbSelect(select: HTMLSelectElement): void {
		select.empty();
		select.createEl("option", {value: REVERB_OFF, text: "No reverb"});
		for (const p of getAllPresets()) {
			select.createEl("option", {value: p.id, text: p.name});
		}
	}

	private updateReverbBypassBtn(): void {
		if (!this.reverbBypassBtn) return;
		const hasPreset = this.manager.reverbPreset !== REVERB_OFF;
		const active = hasPreset && !this.manager.reverbBypassed;
		setIcon(this.reverbBypassBtn, "waves");
		this.reverbBypassBtn.setAttribute(
			"aria-label",
			!hasPreset ? "No reverb preset selected" :
			active    ? "Reverb on (click to bypass)" :
			             "Reverb bypassed (click to enable)"
		);
		this.reverbBypassBtn.toggleClass("is-active", active);
		this.reverbBypassBtn.toggleClass("rpg-audio-btn-disabled", !hasPreset);
	}

	private refreshReverbSelect(): void {
		if (!this.reverbSelect) return;
		this.populateReverbSelect(this.reverbSelect);
		// manager.reverbPreset is the source of truth — settings.ts already falls
		// it back to REVERB_OFF if the active preset was just deleted.
		this.reverbSelect.value = this.manager.reverbPreset;
		const wet = this.getWetForPreset(this.manager.reverbPreset);
		if (this.reverbWetSlider) this.reverbWetSlider.value = String(wet);
		this.updateWetReadout(wet);
	}

	private buildFooter(container: HTMLElement): void {
		const footer = container.createDiv({cls: "rpg-audio-sidebar-footer"});

		this.activeScopeEl = footer.createDiv({cls: "rpg-audio-sidebar-active-scope"});
		this.updateActiveScope();

		const controls = footer.createDiv({cls: "rpg-audio-sidebar-footer-controls"});
		controls.createSpan({
			cls: "rpg-audio-sidebar-version",
			text: `v${this.plugin.manifest.version}`,
		});

		this.debugToggleBtn = controls.createEl("button", {cls: "rpg-audio-btn clickable-icon"});
		this.debugToggleBtn.addEventListener("click", () => void this.toggleDebug());
		this.updateDebugBtn();

		const settingsBtn = controls.createEl("button", {cls: "rpg-audio-btn clickable-icon"});
		setIcon(settingsBtn, "settings");
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		settingsBtn.setAttribute("aria-label", "Open RPG Audio settings");
		settingsBtn.addEventListener("click", () => this.openSettings());
	}

	private updateDebugBtn(): void {
		if (!this.debugToggleBtn) return;
		const on = this.plugin.settings.showDebugInfo;
		setIcon(this.debugToggleBtn, on ? "bug" : "bug-off");
		this.debugToggleBtn.setAttribute("aria-label", on ? "Debug info on (click to disable)" : "Debug info off (click to enable)");
		this.debugToggleBtn.toggleClass("is-active", on);
	}

	private async toggleDebug(): Promise<void> {
		this.plugin.settings.showDebugInfo = !this.plugin.settings.showDebugInfo;
		await this.plugin.saveSettings();
		this.updateDebugBtn();
		this.updateActiveScope();
		this.renderAll(true);
	}

	private updateActiveScope(): void {
		if (!this.activeScopeEl) return;
		const on = this.plugin.settings.showDebugInfo;
		this.activeScopeEl.empty();
		if (!on) {
			this.activeScopeEl.addClass("is-hidden");
			return;
		}
		this.activeScopeEl.removeClass("is-hidden");
		const scope = this.manager.activeScope;
		const label = scope.length === 0 ? "(none)" : `{${scope.join(", ")}}`;
		this.activeScopeEl.createSpan({cls: "rpg-audio-debug-label", text: "Active scope: "});
		this.activeScopeEl.createSpan({text: label});
	}

	private renderAll(preserveScroll = false): void {
		if (!this.contentArea) return;
		if (preserveScroll) preserveScrollPosition(this.contentArea, () => this.renderAllContent());
		else this.renderAllContent();
	}

	private renderAllContent(): void {
		if (!this.contentArea) return;
		this.contentArea.empty();
		this.trackRows.clear();
		this.typeFadeBtns.clear();

		const allTracks = this.manager.getAllTracks();

		if (allTracks.length === 0) {
			this.contentArea.createDiv({
				cls: "rpg-audio-empty-state",
				text: "No audio tracks defined. Add rpg-audio code blocks to your notes.",
			});
			return;
		}

		const groupOrder: string[] = [];
		const groupMap: Map<string, AudioTrackState[]> = new Map();
		for (const track of allTracks) {
			const key = track.def.type;
			let group = groupMap.get(key);
			if (!group) {
				group = [];
				groupMap.set(key, group);
				groupOrder.push(key);
			}
			group.push(track);
		}

		groupOrder.sort((a, b) => a.localeCompare(b));

		for (const type of groupOrder) {
			const tracks = groupMap.get(type);
			if (!tracks || tracks.length === 0) continue;

			const section = this.contentArea.createDiv({cls: "rpg-audio-sidebar-section"});
			const isCollapsed = this.collapsedGroups.has(type);

			// Apply type-specific colour tokens to the section
			const colors = getTypeColors(type);
			section.style.setProperty("--type-bg", colors.bg);
			section.style.setProperty("--type-border", colors.border);
			section.style.setProperty("--type-text", colors.text);
			section.style.setProperty("--type-dim", colors.dim);

			const sectionHeader = section.createDiv({
				cls: "rpg-audio-sidebar-section-header" + (isCollapsed ? " is-collapsed" : ""),
			});

			const chevron = sectionHeader.createSpan({cls: "rpg-audio-section-chevron"});
			setIcon(chevron, "chevron-down");

			sectionHeader.createSpan({text: type});

			sectionHeader.createSpan({
				cls: "rpg-audio-section-count",
				text: String(tracks.length),
			});

			const fadeDuration = () => Math.max(this.manager.crossfadeDuration, MIN_FADE_DURATION_MS);

			const fadeToggleBtn = sectionHeader.createEl("button", {cls: "rpg-audio-btn rpg-audio-section-fade-btn clickable-icon"});
			fadeToggleBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this.hasPlayingTracksOfType(type)) {
					this.manager.fadeOutType(type, fadeDuration());
				} else {
					this.manager.fadeInType(type, fadeDuration());
				}
			});
			this.typeFadeBtns.set(type, fadeToggleBtn);
			this.updateFadeToggle(
				fadeToggleBtn,
				this.hasPlayingTracksOfType(type),
				this.hasPausedTracksOfType(type),
				this.getVolumeChangeDirection(type),
			);

			sectionHeader.addEventListener("click", () => {
				if (this.collapsedGroups.has(type)) {
					this.collapsedGroups.delete(type);
				} else {
					this.collapsedGroups.add(type);
				}
				this.renderAll(true);
			});

			if (!isCollapsed) {
				const sectionBody = section.createDiv({cls: "rpg-audio-sidebar-section-body"});
				for (const track of tracks) {
					this.buildTrackRow(sectionBody, track);
				}
			}
		}
	}

	private buildTrackRow(parent: HTMLElement, track: AudioTrackState): void {
		const row = parent.createDiv({cls: "rpg-audio-sidebar-track"});
		this.applyPlayStateClass(row, track.playState);

		// Row 1: transport buttons + name + badge
		const row1 = row.createDiv({cls: "rpg-audio-sidebar-track-top"});

		const transport = createTransportButtons(row1, {
			onPlay: () => void this.manager.play(track.def.id),
			onPause: () => this.manager.pause(track.def.id),
			onStop: () => this.manager.stop(track.def.id),
			onFadeOut: () => this.manager.fadeOutAndStop(track.def.id, track.def.fadeOutDuration * 1000),
		}, track.def.fadeOutDuration > 0);
		updatePlayPauseButton(transport.playPauseBtn, track.playState);

		const nameEl = row1.createDiv({cls: "rpg-audio-sidebar-track-name", text: track.def.name});
		nameEl.setAttribute("title", track.def.name);

		const badge = row1.createSpan({cls: "rpg-audio-badge"});
		badge.setText(track.def.type.toUpperCase());
		badge.dataset.type = track.def.type.toLowerCase();

		// Settings + volume on the same row (hidden in stopped state via CSS)
		const settings = createSettingsButtons(row1, track.def, (newLoop) => {
			this.manager.setLoopOverride(track.def.id, newLoop);
		});

		const volumeSlider = createVolumeControl(row1, (v) => {
			this.manager.setTrackVolume(track.def.id, v);
		}, track.volume);

		// Status (errors + playlist index)
		const statusEl = row.createDiv({cls: "rpg-audio-status"});
		this.setStatusText(statusEl, track);

		// Seek bar (hidden in stopped state via CSS)
		const seekBar = createSeekBar(row, {
			onSeek: (time) => this.manager.seek(track.def.id, time),
			onRegionChange: (start, end) => this.manager.setEffectiveRegion(track.def.id, start, end),
		});

		const scopeEl = row.createDiv({cls: "rpg-audio-sidebar-track-scope"});
		const debugEl = row.createDiv({cls: "rpg-audio-sidebar-track-debug"});
		this.updateDebugEls(scopeEl, debugEl, track);

		this.trackRows.set(track.def.id, {
			rowEl: row,
			playPauseBtn: transport.playPauseBtn,
			stopFadeBtn: transport.stopBtn,
			volumeSlider,
			statusEl,
			debugEl,
			scopeEl,
			seekBar,
			settings,
		});
		const rowData = this.trackRows.get(track.def.id);
		if (rowData) this.updateFadingState(rowData, track.def.id);
	}

	private updateTrackRow(id: string): void {
		const row = this.trackRows.get(id);
		const state = this.manager.getTrack(id);
		if (!row || !state) return;

		this.applyPlayStateClass(row.rowEl, state.playState);
		updatePlayPauseButton(row.playPauseBtn, state.playState);
		this.updateFadingState(row, id);
		row.volumeSlider.value = String(state.volume);
		this.setStatusText(row.statusEl, state);

		if (row.settings) {
			updateSettingsButtons(row.settings, this.manager.getEffectiveLoop(id));
		}

		const currentTime = this.manager.getCurrentTime(id);
		const duration = this.manager.getDuration(id);
		const region = this.manager.getEffectiveRegion(id);
		updateSeekBar(row.seekBar, currentTime, duration, region, state.playState);

		this.updateDebugEls(row.scopeEl, row.debugEl, state);
	}

	private updateFadingState(row: TrackRowData, id: string): void {
		const state = this.manager.getTrack(id);
		if (!state) return;
		const isFadingOut = this.manager.isFadingOut(id);
		const isFadingIn = this.manager.isFadingIn(id) && !isFadingOut;
		row.rowEl.toggleClass("is-fading-out", isFadingOut);
		row.rowEl.toggleClass("is-fading-in", isFadingIn);
		updateVolumeChangeFeedback(row.volumeSlider, this.manager.getVolumeChangeDirection(id));
		updateStopFadeButton(row.stopFadeBtn, isFadingOut, state.def.fadeOutDuration > 0);
	}

	private updateDebugEls(scopeEl: HTMLElement, debugEl: HTMLElement, track: AudioTrackState): void {
		const on = this.plugin.settings.showDebugInfo;
		scopeEl.empty();
		debugEl.empty();
		if (!on) {
			scopeEl.addClass("is-hidden");
			debugEl.addClass("is-hidden");
			return;
		}
		scopeEl.removeClass("is-hidden");
		debugEl.removeClass("is-hidden");

		if (track.def.scope.length > 0) {
			scopeEl.createSpan({cls: "rpg-audio-debug-label", text: "scope: "});
			scopeEl.createSpan({text: track.def.scope.join(", ")});
		} else {
			scopeEl.createSpan({cls: "rpg-audio-debug-muted", text: "no scope"});
		}

		if (track.def.startTime !== null || track.def.endTime !== null) {
			const regionEl = scopeEl.createDiv({cls: "rpg-audio-sidebar-track-debug"});
			regionEl.createSpan({cls: "rpg-audio-debug-label", text: "region: "});
			const startLabel = track.def.startTime !== null ? formatTimestamp(track.def.startTime) : "start";
			const endLabel = track.def.endTime !== null ? formatTimestamp(track.def.endTime) : "end";
			let regionText = `${startLabel} – ${endLabel}`;
			if (track.def.fadeInDuration > 0) regionText += ` | fadein: ${track.def.fadeInDuration}s`;
			if (track.def.fadeOutDuration > 0) regionText += ` | fadeout: ${track.def.fadeOutDuration}s`;
			regionEl.createSpan({text: regionText});
		}

		if (track.lastCause) {
			debugEl.setText(formatCause(track.lastCause));
		} else {
			debugEl.createSpan({cls: "rpg-audio-debug-muted", text: "no events yet"});
		}
	}

	private hasPlayingTracks(): boolean {
		return this.manager.getAllTracks().some(t => t.playState === PlayState.Playing);
	}

	private hasPausedTracks(): boolean {
		return this.manager.getAllTracks().some(t => t.playState === PlayState.Paused);
	}

	private hasPlayingTracksOfType(type: string): boolean {
		return this.manager.getAllTracks().some(t => t.def.type === type && t.playState === PlayState.Playing);
	}

	private hasPausedTracksOfType(type: string): boolean {
		return this.manager.getAllTracks().some(t => t.def.type === type && t.playState === PlayState.Paused);
	}

	private updateFadeToggle(
		btn: HTMLElement,
		hasPlaying: boolean,
		hasPaused: boolean,
		direction: VolumeChangeDirection = null,
	): void {
		btn.toggleClass("is-volume-increasing", direction === "increasing");
		btn.toggleClass("is-volume-decreasing", direction === "decreasing");
		const status = direction ? ` (volume ${direction})` : "";
		let icon = "volume-x";
		let label = "Fade out";
		let disabled = false;
		if (hasPlaying) {
			// Fade-out action remains available while tracks are playing.
		} else if (hasPaused) {
			icon = "volume-2";
			label = "Fade in";
		} else {
			disabled = true;
		}
		// Avoid replacing the SVG on every timeupdate, which would restart its blink.
		if (btn.dataset["fadeIcon"] !== icon) {
			setIcon(btn, icon);
			btn.dataset["fadeIcon"] = icon;
		}
		btn.setAttribute("aria-label", `${label}${status}`);
		btn.toggleClass("rpg-audio-btn-disabled", disabled);
	}

	private updateAutoplayBtn(): void {
		if (!this.autoplayBtn) return;
		const on = this.manager.allowAutoplay;
		setIcon(this.autoplayBtn, on ? "zap" : "zap-off");
		this.autoplayBtn.setAttribute("aria-label", on ? "Autoplay enabled (click to disable)" : "Autoplay disabled (click to enable)");
		this.autoplayBtn.toggleClass("is-active", on);
	}

	private async toggleAutoplay(): Promise<void> {
		this.plugin.settings.allowAutoplay = !this.plugin.settings.allowAutoplay;
		this.manager.allowAutoplay = this.plugin.settings.allowAutoplay;
		await this.plugin.saveSettings();
	}

	private openSettings(): void {
		const setting = (this.plugin.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting;
		setting.open();
		setting.openTabById(this.plugin.manifest.id);
	}

	private updateFadeButtons(): void {
		if (this.globalFadeBtn) {
			this.updateFadeToggle(
				this.globalFadeBtn,
				this.hasPlayingTracks(),
				this.hasPausedTracks(),
				this.getVolumeChangeDirection(),
			);
		}
		for (const [type, btn] of this.typeFadeBtns) {
			this.updateFadeToggle(
				btn,
				this.hasPlayingTracksOfType(type),
				this.hasPausedTracksOfType(type),
				this.getVolumeChangeDirection(type),
			);
		}
	}

	private getVolumeChangeDirection(type?: string): VolumeChangeDirection {
		let increasing = false;
		for (const track of this.manager.getAllTracks()) {
			if (type !== undefined && track.def.type !== type) continue;
			const direction = this.manager.getVolumeChangeDirection(track.def.id);
			if (direction === "decreasing") return direction;
			if (direction === "increasing") increasing = true;
		}
		return increasing ? "increasing" : null;
	}

	private applyPlayStateClass(el: HTMLElement, playState: PlayState): void {
		el.toggleClass("is-playing", playState === PlayState.Playing);
		el.toggleClass("is-paused", playState === PlayState.Paused);
		el.toggleClass("is-stopped", playState === PlayState.Stopped);
	}

	private setStatusText(el: HTMLElement, state: AudioTrackState): void {
		let text = "";
		if (state.error) {
			text = state.error;
			el.addClass("rpg-audio-error-text");
		} else {
			el.removeClass("rpg-audio-error-text");
			if (state.playState === PlayState.Playing && state.def.entries.length > 1) {
				text = `${state.currentIndex + 1}/${state.def.entries.length}`;
			}
		}
		el.setText(text);
	}
}
