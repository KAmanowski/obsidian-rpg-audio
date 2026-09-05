/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {AudioPreviewController, AudioPreviewElement} from "../src/audio-preview";

class MockAudio implements AudioPreviewElement {
	readonly listeners = new Map<string, Set<() => void>>();
	pauseCount = 0;
	loadCount = 0;
	removedSource = false;

	play(): Promise<void> {
		return Promise.resolve();
	}

	pause(): void {
		this.pauseCount++;
	}

	load(): void {
		this.loadCount++;
	}

	removeAttribute(name: string): void {
		if (name === "src") this.removedSource = true;
	}

	addEventListener(type: "ended" | "error", listener: () => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: "ended" | "error", listener: () => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	emit(type: "ended" | "error"): void {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}
}

describe("AudioPreviewController", () => {
	it("stops and releases the current preview before starting another", () => {
		const audio: MockAudio[] = [];
		const states: Array<string | null> = [];
		const controller = new AudioPreviewController(
			path => states.push(path),
			() => undefined,
			() => {
				const element = new MockAudio();
				audio.push(element);
				return element;
			},
		);

		controller.toggle("first.mp3", "first-resource");
		controller.toggle("second.mp3", "second-resource");

		assert.equal(controller.activePath, "second.mp3");
		assert.equal(audio.length, 2);
		assert.equal(audio[0]?.pauseCount, 1);
		assert.equal(audio[0]?.loadCount, 1);
		assert.equal(audio[0]?.removedSource, true);
		assert.equal(audio[0]?.listeners.get("ended")?.size, 0);
		assert.deepEqual(states, ["first.mp3", "second.mp3"]);
	});

	it("stops the active preview on a second toggle, natural end, or disposal", () => {
		const audio: MockAudio[] = [];
		const controller = new AudioPreviewController(
			() => undefined,
			() => undefined,
			() => {
				const element = new MockAudio();
				audio.push(element);
				return element;
			},
		);

		controller.toggle("one.mp3", "one-resource");
		controller.toggle("one.mp3", "one-resource");
		assert.equal(controller.activePath, null);

		controller.toggle("two.mp3", "two-resource");
		audio[1]?.emit("ended");
		assert.equal(controller.activePath, null);

		controller.toggle("three.mp3", "three-resource");
		controller.dispose();
		assert.equal(controller.activePath, null);
		assert.equal(audio[2]?.pauseCount, 1);
		assert.equal(audio[2]?.removedSource, true);
	});

	it("releases the resource and reports a rejected playback attempt", async () => {
		const audio = new MockAudio();
		audio.play = () => Promise.reject(new Error("Playback failed"));
		const errors: string[] = [];
		const states: Array<string | null> = [];
		const controller = new AudioPreviewController(
			path => states.push(path),
			path => errors.push(path),
			() => audio,
		);

		controller.toggle("broken.mp3", "broken-resource");
		await Promise.resolve();

		assert.equal(controller.activePath, null);
		assert.equal(audio.pauseCount, 1);
		assert.equal(audio.removedSource, true);
		assert.deepEqual(states, ["broken.mp3", null]);
		assert.deepEqual(errors, ["broken.mp3"]);
	});

	it("reports media creation failure without entering an active state", () => {
		const states: Array<string | null> = [];
		const errors: string[] = [];
		const controller = new AudioPreviewController(
			path => states.push(path),
			path => errors.push(path),
			() => { throw new Error("Audio unavailable"); },
		);

		controller.toggle("unavailable.mp3", "unavailable-resource");

		assert.equal(controller.activePath, null);
		assert.deepEqual(states, []);
		assert.deepEqual(errors, ["unavailable.mp3"]);
	});
});
