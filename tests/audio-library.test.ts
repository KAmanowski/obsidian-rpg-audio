/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {audioFileSelectionInputType, groupAudioFilesByFolder} from "../src/audio-library";

interface TestFile {
	path: string;
	marker: number;
}

describe("groupAudioFilesByFolder", () => {
	it("creates labeled sections for each audio folder, including nested music types", () => {
		const groups = groupAudioFilesByFolder<TestFile>([
			{path: "Assets/Audio/Music/theme.mp3", marker: 1},
			{path: "Assets/Audio/Ambience/rain.mp3", marker: 2},
			{path: "Assets/Audio/Music/Combat/battle.mp3", marker: 3},
		]);

		assert.deepEqual(groups.map(group => group.label), [
			"Assets/Audio/Ambience/",
			"Assets/Audio/Music/",
			"Assets/Audio/Music/Combat/",
		]);
	});

	it("sorts files within folders and supports Windows-style paths", () => {
		const groups = groupAudioFilesByFolder<TestFile>([
			{path: "Audio\\SFX\\z.wav", marker: 1},
			{path: "Audio\\SFX\\a.wav", marker: 2},
		]);

		assert.equal(groups[0]?.label, "Audio/SFX/");
		assert.deepEqual(groups[0]?.files.map(file => file.marker), [2, 1]);
	});

	it("labels files without a parent folder as vault-root files", () => {
		const groups = groupAudioFilesByFolder<TestFile>([{path: "theme.mp3", marker: 1}]);
		assert.equal(groups[0]?.label, "Vault root");
	});
});

describe("audioFileSelectionInputType", () => {
	it("uses radios only for explicitly single-select pickers", () => {
		assert.equal(audioFileSelectionInputType(false), "radio");
		assert.equal(audioFileSelectionInputType(true), "checkbox");
		assert.equal(audioFileSelectionInputType(), "checkbox");
	});
});
