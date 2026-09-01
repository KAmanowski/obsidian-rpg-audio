import {App, setIcon} from "obsidian";
import {
	EmojiOption,
	emojiGridTargetIndex,
	filterEmojiOptions,
	getEmojiCategories,
	insertTextAtCursor,
	updateRecentEmojis,
} from "../emoji-picker";

const SEARCH_DELAY_MS = 150;

export class EmojiPicker {
	private readonly button: HTMLButtonElement;
	private popup: HTMLElement | null = null;
	private searchInput: HTMLInputElement | null = null;
	private gridEl: HTMLElement | null = null;
	private optionButtons: HTMLButtonElement[] = [];
	private activeCategory = "rpg";
	private query = "";
	private caretPosition = 0;
	private searchTimer: number | null = null;
	private recent: string[];

	constructor(
		private readonly app: App,
		private readonly parent: HTMLElement,
		private readonly input: HTMLInputElement,
		private readonly onInsert: (value: string) => void,
	) {
		parent.addClass("rpg-audio-name-control");
		this.recent = this.loadRecent();
		this.button = parent.createEl("button", {
			cls: "rpg-audio-emoji-picker-button clickable-icon",
			text: "😀",
			attr: {type: "button", "aria-label": "Insert emoji", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Insert emoji"},
		});
		this.button.addEventListener("click", () => this.popup ? this.close(false) : this.open());
	}

	destroy(): void { this.close(false); }

	private open(): void {
		this.caretPosition = this.input.selectionStart ?? this.input.value.length;
		const popup = this.parent.createDiv({cls: "rpg-audio-emoji-picker", attr: {role: "dialog", "aria-label": "Emoji picker"}});
		this.popup = popup;
		this.button.setAttribute("aria-expanded", "true");

		const search = popup.createDiv({cls: "rpg-audio-emoji-search"});
		const searchIcon = search.createSpan();
		setIcon(searchIcon, "search");
		this.searchInput = search.createEl("input", {type: "search", placeholder: "Search emoji…", attr: {"aria-label": "Search emoji"}});
		this.searchInput.addEventListener("input", () => this.scheduleSearch());
		this.searchInput.addEventListener("keydown", event => {
			if (event.key === "ArrowDown" && this.optionButtons.length > 0) {
				event.preventDefault();
				this.focusOption(0);
			}
		});
		this.renderPickerBody();
		document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
		document.addEventListener("keydown", this.onDocumentKeydown, true);
		this.parent.closest(".modal-content")?.addEventListener("scroll", this.onModalScroll, {passive: true});
		this.searchInput.focus({preventScroll: true});
	}

	private renderPickerBody(): void {
		if (!this.popup) return;
		this.popup.querySelector(".rpg-audio-emoji-tabs")?.remove();
		this.popup.querySelector(".rpg-audio-emoji-results")?.remove();
		this.optionButtons = [];

		if (!this.query) this.renderTabs();
		const results = this.popup.createDiv({cls: "rpg-audio-emoji-results"});
		this.gridEl = results;
		if (this.query) this.renderSearchResults(results);
		else this.renderCategory(results);
	}

	private renderTabs(): void {
		if (!this.popup) return;
		const tabs = this.popup.createDiv({cls: "rpg-audio-emoji-tabs", attr: {role: "tablist", "aria-label": "Emoji categories"}});
		const categories = [{id: "recent", label: "Recently used", icon: "🕐"}, ...getEmojiCategories()];
		for (const [index, category] of categories.entries()) {
			const selected = category.id === this.activeCategory;
			const tab = tabs.createEl("button", {
				cls: `rpg-audio-emoji-tab ${selected ? "is-selected" : ""}`,
				text: category.icon,
				attr: {type: "button", role: "tab", "aria-label": category.label, "aria-selected": String(selected), title: category.label, tabindex: selected ? "0" : "-1"},
			});
			tab.addEventListener("click", () => {
				this.activeCategory = category.id;
				this.renderPickerBody();
				this.popup?.querySelector<HTMLButtonElement>(".rpg-audio-emoji-tab.is-selected")?.focus({preventScroll: true});
			});
			tab.addEventListener("keydown", event => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const next = (index + (event.key === "ArrowRight" ? 1 : categories.length - 1)) % categories.length;
				this.activeCategory = categories[next]!.id;
				this.renderPickerBody();
				this.popup?.querySelectorAll<HTMLButtonElement>(".rpg-audio-emoji-tab")[next]?.focus({preventScroll: true});
			});
		}
	}

	private renderCategory(parent: HTMLElement): void {
		if (this.activeCategory === "recent") {
			this.renderGroup(parent, "Recently used", this.recentOptions());
			return;
		}
		const categories = getEmojiCategories();
		const category = categories.find(item => item.id === this.activeCategory) ?? categories[0];
		if (category) this.renderGroup(parent, category.label, category.options);
	}

