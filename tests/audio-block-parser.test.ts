/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {AudioBlockDefaults, parseAudioBlock, parseAudioBlockDetailed} from "../src/audio-block-parser";

const REQUIRED_FIELDS = `
id: volume-fade
name: Volume fade
file: audio/music/example.mp3
`;

describe("parseAudioBlock volume fade settings", () => {
	it("uses fixed full volume defaults when no volume fade is configured", () => {
		const def = parseAudioBlock(REQUIRED_FIELDS);

		assert.ok(def);
		assert.equal(def.volume, 1);
		assert.equal(def.volumeFadeTarget, null);
		assert.equal(def.volumeFadeDuration, 0);
		assert.equal(def.playlistCrossfadeDuration, 0);
	});

	it("parses a valid initial volume, target volume, and duration", () => {
		const def = parseAudioBlock(`${REQUIRED_FIELDS}
volume: 1.0
volume-fade-to: 0.5
volume-fade-duration: 60
`);

		assert.ok(def);
		assert.equal(def.volume, 1);
		assert.equal(def.volumeFadeTarget, 0.5);
		assert.equal(def.volumeFadeDuration, 60);
	});

	it("supports upward fades and boundary volume values", () => {
		const def = parseAudioBlock(`${REQUIRED_FIELDS}
volume: 0
volume-fade-to: 1
volume-fade-duration: 2.5
`);

		assert.ok(def);
		assert.equal(def.volume, 0);
		assert.equal(def.volumeFadeTarget, 1);
		assert.equal(def.volumeFadeDuration, 2.5);
	});

	it("disables partial or invalid volume fade configurations", () => {
		for (const settings of [
			"volume-fade-to: 0.5",
			"volume-fade-duration: 60",
			"volume-fade-to: 1.1\nvolume-fade-duration: 60",
			"volume-fade-to: 0.5\nvolume-fade-duration: 0",
			"volume-fade-to: loud\nvolume-fade-duration: slowly",
		]) {
			const def = parseAudioBlock(`${REQUIRED_FIELDS}\n${settings}`);
			assert.ok(def);
			assert.equal(def.volumeFadeTarget, null);
			assert.equal(def.volumeFadeDuration, 0);
		}
	});
});

describe("parseAudioBlock plugin-level defaults", () => {
	const ACTIVE_DEFAULTS: AudioBlockDefaults = {
		playlistCrossfadeDuration: 4,
		volumeFadeTarget: 0.25,
		volumeFadeDuration: 30,
	};
	const DISABLED_DEFAULTS: AudioBlockDefaults = {
		playlistCrossfadeDuration: 0,
		volumeFadeTarget: 0.5,
		volumeFadeDuration: 0,
	};

	it("inherits plugin defaults when a block omits crossfade and volume fade settings", () => {
		const def = parseAudioBlock(`
id: inherits-defaults
name: Inherits defaults
files:
- audio/music/one.mp3
- audio/music/two.mp3
`, ACTIVE_DEFAULTS);

		assert.ok(def);
		assert.equal(def.playlistCrossfadeDuration, 4);
		assert.equal(def.volumeFadeTarget, 0.25);
		assert.equal(def.volumeFadeDuration, 30);
	});

	it("lets explicit per-block values override plugin defaults", () => {
		const def = parseAudioBlock(`
id: overrides-defaults
name: Overrides defaults
crossfade: 1.5
volume-fade-to: 0.9
volume-fade-duration: 10
files:
- audio/music/one.mp3
- audio/music/two.mp3
`, ACTIVE_DEFAULTS);

		assert.ok(def);
		assert.equal(def.playlistCrossfadeDuration, 1.5);
		assert.equal(def.volumeFadeTarget, 0.9);
		assert.equal(def.volumeFadeDuration, 10);
	});

	it("keeps current disabled behavior when plugin defaults are zero", () => {
		const def = parseAudioBlock(REQUIRED_FIELDS, DISABLED_DEFAULTS);

		assert.ok(def);
		assert.equal(def.playlistCrossfadeDuration, 0);
		assert.equal(def.volumeFadeTarget, null);
		assert.equal(def.volumeFadeDuration, 0);
	});

	it("still disables a partial volume fade config instead of falling back to plugin defaults", () => {
		const def = parseAudioBlock(`${REQUIRED_FIELDS}\nvolume-fade-to: 0.5`, ACTIVE_DEFAULTS);

		assert.ok(def);
		assert.equal(def.volumeFadeTarget, null);
		assert.equal(def.volumeFadeDuration, 0);
	});

	it("falls back to fixed defaults when no plugin defaults are provided", () => {
		const def = parseAudioBlock(REQUIRED_FIELDS);

		assert.ok(def);
		assert.equal(def.playlistCrossfadeDuration, 0);
		assert.equal(def.volumeFadeTarget, null);
		assert.equal(def.volumeFadeDuration, 0);
	});
});

