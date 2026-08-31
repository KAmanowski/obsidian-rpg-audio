import {AudioFileEntry} from "./types";

export interface PlaylistDisplayItem {
	path: string;
	name: string;
	context: string | null;
}

export interface EffectiveRegion {
	startTime: number | null;
	endTime: number | null;
}

export function resolveConfiguredRegion(
	entry: AudioFileEntry | undefined,
	masterStart: number | null,
	masterEnd: number | null,
): EffectiveRegion {
	return {
		startTime: entry?.startTime === undefined ? masterStart : entry.startTime,
		endTime: entry?.endTime === undefined ? masterEnd : entry.endTime,
	};
}

function splitPath(path: string): string[] {
	return path.split(/[\\/]+/).filter(Boolean);
}

function displayName(path: string): string {
	const parts = splitPath(path);
	const filename = parts[parts.length - 1] ?? path;
	const withoutExtension = filename.replace(/\.[^.]+$/, "");
	return withoutExtension || filename;
}

function parentParts(path: string): string[] {
	const parts = splitPath(path);
	return parts.slice(0, -1);
}

function shortestUniqueParent(paths: string[], targetIndex: number, duplicateIndices: number[]): string | null {
	const target = parentParts(paths[targetIndex] ?? "");
	if (target.length === 0) return null;

	const others = duplicateIndices
		.filter(index => index !== targetIndex)
		.map(index => parentParts(paths[index] ?? ""));
	for (let depth = 1; depth <= target.length; depth++) {
		const suffix = target.slice(-depth).join("/");
		const unique = others.every(parts => parts.slice(-depth).join("/") !== suffix);
		if (unique) return `${suffix}/`;
	}
	return `${target.join("/")}/`;
}

/** Build compact labels while retaining enough parent context for duplicate names. */
export function buildPlaylistDisplayItems(
	entries: AudioFileEntry[],
): PlaylistDisplayItem[] {
	const paths = entries.map(entry => entry.path);
	const names = entries.map(entry => entry.title?.trim() || displayName(entry.path));
	const indicesByName = new Map<string, number[]>();
	for (let index = 0; index < names.length; index++) {
		const name = names[index] ?? "";
		const key = name.toLocaleLowerCase();
		const indices = indicesByName.get(key) ?? [];
		indices.push(index);
		indicesByName.set(key, indices);
	}

	return paths.map((path, index) => {
		const name = names[index] ?? path;
		const duplicateIndices = indicesByName.get(name.toLocaleLowerCase()) ?? [];
		return {
			path,
			name,
			context: duplicateIndices.length > 1
				? shortestUniqueParent(paths, index, duplicateIndices)
				: null,
		};
	});
}

export function isValidPlaylistIndex(index: number, length: number): boolean {
	return Number.isInteger(index) && index >= 0 && index < length;
}
