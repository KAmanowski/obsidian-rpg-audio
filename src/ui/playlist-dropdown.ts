import {setIcon} from "obsidian";
import {AudioFileEntry, AudioTrackState, PlayState} from "../types";
import {buildPlaylistDisplayItems, PlaylistDisplayItem} from "../playlist-utils";

interface PlaylistRowElements {
	item: PlaylistDisplayItem;
	button: HTMLButtonElement;
	marker: HTMLElement;
	badge: HTMLElement;
	errorText: HTMLElement;
}

export interface PlaylistDropdownElements {
	container: HTMLElement;
	toggle: HTMLButtonElement;
	chevron: HTMLElement;
	currentName: HTMLElement;
	positionFull: HTMLElement;
	positionCompact: HTMLElement;
	listContainer: HTMLElement;
	rows: PlaylistRowElements[];
	liveRegion: HTMLElement;
	expanded: boolean;
	isBusy: boolean;
	hasSynced: boolean;
	lastStateKey: string;
	lastCurrentIndex: number;
}

export interface PlaylistDropdownCallbacks {
	onSelect: (index: number) => void;
	onExpand?: () => void;
}

let nextPlaylistId = 0;

function setExpanded(elements: PlaylistDropdownElements, expanded: boolean): void {
	elements.expanded = expanded;
	elements.container.toggleClass("is-expanded", expanded);
	elements.toggle.setAttribute("aria-expanded", String(expanded));
	elements.listContainer.hidden = !expanded;
	if (expanded) {
		elements.rows[elements.lastCurrentIndex]?.button.scrollIntoView({block: "nearest"});
	}
}

function focusRow(rows: PlaylistRowElements[], index: number): void {
	rows[Math.max(0, Math.min(rows.length - 1, index))]?.button.focus();
}

export function createPlaylistDropdown(
	parent: HTMLElement,
	entries: AudioFileEntry[],
	callbacks: PlaylistDropdownCallbacks,
): PlaylistDropdownElements {
	const id = `rpg-audio-playlist-${++nextPlaylistId}`;
	const items = buildPlaylistDisplayItems(entries);
	const container = parent.createDiv({cls: "rpg-audio-playlist"});
	const toggle = container.createEl("button", {cls: "rpg-audio-playlist-toggle"});
	toggle.type = "button";
	toggle.setAttribute("aria-expanded", "false");
	toggle.setAttribute("aria-controls", id);

	const chevron = toggle.createSpan({cls: "rpg-audio-playlist-chevron"});
	setIcon(chevron, "chevron-right");
	const currentName = toggle.createSpan({cls: "rpg-audio-playlist-current-name"});
	const position = toggle.createSpan({cls: "rpg-audio-playlist-position"});
	const positionFull = position.createSpan({cls: "rpg-audio-playlist-position-full"});
	const positionCompact = position.createSpan({cls: "rpg-audio-playlist-position-compact"});
	positionCompact.setAttribute("aria-hidden", "true");

	const listContainer = container.createDiv({cls: "rpg-audio-playlist-list"});
	listContainer.id = id;
	listContainer.hidden = true;
	const list = listContainer.createEl("ol");
	const rows: PlaylistRowElements[] = [];

	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (!item) continue;
		const listItem = list.createEl("li");
		const button = listItem.createEl("button", {cls: "rpg-audio-playlist-item"});
		button.type = "button";
		button.setAttribute("title", item.path);
		const marker = button.createSpan({cls: "rpg-audio-playlist-item-marker", text: String(index + 1)});
		const text = button.createSpan({cls: "rpg-audio-playlist-item-text"});
		text.createSpan({cls: "rpg-audio-playlist-item-name", text: item.name});
		if (item.context) text.createSpan({cls: "rpg-audio-playlist-item-context", text: item.context});
		const errorText = text.createSpan({cls: "rpg-audio-playlist-item-error"});
		errorText.hidden = true;
		const badge = button.createSpan({cls: "rpg-audio-playlist-item-badge"});
		badge.hidden = true;

		button.addEventListener("click", () => {
			if (button.getAttribute("aria-disabled") === "true" || elements.isBusy) return;
			callbacks.onSelect(index);
		});
		button.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				focusRow(rows, index + 1);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				focusRow(rows, index - 1);
			} else if (event.key === "Home") {
				event.preventDefault();
				focusRow(rows, 0);
			} else if (event.key === "End") {
				event.preventDefault();
				focusRow(rows, rows.length - 1);
			} else if (event.key === "Escape") {
				event.preventDefault();
				setExpanded(elements, false);
				toggle.focus();
			}
		});
		rows.push({item, button, marker, badge, errorText});
	}

	const liveRegion = container.createDiv({cls: "rpg-audio-playlist-live"});
	liveRegion.setAttribute("aria-live", "polite");
	liveRegion.setAttribute("aria-atomic", "true");

	const elements: PlaylistDropdownElements = {
		container,
		toggle,
		chevron,
		currentName,
		positionFull,
		positionCompact,
		listContainer,
		rows,
		liveRegion,
		expanded: false,
		isBusy: false,
		hasSynced: false,
		lastStateKey: "",
		lastCurrentIndex: 0,
	};

	toggle.addEventListener("click", () => {
		setExpanded(elements, !elements.expanded);
		if (elements.expanded) callbacks.onExpand?.();
	});
	return elements;
}

