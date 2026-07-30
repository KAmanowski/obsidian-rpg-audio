import {App, PluginSettingTab, Setting} from "obsidian";
import type RpgAudioPlugin from "./main";
import {
	ReverbPreset,
	REVERB_PRESETS,
	REVERB_OFF,
	getPreset,
	getAllPresets,
	isBuiltin,
	isOverridden,
	setCustomPresets,
} from "./reverb-engine";

export interface RpgAudioSettings {
	audioFolder: string;
	masterVolume: number;
	autoOpenSidebar: boolean;
	allowAutoplay: boolean;
	autoplayDelay: number;
	crossfadeDuration: number;
	playFadeDuration: number;
	showDebugInfo: boolean;
	reverbPreset: string;
	reverbWet: number;
	/** Per-preset wet level, keyed by preset id, so switching presets recalls the last level used with it. */
	reverbWetByPreset: Record<string, number>;
	reverbLimiter: boolean;
	customReverbPresets: ReverbPreset[];
}

export const DEFAULT_SETTINGS: RpgAudioSettings = {
	audioFolder: "audio",
	masterVolume: 1.0,
	autoOpenSidebar: true,
	allowAutoplay: false,
	autoplayDelay: 0,
	crossfadeDuration: 2000,
	playFadeDuration: 0,
	showDebugInfo: false,
	reverbPreset: "dry",
	reverbWet: 0.35,
	reverbWetByPreset: {},
	reverbLimiter: true,
	customReverbPresets: [],
};

export class RpgAudioSettingTab extends PluginSettingTab {
	plugin: RpgAudioPlugin;
	private editingPresetId: string = REVERB_PRESETS[0]?.id ?? "";
	private refreshTimer: number | null = null;

