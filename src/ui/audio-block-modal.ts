import {App, Modal, Setting, setIcon} from "obsidian";
import {AudioBlockDefaults} from "../audio-block-parser";
import {
	AudioBlockFormState,
	AudioBlockValidationResult,
	BoundaryInput,
	createAudioFileDraft,
	isPlaylistForm,
	slugifyAudioBlockId,
	validateAudioBlockForm,
} from "../audio-block-form";
import {findAudioFile} from "../audio-file-resolver";
import {
	AudioBlockTypeDefinition,
	BUILTIN_AUDIO_BLOCK_TYPES,
	DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR,
	findCustomAudioBlockType,
	getAudioBlockTypeColor,
	isBuiltinAudioBlockType,
	normalizeAudioBlockTypeColor,
	upsertCustomAudioBlockType,
} from "../audio-block-types";
import {PlaylistEndAction} from "../types";
import {AudioFilePickerModal} from "./audio-file-picker-modal";
import {EmojiPicker} from "./emoji-picker";
import {preserveScrollPosition} from "./scroll-preservation";

export interface AudioBlockSaveResult {
	ok: boolean;
	message?: string;
}

export interface AudioBlockModalOptions {
	mode: "add" | "edit";
	state: AudioBlockFormState;
	audioFolder: string;
	parserDefaults: AudioBlockDefaults;
	duplicateIds: string[];
	hydrationIssues?: string[];
	customTypes: AudioBlockTypeDefinition[];
	onSaveCustomType: (definition: AudioBlockTypeDefinition, previousName?: string) => Promise<void> | void;
	onSave: (source: string) => Promise<AudioBlockSaveResult> | AudioBlockSaveResult;
}

class DiscardAudioBlockModal extends Modal {
	private resolved = false;

	constructor(app: App, private readonly onDiscard: () => void, private readonly onKeep: () => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Discard audio block changes?");
		this.contentEl.createEl("p", {text: "You have unsaved changes. Closing now will discard them."});
		const actions = this.contentEl.createDiv({cls: "rpg-audio-discard-actions"});
		const keep = actions.createEl("button", {text: "Keep editing"});
		keep.addEventListener("click", () => this.close());
		const discard = actions.createEl("button", {text: "Discard changes", cls: "mod-warning"});
		discard.addEventListener("click", () => {
			this.resolved = true;
			super.close();
			this.onDiscard();
		});
	}

	onClose(): void {
		if (!this.resolved) this.onKeep();
		this.contentEl.empty();
	}
}

export class AudioBlockModal extends Modal {
	private readonly options: AudioBlockModalOptions;
	private readonly state: AudioBlockFormState;
	private readonly touched = new Set<string>();
	private readonly expandedEntries = new Set<string>();
	private dirty = false;
	private allowClose = false;
	private discardPromptOpen = false;
	private submitted = false;
	private saving = false;
	private idManuallyEdited: boolean;
	private codeOpen = false;
	private interactionsOpen = false;
	private saveIssue = "";
	private saveButton: HTMLButtonElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;
	private emojiPicker: EmojiPicker | null = null;
	private customTypes: AudioBlockTypeDefinition[];
	private customTypeColor = DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR;
	private customTypeOriginalName: string | undefined;

	constructor(app: App, options: AudioBlockModalOptions) {
		super(app);
		this.options = options;
		this.state = options.state;
		this.idManuallyEdited = options.mode === "edit" || !!options.state.id;
		this.customTypes = options.customTypes.map(type => ({...type}));
		const initialType = options.state.type.mode === "value" ? options.state.type.value : "";
		const initialCustom = findCustomAudioBlockType(this.customTypes, initialType);
		if (initialCustom) {
			this.customTypeColor = initialCustom.color;
			this.customTypeOriginalName = initialCustom.name;
		}
	}

	onOpen(): void {
		this.modalEl.addClass("rpg-audio-block-editor-modal");
		this.render();
	}

	close(): void {
		if (!this.allowClose && this.dirty) {
			if (this.discardPromptOpen) return;
			this.discardPromptOpen = true;
			new DiscardAudioBlockModal(this.app, () => {
				this.discardPromptOpen = false;
				this.allowClose = true;
				super.close();
			}, () => { this.discardPromptOpen = false; }).open();
			return;
		}
		super.close();
	}

