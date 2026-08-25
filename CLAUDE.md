# RPG Audio — Obsidian Plugin

An Obsidian community plugin (id: `rpg-audio`) that provides an in-vault audio soundboard for tabletop RPG sessions. Users define audio tracks using fenced `rpg-audio` code blocks in Markdown notes; the plugin renders inline player widgets and a sidebar panel.

## Build & Development

```bash
npm install
npm run dev       # esbuild watch mode with sourcemaps
npm run build     # tsc type-check + esbuild production build
npm run lint      # eslint
```

Clone into `.obsidian/plugins/rpg-audio/` for local development.

## Architecture

Zero external runtime dependencies — only the `obsidian` API. TypeScript source bundled via esbuild into `main.js`.

### Source Layout

| File | Responsibility |
|------|---------------|
| `src/main.ts` | Plugin lifecycle: loads settings, creates AudioManager, registers code block processor, sidebar view, commands, settings tab |
| `src/audio-manager.ts` | Core engine: manages tracks, HTMLAudioElements, GainNodes, AudioContext, play/pause/stop/fade, scope transitions, directive matching, orphan cleanup |
| `src/audio-block-parser.ts` | Parses and validates `rpg-audio` block syntax into `AudioTrackDef` without UI/runtime dependencies |
| `src/fade-engine.ts` | Generic `requestAnimationFrame`-based linear value interpolation engine |
| `src/volume-fade-controller.ts` | Pausable per-track volume automation built on its own `FadeEngine` lane |
| `src/types.ts` | `PlayState` enum, `AudioTrackDef`/`AudioTrackState`/`TrackCause` interfaces, event constants, timing constants |
| `src/settings.ts` | `RpgAudioSettings` interface, defaults, settings tab UI |
| `src/ui/code-block-player.ts` | Parses code block syntax into `AudioTrackDef`, renders inline player widget, handles autoplay |
| `src/ui/sidebar-view.ts` | Right sidebar: global controls, grouped track list, fade/stop buttons, debug overlay |
| `src/ui/player-controls.ts` | Shared UI factory for play/pause/stop/volume controls |
| `src/ui/insert-track-modal.ts` | Modal GUI for building code blocks |
| `styles.css` | All plugin CSS |

### Audio Pipeline

HTML5 `Audio` element for media playback, routed through Web Audio API for volume control:

```
HTMLAudioElement → MediaElementAudioSourceNode → GainNode → AudioContext.destination
```

- One `AudioContext` shared by all tracks (lazy-created)
- Per-track `GainNode` for volume: `gain.value = trackVolume * masterVolume * fadeMultiplier * regionFadeMultiplier`
- `FadeEngine` animates `fadeMultiplier` via `requestAnimationFrame` (linear interpolation)
- Configured volume automation uses a separate `FadeEngine` and changes `trackVolume`, so it can coexist with transport, crossfade, and region fade multipliers
- Automated volume direction is exposed as `increasing` / `decreasing`; per-track slider thumbs and global/type fade icons use green/red feedback, with static colour under reduced-motion preferences

### Key Data Structures

- `AudioTrackDef` — parsed from code block, including playback/directive/region fields and optional `volumeFadeTarget` / `volumeFadeDuration`
- `AudioTrackState` — runtime state: def, playState, volume, currentIndex, error, lastCause
- Maps keyed by track `id`: `tracks`, `audioElements`, `gainNodes`, transport/region fade multipliers, configured volume fades, and runtime region/loop overrides

### Code Block Syntax

Parsed in `parseAudioBlock()` in `code-block-player.ts`. YAML-like key-value pairs. Required: `id`, `name`, at least one `file`/`files` entry.

### Existing Features

- **Multi-track**: simultaneous playback with independent volume
- **Fading**: crossfade between exclusive tracks, play/pause fade, global/per-type fade (all via FadeEngine)
- **Looping**: native `el.loop` for single file, manual `ended` handler for playlists
- **Scope system**: context labels for automatic scene transitions
- **Directives**: `stops:`, `pauses:`, `resumes:` for inter-track control
- **Autoplay**: configurable delay, gated by sidebar toggle

### Current Limitations

- No seek/scrubber — only play, pause, stop
- No time-based region playback (start/end timestamps)
- No persistent playback state across restarts
- Local vault files only (no URLs/streaming)

## Lint

ESLint with `typescript-eslint` and `eslint-plugin-obsidianmd`. The obsidian rule `obsidianmd/ui/sentence-case` requires sentence-case text in UI strings (setting descriptions, etc). Avoid periods like "e.g." in setting descriptions — spell out "for example" or restructure.

## Conventions

- No external runtime dependencies — only the `obsidian` API
- TypeScript strict mode with `noUncheckedIndexedAccess`
- Events via Obsidian's `Events` mixin (not EventEmitter)
- CSS class prefix: `rpg-audio-`
- Track IDs are user-defined slugs (kebab-case by convention)
