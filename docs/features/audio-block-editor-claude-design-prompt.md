# Claude Design prompt: RPG Audio block editor

Design a production-ready, high-fidelity UI for a new **Add / Edit audio block** workflow in an Obsidian community plugin called **RPG Audio**. Do not design a generic music app: this is an Obsidian-native authoring modal that helps tabletop RPG game masters create and edit fenced Markdown configuration blocks without memorizing syntax.

## Product context

RPG Audio turns fenced `rpg-audio` code blocks in an Obsidian note into compact inline audio players and a sidebar soundboard. All audio is local to the user's vault. The plugin works on desktop and mobile, in dark and light Obsidian themes, and uses Obsidian/Lucide icons and native-looking form controls.

An existing insert-only modal is too limited. The new workflow must:

- add a new block at the editor cursor;
- load every value from an existing block for editing;
- select one or many local audio files;
- automatically switch from **Single file** to **Playlist** when the second file is added;
- enable playlist-only controls in playlist mode;
- visibly grey out and disable settings that do not apply in single-file mode, with a short explanation;
- validate input inline and disable saving until the block is valid;
- generate or update one valid canonical `rpg-audio` fenced block.

Users can open it from the command palette/editor context menu. Each rendered player will also have a compact More actions (three dots) button whose menu contains **Edit audio block…**. Please show this entry point in context, but focus the design work on the modal and file picker.

## Important domain behavior

Playlist mode is determined only by selected file count:

- 0 files: incomplete/empty state; saving is blocked.
- 1 file: Single file mode.
- 2+ files: Playlist mode.

The separate **Type** field is only a display badge/grouping label. It offers **Automatic**, Music, SFX, Ambience, Playlist, and Custom. When Automatic is selected, one file resolves to SFX and multiple files resolve to Playlist. Never overwrite an explicitly selected type when file count changes.

When a second file is added, playlist-only controls enable immediately. If the list drops back to one, those controls become disabled and greyed out. Their draft values may be retained while the modal is open, but they will not be saved in a single-file block. Communicate this without an alarming warning.

## Modal structure

Design a comfortably wide, vertically scrollable desktop modal and a full-height, single-column mobile treatment. Use these sections and hierarchy:

### Header

- Title: **Add audio block** or **Edit audio block**.
- One-line supporting copy.
- Persistent status badge: **Single file** or **Playlist · 4 files**. Before selection, show **No audio files** or an equivalent neutral incomplete state.
- Optional compact **View code** disclosure for a read-only generated-code preview. It is secondary, not the main workflow.

### 1. Basics

- **Name** — required display name.
- **ID** — required unique identifier, automatically suggested from the name but editable.
- **Type** — Automatic, Music, SFX, Ambience, Playlist, Custom; selecting Custom reveals a text field.

### 2. Audio files

- Prominent but not oversized **Add files** button.
- Empty state explaining that one file creates a single track and multiple files create a playlist.
- Ordered file rows. Each row needs:
  - full or sensibly truncated vault path;
  - optional display title in playlist mode;
  - accessible Move up / Move down actions (dragging may supplement but cannot replace them);
  - Replace and Remove actions;
  - a clear row number in playlist mode.
- Duplicate paths are allowed because the same source file can be used as different titled/trimmed excerpts.
- Long paths and titles must truncate gracefully while the full value remains discoverable.
- A missing file loaded from an existing block stays visible with an inline error plus Replace/Remove; Save is blocked.

For playlist rows, include optional per-file region controls, preferably in a compact expandable row detail:

- **Start override** and **End override** each have three states: **Inherit block**, **No boundary**, or **Custom**.
- Custom reveals a timestamp field.
- In Single file mode, playlist titles and per-file overrides remain visible only if helpful for consistency, but must be clearly disabled with text such as “Available when two or more files are selected.” Avoid relying on low opacity alone.

Also design the separate **Add files** picker: a searchable Obsidian-native modal/list of vault audio files with checkboxes, multi-selection, selected count, Cancel, and **Add selected**. It must work well with keyboard and touch.

### 3. Playback

Common controls:

- **Loop** toggle — repeats a single region or controls playlist cycling depending on playlist end behavior.
- **Autoplay** toggle.
- **Start time** and **End time** — optional block-level timestamps; for a playlist these are defaults inherited by items.

Playlist-only controls (enabled for 2+ files, disabled/greyed with explanation for 0–1 file):

- **Random order** toggle.
- **Playlist end action** select: Auto (follow loop), Next item, Repeat item, Stop playlist.
- **Playlist crossfade**: **Use plugin default** or **Custom**, with a non-negative seconds input for Custom.

### 4. Volume and fades

- **Initial volume** from 0 to 1; support precise numeric entry and/or an accessible slider plus value.
- **Fade in duration** in non-negative seconds.
- **Fade out duration** in non-negative seconds.
- **Volume automation** choice: **Use plugin default** or **Custom**.
- Custom volume automation reveals paired **Target volume** (0–1) and **Duration** (>0 seconds). Both are required together.
- Do not show a “Disabled” override: the current block syntax cannot explicitly turn off an active plugin-wide volume automation default.

### 5. Interactions

Put this in a clearly named advanced disclosure, initially collapsed:

