export interface AudioLibraryPath {
	path: string;
}

export interface AudioLibraryFolder<T extends AudioLibraryPath> {
	path: string;
	label: string;
	files: T[];
}

export type AudioLibrarySortDirection = "asc" | "desc";

export function audioFileSelectionInputType(multiple?: boolean): "checkbox" | "radio" {
	return multiple === false ? "radio" : "checkbox";
}

export function audioLibraryFolderPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const separator = normalized.lastIndexOf("/");
	return separator < 0 ? "" : normalized.slice(0, separator);
}

export function audioLibraryFolderLabel(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const separator = normalized.lastIndexOf("/");
	return normalized ? normalized.slice(separator + 1) : "Vault root";
}

export function sortAudioLibraryFiles<T extends AudioLibraryPath>(
	files: T[],
	direction: AudioLibrarySortDirection = "asc",
): T[] {
	const multiplier = direction === "asc" ? 1 : -1;
	return [...files].sort((a, b) => {
		const aPath = a.path.replace(/\\/g, "/");
		const bPath = b.path.replace(/\\/g, "/");
		const aName = aPath.slice(aPath.lastIndexOf("/") + 1);
		const bName = bPath.slice(bPath.lastIndexOf("/") + 1);
		return multiplier * (aName.localeCompare(bName) || aPath.localeCompare(bPath));
	});
}

export function selectAudioLibraryFiles<T extends AudioLibraryPath>(
	files: T[],
	folderPath: string | null,
	query: string,
	direction: AudioLibrarySortDirection,
): T[] {
	const normalizedQuery = query.trim().toLocaleLowerCase("en");
	return sortAudioLibraryFiles(files.filter(file => (
		(folderPath === null || audioLibraryFolderPath(file.path) === folderPath)
		&& (!normalizedQuery || file.path.toLocaleLowerCase("en").includes(normalizedQuery))
	)), direction);
}

export function groupAudioFilesByFolder<T extends AudioLibraryPath>(files: T[]): AudioLibraryFolder<T>[] {
	const folders = new Map<string, T[]>();
	for (const file of files) {
		const path = audioLibraryFolderPath(file.path);
		const group = folders.get(path);
		if (group) group.push(file);
		else folders.set(path, [file]);
	}

	return Array.from(folders, ([path, groupedFiles]) => ({
		path,
		label: audioLibraryFolderLabel(path),
		files: sortAudioLibraryFiles(groupedFiles),
	})).sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}
