import {AudioBlockParseResult} from "./audio-block-parser";

const LEGACY_REQUIRED_FIELDS_ERROR = "Invalid rpg-audio block. Add id, name, and file or files.";

export function getAudioBlockErrors(
	result: AudioBlockParseResult,
	missingFiles: string[],
	validationEnabled: boolean,
): string[] {
	if (!validationEnabled) return result.def ? [] : [LEGACY_REQUIRED_FIELDS_ERROR];

	const errors = [...result.errors];
	for (const path of missingFiles) {
		errors.push(`Audio file not found: "${path}". Check the vault path or configured audio folder.`);
	}
	return errors;
}
