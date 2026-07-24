import {setIcon} from "obsidian";
import {PlayState} from "../types";

// ─── Transport buttons ────────────────────────────────────────────────────────

export interface TransportCallbacks {
	onPlay: () => void;
	onPause: () => void;
	onStop: () => void;
}

export interface TransportElements {
	playPauseBtn: HTMLButtonElement;
	stopBtn: HTMLButtonElement;
}

export function createTransportButtons(
	parent: HTMLElement,
	callbacks: TransportCallbacks,
): TransportElements {
	const playPauseBtn = parent.createEl("button", {
		cls: "rpg-audio-btn rpg-audio-play-btn clickable-icon",
	});
	setIcon(playPauseBtn, "play");
	playPauseBtn.setAttribute("aria-label", "Play");

	const stopBtn = parent.createEl("button", {
		cls: "rpg-audio-btn rpg-audio-stop-btn clickable-icon",
	});
	setIcon(stopBtn, "square");
	stopBtn.setAttribute("aria-label", "Stop");

	playPauseBtn.addEventListener("click", () => {
		if (playPauseBtn.dataset["state"] === PlayState.Playing) {
			callbacks.onPause();
		} else {
			callbacks.onPlay();
		}
	});
	stopBtn.addEventListener("click", () => callbacks.onStop());

	return {playPauseBtn, stopBtn};
}

export function updatePlayPauseButton(btn: HTMLButtonElement, state: PlayState): void {
	btn.dataset["state"] = state;
	btn.removeClass("is-state-playing");
	btn.removeClass("is-state-paused");
	btn.removeClass("is-state-stopped");

	if (state === PlayState.Playing) {
		setIcon(btn, "pause");
		btn.setAttribute("aria-label", "Pause");
		btn.addClass("is-state-playing");
	} else if (state === PlayState.Paused) {
		setIcon(btn, "play");
		btn.setAttribute("aria-label", "Play");
		btn.addClass("is-state-paused");
	} else {
		setIcon(btn, "play");
		btn.setAttribute("aria-label", "Play");
		btn.addClass("is-state-stopped");
	}
}

// ─── Volume control ───────────────────────────────────────────────────────────

export function createVolumeControl(
	parent: HTMLElement,
	onChange: (value: number) => void,
	initial = 1.0,
): HTMLInputElement {
	const wrapper = parent.createDiv({cls: "rpg-audio-vol-wrapper"});
	const volIcon = wrapper.createSpan({cls: "rpg-audio-vol-icon"});
	setIcon(volIcon, "volume-2");

	const slider = wrapper.createEl("input", {cls: "rpg-audio-volume", type: "range"});
	slider.min = "0";
	slider.max = "1";
	slider.step = "0.01";
	slider.value = String(initial);
	slider.addEventListener("input", () => onChange(parseFloat(slider.value)));

	return slider;
}

// ─── Settings buttons (loop toggle + fade indicator) ─────────────────────────

export interface SettingsButtonsElements {
	container: HTMLElement;
	loopBtn: HTMLButtonElement;
	fadeEl: HTMLElement | null;
}

export function createSettingsButtons(
	parent: HTMLElement,
	def: {loop: boolean; fadeInDuration: number; fadeOutDuration: number},
	onLoopToggle?: (newValue: boolean) => void,
): SettingsButtonsElements {
	const container = parent.createDiv({cls: "rpg-audio-settings-buttons"});

	const loopBtn = container.createEl("button", {cls: "rpg-audio-settings-btn clickable-icon"});
	setIcon(loopBtn, "repeat");
	loopBtn.toggleClass("is-active", def.loop);
	loopBtn.setAttribute("aria-label", def.loop ? "Loop: on" : "Loop: off");

	if (onLoopToggle) {
		loopBtn.addEventListener("click", () => {
			const newValue = !loopBtn.hasClass("is-active");
			loopBtn.toggleClass("is-active", newValue);
			loopBtn.setAttribute("aria-label", newValue ? "Loop: on" : "Loop: off");
			onLoopToggle(newValue);
		});
	}

	let fadeEl: HTMLElement | null = null;
	if (def.fadeInDuration > 0 || def.fadeOutDuration > 0) {
		fadeEl = container.createSpan({cls: "rpg-audio-settings-btn is-active"});
		setIcon(fadeEl, "activity");
		const parts: string[] = [];
		if (def.fadeInDuration > 0) parts.push(`Fade in: ${def.fadeInDuration}s`);
		if (def.fadeOutDuration > 0) parts.push(`Fade out: ${def.fadeOutDuration}s`);
		const label = parts.join(" / ");
		fadeEl.setAttribute("aria-label", label);
	}

	return {container, loopBtn, fadeEl};
}

