import {
	AudioBlockDefaults,
	parseAudioBlockDetailed,
	parseAudioTimestamp,
	parseAudioVolume,
	parseDurationSeconds,
	parseNonNegativeSeconds,
} from "./audio-block-parser";
import {PlaylistEndAction} from "./types";

export type OptionalInput = {mode: "inherit"} | {mode: "value"; value: string};
export type BoundaryInput = {mode: "inherit"} | {mode: "none"} | {mode: "value"; value: string};

export interface AudioFileDraft {
	key: string;
	path: string;
	title: string;
	start: BoundaryInput;
	end: BoundaryInput;
}

export interface AudioBlockFormState {
	name: string;
	id: string;
	type: OptionalInput;
	entries: AudioFileDraft[];
	loop: boolean;
	random: boolean;
	autoplay: boolean;
	playlistEndAction: PlaylistEndAction;
	playlistCrossfade: OptionalInput;
	start: string;
	end: string;
	fadein: string;
	fadeout: string;
	volume: OptionalInput;
	volumeFadeMode: "inherit" | "custom";
	volumeFadeTarget: string;
	volumeFadeDuration: string;
	scope: string[];
	stops: string[];
	fadesout: string[];
	pauses: string[];
	resumes: string[];
}

export interface AudioBlockAuthoringDefaults {
	type: string;
	loop: boolean;
	random: boolean;
	autoplay: boolean;
	playlistEndAction: PlaylistEndAction;
	fadeInDuration: number;
	fadeOutDuration: number;
	volume: number;
}

export interface AudioBlockHydrationResult {
	state: AudioBlockFormState;
	issues: string[];
}

export interface AudioBlockValidationContext {
	parserDefaults: AudioBlockDefaults;
	duplicateIds?: Iterable<string>;
	isFileAvailable?: (path: string) => boolean;
	hydrationIssues?: string[];
}

export interface AudioBlockValidationResult {
	valid: boolean;
	fieldErrors: Record<string, string[]>;
	errors: string[];
	serialized: string;
}

export const DEFAULT_AUTHORING_DEFAULTS: AudioBlockAuthoringDefaults = {
	type: "",
	loop: false,
	random: false,
	autoplay: false,
	playlistEndAction: "auto",
	fadeInDuration: 0,
	fadeOutDuration: 0,
	volume: 1,
};

const KNOWN_KEYS = new Set([
	"id", "name", "type", "loop", "random", "autoplay", "scope", "stops", "fadesout", "pauses",
	"resumes", "starts", "start", "end", "fadein", "fadeout", "volume", "volume-fade-to",
	"volume-fade-duration", "playlist-end-action", "crossfade", "file", "files",
]);

const EDITABLE_REQUIRED_PARSER_ERRORS = new Set([
	"Missing required setting: id.",
	"Missing required setting: name.",
	"Missing required audio file: add file or files.",
]);

let draftSequence = 0;

export function createAudioFileDraft(path: string): AudioFileDraft {
	draftSequence += 1;
	return {
		key: `audio-file-${Date.now()}-${draftSequence}`,
		path,
		title: "",
		start: {mode: "inherit"},
		end: {mode: "inherit"},
	};
}

