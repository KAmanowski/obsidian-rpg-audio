import { Plugin } from "obsidian";
import { normalizeRpgAudioSettings, RpgAudioSettings, RpgAudioSettingTab } from "./settings";
import { AudioManager } from "./audio-manager";
import { SIDEBAR_VIEW_TYPE } from "./types";
import { parseAudioBlockDetailed } from "./audio-block-parser";
import { getAudioBlockErrors } from "./audio-block-validation";
import { renderAudioBlockErrors, RpgAudioCodeBlockPlayer } from "./ui/code-block-player";
import { RpgAudioSidebarView } from "./ui/sidebar-view";
import { setCustomPresets, getDefaultWetLevel } from "./reverb-engine";
import { openRenderedAudioBlockEditor, registerAudioBlockCommands } from "./commands/audio-block-commands";

export default class RpgAudioPlugin extends Plugin {
	settings: RpgAudioSettings;
	audioManager: AudioManager;

	async onload() {
		await this.loadSettings();

		this.audioManager = new AudioManager(this.app);
		this.audioManager.masterVolume = this.settings.masterVolume;
		this.audioManager.audioFolder = this.settings.audioFolder;
		this.audioManager.crossfadeDuration = this.settings.crossfadeDuration;
		this.audioManager.playFadeDuration = this.settings.playFadeDuration;
		this.audioManager.allowAutoplay = this.settings.allowAutoplay;
		this.audioManager.autoplayDelay = this.settings.autoplayDelay;
		setCustomPresets(this.settings.customReverbPresets);
		this.audioManager.limiterEnabled = this.settings.reverbLimiter;
		this.audioManager.reverbPreset = this.settings.reverbPreset;
		this.audioManager.reverbWet =
			this.settings.reverbWetByPreset[this.settings.reverbPreset] ?? getDefaultWetLevel(this.settings.reverbPreset);

		this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new RpgAudioSidebarView(leaf, this));

		this.registerMarkdownCodeBlockProcessor("rpg-audio", (source, el, ctx) => {
			const editBlock = () => {
				void openRenderedAudioBlockEditor(this, el, ctx, source);
			};
			const result = parseAudioBlockDetailed(source, {
				playlistCrossfadeDuration: this.settings.defaultPlaylistCrossfade,
				volumeFadeTarget: this.settings.defaultVolumeFadeTarget,
				volumeFadeDuration: this.settings.defaultVolumeFadeDuration,
			});
			const missingFiles = this.settings.validateAudioBlocks && result.def
				? this.audioManager.getMissingAudioFiles(result.def.entries.map(entry => entry.path))
				: [];
			const errors = getAudioBlockErrors(result, missingFiles, this.settings.validateAudioBlocks);
			if (!result.def || errors.length > 0) {
				renderAudioBlockErrors(el, errors, editBlock);
				return;
			}
			const player = new RpgAudioCodeBlockPlayer(el, this.audioManager, result.def, editBlock);
			ctx.addChild(player);
		});

		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.addRibbonIcon("music", "RPG Audio", () => {
			void this.toggleSidebar();
		});

		this.addCommand({
			id: "toggle-sidebar",
			name: "Toggle audio sidebar",
			callback: () => this.toggleSidebar(),
		});

		this.addCommand({
			id: "stop-all",
			name: "Stop all audio",
			callback: () => this.audioManager.stopAll(),
		});

		registerAudioBlockCommands(this);

		this.addSettingTab(new RpgAudioSettingTab(this.app, this));

		if (this.settings.autoOpenSidebar) {
			this.app.workspace.onLayoutReady(() => this.activateSidebar());
		}
	}

	onunload() {
		this.audioManager.destroyAll();
	}

	async loadSettings() {
		this.settings = normalizeRpgAudioSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async toggleSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (existing.length > 0) {
			const first = existing[0];
			if (first) first.detach();
		} else {
			await this.activateSidebar();
		}
	}

	private async activateSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		const first = existing[0];
		if (first) {
			await this.app.workspace.revealLeaf(first);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
			await this.app.workspace.revealLeaf(leaf);
		}
	}
}
