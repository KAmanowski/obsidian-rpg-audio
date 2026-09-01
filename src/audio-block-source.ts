export interface AudioBlockFence {
	startOffset: number;
	endOffset: number;
	bodyStartOffset: number;
	bodyEndOffset: number;
	startLine: number;
	endLine: number;
	source: string;
	body: string;
	/** Markdown container prefix applied to every source line, for example "> " inside a callout. */
	linePrefix: string;
}

export interface AudioBlockSectionHint {
	text: string;
	lineStart: number;
	lineEnd: number;
}

interface SourceLine {
	text: string;
	startOffset: number;
	endOffset: number;
	line: number;
}

function sourceLines(source: string): SourceLine[] {
	const rawLines = source.split("\n");
	const lines: SourceLine[] = [];
	let offset = 0;
	for (let index = 0; index < rawLines.length; index++) {
		const raw = rawLines[index] ?? "";
		const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		lines.push({text, startOffset: offset, endOffset: offset + raw.length, line: index});
		offset += raw.length + (index < rawLines.length - 1 ? 1 : 0);
	}
	return lines;
}

function openingFence(line: string): {length: number; prefix: string} | null {
	const match = line.match(/^(\s{0,3}(?:>\s*)*)(`{3,})\s*rpg-audio\s*$/i);
	const fence = match?.[2];
	return fence ? {length: fence.length, prefix: match?.[1] ?? ""} : null;
}

function isClosingFence(line: string, minimumLength: number, prefix: string): boolean {
	if (!line.startsWith(prefix)) return false;
	const match = line.slice(prefix.length).match(/^(`{3,})\s*$/);
	return (match?.[1]?.length ?? 0) >= minimumLength;
}

function stripLinePrefix(body: string, prefix: string): string {
	if (!prefix) return body.replace(/\r?\n$/, "");
	return body.replace(/\r?\n$/, "").split(/\r?\n/).map(line => {
		if (line.startsWith(prefix)) return line.slice(prefix.length);
		if (line.trimEnd() === prefix.trimEnd()) return "";
		return line;
	}).join("\n");
}

export function findAudioBlockFences(source: string): AudioBlockFence[] {
	const lines = sourceLines(source);
	const blocks: AudioBlockFence[] = [];
	for (let index = 0; index < lines.length; index++) {
		const opening = lines[index];
		if (!opening) continue;
		const fence = openingFence(opening.text);
		if (!fence) continue;

		for (let closingIndex = index + 1; closingIndex < lines.length; closingIndex++) {
			const closing = lines[closingIndex];
			if (!closing || !isClosingFence(closing.text, fence.length, fence.prefix)) continue;
			const bodyStartOffset = Math.min(opening.endOffset + 1, source.length);
			const bodyEndOffset = closing.startOffset;
			blocks.push({
				startOffset: opening.startOffset,
				endOffset: closing.endOffset,
				bodyStartOffset,
				bodyEndOffset,
				startLine: opening.line,
				endLine: closing.line,
				source: source.slice(opening.startOffset, closing.endOffset),
				body: stripLinePrefix(source.slice(bodyStartOffset, bodyEndOffset), fence.prefix),
				linePrefix: fence.prefix,
			});
			index = closingIndex;
			break;
		}
	}
	return blocks;
}

export function findAudioBlockAtSelection(
	source: string,
	fromOffset: number,
	toOffset = fromOffset,
): AudioBlockFence | null {
	const from = Math.min(fromOffset, toOffset);
	const to = Math.max(fromOffset, toOffset);
	const matches = findAudioBlockFences(source).filter(block => {
		if (from === to) return from >= block.startOffset && from <= block.endOffset;
		return from < block.endOffset && to > block.startOffset;
	});
	return matches.length === 1 ? matches[0] ?? null : null;
}

export function findAudioBlockAtLines(source: string, fromLine: number, toLine: number): AudioBlockFence | null {
	const from = Math.min(fromLine, toLine);
	const to = Math.max(fromLine, toLine);
	const matches = findAudioBlockFences(source).filter(block => from <= block.endLine && to >= block.startLine);
	return matches.length === 1 ? matches[0] ?? null : null;
}

function textRanges(source: string, text: string): Array<{start: number; end: number}> {
	if (!text) return [];
	const ranges: Array<{start: number; end: number}> = [];
	let offset = 0;
	while (offset <= source.length) {
		const start = source.indexOf(text, offset);
		if (start < 0) break;
		ranges.push({start, end: start + text.length});
		offset = start + Math.max(text.length, 1);
	}
	return ranges;
}

function normalizedBlockBody(source: string): string {
	return source.replace(/\r\n/g, "\n").trim();
}

export function findRenderedAudioBlock(
	source: string,
	renderedBody: string,
	section?: AudioBlockSectionHint | null,
): AudioBlockFence | null {
	if (section) {
		const byLines = findAudioBlockAtLines(source, section.lineStart, section.lineEnd);
		if (byLines) return byLines;
	}

	const bodyMatches = findRenderedAudioBlockCandidates(source, renderedBody);
	if (bodyMatches.length === 0) return null;

	if (section) {
		const ranges = textRanges(source, section.text);
		if (ranges.length > 0) {
			const sectionMatches = bodyMatches.filter(block => ranges.some(range =>
				block.startOffset < range.end && block.endOffset > range.start,
			));
			if (sectionMatches.length === 1) return sectionMatches[0] ?? null;
		}
	}

	return bodyMatches.length === 1 ? bodyMatches[0] ?? null : null;
}

export function findRenderedAudioBlockCandidates(source: string, renderedBody: string): AudioBlockFence[] {
	const body = normalizedBlockBody(renderedBody);
	return findAudioBlockFences(source).filter(block => normalizedBlockBody(block.body) === body);
}

export function collectAudioBlockIds(source: string, exclude?: AudioBlockFence): string[] {
	const ids: string[] = [];
	for (const block of findAudioBlockFences(source)) {
		if (exclude && block.startOffset === exclude.startOffset && block.endOffset === exclude.endOffset) continue;
		for (const rawLine of block.body.split(/\r?\n/)) {
			const match = rawLine.trim().match(/^id\s*:\s*(.*)$/i);
			if (match?.[1]?.trim()) ids.push(match[1].trim());
		}
	}
	return ids;
}

export function formatAudioBlockInsertion(source: string, offset: number, block: string): string {
	const before = source.slice(0, offset);
	const after = source.slice(offset);
	const prefix = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
	const suffix = after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
	return `${prefix}${block}${suffix}`;
}

export function formatAudioBlockForFence(block: AudioBlockFence, serialized: string): string {
	if (!block.linePrefix) return serialized;
	return serialized.split("\n").map(line => `${block.linePrefix}${line}`).join("\n");
}
