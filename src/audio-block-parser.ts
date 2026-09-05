import {AudioFileEntry, AudioTrackDef, PlaylistEndAction} from "./types";

export interface AudioBlockParseResult {
	def: AudioTrackDef | null;
	errors: string[];
}

export interface AudioBlockDefaults {
	/** Playlist crossfade applied when a block omits "crossfade", in seconds. */
	playlistCrossfadeDuration: number;
	/** Track fade-out applied when a block omits "fadeout", in seconds. Zero disables the default fade. */
	fadeOutDuration: number;
	/** Volume fade target applied when a block omits "volume-fade-to". Ignored unless volumeFadeDuration is above 0. */
	volumeFadeTarget: number;
	/** Volume fade duration applied when a block omits "volume-fade-duration", in seconds. Zero disables the default fade. */
	volumeFadeDuration: number;
}

const NO_DEFAULTS: AudioBlockDefaults = {
	playlistCrossfadeDuration: 0,
	fadeOutDuration: 0,
	volumeFadeTarget: 0.5,
	volumeFadeDuration: 0,
};

const KNOWN_SETTINGS = new Set([
	"id", "name", "type", "loop", "random", "autoplay", "stops", "fadesout",
	"resumes", "starts", "pauses", "scope", "start", "end", "fadein", "fadeout",
	"volume", "volume-fade-to", "volume-fade-duration", "file", "files", "playlist-end-action",
	"crossfade",
]);

export function parseAudioTimestamp(value: string): number | null {
	const parts = value.split(":").map(part => part.trim());
	if (parts.length < 1 || parts.length > 3 || parts.some(part => part.length === 0)) return null;
	const numbers = parts.map(Number);
	if (numbers.some(part => !Number.isFinite(part) || part < 0)) return null;

	if (numbers.length === 1) return numbers[0] ?? null;
	const seconds = numbers[numbers.length - 1];
	const minutes = numbers[numbers.length - 2];
	if (seconds === undefined || minutes === undefined || seconds >= 60) return null;
	if (numbers.length === 2) return minutes * 60 + seconds;
	if (minutes >= 60) return null;
	const hours = numbers[0];
	return hours === undefined ? null : hours * 3600 + minutes * 60 + seconds;
}

function parseBoolean(value: string): boolean | null {
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
}

export function parseAudioVolume(value: string): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

export function parseNonNegativeSeconds(value: string): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseDurationSeconds(value: string): number | null {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return null;
	const numeric = normalized.endsWith("s") ? normalized.slice(0, -1).trim() : normalized;
	return parseNonNegativeSeconds(numeric);
}

function parseEntryBoundary(
	value: string,
	key: "start" | "end",
	lineNumber: number,
	errors: string[],
): number | null | undefined {
	if (!value) {
		errors.push(`Line ${lineNumber}: Playlist file option "${key}" cannot be empty.`);
		return undefined;
	}
	if (value.toLowerCase() === "none") return null;
	const parsed = parseAudioTimestamp(value);
	if (parsed === null) {
		errors.push(`Line ${lineNumber}: Playlist file option "${key}" must be a timestamp or "none".`);
		return undefined;
	}
	return parsed;
}

function parseFileEntry(value: string, lineNumber: number, errors: string[]): AudioFileEntry {
	let remaining = value.trim();
	const entry: AudioFileEntry = {path: "", title: null};

	const braceStart = remaining.lastIndexOf(" {");
	if (braceStart >= 0 && remaining.endsWith("}")) {
		const optionText = remaining.slice(braceStart + 2, -1).trim();
		remaining = remaining.slice(0, braceStart).trim();
		const seen = new Set<string>();
		if (!optionText) errors.push(`Line ${lineNumber}: Playlist file options inside braces cannot be empty.`);
		for (const rawOption of optionText.split(",")) {
			const equals = rawOption.indexOf("=");
			if (equals < 0) {
				errors.push(`Line ${lineNumber}: Playlist file option "${rawOption.trim()}" must use name=value.`);
				continue;
			}
			const key = rawOption.slice(0, equals).trim().toLowerCase();
			const rawValue = rawOption.slice(equals + 1).trim();
			if (key !== "start" && key !== "end") {
				errors.push(`Line ${lineNumber}: Unknown playlist file option "${key}".`);
				continue;
			}
			if (seen.has(key)) {
				errors.push(`Line ${lineNumber}: Playlist file option "${key}" is duplicated.`);
				continue;
			}
			seen.add(key);
			const parsed = parseEntryBoundary(rawValue, key, lineNumber, errors);
			if (parsed !== undefined) {
				if (key === "start") entry.startTime = parsed;
				else entry.endTime = parsed;
			}
		}
	} else if (remaining.includes("{") || remaining.includes("}")) {
		errors.push(`Line ${lineNumber}: Playlist file options must be a trailing block such as {start=0:30, end=2:00}.`);
	}

	const titleStart = remaining.lastIndexOf(" [");
	if (titleStart >= 0 && remaining.endsWith("]")) {
		entry.path = remaining.slice(0, titleStart).trim();
		entry.title = remaining.slice(titleStart + 2, -1).trim() || null;
		if (!entry.title) errors.push(`Line ${lineNumber}: Audio file title inside brackets cannot be empty.`);
	} else {
		entry.path = remaining;
	}
	if (!entry.path) errors.push(`Line ${lineNumber}: Audio file path cannot be empty.`);
	return entry;
}