	onClose(): void {
		this.emojiPicker?.destroy();
		this.emojiPicker = null;
		this.contentEl.empty();
	}

	private render(): void {
		const content = this.contentEl;
		this.emojiPicker?.destroy();
		this.emojiPicker = null;
		content.empty();
		content.addClass("rpg-audio-block-editor");
		this.titleEl.setText(this.options.mode === "edit" ? "Edit audio block" : "Add audio block");

		const header = content.createDiv({cls: "rpg-audio-block-editor-header"});
		header.createDiv({
			cls: "rpg-audio-block-editor-subtitle",
			text: "Choose local audio and configure how this block behaves in your note.",
		});
		const count = this.state.entries.length;
		const badgeText = count === 0 ? "No audio files" : count === 1 ? "Single file" : `Playlist · ${count} files`;
		header.createSpan({
			cls: `rpg-audio-block-mode-badge ${count > 1 ? "is-playlist" : count === 1 ? "is-single" : "is-empty"}`,
			text: badgeText,
			attr: {"aria-live": "polite"},
		});

		this.renderBasics(this.section(content, "Basics"));
		this.renderFiles(this.section(content, "Audio files"));
		this.renderPlayback(this.section(content, "Playback"));
		this.renderVolume(this.section(content, "Volume and fades"));
		this.renderInteractions(content);
		this.renderCodePreview(content);
		this.renderFooter(content);
		this.refreshValidation();
	}

	private rerender(): void {
		preserveScrollPosition(this.contentEl, () => this.render());
	}

	private section(parent: HTMLElement, title: string): HTMLElement {
		const section = parent.createEl("section", {cls: "rpg-audio-block-section"});
		section.createEl("h3", {text: title});
		return section;
	}

	private renderBasics(section: HTMLElement): void {
		this.renderNameSetting(section);
		this.textSetting(section, "id", "ID", "Unique identifier within this note.", this.state.id, "tavern-rain", value => {
			this.state.id = value;
			this.idManuallyEdited = true;
		});

		const setting = new Setting(section).setName("Type").setDesc("Display badge/grouping label. Automatic follows the file count.");
		setting.settingEl.dataset.audioField = "type";
		const controls = setting.controlEl.createDiv({cls: "rpg-audio-segmented rpg-audio-type-selector", attr: {role: "group", "aria-label": "Audio block type"}});
		const currentValue = this.state.type.mode === "value" ? this.state.type.value : "";
		const currentKey = currentValue.trim().toLocaleLowerCase("en");
		const builtin = BUILTIN_AUDIO_BLOCK_TYPES.find(type => type.name === currentKey);
		const savedCustom = findCustomAudioBlockType(this.customTypes, currentValue);
		const selected = this.state.type.mode === "inherit"
			? "automatic"
			: builtin?.name ?? (savedCustom ? `custom:${savedCustom.name.toLocaleLowerCase("en")}` : "draft-custom");
		const automaticType = this.state.entries.length > 1 ? "playlist" : "sfx";
		const choices: Array<{key: string; label: string; color: string; type?: AudioBlockTypeDefinition}> = [
			{key: "automatic", label: "Automatic", color: getAudioBlockTypeColor(automaticType)},
			...BUILTIN_AUDIO_BLOCK_TYPES.map(type => ({
				key: type.name,
				label: type.name === "sfx" ? "SFX" : type.name.charAt(0).toUpperCase() + type.name.slice(1),
				color: type.color,
				type,
			})),
			...this.customTypes.map(type => ({
				key: `custom:${type.name.toLocaleLowerCase("en")}`,
				label: type.name,
				color: type.color,
				type,
			})),
		];
		if (selected === "draft-custom" && currentValue.trim()) {
			choices.push({key: "draft-custom", label: currentValue.trim(), color: this.customTypeColor});
		}
		choices.push({key: "new-custom", label: "Custom…", color: this.customTypeColor});

		let selectedButton: HTMLButtonElement | null = null;
		for (const choice of choices) {
			const choiceSelected = selected === choice.key || (selected === "draft-custom" && choice.key === "new-custom" && !currentValue.trim());
			const button = controls.createEl("button", {
				text: choice.label,
				cls: choiceSelected ? "is-selected" : "",
				attr: {type: "button"},
			});
			button.style.setProperty("--rpg-audio-type-color", choice.color);
			button.setAttribute("aria-pressed", String(choiceSelected));
			if (choiceSelected) selectedButton = button;
			button.addEventListener("click", () => {
				this.markChanged("type");
				if (choice.key === "automatic") {
					this.state.type = {mode: "inherit"};
				} else if (choice.key === "new-custom") {
					this.state.type = {mode: "value", value: ""};
					this.customTypeColor = DEFAULT_CUSTOM_AUDIO_BLOCK_TYPE_COLOR;
					this.customTypeOriginalName = undefined;
				} else if (choice.type) {
					this.state.type = {mode: "value", value: choice.type.name};
					if (!isBuiltinAudioBlockType(choice.type.name)) {
						this.customTypeColor = choice.type.color;
						this.customTypeOriginalName = choice.type.name;
					}
				}
				this.rerender();
			});
		}
		if (this.state.type.mode === "value" && !builtin) {
			const customSetting = new Setting(section)
				.setName("Custom type")
				.setDesc("Name and color are saved for future audio blocks when this block is saved.");
			customSetting.settingEl.dataset.audioField = "type";
			customSetting.settingEl.addClass("rpg-audio-custom-type-setting");
			customSetting.addText(text => {
				text.setValue(currentValue).setPlaceholder("Custom type").onChange(value => {
					this.state.type = {mode: "value", value};
					selectedButton?.setText(value.trim() || "Custom…");
					this.markChanged("type");
				});
				text.inputEl.setAttribute("aria-label", "Custom audio block type");
			});
			customSetting.addColorPicker(picker => picker.setValue(this.customTypeColor).onChange(value => {
				this.customTypeColor = normalizeAudioBlockTypeColor(value);
				selectedButton?.style.setProperty("--rpg-audio-type-color", this.customTypeColor);
				this.markChanged("type");
			}));
			customSetting.controlEl.querySelector<HTMLInputElement>('input[type="color"]')
				?.setAttribute("aria-label", "Custom audio block type color");
		}
		this.errorEl(section, "type");
	}

