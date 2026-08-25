/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {parseAudioBlock} from "../src/audio-block-parser";

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
