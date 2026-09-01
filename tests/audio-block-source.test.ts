/* eslint-disable import/no-nodejs-modules */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
	collectAudioBlockIds,
	findAudioBlockAtLines,
	findAudioBlockAtSelection,
	findAudioBlockFences,
	findRenderedAudioBlock,
	findRenderedAudioBlockCandidates,
	formatAudioBlockForFence,
	formatAudioBlockInsertion,
} from "../src/audio-block-source";

const NOTE = [
	"Before",
	"",
	"```rpg-audio",
	"id: first",
	"name: First",
	"file: one.mp3",
	"```",
	"",
	"Between",
	"",
	"```rpg-audio",
	"id: second",
	"name: Second",
	"file: two.mp3",
	"```",
	"",
	"After",
].join("\n");

describe("audio block source location", () => {
	it("finds ordered fenced blocks and their bodies", () => {
		const blocks = findAudioBlockFences(NOTE);
		assert.equal(blocks.length, 2);
		assert.match(blocks[0]?.body ?? "", /^id: first/m);
		assert.match(blocks[1]?.source ?? "", /^```rpg-audio/m);
	});

	it("treats the opening fence, body, and closing fence as editable", () => {
		const block = findAudioBlockFences(NOTE)[0];
		assert.ok(block);
		assert.equal(findAudioBlockAtSelection(NOTE, block.startOffset)?.body, block.body);
		assert.equal(findAudioBlockAtSelection(NOTE, block.bodyStartOffset + 2)?.body, block.body);
		assert.equal(findAudioBlockAtSelection(NOTE, block.endOffset)?.body, block.body);
		assert.equal(findAudioBlockAtSelection(NOTE, block.endOffset + 1), null);
	});

	it("locates a block from rendered section lines without matching adjacent text", () => {
		const block = findAudioBlockFences(NOTE)[1];
		assert.ok(block);
		assert.equal(findAudioBlockAtLines(NOTE, block.startLine, block.endLine)?.body, block.body);
		assert.equal(findAudioBlockAtLines(NOTE, block.endLine + 1, block.endLine + 1), null);
	});

	it("collects IDs while excluding the edited block", () => {
		const first = findAudioBlockFences(NOTE)[0];
		assert.ok(first);
		assert.deepEqual(collectAudioBlockIds(NOTE), ["first", "second"]);
		assert.deepEqual(collectAudioBlockIds(NOTE, first), ["second"]);
	});

	it("adds readable separation around an inserted block", () => {
		assert.equal(formatAudioBlockInsertion("Text", 4, "BLOCK"), "\n\nBLOCK");
		assert.equal(formatAudioBlockInsertion("Text\nMore", 5, "BLOCK"), "\nBLOCK\n\n");
	});

	it("locates and safely rewrites fenced blocks inside callouts", () => {
		const quoted = [
			"> [!tip] Audio",
			"> ```rpg-audio",
			"> id: church-ambience",
			"> name: Church ambience",
			"> file: ambience.mp3",
			"> ```",
		].join("\n");
		const block = findAudioBlockFences(quoted)[0];
		assert.ok(block);
		assert.equal(block.linePrefix, "> ");
		assert.match(block.body, /^id: church-ambience/m);
		assert.equal(
			formatAudioBlockForFence(block, "```rpg-audio\nid: updated\nname: Updated\nfile: updated.mp3\n```"),
			"> ```rpg-audio\n> id: updated\n> name: Updated\n> file: updated.mp3\n> ```",
		);
	});

	it("falls back to rendered body matching when nested section lines are relative", () => {
		const quoted = [
			"> [!tip] Audio",
			"> ```rpg-audio",
			"> id: nested",
			"> name: Nested",
			"> file: nested.mp3",
			"> ```",
		].join("\n");
		const block = findRenderedAudioBlock(quoted, "id: nested\nname: Nested\nfile: nested.mp3", {
			text: quoted,
			lineStart: 0,
			lineEnd: 0,
		});
		assert.equal(block?.linePrefix, "> ");
	});

	it("uses section text to distinguish identical rendered blocks", () => {
		const body = "id: repeated\nname: Repeated\nfile: repeated.mp3";
		const firstSection = ["> [!tip] First", "> ```rpg-audio", ...body.split("\n").map(line => `> ${line}`), "> ```"].join("\n");
		const secondSection = ["> [!tip] Second", "> ```rpg-audio", ...body.split("\n").map(line => `> ${line}`), "> ```"].join("\n");
		const note = `${firstSection}\n\n${secondSection}`;
		const block = findRenderedAudioBlock(note, body, {text: secondSection, lineStart: 0, lineEnd: 0});
		assert.equal(block?.startLine, 8);
	});

	it("locates a unique rendered block without section information", () => {
		const note = "```rpg-audio\nid: unique\nname: Unique\nfile: unique.mp3\n```";
		const block = findRenderedAudioBlock(note, "id: unique\nname: Unique\nfile: unique.mp3", null);
		assert.equal(block?.startLine, 0);
	});

	it("returns candidates instead of guessing between identical blocks without section information", () => {
		const block = "```rpg-audio\nid: repeated\nname: Repeated\nfile: repeated.mp3\n```";
		const note = `${block}\n\n${block}`;
		assert.equal(findRenderedAudioBlock(note, "id: repeated\nname: Repeated\nfile: repeated.mp3", null), null);
		assert.equal(findRenderedAudioBlockCandidates(note, "id: repeated\nname: Repeated\nfile: repeated.mp3").length, 2);
	});
});
