/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {preserveScrollPosition} from "../src/ui/scroll-preservation";

describe("preserveScrollPosition", () => {
	it("restores both axes after a synchronous view rebuild", () => {
		const target = {scrollTop: 240, scrollLeft: 12};
		preserveScrollPosition(target, () => {
			target.scrollTop = 0;
			target.scrollLeft = 0;
		});

		assert.deepEqual(target, {scrollTop: 240, scrollLeft: 12});
	});

	it("restores the position when rebuilding throws", () => {
		const target = {scrollTop: 80, scrollLeft: 4};
		assert.throws(() => preserveScrollPosition(target, () => {
			target.scrollTop = 0;
			throw new Error("render failed");
		}), /render failed/);
		assert.deepEqual(target, {scrollTop: 80, scrollLeft: 4});
	});
});