	private renderSearchResults(parent: HTMLElement): void {
		let count = 0;
		for (const category of getEmojiCategories()) {
			const matches = filterEmojiOptions(category.options, this.query);
			if (matches.length === 0) continue;
			count += matches.length;
			this.renderGroup(parent, `${category.label} · ${matches.length} result${matches.length === 1 ? "" : "s"}`, matches);
		}
		if (count === 0) {
			const empty = parent.createDiv({cls: "rpg-audio-emoji-empty"});
			empty.createDiv({cls: "rpg-audio-emoji-empty-icon", text: "🔍"});
			empty.createDiv({cls: "rpg-audio-emoji-empty-title", text: "No emoji found"});
			empty.createDiv({text: "Try a keyword like “music”, “sword”, or “rain”."});
		}
		const status = parent.createDiv({cls: "rpg-audio-emoji-status", attr: {"aria-live": "polite"}});
		status.setText(`${count} result${count === 1 ? "" : "s"} for “${this.query}”`);
	}

	private renderGroup(parent: HTMLElement, label: string, items: EmojiOption[]): void {
		parent.createDiv({cls: "rpg-audio-emoji-group-label", text: label});
		if (items.length === 0) {
			parent.createDiv({cls: "rpg-audio-emoji-empty", text: "Emoji you pick will appear here."});
			return;
		}
		const grid = parent.createDiv({cls: "rpg-audio-emoji-grid", attr: {role: "grid", "aria-label": label}});
		for (const item of items) {
			const index = this.optionButtons.length;
			const button = grid.createEl("button", {
				cls: "rpg-audio-emoji-option", text: item.emoji,
				attr: {type: "button", role: "gridcell", "aria-label": item.name, title: item.name, tabindex: index === 0 ? "0" : "-1"},
			});
			button.addEventListener("click", () => this.insert(item.emoji));
			button.addEventListener("keydown", event => this.onOptionKeydown(event, index));
			this.optionButtons.push(button);
		}
	}

	private insert(value: string): void {
		const insertion = insertTextAtCursor(this.input.value, value, this.caretPosition);
		this.caretPosition = insertion.cursor;
		this.input.value = insertion.value;
		this.input.setSelectionRange(insertion.cursor, insertion.cursor);
		this.onInsert(insertion.value);
		this.recent = updateRecentEmojis(this.recent, value);
		this.saveRecent();
	}

	private onOptionKeydown(event: KeyboardEvent, index: number): void {
		if (event.key === "Tab") return;
		const columns = window.matchMedia("(max-width: 500px)").matches ? 7 : 8;
		const target = emojiGridTargetIndex(index, event.key, this.optionButtons.length, columns);
		if (target === index) return;
		event.preventDefault();
		this.focusOption(target);
	}

	private focusOption(index: number): void {
		for (const [buttonIndex, button] of this.optionButtons.entries()) button.tabIndex = buttonIndex === index ? 0 : -1;
		this.optionButtons[index]?.focus({preventScroll: true});
	}

	private scheduleSearch(): void {
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		this.searchTimer = window.setTimeout(() => {
			this.searchTimer = null;
			this.query = this.searchInput?.value.trim() ?? "";
			this.renderPickerBody();
		}, SEARCH_DELAY_MS);
	}

	private recentOptions(): EmojiOption[] {
		const all = getEmojiCategories().flatMap(category => category.options);
		return this.recent.map(value => all.find(item => item.emoji === value) ?? {emoji: value, name: "Recently used emoji", searchText: "recently used emoji"});
	}

	private storageKey(): string { return "rpg-audio-emoji-recent"; }
	private loadRecent(): string[] {
		try { const value = this.app.loadLocalStorage(this.storageKey()) as unknown; return Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, 24) : []; }
		catch { return []; }
	}
	private saveRecent(): void { try { this.app.saveLocalStorage(this.storageKey(), this.recent); } catch { /* Local storage may be unavailable. */ } }

	private close(restoreButtonFocus: boolean): void {
		if (!this.popup) return;
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		this.searchTimer = null;
		document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
		document.removeEventListener("keydown", this.onDocumentKeydown, true);
		this.parent.closest(".modal-content")?.removeEventListener("scroll", this.onModalScroll);
		this.popup.remove();
		this.popup = null;
		this.searchInput = null;
		this.gridEl = null;
		this.optionButtons = [];
		this.query = "";
		this.button.setAttribute("aria-expanded", "false");
		if (restoreButtonFocus) this.button.focus({preventScroll: true});
	}

	private readonly onDocumentPointerDown = (event: PointerEvent): void => {
		if (event.target instanceof Node && !this.parent.contains(event.target)) this.close(false);
	};
	private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		if (this.searchInput?.value) {
			if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
			this.searchTimer = null;
			this.searchInput.value = "";
			this.query = "";
			this.renderPickerBody();
			this.searchInput.focus({preventScroll: true});
		} else this.close(true);
		event.preventDefault();
		event.stopPropagation();
	};
	private readonly onModalScroll = (): void => { if (!window.matchMedia("(max-width: 500px)").matches) this.close(false); };
}
