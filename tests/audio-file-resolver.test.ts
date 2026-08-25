/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {findAudioFile} from "../src/audio-file-resolver";

function createLookup(paths: string[]) {
	const available = new Set(paths);
	return {getFileByPath: (path: string) => available.has(path) ? path : null};
}

describe("findAudioFile", () => {
	it("finds vault-root paths before trying the configured audio folder", () => {
		const lookup = createLookup(["music/theme.mp3", "audio/music/theme.mp3"]);
		assert.equal(findAudioFile(lookup, "audio", "music/theme.mp3"), "music/theme.mp3");
	});

	it("finds paths relative to the configured audio folder", () => {
		const lookup = createLookup(["audio/music/theme.mp3"]);
		assert.equal(findAudioFile(lookup, "/audio/", "music/theme.mp3"), "audio/music/theme.mp3");
	});

	it("returns null when neither candidate exists", () => {
		assert.equal(findAudioFile(createLookup([]), "audio", "missing.mp3"), null);
	});
});
