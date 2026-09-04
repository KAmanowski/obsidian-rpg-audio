import {App, Modal, Notice, setIcon, TFile} from "obsidian";
import {
	AudioLibrarySortDirection,
	audioFileSelectionInputType,
	groupAudioFilesByFolder,
	selectAudioLibraryFiles,
} from "../audio-library";
import {AudioPreviewController} from "../audio-preview";
import {preserveScrollPosition} from "./scroll-preservation";

export const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "webm", "aac"]);

let nextFilePickerId = 0;

export interface AudioFilePickerOptions {
	audioFolder: string;
	multiple?: boolean;
	onChoose: (paths: string[]) => void;
}

export function pathForAudioBlock(file: TFile, audioFolder: string): string {
	const folder = audioFolder.replace(/^\/+|\/+$/g, "");
	return folder && file.path.startsWith(`${folder}/`) ? file.path.slice(folder.length + 1) : file.path;
}

export class AudioFilePickerModal extends Modal {
	private readonly options: AudioFilePickerOptions;
	private readonly selected = new Set<string>();
	private readonly pickerId = ++nextFilePickerId;
	private selectedFolder: string | null = null;
	private sortDirection: AudioLibrarySortDirection = "asc";
	private query = "";
	private folderTabsEl: HTMLElement | null = null;
	private sortButton: HTMLButtonElement | null = null;
	private listEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private submitButton: HTMLButtonElement | null = null;
	private readonly previewButtons = new Map<string, {button: HTMLButtonElement; name: string}>();
	private readonly previewController = new AudioPreviewController(
		activePath => this.updatePreviewButtons(activePath),
		path => new Notice(`Could not preview "${path}".`),
	);

	constructor(app: App, options: AudioFilePickerOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("rpg-audio-file-picker-modal");
		this.titleEl.setText(this.options.multiple === false ? "Choose replacement audio" : "Add audio files");

		const search = this.contentEl.createDiv({cls: "rpg-audio-file-picker-search"});
		const icon = search.createSpan({cls: "rpg-audio-file-picker-search-icon"});
		setIcon(icon, "search");
		const input = search.createEl("input", {
			type: "search",
			placeholder: "Search vault audio files…",
			attr: {"aria-label": "Search vault audio files"},
		});
		input.addEventListener("input", () => {
			this.query = input.value;
			this.renderFiles();
		});

		const toolbar = this.contentEl.createDiv({cls: "rpg-audio-file-picker-toolbar"});
		const tabsScroll = toolbar.createDiv({cls: "rpg-audio-file-picker-tabs-scroll"});
		this.folderTabsEl = tabsScroll.createDiv({
			cls: "rpg-audio-segmented rpg-audio-type-selector rpg-audio-file-picker-folder-tabs",
			attr: {role: "group", "aria-label": "Filter by audio folder"},
		});
		this.sortButton = toolbar.createEl("button", {
			cls: "clickable-icon rpg-audio-file-picker-sort",
			attr: {type: "button"},
		});
		this.sortButton.addEventListener("click", () => {
			this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
			this.updateSortButton();
			this.renderFiles();
		});

		this.listEl = this.contentEl.createDiv({cls: "rpg-audio-file-picker-list"});
		this.listEl.setAttribute("role", "group");
		this.listEl.setAttribute("aria-label", "Audio files");

		const footer = this.contentEl.createDiv({cls: "rpg-audio-file-picker-footer"});
		this.countEl = footer.createDiv({cls: "rpg-audio-file-picker-count"});
		const actions = footer.createDiv({cls: "rpg-audio-file-picker-actions"});
		const cancel = actions.createEl("button", {text: "Cancel"});
		cancel.addEventListener("click", () => this.close());
		this.submitButton = actions.createEl("button", {
			text: this.options.multiple === false ? "Choose file" : "Add selected",
			cls: "mod-cta",
		});
		this.submitButton.addEventListener("click", () => this.submit());

		this.renderFolderTabs();
		this.updateSortButton();
		this.renderFiles();
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.previewController.dispose();
		this.previewButtons.clear();
		this.contentEl.empty();
	}

	private audioFiles(): TFile[] {
		return this.app.vault.getFiles()
			.filter(file => AUDIO_EXTENSIONS.has(file.extension.toLowerCase()));
	}

