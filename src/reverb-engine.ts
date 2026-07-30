export interface ReverbPreset {
	id: string;
	name: string;
	decaySecs: number;
	preDelayMs: number;
	damping: number;
	earlyReflections: number;
	earlyLevel: number;
	diffusion: number;
	/** Per-preset output trim, 0..2. Applied on top of the global wet level. */
	wetTrim: number;
	/** Send high-pass, Hz. Keeps low end out of the tail so bass stays punchy. */
	hpfHz: number;
	/** Send low-pass, Hz. Tames harsh high-frequency buildup. */
	lpfHz: number;
	/** Window the early reflections land in, ms. Shorter reads as a smaller room. */
	erSpreadMs: number;
}

/** Older saved presets predate erSpreadMs. */
const DEFAULT_ER_SPREAD_MS = 80;

// Approximations of Audacity's SoX/Freeverb factory presets. Audacity's single
// "room size" control scales both the comb delay lengths and the room's apparent
// dimensions, so it maps onto decaySecs and erSpreadMs together here. Decay times
// are the longest-comb RT60 implied by each preset's room size and reverberance.
//
//                                    Audacity: size / predelay / reverb / damp / toneLo / toneHi / wet / dry
export const REVERB_PRESETS: ReverbPreset[] = [
	//                                            30 / 10 / 50 / 50 / 100 / 100 / -1 / -1
	{id: "smallroom",  name: "Small room bright", decaySecs: 0.75, preDelayMs: 10, damping: 0.45, earlyReflections: 12, earlyLevel: 0.50, diffusion: 1.0, wetTrim: 1.0, hpfHz: 40, lpfHz: 14000, erSpreadMs: 25},
	//                                            75 / 10 / 40 / 50 / 100 /  70 / -1 / -1
	{id: "mediumroom", name: "Medium room",       decaySecs: 1.05, preDelayMs: 10, damping: 0.45, earlyReflections: 10, earlyLevel: 0.40, diffusion: 1.0, wetTrim: 1.0, hpfHz: 40, lpfHz:  6000, erSpreadMs: 50},
	//                                            85 / 10 / 40 / 50 / 100 /  80 /  0 / -6
	{id: "largeroom",  name: "Large room",        decaySecs: 1.20, preDelayMs: 10, damping: 0.45, earlyReflections:  8, earlyLevel: 0.35, diffusion: 1.0, wetTrim: 2.0, hpfHz: 40, lpfHz:  8000, erSpreadMs: 60},
];

export const REVERB_OFF = "dry";

const SWAP_RAMP_SECS = 0.05;

// ---------------------------------------------------------------------------
// Preset resolution — custom presets shadow built-ins of the same id.
// ---------------------------------------------------------------------------

let customPresets: ReverbPreset[] = [];

/** Called by the plugin whenever settings load or change. */
export function setCustomPresets(presets: ReverbPreset[]): void {
	customPresets = presets;
}

/** Custom presets shadow built-ins of the same id. */
export function getPreset(id: string): ReverbPreset | undefined {
	return customPresets.find(p => p.id === id) ?? REVERB_PRESETS.find(p => p.id === id);
}

/** All presets for display: custom-shadowed built-ins first, then custom-only additions. */
export function getAllPresets(): ReverbPreset[] {
	const builtinIds = new Set(REVERB_PRESETS.map(p => p.id));
	const shadowed = REVERB_PRESETS.map(p => getPreset(p.id)).filter((p): p is ReverbPreset => !!p);
	const extras = customPresets.filter(p => !builtinIds.has(p.id));
	return [...shadowed, ...extras];
}

export function isBuiltin(id: string): boolean {
	return REVERB_PRESETS.some(p => p.id === id);
}

/** True when a built-in currently has a custom override. */
export function isOverridden(id: string): boolean {
	return isBuiltin(id) && customPresets.some(p => p.id === id);
}

/** Scale a channel to unit L2 norm, giving ≈ unity-gain convolution. */
function normalizeChannelL2(data: Float32Array, target: number): void {
	let sumSq = 0;
	for (let i = 0; i < data.length; i++) {
		const v = data[i] ?? 0;
		sumSq += v * v;
	}
	const norm = Math.sqrt(sumSq);
	if (norm <= 0) return;
	const scale = target / norm;
	for (let i = 0; i < data.length; i++) {
		data[i] = (data[i] ?? 0) * scale;
	}
}

