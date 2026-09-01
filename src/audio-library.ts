export interface AudioLibraryPath {
	path: string;
}

export interface AudioLibraryFolder<T extends AudioLibraryPath> {
	label: string;
	files: T[];
}

export function audioFileSelectionInputType(multiple?: boolean): "checkbox" | "radio" {
	return multiple === false ? "radio" : "checkbox";
}

function folderLabel(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const separator = normalized.lastIndexOf("/");
	return separator < 0 ? "Vault root" : `${normalized.slice(0, separator)}/`;
}

export function groupAudioFilesByFolder<T extends AudioLibraryPath>(files: T[]): AudioLibraryFolder<T>[] {
	const folders = new Map<string, T[]>();
	for (const file of files) {
		const label = folderLabel(file.path);
		const group = folders.get(label);
		if (group) group.push(file);
		else folders.set(label, [file]);
	}

	return Array.from(folders, ([label, groupedFiles]) => ({
		label,
		files: groupedFiles.sort((a, b) => a.path.localeCompare(b.path)),
	})).sort((a, b) => a.label.localeCompare(b.label));
}
