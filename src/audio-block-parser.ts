import {AudioTrackDef} from "./types";

function parseTimestamp(str: string): number | null {
	const parts = str.split(":").map(p => p.trim());
	if (parts.length === 1) {
		const s = parseFloat(parts[0] ?? "");
		return isNaN(s) ? null : s;
	}
	if (parts.length === 2) {
		const m = parseInt(parts[0] ?? "");
		const s = parseFloat(parts[1] ?? "");
		if (isNaN(m) || isNaN(s)) return null;
		return m * 60 + s;
	}
	if (parts.length === 3) {
		const h = parseInt(parts[0] ?? "");
		const m = parseInt(parts[1] ?? "");
		const s = parseFloat(parts[2] ?? "");
		if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
		return h * 3600 + m * 60 + s;
	}
	return null;
}

function parseVolume(value: string): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function parsePositiveSeconds(value: string): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function parseAudioBlock(source: string): AudioTrackDef | null {
	const lines = source.split("\n").map(l => l.trim()).filter(l => l.length > 0);

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
	const files: string[] = [];
	let inFilesList = false;

	for (const line of lines) {
		if (inFilesList) {
			if (line.startsWith("- ")) {
				files.push(line.slice(2).trim());
				continue;
			} else {
				inFilesList = false;
			}
		}

		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const key = line.slice(0, colonIdx).trim().toLowerCase();
		const value = line.slice(colonIdx + 1).trim();

		switch (key) {
			case "id":
				id = value;
				break;
			case "name":
				name = value;
				break;
			case "type":
				type = value;
				break;
			case "loop":
				loop = value === "true";
				break;
			case "random":
				random = value === "true";
				break;
			case "autoplay":
				autoplay = value === "true";
				break;
			case "stops":
				if (value) stops = value.split(",").map(s => s.trim()).filter(Boolean);
				break;
			case "fadesout":
				if (value) fadesout = value.split(",").map(s => s.trim()).filter(Boolean);
				break;
			case "resumes":
			case "starts": // deprecated alias for `resumes`, kept for backwards compatibility
				if (value) resumes = value.split(",").map(s => s.trim()).filter(Boolean);
				break;
			case "pauses":
				if (value) pauses = value.split(",").map(s => s.trim()).filter(Boolean);
				break;
			case "scope":
				if (value) {
					const raw = value.split(",").map(s => s.trim()).filter(Boolean);
					for (const token of raw) {
						if (token.includes("/")) {
							console.warn(`RPG Audio: scope label "${token}" contains "/" which is reserved for future use`);
						}
					}
					scope = Array.from(new Set(raw));
				}
				break;
			case "start":
				startTime = parseTimestamp(value);
				break;
			case "end":
				endTime = parseTimestamp(value);
				break;
			case "fadein":
				fadeInDuration = parsePositiveSeconds(value);
				break;
			case "fadeout":
				fadeOutDuration = parsePositiveSeconds(value);
				break;
			case "volume": {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) volume = Math.max(0, Math.min(1, parsed));
				break;
			}
			case "volume-fade-to":
				volumeFadeTarget = parseVolume(value);
				break;
			case "volume-fade-duration":
				volumeFadeDuration = parsePositiveSeconds(value);
				break;
			case "file":
				if (value) files.push(value);
				break;
			case "files":
				inFilesList = true;
				break;
		}
	}

	if (!id || !name || files.length === 0) return null;
	if (!type) type = files.length > 1 ? "playlist" : "sfx";

	// Both values are required to enable volume automation. Invalid or partial
	// configuration safely falls back to the existing fixed-volume behaviour.
	if (volumeFadeTarget === null || volumeFadeDuration <= 0) {
		volumeFadeTarget = null;
		volumeFadeDuration = 0;
	}

	return {
		id, name, type, files, loop, random, autoplay, stops, fadesout, resumes, pauses, scope,
		startTime, endTime, fadeInDuration, fadeOutDuration, volume, volumeFadeTarget, volumeFadeDuration,
	};
}
