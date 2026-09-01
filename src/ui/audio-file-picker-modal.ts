import {App, Modal, setIcon, TFile} from "obsidian";
import {audioFileSelectionInputType, groupAudioFilesByFolder} from "../audio-library";
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
	private readonly collapsedFolders = new Set<string>();
	private readonly pickerId = ++nextFilePickerId;
	private renderGeneration = 0;
	private query = "";
	private listEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private submitButton: HTMLButtonElement | null = null;

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

		this.renderFiles();
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private audioFiles(): TFile[] {
		return this.app.vault.getFiles()
			.filter(file => AUDIO_EXTENSIONS.has(file.extension.toLowerCase()))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	private renderFiles(preserveScroll = false): void {
		const listEl = this.listEl;
		if (!listEl) return;
		if (preserveScroll) preserveScrollPosition(listEl, () => this.renderFileList(listEl));
		else this.renderFileList(listEl);
	}

	private renderFileList(listEl: HTMLElement): void {
		listEl.empty();
		const query = this.query.trim().toLowerCase();
		const files = this.audioFiles().filter(file => !query || file.path.toLowerCase().includes(query));
		const renderGeneration = ++this.renderGeneration;
		if (files.length === 0) {
			listEl.createDiv({
				cls: "rpg-audio-file-picker-empty",
				text: query ? "No matching audio files." : "No supported audio files were found in the vault.",
			});
		}
		for (const [folderIndex, folder] of groupAudioFilesByFolder(files).entries()) {
			const heading = listEl.createDiv({cls: "rpg-audio-file-picker-folder"});
			heading.setAttribute("role", "heading");
			heading.setAttribute("aria-level", "3");
			const contentId = `rpg-audio-file-picker-${this.pickerId}-${renderGeneration}-${folderIndex}`;
			const toggle = heading.createEl("button", {cls: "rpg-audio-file-picker-folder-toggle"});
			const chevron = toggle.createSpan({cls: "rpg-audio-file-picker-folder-chevron"});
			setIcon(chevron, "chevron-down");
			chevron.setAttribute("aria-hidden", "true");
			toggle.createSpan({cls: "rpg-audio-file-picker-folder-name", text: folder.label});
			toggle.createSpan({
				cls: "rpg-audio-file-picker-folder-count",
				text: String(folder.files.length),
				attr: {"aria-label": `${folder.files.length} ${folder.files.length === 1 ? "file" : "files"}`},
			});
			toggle.setAttribute("aria-controls", contentId);

			const folderContent = listEl.createDiv({cls: "rpg-audio-file-picker-folder-content"});
			folderContent.id = contentId;
			folderContent.setAttribute("role", "group");
			folderContent.setAttribute("aria-label", folder.label);
			const setExpanded = (expanded: boolean) => {
				if (expanded) this.collapsedFolders.delete(folder.label);
				else this.collapsedFolders.add(folder.label);
				toggle.setAttribute("aria-expanded", String(expanded));
				toggle.setAttribute("title", `${expanded ? "Collapse" : "Expand"} ${folder.label}`);
				chevron.toggleClass("is-collapsed", !expanded);
				folderContent.hidden = !expanded;
			};
			setExpanded(!this.collapsedFolders.has(folder.label));
			toggle.addEventListener("click", () => {
				setExpanded(toggle.getAttribute("aria-expanded") !== "true");
			});

			for (const file of folder.files) {
				const path = pathForAudioBlock(file, this.options.audioFolder);
				const label = folderContent.createEl("label", {cls: "rpg-audio-file-picker-row"});
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
			}
		}
		this.updateFooter();
	}

	private updateFooter(): void {
		const count = this.selected.size;
		if (this.countEl) this.countEl.setText(`${count} selected`);
		if (this.submitButton) this.submitButton.disabled = count === 0;
	}

	private submit(): void {
		if (this.selected.size === 0) return;
		this.options.onChoose(Array.from(this.selected));
		this.close();
	}
}