	constructor(app: App, plugin: RpgAudioPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/**
	 * Synthesis costs 10–20 ms and slider drags fire continuously, so re-synthesizing
	 * on every tick would stutter playback badly.
	 */
	private scheduleReverbRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			setCustomPresets(this.plugin.settings.customReverbPresets);
			this.plugin.audioManager.refreshReverb();
			this.plugin.audioManager.notifyPresetsChanged();
			void this.plugin.saveSettings();
		}, 200);
	}

	private getWetForPreset(id: string): number {
		return this.plugin.settings.reverbWetByPreset[id] ?? this.plugin.settings.reverbWet;
	}

	private async setWetForPreset(id: string, value: number): Promise<void> {
		this.plugin.settings.reverbWetByPreset[id] = value;
		this.plugin.audioManager.reverbWet = value;
		await this.plugin.saveSettings();
	}

	/** Editing a built-in forks it into a custom override first. */
	private mutateEditedPreset(apply: (p: ReverbPreset) => void): void {
		const list = this.plugin.settings.customReverbPresets;
		let target = list.find(p => p.id === this.editingPresetId);
		if (!target) {
			const base = getPreset(this.editingPresetId);
			if (!base) return;
			target = {...base};
			list.push(target);
		}
		apply(target);
		this.scheduleReverbRefresh();
	}

	private addPresetSlider(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		min: number,
		max: number,
		step: number,
		get: (p: ReverbPreset) => number,
		set: (p: ReverbPreset, v: number) => void,
	): void {
		const preset = getPreset(this.editingPresetId);
		if (!preset) return;
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addSlider(slider => slider
				.setLimits(min, max, step)
				.setValue(get(preset))
				.setDynamicTooltip()
				.onChange((value) => {
					this.mutateEditedPreset(p => set(p, value));
				}));
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Audio folder")
			.setDesc("Vault-relative folder where audio files are stored")
			.addText(text => text
				.setPlaceholder("Audio")
				.setValue(this.plugin.settings.audioFolder)
				.onChange(async (value) => {
					this.plugin.settings.audioFolder = value;
					this.plugin.audioManager.audioFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Master volume")
			.setDesc("Global volume multiplier for all tracks")
			.addSlider(slider => slider
				.setLimits(0, 1, 0.01)
				.setValue(this.plugin.settings.masterVolume)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.masterVolume = value;
					this.plugin.audioManager.masterVolume = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Auto-open sidebar")
			.setDesc("Automatically open the audio sidebar when the plugin loads")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoOpenSidebar)
				.onChange(async (value) => {
					this.plugin.settings.autoOpenSidebar = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Autoplay delay")
			.setDesc("Delay before an autoplay track starts. If the track unloads during the delay, for example when a hover popover is dismissed, playback is cancelled. Set to 0 for instant autoplay.")
			.addSlider(slider => slider
				.setLimits(0, 2000, 50)
				.setValue(this.plugin.settings.autoplayDelay)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.autoplayDelay = value;
					this.plugin.audioManager.autoplayDelay = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Crossfade duration")
			.setDesc("Duration of crossfade between exclusive tracks. Set to 0 to disable.")
			.addSlider(slider => slider
				.setLimits(0, 5000, 100)
				.setValue(this.plugin.settings.crossfadeDuration)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.crossfadeDuration = value;
					this.plugin.audioManager.crossfadeDuration = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Play fade duration")
			.setDesc("Fade in when starting or resuming a track and fade out when pausing. Set to 0 for instant transitions.")
			.addSlider(slider => slider
				.setLimits(0, 5000, 100)
				.setValue(this.plugin.settings.playFadeDuration)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.playFadeDuration = value;
					this.plugin.audioManager.playFadeDuration = value;
					await this.plugin.saveSettings();
				}));

		this.displayReverb(containerEl);
	}

	private displayReverb(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Reverb").setHeading();

		new Setting(containerEl)
			.setName("Reverb space")
			.setDesc("Acoustic space applied to all tracks")
			.addDropdown(drop => {
				drop.addOption(REVERB_OFF, "No reverb");
				for (const p of getAllPresets()) drop.addOption(p.id, p.name);
				drop.setValue(this.plugin.settings.reverbPreset);
				drop.onChange(async (value) => {
					this.plugin.settings.reverbPreset = value;
					this.plugin.audioManager.reverbPreset = value;
					this.plugin.audioManager.reverbWet = this.getWetForPreset(value);
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("Wet level")
			.setDesc("How much reverb is mixed in — remembered separately for each space")
			.addSlider(slider => slider
				.setLimits(0, 1, 0.01)
				.setValue(this.getWetForPreset(this.plugin.settings.reverbPreset))
				.setDynamicTooltip()
				.onChange((value) => {
					void this.setWetForPreset(this.plugin.settings.reverbPreset, value);
				}));

		new Setting(containerEl)
			.setName("Safety limiter")
			.setDesc("Catches peaks so loud material does not clip when reverb is added. Disable only if you hear pumping.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.reverbLimiter)
				.onChange(async (value) => {
					this.plugin.settings.reverbLimiter = value;
					this.plugin.audioManager.limiterEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName("Reverb preset editor").setHeading();

		const editing = getPreset(this.editingPresetId);

		new Setting(containerEl)
			.setName("Editing")
			.setDesc("Preset to modify. Editing a built-in creates a custom override you can reset.")
			.addDropdown(drop => {
				for (const p of getAllPresets()) drop.addOption(p.id, p.name);
				drop.setValue(this.editingPresetId);
				drop.onChange((value) => {
					this.editingPresetId = value;
					this.display();
				});
			})
			.addButton(btn => btn
				.setButtonText("New")
				.onClick(async () => {
					const base = getPreset(this.editingPresetId);
					if (!base) return;
					const created: ReverbPreset = {...base, id: `custom-${Date.now()}`, name: "New space"};
					this.plugin.settings.customReverbPresets.push(created);
					this.editingPresetId = created.id;
					setCustomPresets(this.plugin.settings.customReverbPresets);
					this.plugin.audioManager.notifyPresetsChanged();
					await this.plugin.saveSettings();
					this.display();
				}));

		if (!editing) return;

		if (isOverridden(this.editingPresetId)) {
			new Setting(containerEl)
				.setName("Reset to default")
				.setDesc("Discard your changes to this built-in preset")
				.addButton(btn => btn
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.customReverbPresets =
							this.plugin.settings.customReverbPresets.filter(p => p.id !== this.editingPresetId);
						setCustomPresets(this.plugin.settings.customReverbPresets);
						this.plugin.audioManager.refreshReverb();
						this.plugin.audioManager.notifyPresetsChanged();
						await this.plugin.saveSettings();
						this.display();
					}));
		} else if (!isBuiltin(this.editingPresetId)) {
			new Setting(containerEl)
				.setName("Delete preset")
				.setDesc("Permanently remove this custom preset")
				.addButton(btn => btn
					.setButtonText("Delete")
					.setWarning()
					.onClick(async () => {
						const removed = this.editingPresetId;
						this.plugin.settings.customReverbPresets =
							this.plugin.settings.customReverbPresets.filter(p => p.id !== removed);
						this.editingPresetId = REVERB_PRESETS[0]?.id ?? "";
						if (this.plugin.settings.reverbPreset === removed) {
							this.plugin.settings.reverbPreset = REVERB_OFF;
							this.plugin.audioManager.reverbPreset = REVERB_OFF;
						}
						setCustomPresets(this.plugin.settings.customReverbPresets);
						this.plugin.audioManager.notifyPresetsChanged();
						await this.plugin.saveSettings();
						this.display();
					}));
		}

		new Setting(containerEl)
			.setName("Name")
			.setDesc("Display name for this preset")
			.addText(text => text
				.setValue(editing.name)
				.onChange((value) => {
					this.mutateEditedPreset(p => { p.name = value; });
				}));

		this.addPresetSlider(containerEl, "Decay", "Length of the reverb tail, in seconds",
			0.1, 8, 0.1, p => p.decaySecs, (p, v) => { p.decaySecs = v; });

		this.addPresetSlider(containerEl, "Pre-delay", "Gap before the reverb starts, in milliseconds",
			0, 150, 1, p => p.preDelayMs, (p, v) => { p.preDelayMs = v; });

		this.addPresetSlider(containerEl, "Damping", "How quickly high frequencies fade from the tail",
			0, 1, 0.01, p => p.damping, (p, v) => { p.damping = v; });

		this.addPresetSlider(containerEl, "Diffusion", "Stereo width of the tail. Lower values collapse toward mono.",
			0, 1, 0.01, p => p.diffusion, (p, v) => { p.diffusion = v; });

		this.addPresetSlider(containerEl, "Early reflections", "Number of distinct early echoes",
			0, 40, 1, p => p.earlyReflections, (p, v) => { p.earlyReflections = v; });

		this.addPresetSlider(containerEl, "Early level", "Loudness of the early echoes relative to the tail",
			0, 1, 0.01, p => p.earlyLevel, (p, v) => { p.earlyLevel = v; });

		this.addPresetSlider(containerEl, "Early spread", "Window the early echoes land in, in milliseconds. Shorter sounds like a smaller room.",
			5, 200, 1, p => p.erSpreadMs ?? 80, (p, v) => { p.erSpreadMs = v; });

		this.addPresetSlider(containerEl, "Low cut", "Keeps bass out of the reverb, in hertz. Raise this if low end sounds muddy or distorted.",
			20, 800, 10, p => p.hpfHz, (p, v) => { p.hpfHz = v; });

		this.addPresetSlider(containerEl, "High cut", "Rolls off the top of the reverb, in hertz. Lower values sound darker and more distant.",
			1000, 16000, 100, p => p.lpfHz, (p, v) => { p.lpfHz = v; });

		this.addPresetSlider(containerEl, "Wet trim", "Output level for this preset, used to match it against the others",
			0, 2, 0.01, p => p.wetTrim, (p, v) => { p.wetTrim = v; });
	}
}
