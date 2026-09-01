import {
	Editor,
	FuzzySuggestModal,
	MarkdownFileInfo,
	MarkdownPostProcessorContext,
	MarkdownView,
	Menu,
	Notice,
	TFile,
} from "obsidian";
import type RpgAudioPlugin from "../main";
import {AudioBlockDefaults, parseAudioBlockDetailed} from "../audio-block-parser";
import {
	AudioBlockAuthoringDefaults,
	createAudioBlockFormState,
	hydrateAudioBlockForm,
} from "../audio-block-form";
import {
	AudioBlockFence,
	collectAudioBlockIds,
	findAudioBlockAtSelection,
	findRenderedAudioBlock,
	findRenderedAudioBlockCandidates,
	formatAudioBlockForFence,
	formatAudioBlockInsertion,
} from "../audio-block-source";
import {AudioBlockTypeDefinition, upsertCustomAudioBlockType} from "../audio-block-types";
import {AudioBlockModal} from "../ui/audio-block-modal";

function sourceContextLabel(source: string, block: AudioBlockFence): string {
	const lines = source.split(/\r?\n/);
	for (let index = block.startLine - 1; index >= Math.max(0, block.startLine - 80); index--) {
		const line = lines[index]?.trim() ?? "";
		const heading = line.match(/^#{1,6}\s+(.+)$/);
		if (heading?.[1]) return `Line ${block.startLine + 1} — ${heading[1]}`;
		const callout = line.match(/^>\s*\[![^\]]+\][+-]?\s*(.*)$/);
		if (callout?.[1]) return `Line ${block.startLine + 1} — ${callout[1].replace(/^\*\*|\*\*$/g, "")}`;
	}
	return `Line ${block.startLine + 1}`;
}

class AudioBlockSourceModal extends FuzzySuggestModal<AudioBlockFence> {
	constructor(
		plugin: RpgAudioPlugin,
		private readonly source: string,
		private readonly blocks: AudioBlockFence[],
		private readonly onChoose: (block: AudioBlockFence) => void,
	) {
		super(plugin.app);
		this.setPlaceholder("Choose the matching location…");
	}

	getItems(): AudioBlockFence[] {
		return this.blocks;
	}

	getItemText(block: AudioBlockFence): string {
		return sourceContextLabel(this.source, block);
	}

	onChooseItem(block: AudioBlockFence): void {
		this.onChoose(block);
	}
}

function parserDefaults(plugin: RpgAudioPlugin): AudioBlockDefaults {
	return {
		playlistCrossfadeDuration: plugin.settings.defaultPlaylistCrossfade,
		volumeFadeTarget: plugin.settings.defaultVolumeFadeTarget,
		volumeFadeDuration: plugin.settings.defaultVolumeFadeDuration,
	};
}

function authoringDefaults(plugin: RpgAudioPlugin): AudioBlockAuthoringDefaults {
	return {
		type: plugin.settings.defaultAudioBlockType,
		loop: plugin.settings.defaultAudioBlockLoop,
		random: plugin.settings.defaultAudioBlockRandom,
		autoplay: plugin.settings.defaultAudioBlockAutoplay,
		playlistEndAction: plugin.settings.defaultAudioBlockPlaylistEndAction,
		fadeInDuration: plugin.settings.defaultAudioBlockFadeIn,
		fadeOutDuration: plugin.settings.defaultAudioBlockFadeOut,
		volume: plugin.settings.defaultAudioBlockVolume,
	};
}

function selectedOffsets(editor: Editor): {from: number; to: number} {
	return {
		from: editor.posToOffset(editor.getCursor("from")),
		to: editor.posToOffset(editor.getCursor("to")),
	};
}

function serializedId(source: string): string {
	const body = source.replace(/^```rpg-audio\s*\r?\n/i, "").replace(/\r?\n```\s*$/, "");
	return parseAudioBlockDetailed(body).def?.id ?? "";
}

async function saveCustomAudioBlockType(
	plugin: RpgAudioPlugin,
	definition: AudioBlockTypeDefinition,
	previousName?: string,
): Promise<void> {
	plugin.settings.customAudioBlockTypes = upsertCustomAudioBlockType(
		plugin.settings.customAudioBlockTypes,
		definition,
		previousName,
	);
	if (previousName && plugin.settings.defaultAudioBlockType.toLocaleLowerCase("en") === previousName.toLocaleLowerCase("en")) {
		plugin.settings.defaultAudioBlockType = definition.name;
	}
	await plugin.saveSettings();
}

