import {AudioTrackDef} from "./types";

export interface AudioBlockParseResult {
	def: AudioTrackDef | null;
	errors: string[];
}

const KNOWN_SETTINGS = new Set([
	"id", "name", "type", "loop", "random", "autoplay", "stops", "fadesout",
	"resumes", "starts", "pauses", "scope", "start", "end", "fadein", "fadeout",
	"volume", "volume-fade-to", "volume-fade-duration", "file", "files",
]);

function parseTimestamp(value: string): number | null {
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

function parseVolume(value: string): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function parseNonNegativeSeconds(value: string): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseAudioBlockDetailed(source: string): AudioBlockParseResult {
	const lines = source.split("\n")
		.map((raw, index) => ({text: raw.trim(), number: index + 1}))
		.filter(line => line.text.length > 0);
	const errors: string[] = [];

	let id = "";
	let name = "";
	let type = "";
	let loop = false;
	let random = false;
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
	let volume = 1;
	let volumeFadeTarget: number | null = null;
	let volumeFadeDuration = 0;
	let sawVolumeFadeTarget = false;
	let sawVolumeFadeDuration = false;
	const files: string[] = [];
	let inFilesList = false;

	for (const line of lines) {
		if (inFilesList && line.text.startsWith("- ")) {
			const path = line.text.slice(2).trim();
			if (path) files.push(path);
			else errors.push(`Line ${line.number}: Audio file path cannot be empty.`);
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
				const parsed = parseTimestamp(value);
				if (parsed === null) errors.push(`Line ${line.number}: "start" must be a non-negative timestamp such as 25 or 1:30.`);
				else startTime = parsed;
				break;
			}
			case "end": {
				const parsed = parseTimestamp(value);
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
				const parsed = parseNonNegativeSeconds(value);
				if (parsed === null) errors.push(`Line ${line.number}: "fadeout" must be zero or a positive number of seconds.`);
				else fadeOutDuration = parsed;
				break;
			}
			case "volume": {
				const parsed = parseVolume(value);
				if (parsed === null) errors.push(`Line ${line.number}: "volume" must be a number from 0 to 1.`);
				else volume = parsed;
				break;
			}
			case "volume-fade-to": {
				sawVolumeFadeTarget = true;
				const parsed = parseVolume(value);
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
				if (value) files.push(value);
				break;
			case "files":
				if (value) errors.push(`Line ${line.number}: Put playlist paths on following lines, each beginning with "- ".`);
				inFilesList = true;
				break;
		}
	}

	if (!id) errors.push("Missing required setting: id.");
	if (!name) errors.push("Missing required setting: name.");
	if (files.length === 0) errors.push("Missing required audio file: add file or files.");
	if (startTime !== null && endTime !== null && endTime <= startTime) errors.push('"end" must be later than "start".');
	if (sawVolumeFadeTarget !== sawVolumeFadeDuration) errors.push('"volume-fade-to" and "volume-fade-duration" must be used together.');

	if (!type) type = files.length > 1 ? "playlist" : "sfx";
	if (volumeFadeTarget === null || volumeFadeDuration <= 0) {
		volumeFadeTarget = null;
		volumeFadeDuration = 0;
	}

	const def: AudioTrackDef | null = id && name && files.length > 0 ? {
		id, name, type, files, loop, random, autoplay, stops, fadesout, resumes, pauses, scope,
		startTime, endTime, fadeInDuration, fadeOutDuration, volume, volumeFadeTarget, volumeFadeDuration,
	} : null;
	return {def, errors: Array.from(new Set(errors))};
}

/** Compatibility helper for callers that only need the normalized definition. */
export function parseAudioBlock(source: string): AudioTrackDef | null {
	return parseAudioBlockDetailed(source).def;
}
