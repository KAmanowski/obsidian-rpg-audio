/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
	createAudioBlockFormState,
	createAudioFileDraft,
	hydrateAudioBlockForm,
	serializeAudioBlockBody,
	validateAudioBlockForm,
} from "../src/audio-block-form";
import {AudioBlockDefaults, parseAudioBlockDetailed} from "../src/audio-block-parser";

const PARSER_DEFAULTS: AudioBlockDefaults = {
	playlistCrossfadeDuration: 3,
	fadeOutDuration: 0,
	volumeFadeTarget: 0.5,
	volumeFadeDuration: 60,
};

describe("audio block form codec", () => {
	it("uses configurable authoring defaults for new blocks", () => {
		const state = createAudioBlockFormState({
			type: "ambience",
			loop: true,
			random: true,
			autoplay: false,
			playlistEndAction: "next",
			fadeInDuration: 2,
			fadeOutDuration: 4,
			volume: 0.8,
		});

		assert.deepEqual(state.type, {mode: "value", value: "ambience"});
		assert.equal(state.loop, true);
		assert.equal(state.random, true);
		assert.equal(state.fadein, "2");
		assert.deepEqual(state.volume, {mode: "value", value: "0.8"});
	});

	it("hydrates omission, titles, and tri-state playlist boundaries", () => {
		const result = hydrateAudioBlockForm(`id: battle
name: Battle
start: 15
files:
- one.mp3 [Opening] {start=none, end=2:00}
- two.mp3`, PARSER_DEFAULTS);

		assert.deepEqual(result.issues, []);
		assert.deepEqual(result.state.type, {mode: "inherit"});
		assert.deepEqual(result.state.playlistCrossfade, {mode: "inherit"});
		assert.equal(result.state.entries[0]?.title, "Opening");
		assert.deepEqual(result.state.entries[0]?.start, {mode: "none"});
		assert.deepEqual(result.state.entries[0]?.end, {mode: "value", value: "120"});
	});

	it("blocks unsafe hydration for malformed and duplicated source", () => {
		const result = hydrateAudioBlockForm(`id: first
id: second
name: Broken
unknown: value
file: one.mp3`, PARSER_DEFAULTS);

		assert.ok(result.issues.some(issue => issue.includes('Setting "id" is duplicated')));
		assert.ok(result.issues.some(issue => issue.includes('Unknown setting "unknown"')));
	});

	it("clears missing required source errors after the hydrated form is completed", () => {
		const hydrated = hydrateAudioBlockForm("loop: true", PARSER_DEFAULTS);
		assert.deepEqual(hydrated.issues, []);

		const initial = validateAudioBlockForm(hydrated.state, {
			parserDefaults: PARSER_DEFAULTS,
			hydrationIssues: hydrated.issues,
		});
		assert.equal(initial.errors.length, 3);

		hydrated.state.name = "Completed block";
		hydrated.state.id = "completed-block";
		hydrated.state.entries = [createAudioFileDraft("valid.mp3")];
		const completed = validateAudioBlockForm(hydrated.state, {
			parserDefaults: PARSER_DEFAULTS,
			hydrationIssues: hydrated.issues,
			isFileAvailable: () => true,
		});

		assert.equal(completed.valid, true);
		assert.deepEqual(completed.errors, []);
	});

	it("does not silently discard playlist-style metadata from a single file", () => {
		const result = hydrateAudioBlockForm(`id: excerpt
name: Excerpt
file: one.mp3 [Opening] {start=30}`, PARSER_DEFAULTS);

		assert.ok(result.issues.some(issue => issue.includes("single-file block uses playlist-style")));
	});

	it("omits retained playlist-only values when one file remains", () => {
		const state = createAudioBlockFormState();
		state.id = "single";
		state.name = "Single";
		state.entries = [createAudioFileDraft("one.mp3")];
		state.random = true;
		state.playlistEndAction = "next";
		state.playlistCrossfade = {mode: "value", value: "2"};

		const source = serializeAudioBlockBody(state);
		assert.doesNotMatch(source, /random|playlist-end-action|crossfade/);
		assert.match(source, /file: one\.mp3/);
	});

	it("serializes a canonical playlist that round-trips through the runtime parser", () => {
		const state = createAudioBlockFormState();
		state.id = "battle";
		state.name = "Battle music";
		state.loop = true;
		state.random = true;
		state.playlistEndAction = "next";
		state.playlistCrossfade = {mode: "value", value: "2.5"};
		const first = createAudioFileDraft("one.mp3");
		first.title = "Opening";
		first.start = {mode: "none"};
		first.end = {mode: "value", value: "1:30"};
		state.entries = [first, createAudioFileDraft("two.mp3")];

		const source = serializeAudioBlockBody(state);
		const parsed = parseAudioBlockDetailed(source, PARSER_DEFAULTS);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.def?.entries[0]?.title, "Opening");
		assert.equal(parsed.def?.entries[0]?.startTime, null);
		assert.equal(parsed.def?.entries[0]?.endTime, 90);
	});
});

describe("audio block form validation", () => {
	it("identifies every blocking field in a new empty draft", () => {
		const result = validateAudioBlockForm(createAudioBlockFormState(), {
			parserDefaults: PARSER_DEFAULTS,
		});

		assert.equal(result.valid, false);
		assert.deepEqual(result.fieldErrors, {
			name: ["Name is required."],
			id: ["ID is required."],
			files: ["Add at least one audio file."],
		});
		assert.equal(result.errors.length, 3);
	});

	it("reports duplicate IDs, missing files, and inherited boundary conflicts", () => {
		const state = createAudioBlockFormState();
		state.id = "duplicate";
		state.name = "Playlist";
		state.start = "1:00";
		state.end = "2:00";
		const missing = createAudioFileDraft("missing.mp3");
		missing.start = {mode: "value", value: "1:50"};
		missing.end = {mode: "value", value: "1:40"};
		state.entries = [missing, createAudioFileDraft("ok.mp3")];

		const result = validateAudioBlockForm(state, {
			parserDefaults: PARSER_DEFAULTS,
			duplicateIds: ["duplicate"],
			isFileAvailable: path => path === "ok.mp3",
		});

		assert.equal(result.valid, false);
		assert.ok(result.fieldErrors.id?.some(error => error.includes("already used")));
		assert.ok(result.fieldErrors[`entry-${missing.key}`]?.some(error => error.includes("not found")));
		assert.ok(result.fieldErrors[`entry-${missing.key}`]?.some(error => error.includes("Effective end")));
	});

	it("accepts a complete single-file block with inherited plugin defaults", () => {
		const state = createAudioBlockFormState();
		state.id = "valid";
		state.name = "Valid";
		state.entries = [createAudioFileDraft("valid.mp3")];

		const result = validateAudioBlockForm(state, {
			parserDefaults: PARSER_DEFAULTS,
			isFileAvailable: () => true,
		});
		assert.equal(result.valid, true);
	});
});