export function parseAudioBlockDetailed(source: string, defaults: AudioBlockDefaults = NO_DEFAULTS): AudioBlockParseResult {
	const lines = source.split("\n")
		.map((raw, index) => ({text: raw.trim(), number: index + 1}))
		.filter(line => line.text.length > 0);
	const errors: string[] = [];

	let id = "";
	let name = "";
	let type = "";
	let loop = false;
	let random = false;
	let playlistEndAction: PlaylistEndAction = "auto";
	let sawPlaylistEndAction = false;
	let playlistCrossfadeDuration = 0;
	let sawPlaylistCrossfade = false;
	let autoplay = false;
	let stops: string[] = [];
	let fadesout: string[] = [];
	let resumes: string[] = [];
	let pauses: string[] = [];
	let scope: string[] = [];
	let startTime: number | null = null;
	let endTime: number | null = null;
	let fadeInDuration = 0;
	let fadeOutDuration = 0;
	let sawFadeOut = false;
	let volume = 1;
	let volumeFadeTarget: number | null = null;
	let volumeFadeDuration = 0;
	let sawVolumeFadeTarget = false;
	let sawVolumeFadeDuration = false;
	const entries: AudioFileEntry[] = [];
	const entryLines: number[] = [];
	let inFilesList = false;

	for (const line of lines) {
		if (inFilesList && line.text.startsWith("- ")) {
			const entry = parseFileEntry(line.text.slice(2).trim(), line.number, errors);
			if (entry.path) { entries.push(entry); entryLines.push(line.number); }
			continue;
		}
		inFilesList = false;

		const colonIdx = line.text.indexOf(":");
		if (colonIdx === -1) {
			errors.push(`Line ${line.number}: Expected a setting in "name: value" format.`);
			continue;
		}

		const key = line.text.slice(0, colonIdx).trim().toLowerCase();
		const value = line.text.slice(colonIdx + 1).trim();
		if (!KNOWN_SETTINGS.has(key)) {
			errors.push(`Line ${line.number}: Unknown setting "${key || line.text}".`);
			continue;
		}

		switch (key) {
			case "id": id = value; break;
			case "name": name = value; break;
			case "type": type = value; break;
			case "loop": {
				const parsed = parseBoolean(value);
				if (parsed === null) errors.push(`Line ${line.number}: "loop" must be true or false.`);
				else loop = parsed;
				break;
			}
			case "random": {
				const parsed = parseBoolean(value);
				if (parsed === null) errors.push(`Line ${line.number}: "random" must be true or false.`);
				else random = parsed;
				break;
			}
			case "playlist-end-action": {
				sawPlaylistEndAction = true;
				if (value === "auto" || value === "next" || value === "repeat" || value === "stop") {
					playlistEndAction = value;
				} else {
					errors.push(`Line ${line.number}: "playlist-end-action" must be auto, next, repeat, or stop.`);
				}
				break;
			}
			case "crossfade": {
				sawPlaylistCrossfade = true;
				const parsed = parseDurationSeconds(value);
				if (parsed === null) errors.push(`Line ${line.number}: "crossfade" must be zero or a positive number of seconds, such as 3 or 3s.`);
				else playlistCrossfadeDuration = parsed;
				break;
			}
			case "autoplay": {
				const parsed = parseBoolean(value);
				if (parsed === null) errors.push(`Line ${line.number}: "autoplay" must be true or false.`);
				else autoplay = parsed;
				break;
			}
			case "stops": stops = value.split(",").map(item => item.trim()).filter(Boolean); break;
			case "fadesout": fadesout = value.split(",").map(item => item.trim()).filter(Boolean); break;
			case "resumes":
			case "starts":
				resumes = value.split(",").map(item => item.trim()).filter(Boolean);
				break;
			case "pauses": pauses = value.split(",").map(item => item.trim()).filter(Boolean); break;
			case "scope": {
				const raw = value.split(",").map(item => item.trim()).filter(Boolean);
				for (const token of raw) {
					if (token.includes("/")) console.warn(`RPG Audio: scope label "${token}" contains "/" which is reserved for future use`);
				}
				scope = Array.from(new Set(raw));
				break;
			}
			case "start": {
				const parsed = parseAudioTimestamp(value);
				if (parsed === null) errors.push(`Line ${line.number}: "start" must be a non-negative timestamp such as 25 or 1:30.`);
				else startTime = parsed;
				break;
			}
			case "end": {
				const parsed = parseAudioTimestamp(value);
				if (parsed === null) errors.push(`Line ${line.number}: "end" must be a non-negative timestamp such as 90 or 1:30.`);
				else endTime = parsed;
				break;
			}
			case "fadein": {
				const parsed = parseNonNegativeSeconds(value);
				if (parsed === null) errors.push(`Line ${line.number}: "fadein" must be zero or a positive number of seconds.`);
				else fadeInDuration = parsed;
				break;
			}
			case "fadeout": {
				sawFadeOut = true;
				const parsed = parseNonNegativeSeconds(value);
				if (parsed === null) errors.push(`Line ${line.number}: "fadeout" must be zero or a positive number of seconds.`);
				else fadeOutDuration = parsed;
				break;
			}
			case "volume": {
				const parsed = parseAudioVolume(value);
				if (parsed === null) errors.push(`Line ${line.number}: "volume" must be a number from 0 to 1.`);
				else volume = parsed;
				break;
			}
			case "volume-fade-to": {
				sawVolumeFadeTarget = true;
				const parsed = parseAudioVolume(value);
				if (parsed === null) errors.push(`Line ${line.number}: "volume-fade-to" must be a number from 0 to 1.`);
				else volumeFadeTarget = parsed;
				break;
			}
			case "volume-fade-duration": {
				sawVolumeFadeDuration = true;
				const parsed = parseNonNegativeSeconds(value);
				if (parsed === null || parsed === 0) errors.push(`Line ${line.number}: "volume-fade-duration" must be a positive number of seconds.`);
				else volumeFadeDuration = parsed;
				break;
			}
			case "file":
				if (value) {
					const entry = parseFileEntry(value, line.number, errors);
					if (entry.path) { entries.push(entry); entryLines.push(line.number); }
				}
				break;
			case "files":
				if (value) errors.push(`Line ${line.number}: Put playlist paths on following lines, each beginning with "- ".`);
				inFilesList = true;
				break;
		}
	}

	if (!id) errors.push("Missing required setting: id.");
	if (!name) errors.push("Missing required setting: name.");
	if (entries.length === 0) errors.push("Missing required audio file: add file or files.");
	if (startTime !== null && endTime !== null && endTime <= startTime) errors.push('"end" must be later than "start".');
	if (sawVolumeFadeTarget !== sawVolumeFadeDuration) errors.push('"volume-fade-to" and "volume-fade-duration" must be used together.');
	if (sawPlaylistEndAction && entries.length < 2) errors.push('"playlist-end-action" requires more than one audio file.');
	if (sawPlaylistCrossfade && entries.length < 2) errors.push('"crossfade" requires more than one audio file.');
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry || (entry.startTime === undefined && entry.endTime === undefined)) continue;
		const effectiveStart = entry.startTime === undefined ? startTime : entry.startTime;
		const effectiveEnd = entry.endTime === undefined ? endTime : entry.endTime;
		if (effectiveStart !== null && effectiveEnd !== null && effectiveEnd <= effectiveStart) {
			errors.push(`Line ${entryLines[index]}: Effective file "end" must be later than "start".`);
		}
	}

	if (!type) type = entries.length > 1 ? "playlist" : "sfx";
	if (!sawPlaylistCrossfade) playlistCrossfadeDuration = defaults.playlistCrossfadeDuration;
	if (!sawFadeOut) fadeOutDuration = defaults.fadeOutDuration;
	if (!sawVolumeFadeTarget && !sawVolumeFadeDuration) {
		volumeFadeTarget = defaults.volumeFadeTarget;
		volumeFadeDuration = defaults.volumeFadeDuration;
	}
	if (volumeFadeTarget === null || volumeFadeDuration <= 0) {
		volumeFadeTarget = null;
		volumeFadeDuration = 0;
	}

	const def: AudioTrackDef | null = id && name && entries.length > 0 ? {
		id, name, type, entries, playlistEndAction, playlistCrossfadeDuration, loop, random, autoplay, stops, fadesout, resumes, pauses, scope,
		startTime, endTime, fadeInDuration, fadeOutDuration, volume, volumeFadeTarget, volumeFadeDuration,
	} : null;
	return {def, errors: Array.from(new Set(errors))};
}

/** Compatibility helper for callers that only need the normalized definition. */
export function parseAudioBlock(source: string, defaults?: AudioBlockDefaults): AudioTrackDef | null {
	return parseAudioBlockDetailed(source, defaults).def;
}