function setMarker(row: PlaylistRowElements, index: number, icon: string | null): void {
	row.marker.empty();
	if (icon) setIcon(row.marker, icon);
	else row.marker.setText(String(index + 1));
}

export function updatePlaylistDropdown(
	elements: PlaylistDropdownElements,
	state: AudioTrackState,
	unavailablePaths: Set<string>,
): void {
	const total = elements.rows.length;
	const currentIndex = Math.max(0, Math.min(total - 1, state.currentIndex));
	const current = elements.rows[currentIndex];
	if (!current) return;

	elements.isBusy = state.loadingIndex !== null;
	elements.currentName.setText(current.item.name);
	elements.currentName.setAttribute("title", current.item.path);
	elements.positionFull.setText(`${currentIndex + 1} of ${total}`);
	elements.positionCompact.setText(`${currentIndex + 1}/${total}`);
	elements.toggle.setAttribute(
		"aria-label",
		`Playlist, current track ${currentIndex + 1} of ${total}: ${current.item.path}`,
	);
	elements.listContainer.setAttribute("aria-busy", String(elements.isBusy));

	for (let index = 0; index < elements.rows.length; index++) {
		const row = elements.rows[index];
		if (!row) continue;
		const isCurrent = index === currentIndex;
		const isLoading = index === state.loadingIndex;
		const isUnavailable = unavailablePaths.has(row.item.path)
			|| (index === state.errorIndex && state.error?.startsWith("File not found:") === true);
		const isError = index === state.errorIndex
			&& state.error?.startsWith("Playback failed:") === true;
		const isPaused = isCurrent && state.playState === PlayState.Paused;
		const isPlaying = isCurrent && state.playState === PlayState.Playing;
		const isSelected = isCurrent && state.playState === PlayState.Stopped;

		row.button.toggleClass("is-current", isCurrent);
		row.button.toggleClass("is-playing", isPlaying);
		row.button.toggleClass("is-paused", isPaused);
		row.button.toggleClass("is-selected", isSelected);
		row.button.toggleClass("is-loading", isLoading);
		row.button.toggleClass("is-unavailable", isUnavailable);
		row.button.toggleClass("is-error", isError);
		if (isCurrent) row.button.setAttribute("aria-current", "true");
		else row.button.removeAttribute("aria-current");
		if (isLoading) row.button.setAttribute("aria-busy", "true");
		else row.button.removeAttribute("aria-busy");
		if (isUnavailable) row.button.setAttribute("aria-disabled", "true");
		else row.button.removeAttribute("aria-disabled");
		if (isError) row.button.setAttribute("aria-invalid", "true");
		else row.button.removeAttribute("aria-invalid");

		let badge = "";
		let icon: string | null = null;
		if (isLoading) {
			badge = "Loading";
			icon = "loader-circle";
		} else if (isUnavailable) {
			badge = "Unavailable";
			icon = "ban";
		} else if (isError) {
			badge = "Error";
			icon = "circle-alert";
		} else if (isPlaying) {
			badge = "Current";
			icon = "audio-lines";
		} else if (isPaused) {
			badge = "Paused";
			icon = "pause";
		} else if (isSelected) {
			badge = "Selected";
			icon = "check";
		}
		setMarker(row, index, icon);
		row.badge.hidden = badge.length === 0;
		row.badge.setText(badge);
		row.errorText.hidden = !isError;
		row.errorText.setText(isError ? "Playback failed · Select to retry" : "");

		const status = badge ? `, ${badge.toLocaleLowerCase()}` : "";
		row.button.setAttribute(
			"aria-label",
			`Track ${index + 1} of ${total}: ${row.item.path}${status}`,
		);
	}

	const stateKey = [currentIndex, state.playState, state.loadingIndex, state.errorIndex, state.error].join("|");
	if (elements.hasSynced && stateKey !== elements.lastStateKey) {
		if (state.loadingIndex !== null) {
			const loading = elements.rows[state.loadingIndex];
			if (loading) elements.liveRegion.setText(`Loading ${loading.item.name}.`);
		} else if (state.error) {
			elements.liveRegion.setText(state.error);
		} else if (state.playState === PlayState.Playing) {
			elements.liveRegion.setText(`Playing ${current.item.name}, track ${currentIndex + 1} of ${total}.`);
		} else if (state.playState === PlayState.Paused) {
			elements.liveRegion.setText(`Paused ${current.item.name}.`);
		} else {
			elements.liveRegion.setText(`Selected ${current.item.name}.`);
		}
	}

	if (elements.expanded && currentIndex !== elements.lastCurrentIndex) {
		current.button.scrollIntoView({block: "nearest"});
	}
	elements.hasSynced = true;
	elements.lastStateKey = stateKey;
	elements.lastCurrentIndex = currentIndex;
}
