/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {buildPlaylistDisplayItems, isValidPlaylistIndex, resolveConfiguredRegion} from "../src/playlist-utils";

const entry = (path: string, title: string | null = null) => ({path, title});

describe("buildPlaylistDisplayItems", () => {
	it("preserves source order and removes filename extensions", () => {
		const items = buildPlaylistDisplayItems([
			entry("audio/battle/Opening Strike.mp3"),
			entry("audio/battle/Final Stand.ogg"),
		]);
		assert.deepEqual(items.map(item => item.name), ["Opening Strike", "Final Stand"]);
		assert.deepEqual(items.map(item => item.path), [
			"audio/battle/Opening Strike.mp3",
			"audio/battle/Final Stand.ogg",
		]);
		assert.deepEqual(items.map(item => item.context), [null, null]);
	});

	it("adds the shortest useful parent context to duplicate names", () => {
		const items = buildPlaylistDisplayItems([
			entry("audio/tavern/indoor/Ambience Loop.mp3"),
			entry("audio/forest/night/Ambience Loop.ogg"),
			entry("audio/forest/day/Ambience Loop.wav"),
			entry("audio/tavern/indoor/Different Track.mp3"),
		]);
		assert.deepEqual(items.map(item => item.context), ["indoor/", "night/", "day/", null]);
	});

	it("accepts Windows-style separators", () => {
		const [item] = buildPlaylistDisplayItems([entry("audio\\music\\Theme.flac")]);
		assert.equal(item?.name, "Theme");
		assert.equal(item?.context, null);
	});

	it("prefers explicit titles and disambiguates duplicate titles", () => {
		const items = buildPlaylistDisplayItems(
			[
				entry("audio/tavern/first.mp3", "Night ambience"),
				entry("audio/forest/second.mp3", "Night ambience"),
				entry("audio/third.mp3"),
			],
		);
		assert.deepEqual(items.map(item => item.name), ["Night ambience", "Night ambience", "third"]);
		assert.deepEqual(items.map(item => item.context), ["tavern/", "forest/", null]);
	});
});

describe("isValidPlaylistIndex", () => {
	it("accepts only integer indices within the playlist", () => {
		assert.equal(isValidPlaylistIndex(0, 3), true);
		assert.equal(isValidPlaylistIndex(2, 3), true);
		assert.equal(isValidPlaylistIndex(-1, 3), false);
		assert.equal(isValidPlaylistIndex(3, 3), false);
		assert.equal(isValidPlaylistIndex(1.5, 3), false);
	});
});

describe("resolveConfiguredRegion", () => {
	it("inherits, overrides, and explicitly clears each boundary independently", () => {
		assert.deepEqual(resolveConfiguredRegion(entry("a.mp3"), 15, 180), {
			startTime: 15,
			endTime: 180,
		});
		assert.deepEqual(resolveConfiguredRegion(
			{...entry("b.mp3"), startTime: 30, endTime: null},
			15,
			180,
		), {
			startTime: 30,
			endTime: null,
		});
		assert.deepEqual(resolveConfiguredRegion(
			{...entry("c.mp3"), startTime: null, endTime: 90},
			15,
			180,
		), {
			startTime: null,
			endTime: 90,
		});
	});
});
