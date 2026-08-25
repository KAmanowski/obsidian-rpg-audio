export interface AudioFileLookup<T> {
	getFileByPath(path: string): T | null;
}

export function findAudioFile<T>(lookup: AudioFileLookup<T>, audioFolder: string, path: string): T | null {
	const direct = lookup.getFileByPath(path);
	if (direct) return direct;

	const folder = audioFolder.replace(/^\/+|\/+$/g, "");
	if (!folder) return null;
	return lookup.getFileByPath(`${folder}/${path}`);
}