export function slugifyAudioBlockId(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function numberInput(value: number, fallback: number): string {
	return Number.isFinite(value) && value !== fallback ? String(value) : "";
}

export function createAudioBlockFormState(
	defaults: AudioBlockAuthoringDefaults = DEFAULT_AUTHORING_DEFAULTS,
): AudioBlockFormState {
	return {
		name: "",
		id: "",
		type: defaults.type.trim() ? {mode: "value", value: defaults.type.trim()} : {mode: "inherit"},
		entries: [],
		loop: defaults.loop,
		random: defaults.random,
		autoplay: defaults.autoplay,
		playlistEndAction: defaults.playlistEndAction,
		playlistCrossfade: {mode: "inherit"},
		start: "",
		end: "",
		fadein: numberInput(defaults.fadeInDuration, 0),
		fadeout: numberInput(defaults.fadeOutDuration, 0),
		volume: defaults.volume === 1 ? {mode: "inherit"} : {mode: "value", value: String(defaults.volume)},
		volumeFadeMode: "inherit",
		volumeFadeTarget: "",
		volumeFadeDuration: "",
		scope: [],
		stops: [],
		fadesout: [],
		pauses: [],
		resumes: [],
	};
}

export function isPlaylistForm(state: AudioBlockFormState): boolean {
	return state.entries.length > 1;
}

function rawSettings(source: string): {values: Map<string, string>; issues: string[]} {
	const values = new Map<string, string>();
	const issues: string[] = [];
	let inFiles = false;
	const seen = new Set<string>();
	for (const [index, raw] of source.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (!line) continue;
		if (inFiles && line.startsWith("- ")) continue;
		inFiles = false;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const sourceKey = line.slice(0, colon).trim().toLowerCase();
		if (!KNOWN_KEYS.has(sourceKey)) continue;
		const key = sourceKey === "starts" ? "resumes" : sourceKey;
		if (seen.has(key)) issues.push(`Line ${index + 1}: Setting "${key}" is duplicated and cannot be edited safely.`);
		seen.add(key);
		values.set(key, line.slice(colon + 1).trim());
		if (sourceKey === "files") inFiles = true;
	}
	if (values.has("file") && values.has("files")) {
		issues.push('Settings "file" and "files" cannot be used together in the visual editor.');
	}
	return {values, issues};
}

function boundaryFromParsed(value: number | null | undefined): BoundaryInput {
	if (value === undefined) return {mode: "inherit"};
	if (value === null) return {mode: "none"};
	return {mode: "value", value: String(value)};
}

function csv(value: string | undefined): string[] {
	return value?.split(",").map(item => item.trim()).filter(Boolean) ?? [];
}

export function hydrateAudioBlockForm(
	source: string,
	parserDefaults: AudioBlockDefaults,
	authoringDefaults: AudioBlockAuthoringDefaults = DEFAULT_AUTHORING_DEFAULTS,
): AudioBlockHydrationResult {
	const raw = rawSettings(source);
	const parsed = parseAudioBlockDetailed(source, parserDefaults);
	const state = createAudioBlockFormState(authoringDefaults);
	const def = parsed.def;

	state.id = raw.values.get("id") ?? "";
	state.name = raw.values.get("name") ?? "";
	state.type = raw.values.has("type")
		? {mode: "value", value: raw.values.get("type") ?? ""}
		: {mode: "inherit"};
	state.start = raw.values.get("start") ?? "";
	state.end = raw.values.get("end") ?? "";
	state.fadein = raw.values.get("fadein") ?? "";
	state.fadeout = raw.values.get("fadeout") ?? "";
	state.volume = raw.values.has("volume")
		? {mode: "value", value: raw.values.get("volume") ?? ""}
		: {mode: "inherit"};
	state.playlistCrossfade = raw.values.has("crossfade")
		? {mode: "value", value: raw.values.get("crossfade") ?? ""}
		: {mode: "inherit"};
	state.volumeFadeMode = raw.values.has("volume-fade-to") || raw.values.has("volume-fade-duration")
		? "custom"
		: "inherit";
	state.volumeFadeTarget = raw.values.get("volume-fade-to") ?? "";
	state.volumeFadeDuration = raw.values.get("volume-fade-duration") ?? "";
	state.scope = csv(raw.values.get("scope"));
	state.stops = csv(raw.values.get("stops"));
	state.fadesout = csv(raw.values.get("fadesout"));
	state.pauses = csv(raw.values.get("pauses"));
	state.resumes = csv(raw.values.get("resumes"));

	if (def) {
		state.loop = def.loop;
		state.random = def.random;
		state.autoplay = def.autoplay;
		state.playlistEndAction = def.playlistEndAction;
		state.entries = def.entries.map(entry => ({
			...createAudioFileDraft(entry.path),
			title: entry.title ?? "",
			start: boundaryFromParsed(entry.startTime),
			end: boundaryFromParsed(entry.endTime),
		}));
		const singleEntry = def.entries.length === 1 ? def.entries[0] : undefined;
		if (singleEntry && (singleEntry.title !== null || singleEntry.startTime !== undefined || singleEntry.endTime !== undefined)) {
			raw.issues.push("This single-file block uses playlist-style title or per-file region metadata. Move those boundaries to block-level start/end settings, or add a second file, before using the visual editor.");
		}
	}

	const unsafeParserIssues = parsed.errors.filter(error => !EDITABLE_REQUIRED_PARSER_ERRORS.has(error));
	return {state, issues: Array.from(new Set([...unsafeParserIssues, ...raw.issues]))};
}

function appendCsv(lines: string[], key: string, values: string[]): void {
	const normalized = values.map(value => value.trim()).filter(Boolean);
	if (normalized.length > 0) lines.push(`${key}: ${normalized.join(", ")}`);
}

function entryBoundary(key: "start" | "end", input: BoundaryInput): string | null {
	if (input.mode === "inherit") return null;
	if (input.mode === "none") return `${key}=none`;
	return `${key}=${input.value.trim()}`;
}

export function serializeAudioBlockBody(state: AudioBlockFormState): string {
	const playlist = isPlaylistForm(state);
	const lines = [`id: ${state.id.trim()}`, `name: ${state.name.trim()}`];
	if (state.type.mode === "value" && state.type.value.trim()) lines.push(`type: ${state.type.value.trim()}`);
	if (state.loop) lines.push("loop: true");
	if (playlist && state.random) lines.push("random: true");
	if (playlist && state.playlistEndAction !== "auto") lines.push(`playlist-end-action: ${state.playlistEndAction}`);
	if (playlist && state.playlistCrossfade.mode === "value") {
		lines.push(`crossfade: ${state.playlistCrossfade.value.trim()}`);
	}
	if (state.autoplay) lines.push("autoplay: true");
	appendCsv(lines, "scope", state.scope);
	appendCsv(lines, "stops", state.stops);
	appendCsv(lines, "fadesout", state.fadesout);
	appendCsv(lines, "pauses", state.pauses);
	appendCsv(lines, "resumes", state.resumes);
	if (state.start.trim()) lines.push(`start: ${state.start.trim()}`);
	if (state.end.trim()) lines.push(`end: ${state.end.trim()}`);
	if (state.fadein.trim()) lines.push(`fadein: ${state.fadein.trim()}`);
	if (state.fadeout.trim()) lines.push(`fadeout: ${state.fadeout.trim()}`);
	if (state.volume.mode === "value" && state.volume.value.trim() !== "1") {
		lines.push(`volume: ${state.volume.value.trim()}`);
	}
	if (state.volumeFadeMode === "custom") {
		lines.push(`volume-fade-to: ${state.volumeFadeTarget.trim()}`);
		lines.push(`volume-fade-duration: ${state.volumeFadeDuration.trim()}`);
	}

	if (state.entries.length === 1) {
		lines.push(`file: ${state.entries[0]?.path.trim() ?? ""}`);
	} else if (playlist) {
		lines.push("files:");
		for (const entry of state.entries) {
			let value = entry.path.trim();
			if (entry.title.trim()) value += ` [${entry.title.trim()}]`;
			const boundaries = [entryBoundary("start", entry.start), entryBoundary("end", entry.end)]
				.filter((item): item is string => item !== null);
			if (boundaries.length > 0) value += ` {${boundaries.join(", ")}}`;
			lines.push(`- ${value}`);
		}
	}
	return lines.join("\n");
}

export function serializeAudioBlock(state: AudioBlockFormState): string {
	return `\`\`\`rpg-audio\n${serializeAudioBlockBody(state)}\n\`\`\``;
}

function addError(fieldErrors: Record<string, string[]>, field: string, message: string): void {
	(fieldErrors[field] ??= []).push(message);
}

function validateTimestamp(fieldErrors: Record<string, string[]>, field: string, value: string): number | null {
	if (!value.trim()) return null;
	const parsed = parseAudioTimestamp(value.trim());
	if (parsed === null) addError(fieldErrors, field, "Enter a non-negative timestamp such as 25, 1:30, or 1:02:30.");
	return parsed;
}

export function validateAudioBlockForm(
	state: AudioBlockFormState,
	context: AudioBlockValidationContext,
): AudioBlockValidationResult {
	const fieldErrors: Record<string, string[]> = {};
	if (!state.name.trim()) addError(fieldErrors, "name", "Name is required.");
	if (!state.id.trim()) addError(fieldErrors, "id", "ID is required.");
	if (state.type.mode === "value" && !state.type.value.trim()) addError(fieldErrors, "type", "Enter a custom type or use Automatic.");
	if (state.entries.length === 0) addError(fieldErrors, "files", "Add at least one audio file.");

	const duplicateIds = new Set(Array.from(context.duplicateIds ?? [], value => value.trim()).filter(Boolean));
	if (state.id.trim() && duplicateIds.has(state.id.trim())) {
		addError(fieldErrors, "id", "This ID is already used by another audio block in this note.");
	}

	for (const entry of state.entries) {
		if (!entry.path.trim()) addError(fieldErrors, `entry-${entry.key}`, "Audio file path is required.");
		else if (context.isFileAvailable && !context.isFileAvailable(entry.path)) {
			addError(fieldErrors, `entry-${entry.key}`, "Audio file was not found. Replace or remove it.");
		}
	}

	const start = validateTimestamp(fieldErrors, "start", state.start);
	const end = validateTimestamp(fieldErrors, "end", state.end);
	if (start !== null && end !== null && end <= start) addError(fieldErrors, "end", "End time must be later than start time.");

	for (const [field, value] of [["fadein", state.fadein], ["fadeout", state.fadeout]] as const) {
		if (value.trim() && parseNonNegativeSeconds(value.trim()) === null) {
			addError(fieldErrors, field, "Enter zero or a positive number of seconds.");
		}
	}
	if (state.volume.mode === "value" && parseAudioVolume(state.volume.value.trim()) === null) {
		addError(fieldErrors, "volume", "Volume must be a number from 0 to 1.");
	}
	if (isPlaylistForm(state) && state.playlistCrossfade.mode === "value"
		&& parseDurationSeconds(state.playlistCrossfade.value) === null) {
		addError(fieldErrors, "crossfade", "Crossfade must be zero or a positive number of seconds.");
	}
	if (state.volumeFadeMode === "custom") {
		if (parseAudioVolume(state.volumeFadeTarget.trim()) === null) {
			addError(fieldErrors, "volume-fade-target", "Target volume must be a number from 0 to 1.");
		}
		const duration = parseNonNegativeSeconds(state.volumeFadeDuration.trim());
		if (duration === null || duration <= 0) {
			addError(fieldErrors, "volume-fade-duration", "Duration must be greater than zero seconds.");
		}
	}

	if (isPlaylistForm(state)) {
		for (const entry of state.entries) {
			const entryStart = entry.start.mode === "value"
				? validateTimestamp(fieldErrors, `entry-${entry.key}`, entry.start.value)
				: entry.start.mode === "none" ? null : start;
			const entryEnd = entry.end.mode === "value"
				? validateTimestamp(fieldErrors, `entry-${entry.key}`, entry.end.value)
				: entry.end.mode === "none" ? null : end;
			if (entryStart !== null && entryEnd !== null && entryEnd <= entryStart) {
				addError(fieldErrors, `entry-${entry.key}`, "Effective end must be later than effective start.");
			}
		}
	}

	for (const issue of context.hydrationIssues ?? []) addError(fieldErrors, "source", issue);
	const serialized = serializeAudioBlock(state);
	if (Object.keys(fieldErrors).length === 0) {
		const finalResult = parseAudioBlockDetailed(serializeAudioBlockBody(state), context.parserDefaults);
		for (const error of finalResult.errors) addError(fieldErrors, "source", error);
		if (!finalResult.def) addError(fieldErrors, "source", "The generated audio block could not be parsed.");
	}
	const errors = Array.from(new Set(Object.values(fieldErrors).flat()));
	return {valid: errors.length === 0, fieldErrors, errors, serialized};
}