export function updateSettingsButtons(elements: SettingsButtonsElements, loopOn: boolean): void {
	elements.loopBtn.toggleClass("is-active", loopOn);
	elements.loopBtn.setAttribute("aria-label", loopOn ? "Loop: on" : "Loop: off");
}

// ─── Seek bar ─────────────────────────────────────────────────────────────────

export interface SeekBarElements {
	wrapper: HTMLElement;
	container: HTMLElement;
	track: HTMLElement;
	slider: HTMLInputElement;
	startHandle: HTMLElement;
	endHandle: HTMLElement;
	timeLeft: HTMLElement;
	timeCenter: HTMLElement;
	timeRight: HTMLElement;
}

export interface SeekBarCallbacks {
	onSeek: (time: number) => void;
	onRegionChange?: (startTime: number | null, endTime: number | null) => void;
}

function formatTs(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = Math.floor(secs % 60).toString().padStart(2, "0");
	return `${m}:${s}`;
}

function buildSeekBackground(
	prog: number,
	rs: number,
	re: number,
	hasRegion: boolean,
	paused: boolean,
): string {
	const a0 = paused ? "rgba(80,60,140,0.4)" : "#6b4fa8";
	const a1 = paused ? "rgba(100,79,168,0.4)" : "#7c5cbf";
	const dim = "rgba(124,92,191,0.15)";
	const hatch = "repeating-linear-gradient(90deg, rgba(255,255,255,.03) 0px, rgba(255,255,255,.03) 2px, transparent 2px, transparent 4px)";
	const base = "rgba(255,255,255,0.05)";
	const p = (n: number) => `${(n * 100).toFixed(2)}%`;

	if (!hasRegion) {
		const main = `linear-gradient(90deg, ${a0} 0%, ${a1} ${p(prog)}, ${dim} ${p(prog)}, ${dim} 100%)`;
		return `${main}, ${base}`;
	}

	// Clamp progress to region bounds
	const ep = Math.max(rs, Math.min(re, prog));

	// Build 4-zone gradient: [out-of-region | played | unplayed-in-region | out-of-region]
	// Zero-width zones (when boundaries coincide) are handled gracefully by CSS.
	const stops = [
		`transparent ${p(0)}`,
		`transparent ${p(rs)}`,
		`${a0} ${p(rs)}`,
		`${a1} ${p(ep)}`,
		`${dim} ${p(ep)}`,
		`${dim} ${p(re)}`,
		`transparent ${p(re)}`,
		`transparent ${p(1)}`,
	];

	const main = `linear-gradient(90deg, ${stops.join(", ")})`;
	return `${main}, ${hatch}, ${base}`;
}

