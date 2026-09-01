/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
	DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR,
	findCustomAudioBlockType,
	getAudioBlockTypeColor,
	normalizeCustomAudioBlockTypes,
	upsertCustomAudioBlockType,
} from "../src/audio-block-types";

describe("custom audio block types", () => {
	it("normalizes persisted definitions and rejects invalid or built-in names", () => {
		assert.deepEqual(normalizeCustomAudioBlockTypes([
			{name: "  Dialogue  ", color: "#ABCDEF"},
			{name: "dialogue", color: "#123456"},
			{name: "music", color: "#ffffff"},
			{name: "Weather", color: "not-a-color"},
			{name: "", color: "#000000"},
			null,
		]), [
			{name: "Dialogue", color: "#abcdef"},
			{name: "Weather", color: DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR},
		]);
	});

	it("upserts and renames a definition without leaving stale duplicates", () => {
		const updated = upsertCustomAudioBlockType([
			{name: "Dialogue", color: "#112233"},
			{name: "Weather", color: "#445566"},
		], {name: "NPC", color: "#AABBCC"}, "Dialogue");

		assert.deepEqual(updated, [
			{name: "Weather", color: "#445566"},
			{name: "NPC", color: "#aabbcc"},
		]);
	});

	it("resolves built-in, custom, and fallback colors case-insensitively", () => {
		const custom = [{name: "Dialogue", color: "#123456"}];
		assert.equal(getAudioBlockTypeColor("SFX", custom), "#e8a854");
		assert.equal(getAudioBlockTypeColor("dialogue", custom), "#123456");
		assert.equal(getAudioBlockTypeColor("unknown", custom), DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR);
		assert.deepEqual(findCustomAudioBlockType(custom, "DIALOGUE"), custom[0]);
	});
});
