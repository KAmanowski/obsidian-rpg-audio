import {setIcon} from "obsidian";
import {PlayState} from "../types";

export interface PlayerControlsCallbacks {
	onPlay: () => void;
	onPause: () => void;
	onStop: () => void;
	onVolumeChange: (volume: number) => void;
}

export interface PlayerControlsElements {
	container: HTMLElement;
	playPauseBtn: HTMLButtonElement;
	stopBtn: HTMLButtonElement;
	volumeSlider: HTMLInputElement;
}

export function createPlayerControls(
	parent: HTMLElement,
	callbacks: PlayerControlsCallbacks,
	initialVolume = 1.0,
): PlayerControlsElements {
	const container = parent.createDiv({cls: "rpg-audio-controls"});

	const playPauseBtn = container.createEl("button", {cls: "rpg-audio-btn rpg-audio-play-btn clickable-icon"});
	setIcon(playPauseBtn, "play");

	const stopBtn = container.createEl("button", {cls: "rpg-audio-btn rpg-audio-stop-btn clickable-icon"});
	setIcon(stopBtn, "square");

	const volumeSlider = container.createEl("input", {
		cls: "rpg-audio-volume",
		type: "range",
	});
	volumeSlider.min = "0";
	volumeSlider.max = "1";
	volumeSlider.step = "0.01";
	volumeSlider.value = String(initialVolume);

	playPauseBtn.addEventListener("click", () => {
		const isPlaying = playPauseBtn.dataset["state"] === PlayState.Playing;
		if (isPlaying) {
			callbacks.onPause();
		} else {
			callbacks.onPlay();
		}
	});

	stopBtn.addEventListener("click", () => callbacks.onStop());
	volumeSlider.addEventListener("input", () => callbacks.onVolumeChange(parseFloat(volumeSlider.value)));

	return {container, playPauseBtn, stopBtn, volumeSlider};
}

export function updatePlayPauseButton(btn: HTMLButtonElement, state: PlayState): void {
	btn.dataset["state"] = state;
	if (state === PlayState.Playing) {
		setIcon(btn, "pause");
		btn.setAttribute("aria-label", "Pause");
	} else {
		setIcon(btn, "play");
		btn.setAttribute("aria-label", "Play");
	}
}

function formatTs(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = Math.floor(secs % 60).toString().padStart(2, "0");
	return `${m}:${s}`;
}

export interface SeekBarElements {
	container: HTMLElement;
	slider: HTMLInputElement;
	timeDisplay: HTMLElement;
	startHandle: HTMLElement;
	endHandle: HTMLElement;
}

export interface SeekBarCallbacks {
	onSeek: (time: number) => void;
	onRegionChange?: (startTime: number | null, endTime: number | null) => void;
}

export function createSeekBar(parent: HTMLElement, callbacks: SeekBarCallbacks): SeekBarElements {
	const container = parent.createDiv({cls: "rpg-audio-seek-container"});

	const slider = container.createEl("input", {
		cls: "rpg-audio-seek",
		type: "range",
	});
	slider.min = "0";
	slider.max = "1";
	slider.step = "0.001";
	slider.value = "0";

	const timeDisplay = container.createSpan({cls: "rpg-audio-time"});

	const startHandle = container.createDiv({cls: "rpg-audio-region-handle rpg-audio-region-handle-start"});
	const endHandle = container.createDiv({cls: "rpg-audio-region-handle rpg-audio-region-handle-end"});

	slider.addEventListener("pointerdown", () => { container.dataset.seeking = "1"; });
	slider.addEventListener("change", () => { delete container.dataset.seeking; });
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
				const rect = slider.getBoundingClientRect();
				const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
				const duration = parseFloat(container.dataset.duration ?? "0");
				const time = frac * duration;

				const curStart = container.dataset.regionStart !== undefined ? parseFloat(container.dataset.regionStart) : null;
				const curEnd = container.dataset.regionEnd !== undefined ? parseFloat(container.dataset.regionEnd) : null;

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

	return {container, slider, timeDisplay, startHandle, endHandle};
}

export function updateSeekBar(
	elements: SeekBarElements,
	currentTime: number,
	duration: number,
	region: {startTime: number | null; endTime: number | null},
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
	const frac = duration > 0 ? currentTime / duration : 0;

	if (!elements.container.dataset.seeking) {
		elements.slider.value = String(frac);
	}

	elements.timeDisplay.setText(`${formatTs(currentTime)} / ${formatTs(duration)}`);

	const regionStart = region.startTime !== null ? region.startTime / denom : 0;
	const regionEnd = region.endTime !== null ? region.endTime / denom : 1;

	elements.container.style.setProperty("--region-start", `${regionStart * 100}%`);
	elements.container.style.setProperty("--region-end", `${regionEnd * 100}%`);
	elements.container.style.setProperty("--seek-progress", `${frac * 100}%`);

	const hasRegion = region.startTime !== null || region.endTime !== null;
	elements.startHandle.toggleClass("is-hidden", !hasRegion);
	elements.endHandle.toggleClass("is-hidden", !hasRegion);

	if (hasRegion) {
		elements.startHandle.style.left = `${regionStart * 100}%`;
		elements.endHandle.style.left = `${regionEnd * 100}%`;
		elements.startHandle.setAttribute("title", region.startTime !== null ? formatTs(region.startTime) : "");
		elements.endHandle.setAttribute("title", region.endTime !== null ? formatTs(region.endTime) : "");
	}
}