describe("parseAudioBlockDetailed validation", () => {
	it("parses optional playlist titles without changing file paths", () => {
		const result = parseAudioBlockDetailed(`
id: titled-playlist
name: Titled playlist
files:
- audio/music/file-01.mp3 [File Name - 1]
- audio/music/file-02.ogg
`);

		assert.ok(result.def);
		assert.deepEqual(result.errors, []);
		assert.deepEqual(result.def.entries, [
			{path: "audio/music/file-01.mp3", title: "File Name - 1"},
			{path: "audio/music/file-02.ogg", title: null},
		]);
	});

	it("reports an empty trailing playlist title", () => {
		const result = parseAudioBlockDetailed(`
id: titled-playlist
name: Titled playlist
files:
- audio/music/file-01.mp3 []
`);

		assert.ok(result.def);
		assert.deepEqual(result.def.entries, [{path: "audio/music/file-01.mp3", title: null}]);
		assert.deepEqual(result.errors, ["Line 5: Audio file title inside brackets cannot be empty."]);
	});

	it("parses playlist regions, explicit clears, and an end action", () => {
		const result = parseAudioBlockDetailed(`
id: region-playlist
name: Region playlist
start: 0:15
end: 3:00
playlist-end-action: next
crossfade: 3s
files:
- battle-01.mp3 [Opening] {start=0:30, end=2:10}
- battle-02.mp3 [Middle] {end=none}
- battle-03.mp3 {start=none}
`);

		assert.ok(result.def);
		assert.deepEqual(result.errors, []);
		assert.equal(result.def.playlistEndAction, "next");
		assert.equal(result.def.playlistCrossfadeDuration, 3);
		assert.deepEqual(result.def.entries, [
			{path: "battle-01.mp3", title: "Opening", startTime: 30, endTime: 130},
			{path: "battle-02.mp3", title: "Middle", endTime: null},
			{path: "battle-03.mp3", title: null, startTime: null},
		]);
	});

	it("validates playlist region shorthand and inherited boundaries", () => {
		const result = parseAudioBlockDetailed(`
id: invalid-region-playlist
name: Invalid region playlist
start: 1:00
end: 2:00
playlist-end-action: sideways
files:
- bad.mp3 {start=1:50, end=1:40, start=0:10}
- ambiguous.mp3 {1:30:2:45}
- unknown.mp3 {offset=10}
`);

		assert.ok(result.def);
		assert.ok(result.errors.includes('Line 6: "playlist-end-action" must be auto, next, repeat, or stop.'));
		assert.ok(result.errors.includes('Line 8: Playlist file option "start" is duplicated.'));
		assert.ok(result.errors.includes('Line 8: Effective file "end" must be later than "start".'));
		assert.ok(result.errors.includes('Line 9: Playlist file option "1:30:2:45" must use name=value.'));
		assert.ok(result.errors.includes('Line 10: Unknown playlist file option "offset".'));
	});

	it("validates playlist crossfade duration and playlist-only use", () => {
		const invalidDuration = parseAudioBlockDetailed(`${REQUIRED_FIELDS}\ncrossfade: slowly`);
		assert.ok(invalidDuration.errors.some(error => error.includes('"crossfade" must be zero or a positive number')));
		assert.ok(invalidDuration.errors.includes('"crossfade" requires more than one audio file.'));

		const numeric = parseAudioBlockDetailed(`
id: crossfade-playlist
name: Crossfade playlist
crossfade: 2.5
files:
- first.mp3
- second.mp3
`);
		assert.ok(numeric.def);
		assert.deepEqual(numeric.errors, []);
		assert.equal(numeric.def.playlistCrossfadeDuration, 2.5);
	});

	it("reports malformed and unknown settings with line numbers", () => {
		const result = parseAudioBlockDetailed(`${REQUIRED_FIELDS}
loop: yes
volum: 0.5
broken setting
`);

		assert.ok(result.def);
		assert.deepEqual(result.errors, [
			'Line 6: "loop" must be true or false.',
			'Line 7: Unknown setting "volum".',
			'Line 8: Expected a setting in "name: value" format.',
		]);
	});

	it("reports invalid numeric settings and incompatible regions", () => {
		const result = parseAudioBlockDetailed(`${REQUIRED_FIELDS}
start: 2:00
end: 1:30
volume: loud
fadein: -1
volume-fade-to: 0.5
`);

		assert.ok(result.def);
		assert.ok(result.errors.includes('Line 8: "volume" must be a number from 0 to 1.'));
		assert.ok(result.errors.includes('Line 9: "fadein" must be zero or a positive number of seconds.'));
		assert.ok(result.errors.includes('"end" must be later than "start".'));
		assert.ok(result.errors.includes('"volume-fade-to" and "volume-fade-duration" must be used together.'));
	});

	it("reports missing required settings", () => {
		const result = parseAudioBlockDetailed("loop: true");

		assert.equal(result.def, null);
		assert.deepEqual(result.errors, [
			"Missing required setting: id.",
			"Missing required setting: name.",
			"Missing required audio file: add file or files.",
		]);
	});
});