export function synthesizeIR(ctx: BaseAudioContext, preset: ReverbPreset): AudioBuffer {
	const rate = ctx.sampleRate;
	const preDelaySamples = Math.floor((preset.preDelayMs / 1000) * rate);
	const tailSamples = Math.ceil(preset.decaySecs * rate);
	const length = preDelaySamples + tailSamples;
	const buf = ctx.createBuffer(2, length, rate);

	for (let ch = 0; ch < 2; ch++) {
		const data = buf.getChannelData(ch);

		// 1. Dense exponentially-decaying noise with a fixed one-pole lowpass.
		//    Previously used sparse (diffusion-gated) noise and a time-varying filter
		//    coefficient — the sparse input caused the filter to ring between zero
		//    crossings, creating audible frequency-jumping artefacts. Dense noise
		//    with a fixed coefficient gives a smooth, even spectral density.
		const lpCoeff = Math.max(0.05, 1 - preset.damping);
		let lp = 0;
		for (let i = 0; i < tailSamples; i++) {
			const t = i / tailSamples;
			const env = Math.exp(-6.9 * t);
			lp += lpCoeff * ((Math.random() * 2 - 1) * env - lp);
			data[preDelaySamples + i] = lp;
		}

		// 2. Diffusion: blend toward mono for narrow or dead-sounding spaces.
		//    At 1.0 (default) each channel is fully independent (wide stereo).
		if (ch === 1 && preset.diffusion < 0.99) {
			const ch0 = buf.getChannelData(0);
			for (let i = preDelaySamples; i < length; i++) {
				data[i] = (data[i] ?? 0) * preset.diffusion + (ch0[i] ?? 0) * (1 - preset.diffusion);
			}
		}

		// 3. Normalize the tail so ER level below is relative to a known reference.
		normalizeChannelL2(data, 1.0);

		// 4. Early reflections. Dividing by √count keeps total ER energy equal to
		//    earlyLevel regardless of how many spikes there are.
		const spreadMs = preset.erSpreadMs ?? DEFAULT_ER_SPREAD_MS;
		const erWindow = Math.max(1, Math.floor((spreadMs / 1000) * rate));
		const erUnit = preset.earlyReflections > 0
			? preset.earlyLevel / Math.sqrt(preset.earlyReflections)
			: 0;
		for (let r = 0; r < preset.earlyReflections; r++) {
			const pos = preDelaySamples + Math.floor(Math.random() * erWindow);
			if (pos >= length) continue;
			const falloff = 1 - r / preset.earlyReflections;
			data[pos] = (data[pos] ?? 0) + erUnit * falloff * (Math.random() * 2 - 1);
		}

		// 5. Re-normalize so adding ERs didn't raise overall gain.
		normalizeChannelL2(data, 1.0);
	}

	return buf;
}

export class ReverbBus {
	readonly input: GainNode;

	private ctx: BaseAudioContext;
	private hpf: BiquadFilterNode;
	private lpf: BiquadFilterNode;
	private convolver: ConvolverNode;
	private wet: GainNode;
	private cache: Map<string, AudioBuffer> = new Map();
	private presetId: string = REVERB_OFF;

	constructor(ctx: BaseAudioContext, output: AudioNode) {
		this.ctx = ctx;
		this.input = ctx.createGain();

		// Band-limit the send. Without the high-pass, bass energy convolves into the
		// whole tail and stacks across the decay — the main cause of mud and clipping
		// on bass-heavy material.
		this.hpf = ctx.createBiquadFilter();
		this.hpf.type = "highpass";
		this.hpf.frequency.value = 200;
		this.hpf.Q.value = 0.707;

		this.lpf = ctx.createBiquadFilter();
		this.lpf.type = "lowpass";
		this.lpf.frequency.value = 8000;
		this.lpf.Q.value = 0.707;

		this.convolver = ctx.createConvolver();
		this.convolver.normalize = false;
		this.wet = ctx.createGain();
		this.wet.gain.value = 1; // Fixed summing node — per-track sends control wet amount

		this.input.connect(this.hpf);
		this.hpf.connect(this.lpf);
		this.lpf.connect(this.convolver);
		this.convolver.connect(this.wet);
		this.wet.connect(output);
	}

	get preset(): string { return this.presetId; }

	setPreset(id: string): void {
		if (id === this.presetId) return;
		this.presetId = id;

		const preset = getPreset(id);
		if (!preset) {
			this.rampWetTo(0);
			this.convolver.buffer = null;
			return;
		}

		this.applyFilters(preset);

		let ir = this.cache.get(id);
		if (!ir) {
			ir = synthesizeIR(this.ctx, preset);
			this.cache.set(id, ir);
		}

		const now = this.ctx.currentTime;
		this.wet.gain.cancelScheduledValues(now);
		this.wet.gain.setValueAtTime(this.wet.gain.value, now);
		this.wet.gain.linearRampToValueAtTime(0, now + SWAP_RAMP_SECS);
		const bufferedIr = ir;
		window.setTimeout(() => {
			this.convolver.buffer = bufferedIr;
			this.rampWetTo(1);
		}, SWAP_RAMP_SECS * 1000);
	}

	private applyFilters(preset: ReverbPreset): void {
		const now = this.ctx.currentTime;
		const nyquist = this.ctx.sampleRate / 2;
		this.hpf.frequency.setTargetAtTime(Math.max(20, Math.min(nyquist, preset.hpfHz)), now, 0.01);
		this.lpf.frequency.setTargetAtTime(Math.max(200, Math.min(nyquist, preset.lpfHz)), now, 0.01);
	}

	/** Drop a cached IR so the next use re-synthesizes. Pass no id to clear all. */
	invalidate(id?: string): void {
		if (id === undefined) this.cache.clear();
		else this.cache.delete(id);
	}

	/** Force re-synthesis and re-application of the currently active preset. */
	refresh(): void {
		const active = this.presetId;
		this.cache.delete(active);
		this.presetId = " "; // defeat the early-return in setPreset
		this.setPreset(active);
	}

	private rampWetTo(value: number): void {
		const now = this.ctx.currentTime;
		this.wet.gain.cancelScheduledValues(now);
		this.wet.gain.setValueAtTime(this.wet.gain.value, now);
		this.wet.gain.linearRampToValueAtTime(value, now + SWAP_RAMP_SECS);
	}

	destroy(): void {
		this.input.disconnect();
		this.hpf.disconnect();
		this.lpf.disconnect();
		this.convolver.disconnect();
		this.wet.disconnect();
		this.convolver.buffer = null;
		this.cache.clear();
	}
}