	private async persistSelectedCustomType(): Promise<void> {
		if (this.state.type.mode !== "value" || isBuiltinAudioBlockType(this.state.type.value)) return;
		const name = this.state.type.value.trim();
		if (!name) return;
		const definition = {name, color: this.customTypeColor};
		await this.options.onSaveCustomType(definition, this.customTypeOriginalName);
		this.customTypes = upsertCustomAudioBlockType(this.customTypes, definition, this.customTypeOriginalName);
		this.customTypeOriginalName = name;
	}

	private renderNameSetting(section: HTMLElement): void {
		const setting = new Setting(section).setName("Name").setDesc("Display name shown in the player.");
		setting.settingEl.dataset.audioField = "name";
		setting.addText(text => {
			text.setValue(this.state.name).setPlaceholder("Tavern rain");
			text.onChange(value => {
				this.updateName(value);
				this.markChanged("name");
			});
			this.emojiPicker = new EmojiPicker(this.app, setting.controlEl, text.inputEl, value => {
				this.updateName(value);
				this.markChanged("name");
			});
		});
		this.errorEl(section, "name");
	}

	private updateName(value: string): void {
		this.state.name = value;
		if (this.idManuallyEdited) return;
		this.state.id = slugifyAudioBlockId(value);
		const idInput = this.contentEl.querySelector<HTMLInputElement>('[data-audio-field="id"] input');
		if (idInput) idInput.value = this.state.id;
	}

