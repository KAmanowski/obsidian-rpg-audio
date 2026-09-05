export interface AudioPreviewElement {
	play(): Promise<void> | void;
	pause(): void;
	load(): void;
	removeAttribute(name: string): void;
	addEventListener(type: "ended" | "error", listener: () => void): void;
	removeEventListener(type: "ended" | "error", listener: () => void): void;
}

export type AudioPreviewFactory = (source: string) => AudioPreviewElement;

interface AudioPreviewSession {
	path: string;
	audio: AudioPreviewElement;
	onEnded: () => void;
	onError: () => void;
}

/** Owns the picker preview resource and guarantees that at most one file is active. */
export class AudioPreviewController {
	private session: AudioPreviewSession | null = null;

	constructor(
		private readonly onChange: (activePath: string | null) => void,
		private readonly onError: (path: string) => void,
		private readonly createAudio: AudioPreviewFactory = source => new Audio(source),
	) {}

	get activePath(): string | null {
		return this.session?.path ?? null;
	}

	toggle(path: string, source: string): void {
		if (this.session?.path === path) {
			this.stop();
			return;
		}

		this.release(false);
		let audio: AudioPreviewElement;
		try {
			audio = this.createAudio(source);
		} catch {
			this.onError(path);
			return;
		}
		const session: AudioPreviewSession = {
			path,
			audio,
			onEnded: () => this.finish(session, false),
			onError: () => this.finish(session, true),
		};
		this.session = session;
		audio.addEventListener("ended", session.onEnded);
		audio.addEventListener("error", session.onError);
		this.onChange(path);

		try {
			const playback = audio.play();
			if (playback) void playback.catch(() => this.finish(session, true));
		} catch {
			this.finish(session, true);
		}
	}

	stop(): void {
		this.release(true);
	}

	dispose(): void {
		this.release(true);
	}

	private finish(session: AudioPreviewSession, failed: boolean): void {
		if (this.session !== session) return;
		const path = session.path;
		this.release(true);
		if (failed) this.onError(path);
	}

	private release(notify: boolean): void {
		const session = this.session;
		if (!session) return;
		this.session = null;
		session.audio.removeEventListener("ended", session.onEnded);
		session.audio.removeEventListener("error", session.onError);
		session.audio.pause();
		session.audio.removeAttribute("src");
		session.audio.load();
		if (notify) this.onChange(null);
	}
}
