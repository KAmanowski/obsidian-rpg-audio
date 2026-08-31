import {App, PluginSettingTab, Setting} from "obsidian";
import type RpgAudioPlugin from "./main";
import {
	ReverbPreset,
	REVERB_PRESETS,
	REVERB_OFF,
	getPreset,
	getAllPresets,
	getDefaultWetLevel,
	isBuiltin,
	isOverridden,
	setCustomPresets,
} from "./reverb-engine";

export interface RpgAudioSettings {
	audioFolder: string;
	validateAudioBlocks: boolean;
	masterVolume: number;
	autoOpenSidebar: boolean;
	allowAutoplay: boolean;
	autoplayDelay: number;
	crossfadeDuration: number;
	playFadeDuration: number;
	/** Default playlist crossfade applied to blocks that omit "crossfade", in seconds. Zero disables it. */
	defaultPlaylistCrossfade: number;
	/** Default volume fade target applied to blocks that omit "volume-fade-to", from 0 to 1. */
	defaultVolumeFadeTarget: number;
	/** Default volume fade duration applied to blocks that omit "volume-fade-duration", in seconds. Zero disables the fade. */
	defaultVolumeFadeDuration: number;
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
	validateAudioBlocks: true,
	masterVolume: 1.0,
	autoOpenSidebar: true,
	allowAutoplay: false,
	autoplayDelay: 0,
	crossfadeDuration: 2000,
	playFadeDuration: 0,
	defaultPlaylistCrossfade: 0,
	defaultVolumeFadeTarget: 0.5,
	defaultVolumeFadeDuration: 0,
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
		return this.plugin.settings.reverbWetByPreset[id] ?? getDefaultWetLevel(id);
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
			.setDesc("Folder path, relative to the vault root, checked for audio files whose block paths do not already resolve from the vault root, for example \"audio\" or \"assets/sound\".")
			.addText(text => text
				.setPlaceholder("Audio")
				.setValue(this.plugin.settings.audioFolder)
				.onChange(async (value) => {
					this.plugin.settings.audioFolder = value;
					this.plugin.audioManager.audioFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Validate audio blocks")
			.setDesc("When enabled, checks every setting and file path in a code block before creating a player, blocking the block with a red error panel if a problem is found. When disabled, only the structurally required identifier, name, and file settings are enforced.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.validateAudioBlocks)
				.onChange(async (value) => {
					this.plugin.settings.validateAudioBlocks = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Master volume")
			.setDesc("Global volume multiplier applied on top of every track's own volume, from 0 (silent) to 1 (full, unitless).")
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
			.setDesc("Automatically open the audio sidebar panel in the right side dock when the plugin loads.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoOpenSidebar)
				.onChange(async (value) => {
					this.plugin.settings.autoOpenSidebar = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Autoplay delay")
			.setDesc("Time to wait before an autoplay track starts, in milliseconds (0-2000ms). If the track unloads during the delay, for example when a hover popover is dismissed, playback is cancelled. Set to 0 for instant autoplay.")
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
			.setDesc("Duration of the crossfade between exclusive tracks, in milliseconds (0-5000ms), for example when a scope transition or directive stops one track while starting another. Set to 0 to disable crossfading and use hard stops.")
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
			.setDesc("Duration, in milliseconds (0-5000ms), of the fade applied when starting or resuming a track and the fade applied when pausing one. Set to 0 for instant transitions.")
			.addSlider(slider => slider
				.setLimits(0, 5000, 100)
				.setValue(this.plugin.settings.playFadeDuration)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.playFadeDuration = value;
					this.plugin.audioManager.playFadeDuration = value;
					await this.plugin.saveSettings();
				}));

		this.displayBlockDefaults(containerEl);
		this.displayReverb(containerEl);
	}

	private displayBlockDefaults(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Code block defaults").setHeading();

		new Setting(containerEl)
			.setName("Default playlist crossfade")
			.setDesc("Overlap between adjacent playlist items while fading into each other, in seconds (0-10s), used by rpg-audio blocks that omit their own \"crossfade\" setting. An explicit per-block \"crossfade\" always overrides this. Set to 0 to disable by default.")
			.addSlider(slider => slider
				.setLimits(0, 10, 0.5)
				.setValue(this.plugin.settings.defaultPlaylistCrossfade)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.defaultPlaylistCrossfade = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Default volume fade target")
			.setDesc("Target volume, from 0 (silent) to 1 (full, unitless), used by rpg-audio blocks that omit both \"volume-fade-to\" and \"volume-fade-duration\". An explicit per-block \"volume-fade-to\" always overrides this. Only takes effect when the default volume fade duration below is above 0.")
			.addSlider(slider => slider
				.setLimits(0, 1, 0.01)
				.setValue(this.plugin.settings.defaultVolumeFadeTarget)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.defaultVolumeFadeTarget = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Default volume fade duration")
			.setDesc("Duration of the volume fade, in seconds (0-120s), used by rpg-audio blocks that omit both \"volume-fade-to\" and \"volume-fade-duration\". An explicit per-block \"volume-fade-duration\" always overrides this. Set to 0 to disable the default volume fade.")
			.addSlider(slider => slider
				.setLimits(0, 120, 1)
				.setValue(this.plugin.settings.defaultVolumeFadeDuration)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.defaultVolumeFadeDuration = value;
					await this.plugin.saveSettings();
				}));
	}

	private displayReverb(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Reverb").setHeading();

		new Setting(containerEl)
			.setName("Reverb space")
			.setDesc("Acoustic space (reverb preset) applied to every track's audio output. Select the no-reverb option at the top of the list to disable the effect entirely.")
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
			.setDesc("How much reverb is mixed into the dry signal, from 0 (no reverb audible) to 1 (fully wet, unitless). Remembered separately for each reverb space.")
			.addSlider(slider => slider
				.setLimits(0, 1, 0.01)
				.setValue(this.getWetForPreset(this.plugin.settings.reverbPreset))
				.setDynamicTooltip()
				.onChange((value) => {
					void this.setWetForPreset(this.plugin.settings.reverbPreset, value);
				}));

		new Setting(containerEl)
			.setName("Safety limiter")
			.setDesc("When enabled, catches output peaks so loud material does not clip when reverb is added. Disable only if you hear pumping (audible volume ducking) on loud passages.")
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
			.setDesc("Reverb preset the sliders below edit. Editing a built-in preset creates a custom override (resettable); the new button duplicates the selected preset as a new custom preset.")
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

		this.addPresetSlider(containerEl, "Decay", "Length of the reverb tail, in seconds (0.1-8s). Longer values sound like a larger space.",
			0.1, 8, 0.1, p => p.decaySecs, (p, v) => { p.decaySecs = v; });

		this.addPresetSlider(containerEl, "Pre-delay", "Gap before the reverb starts, in milliseconds (0-150ms). Longer values separate the dry sound from the reverb tail, suggesting a larger room.",
			0, 150, 1, p => p.preDelayMs, (p, v) => { p.preDelayMs = v; });

		this.addPresetSlider(containerEl, "Damping", "How quickly high frequencies fade from the reverb tail, from 0 (no extra damping) to 1 (heavily damped, unitless). Higher values sound darker and more absorbent.",
			0, 1, 0.01, p => p.damping, (p, v) => { p.damping = v; });

		this.addPresetSlider(containerEl, "Diffusion", "Stereo width of the reverb tail, from 0 (collapsed toward mono) to 1 (fully wide, unitless).",
			0, 1, 0.01, p => p.diffusion, (p, v) => { p.diffusion = v; });

		this.addPresetSlider(containerEl, "Early reflections", "Number of distinct early echoes simulated before the main tail (0-40, a count).",
			0, 40, 1, p => p.earlyReflections, (p, v) => { p.earlyReflections = v; });

		this.addPresetSlider(containerEl, "Early level", "Loudness of the early echoes relative to the reverb tail, from 0 (silent) to 1 (as loud as the tail, unitless).",
			0, 1, 0.01, p => p.earlyLevel, (p, v) => { p.earlyLevel = v; });

		this.addPresetSlider(containerEl, "Early spread", "Time window the early echoes land within, in milliseconds (5-200ms). Shorter values sound like a smaller room.",
			5, 200, 1, p => p.erSpreadMs ?? 80, (p, v) => { p.erSpreadMs = v; });

		this.addPresetSlider(containerEl, "Low cut", "High-pass filter cutoff that keeps bass out of the reverb, in hertz (20-800Hz). Raise this if the low end sounds muddy or distorted.",
			20, 800, 10, p => p.hpfHz, (p, v) => { p.hpfHz = v; });

		this.addPresetSlider(containerEl, "High cut", "Low-pass filter cutoff that rolls off the top of the reverb, in hertz (1000-16000Hz). Lower values sound darker and more distant.",
			1000, 16000, 100, p => p.lpfHz, (p, v) => { p.lpfHz = v; });

		this.addPresetSlider(containerEl, "Wet trim", "Output level multiplier for this preset's reverb signal, from 0 (silent) to 2 (double gain, unitless), used to match its loudness against other presets.",
			0, 2, 0.01, p => p.wetTrim, (p, v) => { p.wetTrim = v; });
	}
}
