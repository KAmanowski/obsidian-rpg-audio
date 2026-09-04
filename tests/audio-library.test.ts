/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
	audioFileSelectionInputType,
	groupAudioFilesByFolder,
	selectAudioLibraryFiles,
} from "../src/audio-library";

interface TestFile {
	path: string;
	marker: number;
}

describe("groupAudioFilesByFolder", () => {
	it("creates final-segment folder tabs while retaining full path keys", () => {
		const groups = groupAudioFilesByFolder<TestFile>([
			{path: "Assets/Audio/Music/theme.mp3", marker: 1},
			{path: "Assets/Audio/Ambience/rain.mp3", marker: 2},
			{path: "Assets/Audio/Music/Combat/battle.mp3", marker: 3},
			{path: "Assets/Other/Combat/clash.mp3", marker: 4},
		]);

		assert.deepEqual(groups.map(group => group.label), [
			"Ambience",
			"Combat",
			"Combat",
			"Music",
		]);
		assert.deepEqual(groups.map(group => group.path), [
			"Assets/Audio/Ambience",
			"Assets/Audio/Music/Combat",
			"Assets/Other/Combat",
			"Assets/Audio/Music",
		]);
	});

	it("sorts files within folders and supports Windows-style paths", () => {
		const groups = groupAudioFilesByFolder<TestFile>([
			{path: "Audio\\SFX\\z.wav", marker: 1},
			{path: "Audio\\SFX\\a.wav", marker: 2},
		]);

		assert.equal(groups[0]?.label, "SFX");
		assert.equal(groups[0]?.path, "Audio/SFX");
		assert.deepEqual(groups[0]?.files.map(file => file.marker), [2, 1]);
	});

	it("labels files without a parent folder as vault-root files", () => {
		const groups = groupAudioFilesByFolder<TestFile>([{path: "theme.mp3", marker: 1}]);
		assert.equal(groups[0]?.label, "Vault root");
		assert.equal(groups[0]?.path, "");
	});
});

describe("selectAudioLibraryFiles", () => {
	const files: TestFile[] = [
		{path: "Audio/Music/z-theme.mp3", marker: 1},
		{path: "Audio/Ambience/a-rain.mp3", marker: 2},
		{path: "Audio/Music/b-battle.mp3", marker: 3},
	];

	it("combines every folder and sorts file names ascending by default", () => {
		const selected = selectAudioLibraryFiles(files, null, "", "asc");
		assert.deepEqual(selected.map(file => file.marker), [2, 3, 1]);
	});

	it("filters by exact folder and toggles to descending order", () => {
		const selected = selectAudioLibraryFiles(files, "Audio/Music", "", "desc");
		assert.deepEqual(selected.map(file => file.marker), [1, 3]);
	});

	it("combines folder and case-insensitive path search filters", () => {
		const selected = selectAudioLibraryFiles(files, "Audio/Music", "BATTLE", "asc");
		assert.deepEqual(selected.map(file => file.marker), [3]);
	});
});

describe("audioFileSelectionInputType", () => {
	it("uses radios only for explicitly single-select pickers", () => {
		assert.equal(audioFileSelectionInputType(false), "radio");
		assert.equal(audioFileSelectionInputType(true), "checkbox");
		assert.equal(audioFileSelectionInputType(), "checkbox");
	});
});