export function createSeekBar(parent: HTMLElement, callbacks: SeekBarCallbacks): SeekBarElements {
	const wrapper = parent.createDiv({cls: "rpg-audio-seek-wrapper"});

	const container = wrapper.createDiv({cls: "rpg-audio-seek-container"});
	const track = container.createDiv({cls: "rpg-audio-seek-track"});

	const slider = container.createEl("input", {cls: "rpg-audio-seek", type: "range"});
	slider.min = "0";
	slider.max = "1";
	slider.step = "0.001";
	slider.value = "0";

	const startHandle = container.createDiv({
		cls: "rpg-audio-region-handle rpg-audio-region-handle-start is-dormant",
	});
	const endHandle = container.createDiv({
		cls: "rpg-audio-region-handle rpg-audio-region-handle-end is-dormant",
	});

	const timeRow = wrapper.createDiv({cls: "rpg-audio-time-row"});
	const timeLeft = timeRow.createSpan({cls: "rpg-audio-time-left"});
	const timeCenter = timeRow.createSpan({cls: "rpg-audio-time-center"});
	const timeRight = timeRow.createSpan({cls: "rpg-audio-time-right"});

	// Initial dormant handle positions
	startHandle.style.left = "0%";
	endHandle.style.left = "100%";

	slider.addEventListener("pointerdown", () => {
		container.dataset.seeking = "1";
	});
	slider.addEventListener("change", () => {
		delete container.dataset.seeking;
	});
	slider.addEventListener("input", () => {
		const frac = parseFloat(slider.value);
		const duration = parseFloat(container.dataset.duration ?? "0");
		callbacks.onSeek(frac * duration);
	});

	const setupDrag = (handle: HTMLElement, side: "start" | "end") => {
		handle.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			handle.setPointerCapture(e.pointerId);

			const onMove = (ev: PointerEvent) => {
				const rect = track.getBoundingClientRect();
				const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
				const duration = parseFloat(container.dataset.duration ?? "0");
				const time = frac * duration;

				const curStart = container.dataset.regionStart !== undefined
					? parseFloat(container.dataset.regionStart)
					: null;
				const curEnd = container.dataset.regionEnd !== undefined
					? parseFloat(container.dataset.regionEnd)
					: null;

				if (side === "start") {
					const maxTime = curEnd !== null ? curEnd - 0.5 : duration;
					callbacks.onRegionChange?.(Math.max(0, Math.min(maxTime, time)), curEnd);
				} else {
					const minTime = curStart !== null ? curStart + 0.5 : 0;
					callbacks.onRegionChange?.(curStart, Math.max(minTime, Math.min(duration, time)));
				}
			};

			const onUp = () => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
			};

			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
		});
	};

	setupDrag(startHandle, "start");
	setupDrag(endHandle, "end");

	return {wrapper, container, track, slider, startHandle, endHandle, timeLeft, timeCenter, timeRight};
}

export function updateSeekBar(
	elements: SeekBarElements,
	currentTime: number,
	duration: number,
	region: {startTime: number | null; endTime: number | null},
	playState?: PlayState,
): void {
	elements.container.dataset.duration = String(duration);

	if (region.startTime !== null) {
		elements.container.dataset.regionStart = String(region.startTime);
	} else {
		delete elements.container.dataset.regionStart;
	}
	if (region.endTime !== null) {
		elements.container.dataset.regionEnd = String(region.endTime);
	} else {
		delete elements.container.dataset.regionEnd;
	}

	const denom = Math.max(duration, 0.001);
	const prog = duration > 0 ? currentTime / denom : 0;

	if (!elements.container.dataset.seeking) {
		elements.slider.value = String(prog);
	}

	const hasRegion = region.startTime !== null || region.endTime !== null;
	const rs = region.startTime !== null ? region.startTime / denom : 0;
	const re = region.endTime !== null ? region.endTime / denom : 1;
	const paused = playState === PlayState.Paused;

	// Update visual track gradient
	elements.track.style.background = buildSeekBackground(prog, rs, re, hasRegion, paused);

	// Handles: dormant (parked at edges, muted) or active (at region bounds, glowing)
	const dormant = !hasRegion;
	elements.startHandle.toggleClass("is-dormant", dormant);
	elements.endHandle.toggleClass("is-dormant", dormant);
	if (dormant) {
		elements.startHandle.style.left = "0%";
		elements.endHandle.style.left = "100%";
	} else {
		elements.startHandle.style.left = `${rs * 100}%`;
		elements.endHandle.style.left = `${re * 100}%`;
	}
	elements.startHandle.setAttribute(
		"title",
		region.startTime !== null ? formatTs(region.startTime) : "",
	);
	elements.endHandle.setAttribute(
		"title",
		region.endTime !== null ? formatTs(region.endTime) : "",
	);

	// Time labels
	elements.timeLeft.setText(formatTs(currentTime));
	elements.timeRight.setText(formatTs(duration));

	if (paused) {
		elements.timeCenter.setText("paused");
	} else if (hasRegion) {
		const startLabel = region.startTime !== null ? formatTs(region.startTime) : "0:00";
		const endLabel = region.endTime !== null ? formatTs(region.endTime) : formatTs(duration);
		elements.timeCenter.setText(`region ${startLabel} – ${endLabel}`);
	} else {
		elements.timeCenter.setText("");
	}
}
