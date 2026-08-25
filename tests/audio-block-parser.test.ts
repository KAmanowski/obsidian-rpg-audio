/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {parseAudioBlock, parseAudioBlockDetailed} from "../src/audio-block-parser";

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

describe("parseAudioBlockDetailed validation", () => {
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