function openEditorModal(
	plugin: RpgAudioPlugin,
	editor: Editor,
	mode: "add" | "edit",
	block: AudioBlockFence | null,
): void {
	const initialSource = editor.getValue();
	const offsets = selectedOffsets(editor);
	const insertionOffset = offsets.to;
	const defaults = parserDefaults(plugin);
	const hydrated = block
		? hydrateAudioBlockForm(block.body, defaults, authoringDefaults(plugin))
		: {state: createAudioBlockFormState(authoringDefaults(plugin)), issues: []};
	const duplicateIds = collectAudioBlockIds(initialSource, block ?? undefined);

	new AudioBlockModal(plugin.app, {
		mode,
		state: hydrated.state,
		audioFolder: plugin.settings.audioFolder,
		parserDefaults: defaults,
		duplicateIds,
		hydrationIssues: hydrated.issues,
		customTypes: plugin.settings.customAudioBlockTypes,
		onSaveCustomType: (definition, previousName) => saveCustomAudioBlockType(plugin, definition, previousName),
		onSave: source => {
			const current = editor.getValue();
			if (block) {
				if (current.slice(block.startOffset, block.endOffset) !== block.source) {
					return {ok: false, message: "The source changed while this editor was open. Close and reopen the audio block to review the latest version."};
				}
				const currentBlock = findAudioBlockAtSelection(current, block.startOffset);
				const id = serializedId(source);
				if (id && collectAudioBlockIds(current, currentBlock ?? undefined).includes(id)) {
					return {ok: false, message: "Another audio block in this note now uses the same ID."};
				}
				editor.replaceRange(formatAudioBlockForFence(block, source), editor.offsetToPos(block.startOffset), editor.offsetToPos(block.endOffset));
				return {ok: true};
			}

			const id = serializedId(source);
			if (id && collectAudioBlockIds(current).includes(id)) {
				return {ok: false, message: "Another audio block in this note now uses the same ID."};
			}
			const safeOffset = Math.min(insertionOffset, current.length);
			editor.replaceRange(formatAudioBlockInsertion(current, safeOffset, source), editor.offsetToPos(safeOffset));
			return {ok: true};
		},
	}).open();
}

function blockAtEditorSelection(editor: Editor): AudioBlockFence | null {
	const source = editor.getValue();
	const offsets = selectedOffsets(editor);
	return findAudioBlockAtSelection(source, offsets.from, offsets.to);
}

export function registerAudioBlockCommands(plugin: RpgAudioPlugin): void {
	plugin.addCommand({
		id: "insert-track",
		name: "Add audio block",
		editorCallback: editor => openEditorModal(plugin, editor, "add", null),
	});

	plugin.addCommand({
		id: "edit-audio-block",
		name: "Edit audio block",
		editorCheckCallback: (checking, editor) => {
			const block = blockAtEditorSelection(editor);
			if (!block) return false;
			if (!checking) openEditorModal(plugin, editor, "edit", block);
			return true;
		},
	});

	plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
		const block = blockAtEditorSelection(editor);
		menu.addItem(item => item
			.setTitle(block ? "Edit audio block…" : "Add audio block…")
			.setIcon(block ? "pencil" : "music")
			.onClick(() => openEditorModal(plugin, editor, block ? "edit" : "add", block)));
	}));
}

export async function openRenderedAudioBlockEditor(
	plugin: RpgAudioPlugin,
	element: HTMLElement,
	context: MarkdownPostProcessorContext,
	renderedSource: string,
): Promise<void> {
	const section = context.getSectionInfo(element);
	const file = plugin.app.vault.getFileByPath(context.sourcePath);
	if (!(file instanceof TFile)) {
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- RPG Audio is the plugin name.
		new Notice("RPG Audio could not open the source note for this block.");
		return;
	}
	const initialSource = await plugin.app.vault.cachedRead(file);
	const block = findRenderedAudioBlock(initialSource, renderedSource, section);
	if (block) {
		openRenderedBlockModal(plugin, file, initialSource, block);
		return;
	}
	const candidates = findRenderedAudioBlockCandidates(initialSource, renderedSource);
	if (candidates.length > 1) {
		new AudioBlockSourceModal(plugin, initialSource, candidates, chosen => {
			openRenderedBlockModal(plugin, file, initialSource, chosen);
		}).open();
		return;
	}
	if (candidates.length === 1) {
		const candidate = candidates[0];
		if (candidate) openRenderedBlockModal(plugin, file, initialSource, candidate);
		return;
	}
	if (!block) {
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- RPG Audio is the plugin name.
		new Notice("RPG Audio could not safely identify this block's source. Open the source note and edit it there.");
	}
	return;
}

function openRenderedBlockModal(
	plugin: RpgAudioPlugin,
	file: TFile,
	initialSource: string,
	block: AudioBlockFence,
): void {
	const defaults = parserDefaults(plugin);
	const hydrated = hydrateAudioBlockForm(block.body, defaults, authoringDefaults(plugin));
	new AudioBlockModal(plugin.app, {
		mode: "edit",
		state: hydrated.state,
		audioFolder: plugin.settings.audioFolder,
		parserDefaults: defaults,
		duplicateIds: collectAudioBlockIds(initialSource, block),
		hydrationIssues: hydrated.issues,
		customTypes: plugin.settings.customAudioBlockTypes,
		onSaveCustomType: (definition, previousName) => saveCustomAudioBlockType(plugin, definition, previousName),
		onSave: async source => {
			let conflict = "";
			await plugin.app.vault.process(file, current => {
				if (current.slice(block.startOffset, block.endOffset) !== block.source) {
					conflict = "The source changed while this editor was open. Close and reopen the audio block to review the latest version.";
					return current;
				}
				const currentBlock = findAudioBlockAtSelection(current, block.startOffset);
				const id = serializedId(source);
				if (id && collectAudioBlockIds(current, currentBlock ?? undefined).includes(id)) {
					conflict = "Another audio block in this note now uses the same ID.";
					return current;
				}
				return current.slice(0, block.startOffset) + formatAudioBlockForFence(block, source) + current.slice(block.endOffset);
			});
			return conflict ? {ok: false, message: conflict} : {ok: true};
		},
	}).open();
}

// Keep these imports exercised by the command signature across Obsidian API variants.
export type AudioBlockEditorContext = MarkdownView | MarkdownFileInfo;
