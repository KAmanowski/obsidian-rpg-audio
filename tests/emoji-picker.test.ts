/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
	EMOJI_DATA_SOURCE,
	EMOJI_DATA_VERSION,
	emojiGridTargetIndex,
	filterEmojiOptions,
	getEmojiCategories,
	insertTextAtCursor,
	updateRecentEmojis,
} from "../src/emoji-picker";

describe("insertTextAtCursor", () => {
	it("inserts at the caret without replacing surrounding or selected text", () => {
		assert.deepEqual(insertTextAtCursor("Battle music", "⚔️", 7), {
			value: "Battle ⚔️music",
			cursor: 9,
		});
	});

	it("appends when no caret is available and clamps invalid positions", () => {
		assert.deepEqual(insertTextAtCursor("Rain", "🌧️", null), {value: "Rain🌧️", cursor: 7});
		assert.deepEqual(insertTextAtCursor("Rain", "🎵", 99), {value: "Rain🎵", cursor: 6});
	});
});

describe("emojiGridTargetIndex", () => {
	it("supports arrows, Home, and End without wrapping past grid bounds", () => {
		assert.equal(emojiGridTargetIndex(1, "ArrowRight", 10, 6), 2);
		assert.equal(emojiGridTargetIndex(1, "ArrowLeft", 10, 6), 0);
		assert.equal(emojiGridTargetIndex(1, "ArrowDown", 10, 6), 7);
		assert.equal(emojiGridTargetIndex(7, "ArrowUp", 10, 6), 1);
		assert.equal(emojiGridTargetIndex(4, "Home", 10, 6), 0);
		assert.equal(emojiGridTargetIndex(4, "End", 10, 6), 5);
		assert.equal(emojiGridTargetIndex(9, "ArrowRight", 10, 6), 9);
	});
});

describe("emoji library", () => {
	it("provides the pinned Emojibase catalog with standard and RPG categories", () => {
		const categories = getEmojiCategories();
		assert.equal(EMOJI_DATA_SOURCE, "emojibase-data");
		assert.equal(EMOJI_DATA_VERSION, "17.0.0");
		assert.deepEqual(categories.map(category => category.id), [
			"rpg", "smileys", "people", "nature", "food", "places",
			"activities", "objects", "symbols", "flags",
		]);
		assert.ok(categories.slice(1).reduce((count, category) => count + category.options.length, 0) >= 1900);
	});

	it("searches CLDR names, upstream tags, and RPG-specific aliases case-insensitively", () => {
		const categories = getEmojiCategories();
		const rpg = categories.find(category => category.id === "rpg");
		assert.deepEqual(filterEmojiOptions(rpg?.options ?? [], "SWORD").map(item => item.emoji), ["⚔️", "🗡️"]);
		assert.ok(filterEmojiOptions(rpg?.options ?? [], "rain").some(item => item.emoji === "🌧️"));
		const smileys = categories.find(category => category.id === "smileys");
		assert.ok(filterEmojiOptions(smileys?.options ?? [], "CHEERFUL").some(item => item.emoji === "😀"));
	});

	it("does not duplicate emoji within the standard catalog", () => {
		const standard = getEmojiCategories().slice(1).flatMap(category => category.options.map(option => option.emoji));
		assert.equal(new Set(standard).size, standard.length);
	});

	it("maintains a bounded least-recently-used list", () => {
		assert.deepEqual(updateRecentEmojis(["🎵", "🔥", "🌧️"], "🔥", 3), ["🔥", "🎵", "🌧️"]);
		assert.deepEqual(updateRecentEmojis(["🎵", "🔥", "🌧️"], "⚔️", 3), ["⚔️", "🎵", "🔥"]);
	});
});
