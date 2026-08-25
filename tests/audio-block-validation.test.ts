/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {parseAudioBlockDetailed} from "../src/audio-block-parser";
import {getAudioBlockErrors} from "../src/audio-block-validation";

describe("getAudioBlockErrors", () => {
	it("blocks setting and missing-file errors when validation is enabled", () => {
		const result = parseAudioBlockDetailed(`
id: test
name: Test
file: missing.mp3
loop: yes
`);

		assert.deepEqual(getAudioBlockErrors(result, ["missing.mp3"], true), [
			'Line 5: "loop" must be true or false.',
			'Audio file not found: "missing.mp3". Check the vault path or configured audio folder.',
		]);
	});

	it("allows optional setting and missing-file errors when validation is disabled", () => {
		const result = parseAudioBlockDetailed(`
id: test
name: Test
file: missing.mp3
loop: yes
`);

		assert.ok(result.def);
		assert.deepEqual(getAudioBlockErrors(result, ["missing.mp3"], false), []);
	});

	it("still rejects blocks that cannot produce a track definition", () => {
		const result = parseAudioBlockDetailed("loop: true");

		assert.deepEqual(getAudioBlockErrors(result, [], false), [
			"Invalid rpg-audio block. Add id, name, and file or files.",
		]);
	});
});