- **Scope**
- **Stops**
- **Fades out**
- **Pauses**
- **Resumes**

Each accepts comma-separated track IDs/types/context labels. A tag/chip pattern is welcome only if it is simple and fully keyboard accessible. Include concise helper text so a game master understands these are cross-track actions triggered when this block starts.

### Footer

- Persistent validation-summary area using text plus icon, suitable for an `aria-live="polite"` region.
- **Cancel** secondary action.
- **Add block** or **Save changes** primary action.
- Primary action disabled when invalid; show the reason in visible text rather than only a tooltip.
- Account for a dirty-form close/discard confirmation.

## Validation states to show

Design friendly field-level validation and a summary for these cases:

- missing Name, ID, or audio files;
- duplicate ID in the current note;
- unresolved/missing audio path;
- invalid timestamp, or End not later than Start;
- volume outside 0–1;
- negative fade/crossfade duration;
- custom volume automation with only one of target/duration supplied;
- per-file effective End not later than effective Start after inheritance;
- an existing block containing unsupported/malformed source that cannot safely be represented. In that last case, disable Save and provide a calm instruction to correct the source rather than silently dropping data;
- source changed while the modal was open: conflict state with no overwrite, and actions to close/reopen or review the latest source.

Errors should be specific and local. Do not flood an untouched empty add form with red messages; reveal validation progressively after interaction or submit.

## Current code-block syntax for realistic examples

A single file:

```yaml
id: tavern-rain
name: Tavern rain
type: ambience
loop: true
start: 0:15
end: 3:00
fadein: 2
fadeout: 4
volume: 0.8
file: audio/ambience/tavern-rain.mp3
```

A playlist:

```yaml
id: battle-music
name: Battle music
type: music
loop: true
random: false
playlist-end-action: next
crossfade: 3s
start: 0:15
end: 3:00
volume-fade-to: 0.5
volume-fade-duration: 60
files:
- audio/music/battle-01.mp3 [Opening assault]
- audio/music/battle-02.mp3 [Reinforcements] {start=0:45, end=2:20}
- audio/music/battle-03.mp3 [Last stand] {start=none, end=4:00}
```

Other supported settings are `scope`, `stops`, `fadesout`, `pauses`, `resumes`, and `autoplay`. False booleans and inherited/default values are normally omitted from generated code.

## Visual conventions

Make it feel native to modern Obsidian rather than like a web dashboard:

- Obsidian dark theme is the primary presentation; include light-theme mapping for key screens.
- Use Obsidian semantic theme tokens conceptually: primary/secondary backgrounds, modifier borders/hover, normal/muted/error text, interactive accent, focus ring.
- Existing RPG Audio UI uses compact cards, about 6px radii, subtle recessed secondary surfaces, purple as the playlist/accent cue, green for playing/success, amber for paused/caution, and red only for actual errors/destructive actions.
- Use Lucide-style icons, sentence-case labels, restrained shadows, compact spacing, and clear section dividers.
- Do not use glassmorphism, decorative gradients, oversized cards, excessive pills, or a permanently visible wall of advanced settings.
- Greyed controls must retain readable contrast and include a non-colour explanation of why they are unavailable.
- Desktop controls can be compact; mobile interactive targets must be at least 44×44px.
- Include clear hover, active, focus-visible, disabled, loading, and error treatments. Respect reduced-motion preferences.

## Accessibility and keyboard behavior

- Logical heading and tab order from Basics through footer.
- Visible focus rings in both themes.
- Native labels and descriptions; errors programmatically associated with fields.
- Toggle/select behavior must not depend on colour.
- File rows can be reordered and removed without drag.
- Escape closes nested picker first, then the owning modal (with dirty confirmation when needed).
- Long content and 200% zoom must not hide actions or force horizontal scrolling.
- Mode changes and validation summaries should be announceable without disruptive alerts.

## Required design states and deliverables

Provide a coherent design board plus a written implementation handoff. At minimum include:

1. Add mode, empty/untouched.
2. Add mode with one valid file (Single file); playlist-only controls visibly disabled.
3. Add/edit mode with a 3–5 item playlist, including expanded per-file overrides and enabled playlist controls.
4. Edit mode pre-populated from the playlist example above.
5. Multi-select audio-file picker with search and several selected files.
6. Validation state with both a local field error and footer summary.
7. Existing missing-file row with recovery actions.
8. Inherited versus Custom playlist crossfade and volume-automation states.
9. Generated-code disclosure open.
10. Rendered inline player More actions menu showing **Edit audio block…**.
11. Dirty-close confirmation and stale-source conflict state.
12. Narrow/mobile layout for empty, single-file, and playlist states.
13. Key light-theme screen plus keyboard-focus examples.

For the handoff, specify modal dimensions/max height, responsive breakpoints/behavior, section and row spacing, control sizing, disabled/error/focus tokens, truncation behavior, file-list scrolling, exact interaction transitions, and any design assumptions. Include a state matrix identifying which controls are enabled for 0, 1, and 2+ files. Prefer repository-compatible global CSS/class guidance; do not assume React, CSS modules, custom SVG files, or third-party component libraries.

Do not implement the plugin. Produce UI designs and an implementation-ready visual/interaction specification for review.
