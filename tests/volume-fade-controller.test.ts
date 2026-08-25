/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {VolumeFadeController} from "../src/volume-fade-controller";

describe("VolumeFadeController", () => {
	it("freezes on pause and resumes linearly over the remaining duration", async () => {
		const originalRaf = globalThis.requestAnimationFrame;
		const originalCancelRaf = globalThis.cancelAnimationFrame;
		const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
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
			let completions = 0;
			const controller = new VolumeFadeController();
			assert.equal(controller.start("track", 1, 0.5, 60_000, value => values.push(value), () => completions++), true);
			assert.equal(controller.getDirection("track"), "decreasing");

			now = 20_000;
			assert.ok(nextFrame);
			(nextFrame as unknown as FrameRequestCallback)(now);
			assert.ok(Math.abs((values.at(-1) ?? 0) - (5 / 6)) < 1e-10);

			now = 30_000;
			controller.pause("track");
			assert.equal(values.at(-1), 0.75);
			assert.equal(nextFrame, null);
			assert.equal(controller.getDirection("track"), null);
			now = 90_000;
			controller.resume("track");
			assert.equal(controller.getDirection("track"), "decreasing");

			now = 105_000;
			assert.ok(nextFrame);
			(nextFrame as unknown as FrameRequestCallback)(now);
			assert.equal(values.at(-1), 0.625);

			now = 120_000;
			assert.ok(nextFrame);
			(nextFrame as unknown as FrameRequestCallback)(now);
			await Promise.resolve();
			assert.equal(values.at(-1), 0.5);
			assert.equal(completions, 1);
			assert.equal(controller.getDirection("track"), null);

			assert.equal(controller.start("up", 0.2, 0.8, 1_000, () => {}, () => {}), true);
			assert.equal(controller.getDirection("up"), "increasing");
			controller.cancel("up");
			assert.equal(controller.getDirection("up"), null);
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
