export interface AudioBlockTypeDefinition {
	name: string;
	color: string;
}

export const BUILTIN_AUDIO_BLOCK_TYPES: AudioBlockTypeDefinition[] = [
	{name: "music", color: "#b8a0e0"},
	{name: "sfx", color: "#e8a854"},
	{name: "ambience", color: "#5ecec7"},
	{name: "playlist", color: "#b8a0e0"},
];

export const DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR = "#a78bfa";

const BUILTIN_NAMES = new Set(BUILTIN_AUDIO_BLOCK_TYPES.map(type => type.name));
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function isBuiltinAudioBlockType(name: string): boolean {
	return BUILTIN_NAMES.has(name.trim().toLocaleLowerCase("en"));
}

export function normalizeAudioBlockTypeColor(value: unknown): string {
	return typeof value === "string" && HEX_COLOR.test(value.trim())
		? value.trim().toLocaleLowerCase("en")
		: DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR;
}

export function normalizeCustomAudioBlockTypes(value: unknown): AudioBlockTypeDefinition[] {
	if (!Array.isArray(value)) return [];
	const normalized: AudioBlockTypeDefinition[] = [];
	const names = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Partial<AudioBlockTypeDefinition>;
		const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
		const key = name.toLocaleLowerCase("en");
		if (!name || BUILTIN_NAMES.has(key) || names.has(key)) continue;
		names.add(key);
		normalized.push({name, color: normalizeAudioBlockTypeColor(candidate.color)});
	}
	return normalized;
}

export function upsertCustomAudioBlockType(
	definitions: AudioBlockTypeDefinition[],
	definition: AudioBlockTypeDefinition,
	previousName?: string,
): AudioBlockTypeDefinition[] {
	const name = definition.name.trim();
	if (!name || isBuiltinAudioBlockType(name)) return normalizeCustomAudioBlockTypes(definitions);
	const previousKey = previousName?.trim().toLocaleLowerCase("en");
	const currentKey = name.toLocaleLowerCase("en");
	const retained = definitions.filter(item => {
		const key = item.name.trim().toLocaleLowerCase("en");
		return key !== currentKey && (!previousKey || key !== previousKey);
	});
	return normalizeCustomAudioBlockTypes([
		...retained,
		{name, color: normalizeAudioBlockTypeColor(definition.color)},
	]);
}

export function findCustomAudioBlockType(
	definitions: AudioBlockTypeDefinition[],
	name: string,
): AudioBlockTypeDefinition | undefined {
	const key = name.trim().toLocaleLowerCase("en");
	return definitions.find(item => item.name.toLocaleLowerCase("en") === key);
}

export function getAudioBlockTypeColor(
	name: string,
	customDefinitions: AudioBlockTypeDefinition[] = [],
): string {
	const key = name.trim().toLocaleLowerCase("en");
	return BUILTIN_AUDIO_BLOCK_TYPES.find(type => type.name === key)?.color
		?? findCustomAudioBlockType(customDefinitions, name)?.color
		?? DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR;
}