	private renderFiles(section: HTMLElement): void {
		section.dataset.audioField = "files";
		const intro = section.createDiv({cls: "rpg-audio-files-heading"});
		intro.createDiv({
			cls: "setting-item-description",
			text: "One file creates a single track; two or more files create an ordered playlist.",
		});
		const add = intro.createEl("button", {text: "Add files", cls: "mod-cta"});
		add.addEventListener("click", () => this.openAddFiles());

		if (this.state.entries.length === 0) {
			const empty = section.createDiv({cls: "rpg-audio-files-empty"});
			const icon = empty.createSpan();
			setIcon(icon, "music");
			empty.createDiv({text: "Select audio from the library configured by Audio folder in plugin settings."});
		}

		const list = section.createEl("ol", {cls: "rpg-audio-editor-file-list"});
		const playlist = isPlaylistForm(this.state);
		this.state.entries.forEach((entry, index) => {
			const entryField = `entry-${entry.key}`;
			const item = list.createEl("li", {cls: "rpg-audio-editor-file-row"});
			item.dataset.audioField = entryField;
			const row = item.createDiv({cls: "rpg-audio-editor-file-summary"});
			if (playlist) row.createSpan({cls: "rpg-audio-editor-file-number", text: String(index + 1)});
			const path = row.createDiv({cls: "rpg-audio-editor-file-path", text: entry.path, attr: {title: entry.path}});
			if (!this.fileAvailable(entry.path)) path.addClass("is-missing");
			const actions = row.createDiv({cls: "rpg-audio-editor-file-actions"});
			this.iconButton(actions, "arrow-up", "Move up", index === 0, () => this.moveEntry(index, index - 1));
			this.iconButton(actions, "arrow-down", "Move down", index === this.state.entries.length - 1, () => this.moveEntry(index, index + 1));
			this.iconButton(actions, "replace", "Replace", false, () => this.replaceEntry(index));
			this.iconButton(actions, "trash-2", "Remove", false, () => {
				this.state.entries.splice(index, 1);
				this.markChanged("files");
				this.rerender();
			});

			this.errorEl(item, entryField);

			const details = item.createEl("details", {cls: `rpg-audio-editor-file-details ${playlist ? "" : "is-disabled"}`});
			details.open = this.expandedEntries.has(entry.key);
			details.addEventListener("toggle", () => {
				if (details.open) this.expandedEntries.add(entry.key);
				else this.expandedEntries.delete(entry.key);
			});
			details.createEl("summary", {text: "Title and region overrides"});
			const explanation = details.createDiv({cls: "rpg-audio-disabled-explanation"});
			if (!playlist) explanation.setText("Available when two or more files are selected. Draft values are retained but not saved for a single file.");
			this.textSetting(details, entryField, "Display title", "Optional playlist item title.", entry.title, "Opening assault", value => {
				entry.title = value;
			}, !playlist);
			this.boundarySetting(details, entry.key, "start", "Start override", entry.start, !playlist, value => { entry.start = value; });
			this.boundarySetting(details, entry.key, "end", "End override", entry.end, !playlist, value => { entry.end = value; });
		});
		this.errorEl(section, "files");
	}

	private renderPlayback(section: HTMLElement): void {
		this.toggleSetting(section, "loop", "Loop", "Repeat the single region or control playlist cycling.", this.state.loop, value => { this.state.loop = value; });
		this.toggleSetting(section, "autoplay", "Autoplay", "Start when the rendered block loads, if global autoplay is allowed.", this.state.autoplay, value => { this.state.autoplay = value; });
		this.textSetting(section, "start", "Start time", "Optional block boundary; playlists use it as the inherited default.", this.state.start, "0:15", value => { this.state.start = value; });
		this.textSetting(section, "end", "End time", "Optional block boundary; must be later than Start time.", this.state.end, "3:00", value => { this.state.end = value; });

		const playlist = isPlaylistForm(this.state);
		const group = section.createDiv({cls: `rpg-audio-playlist-only ${playlist ? "" : "is-disabled"}`});
		group.createDiv({cls: "rpg-audio-playlist-only-title", text: "Playlist controls"});
		if (!playlist) group.createDiv({cls: "rpg-audio-disabled-explanation", text: "Available when two or more files are selected. Draft values are retained while this editor stays open."});
		this.toggleSetting(group, "random", "Random order", "Choose a randomized item order.", this.state.random, value => { this.state.random = value; }, !playlist);
		const endAction = new Setting(group).setName("Playlist end action").setDesc("Choose what happens when an item reaches its boundary or natural end.");
		endAction.addDropdown(dropdown => dropdown
			.addOption("auto", "Auto (follow loop)")
			.addOption("next", "Next item")
			.addOption("repeat", "Repeat item")
			.addOption("stop", "Stop playlist")
			.setValue(this.state.playlistEndAction)
			.setDisabled(!playlist)
			.onChange(value => {
				this.state.playlistEndAction = value as PlaylistEndAction;
				this.markChanged("playlist-end-action");
			}));

		this.choiceSetting(group, "crossfade", "Playlist crossfade", "Use the plugin default or set seconds for this playlist.",
			this.state.playlistCrossfade.mode === "inherit" ? "inherit" : "custom", !playlist, value => {
			this.state.playlistCrossfade = value === "inherit" ? {mode: "inherit"} : {mode: "value", value: ""};
			this.rerender();
			});
		if (this.state.playlistCrossfade.mode === "value") {
			this.textSetting(group, "crossfade", "Crossfade duration", "Seconds of overlap between adjacent items.", this.state.playlistCrossfade.value, "3", value => {
				this.state.playlistCrossfade = {mode: "value", value};
			}, !playlist, "number");
		}
	}