	private renderFolderTabs(): void {
		const tabs = this.folderTabsEl;
		if (!tabs) return;
		const render = () => {
			tabs.empty();
			for (const folder of groupAudioFilesByFolder(this.audioFiles())) {
				const selected = folder.path === this.selectedFolder;
				const fullLabel = folder.path || "Vault root";
				const actionLabel = selected
					? `Show files from all folders; currently filtering by ${fullLabel}`
					: `Filter by ${fullLabel}`;
				const button = tabs.createEl("button", {
					text: folder.label,
					cls: selected ? "is-selected" : "",
					attr: {
						type: "button",
						"aria-label": actionLabel,
						"aria-pressed": String(selected),
						title: actionLabel,
					},
				});
				button.addEventListener("click", () => {
					this.selectedFolder = selected ? null : folder.path;
					this.renderFolderTabs();
					this.renderFiles();
				});
			}
		};
		const scrollEl = tabs.parentElement;
		if (scrollEl) preserveScrollPosition(scrollEl, render);
		else render();
	}

	private updateSortButton(): void {
		const button = this.sortButton;
		if (!button) return;
		button.empty();
		const ascending = this.sortDirection === "asc";
		setIcon(button, ascending ? "arrow-up" : "arrow-down");
		button.createSpan({text: ascending ? "ASC" : "DESC"});
		const label = ascending
			? "Files sorted ascending; select to sort descending"
			: "Files sorted descending; select to sort ascending";
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
	}

	private renderFiles(preserveScroll = false): void {
		const listEl = this.listEl;
		if (!listEl) return;
		if (preserveScroll) preserveScrollPosition(listEl, () => this.renderFileList(listEl));
		else this.renderFileList(listEl);
	}

	private renderFileList(listEl: HTMLElement): void {
		listEl.empty();
		this.previewButtons.clear();
		const query = this.query.trim();
		const files = selectAudioLibraryFiles(this.audioFiles(), this.selectedFolder, query, this.sortDirection);
		if (files.length === 0) {
			listEl.createDiv({
				cls: "rpg-audio-file-picker-empty",
				text: query || this.selectedFolder !== null
					? "No matching audio files."
					: "No supported audio files were found in the vault.",
			});
		}
		for (const file of files) {
			const path = pathForAudioBlock(file, this.options.audioFolder);
			const row = listEl.createDiv({cls: "rpg-audio-file-picker-row"});
			const label = row.createEl("label", {cls: "rpg-audio-file-picker-selection"});
			const selector = label.createEl("input", {type: audioFileSelectionInputType(this.options.multiple)});
			if (this.options.multiple === false) selector.name = `rpg-audio-file-picker-${this.pickerId}-selection`;
			selector.checked = this.selected.has(path);
			selector.addEventListener("change", () => {
				if (this.options.multiple === false) this.selected.clear();
				if (selector.checked) this.selected.add(path);
				else this.selected.delete(path);
				if (this.options.multiple === false) this.renderFiles(true);
				this.updateFooter();
			});
			const details = label.createDiv({cls: "rpg-audio-file-picker-row-details"});
			details.createDiv({cls: "rpg-audio-file-picker-name", text: file.name});
			details.createDiv({cls: "rpg-audio-file-picker-path", text: file.path, attr: {title: file.path}});
			const preview = row.createEl("button", {
				cls: "rpg-audio-file-picker-preview",
				attr: {type: "button"},
			});
			this.previewButtons.set(path, {button: preview, name: file.name});
			preview.addEventListener("click", event => {
				event.preventDefault();
				event.stopPropagation();
				this.previewController.toggle(path, this.app.vault.getResourcePath(file));
			});
		}
		const activePath = this.previewController.activePath;
		if (activePath && !this.previewButtons.has(activePath)) this.previewController.stop();
		else this.updatePreviewButtons(activePath);
		this.updateFooter();
	}

	private updatePreviewButtons(activePath: string | null): void {
		for (const [path, {button, name}] of this.previewButtons) {
			const active = path === activePath;
			button.empty();
			setIcon(button, active ? "square" : "play");
			button.toggleClass("is-previewing", active);
			const label = active ? `Stop preview of ${name}` : `Preview ${name}`;
			button.setAttribute("aria-label", label);
			button.setAttribute("title", label);
		}
	}

	private updateFooter(): void {
		const count = this.selected.size;
		if (this.countEl) this.countEl.setText(`${count} selected`);
		if (this.submitButton) this.submitButton.disabled = count === 0;
	}

	private submit(): void {
		if (this.selected.size === 0) return;
		this.previewController.stop();
		this.options.onChoose(Array.from(this.selected));
		this.close();
	}
}
