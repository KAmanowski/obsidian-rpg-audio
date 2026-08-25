/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {FadeEngine} from "../src/fade-engine";

const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
const originalNow = Object.getOwnPropertyDescriptor(performance, "now");

describe("FadeEngine", () => {
	it("interpolates descending values linearly to the exact target", async () => {
		let now = 0;
		let nextFrame: FrameRequestCallback | null = null;
		Object.defineProperty(performance, "now", {configurable: true, value: () => now});
		globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
			nextFrame = callback;
			return 1;
		};
		globalThis.cancelAnimationFrame = () => {
			nextFrame = null;
		};

		try {
			const values: number[] = [];
			const engine = new FadeEngine();
			const completed = engine.start("track", 1, 0.5, 60_000, value => values.push(value));

			now = 30_000;
			assert.ok(nextFrame);
			(nextFrame as unknown as FrameRequestCallback)(now);
			assert.equal(values.at(-1), 0.75);

			now = 60_000;
			assert.ok(nextFrame);
			(nextFrame as unknown as FrameRequestCallback)(now);
			assert.equal(values.at(-1), 0.5);
			assert.equal(await completed, true);
		} finally {
			globalThis.requestAnimationFrame = originalRaf;
			globalThis.cancelAnimationFrame = originalCancelRaf;
			if (originalNow) {
				Object.defineProperty(performance, "now", originalNow);
			} else {
				Reflect.deleteProperty(performance, "now");
			}
		}
	});
});