	private renderVolume(section: HTMLElement): void {
		const initialVolume = this.state.volume.mode === "value" ? this.state.volume.value : "1";
		this.textSetting(section, "volume", "Initial volume", "Value from 0 (silent) to 1 (full).", initialVolume, "1", value => {
			this.state.volume = value.trim() === "" || value.trim() === "1" ? {mode: "inherit"} : {mode: "value", value};
		}, false, "number");
		this.textSetting(section, "fadein", "Fade in duration", "Non-negative seconds from silence when playback starts.", this.state.fadein, "2", value => { this.state.fadein = value; }, false, "number");
		this.textSetting(section, "fadeout", "Fade out duration", "Optional per-block override in seconds. Leave blank to inherit the plugin default.", this.state.fadeout, "4", value => { this.state.fadeout = value; }, false, "number");

		this.choiceSetting(section, "volume-fade", "Volume automation", "Use the plugin default or define a target and duration for this block.", this.state.volumeFadeMode, false, value => {
			this.state.volumeFadeMode = value as "inherit" | "custom";
			this.rerender();
		});
		if (this.state.volumeFadeMode === "custom") {
			this.textSetting(section, "volume-fade-target", "Target volume", "Required value from 0 to 1.", this.state.volumeFadeTarget, "0.5", value => { this.state.volumeFadeTarget = value; }, false, "number");
			this.textSetting(section, "volume-fade-duration", "Duration", "Required duration greater than zero seconds.", this.state.volumeFadeDuration, "60", value => { this.state.volumeFadeDuration = value; }, false, "number");
		}
	}

	private renderInteractions(parent: HTMLElement): void {
		const details = parent.createEl("details", {cls: "rpg-audio-interactions"});
		details.open = this.interactionsOpen;
		details.addEventListener("toggle", () => { this.interactionsOpen = details.open; });
		details.createEl("summary", {text: "Interactions"});
		details.createDiv({cls: "setting-item-description", text: "Advanced cross-track actions triggered when this block starts."});
		this.csvSetting(details, "scope", "Scope", "Context labels; starting this block stops tracks in other active scopes.", this.state.scope, value => { this.state.scope = value; });
		this.csvSetting(details, "stops", "Stops", "Track IDs or types to stop immediately.", this.state.stops, value => { this.state.stops = value; });
		this.csvSetting(details, "fadesout", "Fades out", "Track IDs or types to fade using their own fade-out duration.", this.state.fadesout, value => { this.state.fadesout = value; });
		this.csvSetting(details, "pauses", "Pauses", "Track IDs or types to pause.", this.state.pauses, value => { this.state.pauses = value; });
		this.csvSetting(details, "resumes", "Resumes", "Track IDs or types to resume.", this.state.resumes, value => { this.state.resumes = value; });
	}

	private renderCodePreview(parent: HTMLElement): void {
		const details = parent.createEl("details", {cls: "rpg-audio-code-preview"});
		details.open = this.codeOpen;
		details.addEventListener("toggle", () => { this.codeOpen = details.open; });
		details.createEl("summary", {text: "View code"});
		this.previewEl = details.createEl("pre");
	}

