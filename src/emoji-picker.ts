import {
	EMOJI_DATA_SOURCE,
	EMOJI_DATA_VERSION,
	GENERATED_EMOJI_CATEGORIES,
} from "./data/emoji-data.generated";

export interface EmojiOption { emoji: string; name: string; searchText: string; }
export interface EmojiCategory { id: string; label: string; icon: string; options: EmojiOption[]; }

export {EMOJI_DATA_SOURCE, EMOJI_DATA_VERSION};

let cachedCategories: EmojiCategory[] | null = null;

export function getEmojiCategories(): EmojiCategory[] {
	if (!cachedCategories) {
		cachedCategories = GENERATED_EMOJI_CATEGORIES.map(category => ({
			id: category.id,
			label: category.label,
			icon: category.icon,
			options: category.options.map(([emoji, name, searchTerms]) => ({
				emoji,
				name,
				searchText: `${name.toLocaleLowerCase("en")} ${searchTerms}`,
			})),
		}));
	}
	return cachedCategories;
}

export interface TextInsertion { value: string; cursor: number; }
export function insertTextAtCursor(value: string, text: string, selectionStart: number | null): TextInsertion {
	const cursor = Math.max(0, Math.min(selectionStart ?? value.length, value.length));
	return {value: `${value.slice(0, cursor)}${text}${value.slice(cursor)}`, cursor: cursor + text.length};
}

export function filterEmojiOptions(items: EmojiOption[], query: string): EmojiOption[] {
	const needle = query.trim().toLocaleLowerCase("en");
	if (!needle) return items;
	return items.filter(item => item.searchText.includes(needle));
}

export function updateRecentEmojis(recent: string[], selected: string, limit = 24): string[] {
	return [selected, ...recent.filter(item => item !== selected)].slice(0, limit);
}

export function emojiGridTargetIndex(current: number, key: string, count: number, columns: number): number {
	if (count <= 0) return -1;
	const rowStart = Math.floor(current / columns) * columns;
	const rowEnd = Math.min(rowStart + columns - 1, count - 1);
	switch (key) {
		case "ArrowRight": return Math.min(current + 1, count - 1);
		case "ArrowLeft": return Math.max(current - 1, 0);
		case "ArrowDown": return Math.min(current + columns, count - 1);
		case "ArrowUp": return Math.max(current - columns, 0);
		case "Home": return rowStart;
		case "End": return rowEnd;
		default: return current;
	}
}