	private renderFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({cls: "rpg-audio-block-editor-footer"});
		const status = footer.createDiv({cls: "rpg-audio-validation-status", attr: {"aria-live": "polite"}});
		status.dataset.audioField = "source";
		this.summaryEl = status.createDiv({cls: "rpg-audio-validation-summary"});
		this.errorEl(status, "source");
		const actions = footer.createDiv({cls: "rpg-audio-block-editor-actions"});
		const cancel = actions.createEl("button", {text: "Cancel"});
		cancel.addEventListener("click", () => this.close());
		this.saveButton = actions.createEl("button", {
			text: this.options.mode === "edit" ? "Save changes" : "Add block",
			cls: "mod-cta",
		});
		this.saveButton.addEventListener("click", () => { void this.save(); });
	}

	private textSetting(
		parent: HTMLElement,
		field: string,
		name: string,
		description: string,
		value: string,
		placeholder: string,
		onInput: (value: string) => void,
		disabled = false,
		type: "text" | "number" = "text",
	): void {
		const setting = new Setting(parent).setName(name).setDesc(description);
		setting.settingEl.dataset.audioField = field;
		setting.addText(text => {
			text.setValue(value).setPlaceholder(placeholder).setDisabled(disabled);
			text.inputEl.type = type;
			if (type === "number") text.inputEl.step = "any";
			text.onChange(next => {
				onInput(next);
				this.markChanged(field);
			});
		});
		this.errorEl(parent, field);
	}

	private toggleSetting(parent: HTMLElement, field: string, name: string, description: string, value: boolean, onChange: (value: boolean) => void, disabled = false): void {
		const setting = new Setting(parent).setName(name).setDesc(description);
		setting.settingEl.dataset.audioField = field;
		setting.addToggle(toggle => toggle.setValue(value).setDisabled(disabled).onChange(next => {
			onChange(next);
			this.markChanged(field);
		}));
	}

	private choiceSetting(parent: HTMLElement, field: string, name: string, description: string, value: string, disabled: boolean, onChange: (value: string) => void): void {
		const setting = new Setting(parent).setName(name).setDesc(description);
		setting.settingEl.dataset.audioField = field;
		const group = setting.controlEl.createDiv({cls: "rpg-audio-segmented", attr: {role: "group", "aria-label": name}});
		for (const [option, label] of [["inherit", "Use plugin default"], ["custom", "Custom"]] as const) {
			const button = group.createEl("button", {text: label, cls: option === value ? "is-selected" : ""});
			button.disabled = disabled;
			button.setAttribute("aria-pressed", String(option === value));
			button.addEventListener("click", () => {
				onChange(option);
				this.markChanged(field);
			});
		}
	}

	private boundarySetting(parent: HTMLElement, entryKey: string, boundary: "start" | "end", name: string, value: BoundaryInput, disabled: boolean, onChange: (value: BoundaryInput) => void): void {
		const setting = new Setting(parent).setName(name);
		setting.settingEl.dataset.audioField = `entry-${entryKey}`;
		setting.addDropdown(dropdown => dropdown
			.addOption("inherit", "Inherit block")
			.addOption("none", "No boundary")
			.addOption("value", "Custom")
			.setValue(value.mode)
			.setDisabled(disabled)
			.onChange(mode => {
				onChange(mode === "value" ? {mode: "value", value: ""} : mode === "none" ? {mode: "none"} : {mode: "inherit"});
				this.markChanged(`entry-${entryKey}`);
				this.rerender();
			}));
		if (value.mode === "value") {
			setting.addText(text => text.setValue(value.value).setPlaceholder(boundary === "start" ? "0:30" : "2:00").setDisabled(disabled).onChange(next => {
				onChange({mode: "value", value: next});
				this.markChanged(`entry-${entryKey}`);
			}));
		}
	}

	private csvSetting(parent: HTMLElement, field: string, name: string, description: string, value: string[], onChange: (value: string[]) => void): void {
		this.textSetting(parent, field, name, description, value.join(", "), "music, ambience", next => {
			onChange(next.split(",").map(item => item.trim()).filter(Boolean));
		});
	}

	private errorEl(parent: HTMLElement, field: string): void {
		if (this.contentEl.querySelector(`.rpg-audio-field-error[data-error-for="${field}"]`)) return;
		parent.createDiv({
			cls: "rpg-audio-field-error",
			attr: {
				id: `rpg-audio-field-error-${field}`,
				"data-error-for": field,
			},
		});
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, disabled: boolean, action: () => void): void {
		const button = parent.createEl("button", {cls: "clickable-icon", attr: {"aria-label": label, title: label}});
		button.disabled = disabled;
		setIcon(button, icon);
		button.addEventListener("click", action);
	}

	private markChanged(field: string): void {
		this.dirty = true;
		this.touched.add(field);
		this.saveIssue = "";
		this.refreshValidation();
	}

	private validation(): AudioBlockValidationResult {
		return validateAudioBlockForm(this.state, {
			parserDefaults: this.options.parserDefaults,
			duplicateIds: this.options.duplicateIds,
			isFileAvailable: path => this.fileAvailable(path),
			hydrationIssues: [...(this.options.hydrationIssues ?? []), ...(this.saveIssue ? [this.saveIssue] : [])],
		});
	}

	private refreshValidation(): void {
		const result = this.validation();
		for (const element of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-error-for]"))) {
			const field = element.dataset.errorFor ?? "";
			const messages = result.fieldErrors[field] ?? [];
			element.setText(messages.join(" "));
			element.toggleClass("is-visible", messages.length > 0);
		}
		for (const fieldContainer of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-audio-field]"))) {
			const field = fieldContainer.dataset.audioField ?? "";
			const error = this.contentEl.querySelector<HTMLElement>(`.rpg-audio-field-error[data-error-for="${field}"]`);
			const invalid = (result.fieldErrors[field]?.length ?? 0) > 0;
			fieldContainer.toggleClass("has-error", invalid);
			if (invalid && error) fieldContainer.setAttribute("aria-describedby", error.id);
			else fieldContainer.removeAttribute("aria-describedby");
			const controls = Array.from(fieldContainer.querySelectorAll<HTMLElement>("input, select, textarea"))
				.filter(control => control.closest("[data-audio-field]") === fieldContainer);
			for (const control of controls) {
				if (invalid) control.setAttribute("aria-invalid", "true");
				else control.removeAttribute("aria-invalid");
				const describedBy = new Set((control.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean));
				if (invalid && error) describedBy.add(error.id);
				else if (error) describedBy.delete(error.id);
				if (describedBy.size > 0) control.setAttribute("aria-describedby", Array.from(describedBy).join(" "));
				else control.removeAttribute("aria-describedby");
			}
		}
		if (this.previewEl) this.previewEl.setText(result.serialized);
		if (this.saveButton) this.saveButton.disabled = !result.valid || this.saving;
		if (this.summaryEl) {
			if (result.valid) {
				this.summaryEl.setText(this.saving ? "Saving audio block…" : "Ready to save.");
				this.summaryEl.removeClass("is-error");
			} else if (!this.submitted && this.touched.size === 0 && this.options.mode === "add") {
				this.summaryEl.setText("Complete the required fields to add this block.");
				this.summaryEl.removeClass("is-error");
			} else {
				this.summaryEl.setText(`${result.errors.length} issue${result.errors.length === 1 ? "" : "s"} must be fixed before saving.`);
				this.summaryEl.addClass("is-error");
			}
		}
	}

	private fileAvailable(path: string): boolean {
		return !!findAudioFile(this.app.vault, this.options.audioFolder, path);
	}

	private openAddFiles(): void {
		new AudioFilePickerModal(this.app, {
			audioFolder: this.options.audioFolder,
			onChoose: paths => {
				for (const path of paths) this.state.entries.push(createAudioFileDraft(path));
				this.markChanged("files");
				this.rerender();
			},
		}).open();
	}

	private replaceEntry(index: number): void {
		new AudioFilePickerModal(this.app, {
			audioFolder: this.options.audioFolder,
			multiple: false,
			onChoose: paths => {
				const entry = this.state.entries[index];
				const path = paths[0];
				if (entry && path) entry.path = path;
				this.markChanged(`entry-${entry?.key ?? index}`);
				this.rerender();
			},
		}).open();
	}

	private moveEntry(from: number, to: number): void {
		if (to < 0 || to >= this.state.entries.length) return;
		const [entry] = this.state.entries.splice(from, 1);
		if (!entry) return;
		this.state.entries.splice(to, 0, entry);
		this.markChanged("files");
		this.rerender();
	}

	private async save(): Promise<void> {
		if (this.saving) return;
		this.submitted = true;
		const validation = this.validation();
		if (!validation.valid) {
			this.refreshValidation();
			return;
		}
		this.saving = true;
		this.refreshValidation();
		try {
			await this.persistSelectedCustomType();
			const result = await this.options.onSave(validation.serialized);
			if (!result.ok) {
				this.saveIssue = result.message ?? "The source changed while this editor was open. Reopen the block and review the latest source.";
				this.saving = false;
				this.rerender();
				return;
			}
			this.allowClose = true;
			this.dirty = false;
			super.close();
		} catch (error) {
			this.saveIssue = error instanceof Error ? error.message : "The audio block could not be saved.";
			this.saving = false;
			this.rerender();
		}
	}
}
