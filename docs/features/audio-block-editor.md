# Audio block editor design

Status: implementation complete in the working tree; automated verification passes; manual Obsidian UX testing and the missing Claude mobile/light/focus design refinements remain.

## Goal and scope

Replace the insert-only form with one menu-based GUI that can add a new `rpg-audio` block or edit an existing one. It must cover every currently supported setting, use the existing parser as the final authority, and write a canonical valid block without changing playback state directly.

The current insert modal already selects multiple files and emits basic blocks, but it cannot edit, perform full validation, reorder or annotate playlist entries, configure per-file regions, or reliably express inherited plugin defaults. This feature supersedes that UI while retaining the stable `insert-track` command ID.

## Entry points and user flow

1. Keep **Insert audio track** (`insert-track`) for compatibility; it opens the new editor in add mode. Its visible name may become **Add audio block**.
2. Add **Edit audio block** with a stable new command ID. It is available only when the editor cursor or selection is inside an `rpg-audio` fence.
3. Add one contextual editor-menu item: **Edit audio block…** inside a block, otherwise **Add audio block…** at the cursor.
4. Add a compact More actions button to each rendered inline player. Its Obsidian `Menu` contains **Edit audio block…**. Resolve `ctx.getSectionInfo(el)` immediately before opening and tolerate a null result.
5. Add mode inserts after the selection/cursor with sensible newline separation. Edit mode loads the existing source, and **Save changes** replaces exactly that fence. Cancel never writes.
6. After writing, allow Obsidian's Markdown rerender to rebuild/register the player; do not mutate `AudioManager` from the form.

For an edit invoked from a live editor, use `Editor.replaceRange` so normal undo works. A rendered-player edit may target a non-active note or embed: retain the source path, original fenced text, and fresh section information; at save, atomically verify the same text still occupies the target before changing it. Abort with a `Notice` if it moved or changed rather than risking the wrong block.

## Layout and interaction model

Use an Obsidian `Modal`, native `Setting` controls where practical, Lucide icons via `setIcon`, sentence-case copy, theme variables, and the `rpg-audio-` CSS prefix. The modal is a comfortably wide, scrollable desktop dialog and a full-height single-column sheet on narrow/mobile screens.

Header:

- **Add audio block** or **Edit audio block** title.
- Short subtitle plus a persistent mode badge: **Single file** for one entry, **Playlist · n files** for two or more.
- Optional compact **View code** disclosure showing read-only generated syntax.

Sections:

1. **Basics**: Name, ID, and Type. Type offers **Automatic**, Music, SFX, Ambience, Playlist, and Custom. Automatic omits `type`, so the parser resolves SFX for one file and Playlist for multiple files. Explicit types are never changed by file count because runtime playlist behavior does not depend on the badge/grouping type.
2. **Audio files**: searchable **Add files** action with multi-selection; ordered file rows with path, optional title, Remove, and accessible Move up/Move down actions. Drag reordering may supplement, never replace, buttons/keyboard. Duplicate paths are allowed because the same source may represent different titled/trimmed playlist excerpts.
3. **Playback**: Loop, Autoplay, block Start and End, plus Random, Playlist end action, and Playlist crossfade. The last three are playlist-only.
4. **Volume and fades**: Initial volume, Fade in duration, Fade out duration, and paired Volume fade target/duration. Provide an explicit **Use plugin default** vs **Custom** choice for volume automation; Custom requires both fields. There is currently no block syntax that explicitly disables an active plugin-wide volume-fade default, so the UI must not promise that state.
5. **Interactions** (advanced disclosure): Scope, Stops, Fades out, Pauses, and Resumes. Present comma-separated tokens as simple tag/chip input if it remains keyboard accessible; serialize them as comma-separated values.

Footer:

- A live validation summary (`aria-live="polite"`) near the actions.
- **Cancel** and context-sensitive primary action (**Add block** / **Save changes**).
- The primary action is disabled while required or semantic errors exist; disabled reasons remain visible in text, not only through colour or a tooltip.

## File-row states

Each row has a stable internal key rather than using its path as identity.

- Single-file mode: only path and remove/replace actions apply. Title and per-file override controls are visibly disabled with explanatory copy because the player name and block-level region are authoritative.
- Playlist mode: title is enabled. Start override and End override each use a three-state control: **Inherit block**, **No boundary**, or **Custom**, with a timestamp input for Custom. This maps exactly to `undefined`, `null`, or seconds in `AudioFileEntry`.
- Missing files loaded from existing source stay visible with an error treatment and can be replaced or removed. Saving remains blocked until all paths resolve.
- A selected file may be added more than once. Reordering changes source order.

When the second file is added, mode changes immediately to Playlist and playlist-only controls become enabled. When the list drops to one, those controls are disabled and greyed out, but their in-memory draft values are retained in case another file is re-added before closing. They are omitted if a single-file block is saved. Empty state shows an Add files call to action and blocks saving.

## Form data model

Keep editable syntax state separate from normalized playback state so editing can preserve omission/inheritance and invalid raw input:

```ts
type OptionalInput = { mode: "inherit" } | { mode: "value"; value: string };
type BoundaryInput = { mode: "inherit" | "none" } | { mode: "value"; value: string };

interface AudioFileDraft {
  key: string;
  path: string;
  title: string;
  start: BoundaryInput;
  end: BoundaryInput;
}

interface AudioBlockFormState {
  name: string;
  id: string;
  type: OptionalInput;
  entries: AudioFileDraft[];
  loop: boolean;
  random: boolean;
  autoplay: boolean;
  playlistEndAction: "auto" | "next" | "repeat" | "stop";
  playlistCrossfade: OptionalInput;
  start: string;
  end: string;
  fadein: string;
  fadeout: string;
  volume: OptionalInput;
  volumeFadeMode: "inherit" | "custom";
  volumeFadeTarget: string;
  volumeFadeDuration: string;
  scope: string[];
  stops: string[];
  fadesout: string[];
  pauses: string[];
  resumes: string[];
}
```

`isPlaylist` is derived from `entries.length > 1`; it is never stored independently. Add mode starts with empty required values, Automatic type, false toggles, `auto` end action, and inherited optional defaults. Edit mode hydrates from source syntax, not only `AudioTrackDef`, because normalization loses whether values were omitted and inherited from plugin settings.

## Validation

Validate on change after a field is touched and validate everything on submit. Show field-level messages and one summary. The serializer output must also pass `parseAudioBlockDetailed()` using the current plugin defaults; its errors are the final authority.

- Name, ID, and at least one file are required. Do not invent a stricter ID grammar than the runtime parser currently enforces.
- Warn/block duplicate IDs found in other `rpg-audio` fences in the current note, excluding the block being edited. Do not scan the whole vault during modal input.
- All paths must resolve through the existing vault-root-then-audio-folder resolver. The picker lists the existing supported audio extensions; an edited path is not rewritten merely because it uses a different resolvable form.
- Booleans are emitted only as `true`; false values are omitted.
- Volume and volume-fade target are finite `0..1` numbers. Fade in/out and crossfade are finite non-negative seconds. Custom volume-fade duration is finite and greater than zero, and target/duration are always emitted as a pair.
- Timestamps follow the parser: non-negative seconds, `m:ss`, or `h:mm:ss`; seconds (and minutes in three-part form) must be below 60. End must be later than start.
- In playlists, validate each effective boundary after applying per-file inherit/none/value over block boundaries.
- Playlist-only values are never serialized for one entry. `file:` is used for one entry; `files:` plus ordered `- ` lines is used for two or more.
- Unknown, malformed, or duplicate source settings that cannot be represented safely are reported when hydrating. Do not silently delete them. Disable Save and direct the user to correct source (or offer an explicitly reviewed source-cleanup action in a later iteration).

Validation is strict inside this authoring tool even if runtime **Validate audio blocks** is disabled: its promise is to generate a valid block. Runtime permissive mode remains unchanged.

## Canonical serialization

Create a pure serializer; do not keep string construction inside the modal. Canonical order:

1. `id`, `name`, optional `type`
2. `loop`, playlist `random`, non-default `playlist-end-action`, explicit playlist `crossfade`, `autoplay`
3. `scope`, `stops`, `fadesout`, `pauses`, `resumes`
4. `start`, `end`, `fadein`, `fadeout`, explicit non-default `volume`, paired explicit volume-fade fields
5. `file` or `files` entries

Omit false booleans and default/inherited optional values. Emit entry syntax as `path`, then optional ` [Title]`, then optional ` {start=…, end=…}` in that order. Emit `none` for explicit boundary clears. Editing canonicalizes supported syntax, including the legacy `starts` alias to `resumes`, and replaces the entire fenced block. Preview and saved output must use the same serializer.

## Proposed implementation surface

- `src/main.ts`: delegate command/menu registration and pass an edit callback/source locator into rendered players; keep lifecycle code small.
- `src/commands/audio-block-commands.ts` (new): register add/edit commands and the `editor-menu` event; choose add/edit mode from cursor context.
- `src/audio-block-source.ts` (new): pure fence locator, editable-source hydration metadata, and canonical serializer. Extract/share low-level syntax helpers with `audio-block-parser.ts` instead of maintaining two grammars.
- `src/audio-block-form.ts` (new): form state, mode derivation, field validation, and conversion to serializable source.
- `src/ui/audio-block-modal.ts` (new): form rendering and add/edit actions. Replace `InsertTrackModal`; a compatibility re-export is optional during migration.
- `src/ui/audio-file-picker-modal.ts` (new): searchable, multi-select vault file picker.
- `src/ui/code-block-player.ts`: add an accessible More actions button and call the supplied edit action. The player remains unaware of editor/vault mutation details.
- `styles.css`: modal layout, file rows, disabled groups, error/help text, mode badges, focus/reduced-motion/mobile states.
- `README.md`: rename/describe commands and document add/edit entry points.
- Tests: pure fence location, hydration/presence, serializer golden cases and round trips, mode transitions, single-vs-playlist omission, per-entry tri-state boundaries, malformed-source safeguards, duplicate-note IDs, and validation parity with `parseAudioBlockDetailed`.

Avoid Node/Electron APIs and external dependencies. Register workspace menu listeners through `registerEvent`, DOM listeners through component/modal cleanup patterns, and ensure nested file-picker/modals cannot outlive the owning workflow.

## Edge cases and safeguards

- Cursor on opening/closing fence, body, or a selection spanning the block counts as edit; adjacent text does not.
- Multiple blocks with identical source must not cause a rendered edit to replace the wrong one.
- A source change while the modal is open causes a conflict message and no write.
- Editing in an embed/hover resolves the source note, not the host note; if exact safe replacement is unavailable, offer to open the source at the block instead of guessing.
- Preserve explicitly selected type across mode changes; Automatic follows file count.
- Long paths/titles truncate visually but retain full text in accessible names/tooltips.
- File picker and rows support keyboard-only use, visible focus, Escape/Cancel, and at least 44px touch targets on narrow screens.
- Disabled controls remain perceivable, are excluded from tab order where native disabled semantics apply, and have adjacent explanatory text. State never relies on grey colour alone.
- Modal close with dirty changes asks for discard confirmation. Successful save closes once; double submission is guarded.

## Implementation sequence and acceptance

1. Review and approve UI designs against this specification.
2. Add pure source/form/serializer modules and unit tests.
3. Build the modal and multi-file picker, including state-dependent disabling and accessibility.
4. Register add/edit commands and editor context menu while retaining `insert-track`.
5. Add rendered-player More actions integration with conflict-safe replacement.
6. Add CSS/docs/tests; run `npm test`, `npm run lint`, `npm run build`, and `git diff --check`.
7. Manually test source/live-preview/reading modes, embeds, dark/light themes, keyboard/mobile layouts, file-count transitions, inherited defaults, validation failures, undo, and stale-source conflicts before committing or releasing.

Acceptance requires valid canonical round trips for every supported setting, correct single/playlist gating, exact existing-block replacement, no write on validation/conflict/cancel, and no playback/listener leaks after rerender.

## Implementation report (2026-09-01)

### Design review

- Reviewed `C:\Users\Kacper\Downloads\UI screenshots for plugin design.zip`. Its primary board, `RPG Audio Block Editor.dc.html`, covers desktop empty, single-file, playlist edit, expanded per-file overrides, file picker, validation/missing file, generated code, rendered More actions, dirty close, and stale-source states.
- Initially adopted the board's 520px desktop modal, then increased it to a responsive 760px maximum after in-vault testing showed the form was too cramped. Retained the compact Obsidian-native sections, purple playlist cues, recessed file rows, segmented choices, persistent footer validation, and progressive error treatment.
- The export does not contain the requested mobile screens, full light-theme screen, or keyboard-focus examples. Implementation uses semantic Obsidian variables, a conservative full-height layout below 600px, 44px mobile targets, wrapping file actions, and explicit focus-visible rings. Request Claude refinements before treating those visual details as final.

### Completed work

- Fast-forwarded `feature/audio-block-ui` from `00a2b96` to verified prerequisite commit `333ba8d`, preserving the completed playlist entries/regions/crossfade/dropdown and plugin-default work described in project memory.
- Added pure audio-fence discovery, cursor/selection and section-line location, note-local ID collection, and insertion spacing.
- Added a separate editable form model with raw-presence hydration, configurable new-block defaults, canonical serialization, runtime-parser parity, strict validation, per-file tri-state boundaries, missing-file checks, duplicate-note ID checks, and unsafe-source safeguards.
- Added the Add/Edit modal and searchable multi-select file picker. The modal supports file addition, duplicates, replacement, removal, ordered move buttons, playlist titles, per-file regions, block playback/volume/fade settings, advanced interactions, generated-code preview, progressive validation, cancellation, dirty-close confirmation, double-submit protection, and conflict feedback.
- Retained command ID `insert-track` under the visible name **Add audio block**; added `edit-audio-block`, an editor context-menu Add/Edit action, and rendered-player More actions integration.
- Live-editor saves use `Editor.replaceRange`; rendered saves use `Vault.process` and verify the exact original source at its original offsets before replacing it. Moved/changed/ambiguous sources are never overwritten.
- Added global authoring defaults for type, loop, random order, autoplay, playlist end action, fade in/out, and initial volume. Existing plugin-level playlist crossfade and volume automation defaults remain inherited dynamically. Saved settings are normalized so absent/invalid new fields migrate to safe defaults.
- Removed the superseded insert-only modal and documented the new workflow and commands in `README.md`.
- Removed the unintended dotted box around disabled per-file overrides; only the intentionally outlined playlist-only panel retains a dashed disabled border. Increased the desktop editor width to `min(760px, 100vw - 48px)` while preserving the full-screen layout below 600px.
- Updated the audio library picker to match Claude's labeled-folder design. Search results are divided by exact parent folder, nested types such as `Music/Combat` remain distinct, headers stay visible while scrolling and show the matching file count, and existing search/multi-selection behavior is unchanged.
- Made every library folder heading collapsible without changing the established visual hierarchy. Each heading contains a native button with `aria-expanded` and `aria-controls`, a down/right chevron communicates expanded/collapsed state (without animation under reduced-motion preferences), Enter and Space work through native keyboard semantics, controlled file groups are labeled for assistive technology, and collapse state survives picker rerenders caused by search or single-file selection.
- Fixed scroll jumps caused by synchronous view rebuilds. Dynamic audio-block choices (including Volume automation, type, crossfade, per-file boundaries, and file-list mutations), reverb settings redisplays, in-place sidebar controls, and single-file picker selection now restore the scroll container's horizontal and vertical position after rebuilding. Initial opens, audio-library searches, sidebar track-set updates that may represent note navigation, and the playlist's explicit current-item `scrollIntoView` behavior retain their existing reset/navigation semantics.
- File-picker selectors now communicate cardinality through their native control type: replacement mode (`multiple: false`) uses one named radio group, while add-files mode and the default configuration use independent checkboxes. Selection state, folder collapse state, search, and scroll preservation are unchanged.
- Expanded the Name emoji picker following Claude's Android-keyboard-style board. Its catalog is now generated from the exact lockfile-pinned `emojibase-data` 17.0.0 package: 1,914 standard Unicode 17/CLDR entries across nine standard groups plus 40 curated RPG & Audio shortcuts with tabletop aliases. The generated catalog and pre-normalized English search metadata are bundled into `main.js`; runtime browsing performs no network requests. A deterministic generator and stale-data check protect updates, while the existing 24-item vault-scoped Recently used list, popup/bottom-sheet layout, grouped search, keyboard navigation, caret insertion, and cleanup behavior remain unchanged. Skin-tone variants are not yet exposed as separate grid entries because doing so requires a dedicated accessible variant interaction rather than thousands of additional category buttons.
- Restyled boolean ToggleComponents only inside the audio-block editor to match Claude's switch design and override conflicting theme geometry: 32×18px desktop with a 14px thumb, 36×20px mobile with a 16px thumb, neutral grey off, green on, white active thumb, visible focus ring, disabled treatment, light-theme mapping, and reduced-motion handling.
- Colored every audio-block type selector option with the existing type palette, including the selected state; Automatic reflects the type derived from the current file count. Added settings-backed custom type definitions (`name` plus validated six-digit hex color), displayed saved definitions as reusable selector buttons, and provided an Obsidian-native text/color editor for the active custom type. Custom definitions are normalized during settings load and committed when the block saves, so cancellation remains non-mutating; renaming also updates a matching new-block default. Saved custom definitions are available in the global **Default type** dropdown after reload.

### Files changed

- Added: `src/audio-block-form.ts`, `src/audio-block-source.ts`, `src/audio-block-types.ts`, `src/audio-library.ts`, `src/emoji-picker.ts`, `src/data/emoji-data.generated.ts`, `src/commands/audio-block-commands.ts`, `src/ui/audio-block-modal.ts`, `src/ui/audio-file-picker-modal.ts`, `src/ui/emoji-picker.ts`, `src/ui/scroll-preservation.ts`, `scripts/generate-emoji-data.mjs`, `scripts/emoji-rpg-aliases.json`, `tests/audio-block-form.test.ts`, `tests/audio-block-source.test.ts`, `tests/audio-block-types.test.ts`, `tests/audio-library.test.ts`, `tests/emoji-picker.test.ts`, `tests/scroll-preservation.test.ts`, `THIRD_PARTY_NOTICES.md`.
- Updated: `src/audio-block-parser.ts`, `src/main.ts`, `src/settings.ts`, `src/ui/code-block-player.ts`, `styles.css`, `README.md`, `package.json`, `package-lock.json`, `eslint.config.mts`.
- Removed: `src/ui/insert-track-modal.ts`.

### Verification

- `npm run check:emoji-data`: passes; the committed generated catalog exactly matches pinned Emojibase 17.0.0 and the curated RPG aliases.
- `npm test`: 65 tests pass, including custom-type normalization/upsert/color resolution and emoji dataset provenance, category coverage, CLDR/RPG search, and standard-catalog uniqueness.
- `npm run lint`: passes.
- `npm run build`: passes, including `tsc -noEmit -skipLibCheck` and production esbuild.
- `git diff --check`: passes.
- Production `main.js` is 274,796 bytes with the bundled offline catalog and persisted custom-type selector, up from the pre-catalog 152,246 bytes. Removing duplicated labels/tags from generated search metadata reduced the first full-catalog build from 314,638 bytes.

### Unresolved and exact next steps

1. Obtain Claude's mobile empty/single/playlist screens, light-theme mapping, and focus-visible examples using the focused follow-up prompt recorded in project memory; reconcile only visual details that differ from the conservative responsive implementation.
2. Manually test in Obsidian source/live-preview/reading modes: add at cursor/after selection, edit/Undo, editor menu, rendered More actions, embeds, stale source, duplicate IDs, missing files, single↔playlist transitions, per-file inheritance/none/custom, cancellation/dirty close, and double submission.
3. Test dark/light themes, keyboard-only operation, 200% zoom, narrow desktop, iOS/Android layouts, long paths/titles/playlists, and reduced motion. Confirm the sticky footer never hides fields and no horizontal scrolling appears.
4. Copy generated `main.js` and `styles.css` into a development vault plugin folder for the user's preferred local test-before-commit workflow. Do not commit or release until manual UX checks pass.
5. Manually check category-opening and search responsiveness on lower-powered mobile devices and confirm Unicode 17 glyph fallback on supported Obsidian platforms. A future skin-tone feature should use an accessible variant chooser rather than flattening every modifier sequence into the main grid.

### Callout source-location fix (2026-09-01)

- User testing on `B5i. The Barovian Church.md` showed rendered editing failed for **Church Ambience** because the block is inside a callout: every fence/body line is prefixed with `> `.
- `src/audio-block-source.ts` now recognizes blockquote/callout-prefixed fences, strips the container prefix before hydration, and reapplies the exact prefix to every canonical line when saving. This keeps the edited block inside its original callout.
- Configuration-error rendering no longer adds the generic “RPG Audio configuration error” heading. It displays the actual error message(s) and provides **Edit audio block…**, using the same conflict-safe rendered edit path.
- Added regression tests for locating, hydrating, and rewriting quoted blocks, resolving relative nested-section line numbers through rendered-body matching, and distinguishing identical block bodies through surrounding section text. Full test count is now 47; tests, lint, build, and `git diff --check` pass.
- Follow-up B5i testing confirmed Obsidian can return section line numbers relative to a nested callout rather than the outer note. Rendered editing now first uses line ranges, then safely falls back to the processor's exact rendered body and `MarkdownSectionInformation.text`; it still aborts if those signals leave multiple candidates.
- A further B5i path returned `null` from `getSectionInfo()` entirely. Rendered editing no longer aborts in that case: a unique exact-body match opens directly; repeated identical matches open a searchable location chooser labeled with source line and nearest heading/callout. The chooser is required for the two `church-ambience` occurrences and prevents guessing.

### Main-branch conflict resolution (2026-09-02)

- The repository's primary branch is `main`; no `master` ref exists. Fetched and merged `origin/main` at `33ac5b1` into `feature/audio-block-ui` with `--no-commit` so the result remains reviewable.
- Resolved content conflicts in `README.md`, `src/audio-block-parser.ts`, `src/main.ts`, `src/settings.ts`, `src/ui/code-block-player.ts`, and `styles.css`, plus the modify/delete conflict for `src/ui/insert-track-modal.ts`.
- The `main` playlist/file-check changes were already present through prerequisite merge `333ba8d`. Retained the feature-side supersets: exported parser helpers used by form validation, rendered/editor edit entry points, authoring defaults, More actions, responsive editor styling, and the intentional removal of the obsolete insert-only modal. Preserved Git's clean auto-merges in the engine, playlist utilities/dropdown/tests, types, and sidebar.
- Temporarily stashed the uncommitted custom-type selector work, reapplied it after resolving the branch merge, and retained `stash@{0}` as a safety copy until the pending merge is committed.
- Post-resolution verification: `npm test` passes 65 tests; `npm run lint`, `npm run build` (including TypeScript), `npm run check:emoji-data`, `git diff --check`, and the unmerged-path check all pass.
- The resolved feature was subsequently merged to `main` as `0cccfd9` (**Added Settings UI (#12)**). The named safety stash remains available and can be dropped after release confidence checks.

### Release preparation (2026-09-02)

- Bumped the release version from `0.4.0` to `0.5.0` in `package.json`, the package-lock root/package records, and `manifest.json`.
- Added the required `"0.5.0": "1.5.7"` entry to `versions.json`; the minimum supported Obsidian version is unchanged.
- `npm run build` passes at version 0.5.0, including generated emoji-data validation, TypeScript checking, and the production esbuild bundle. All four JSON release/version files parse and report consistent values; `git diff --check` passes.
- Committed the release metadata as `f8884b8` (**Release 0.5.0**), pushed `main`, and pushed annotated tag `0.5.0` without a `v` prefix.
- GitHub Actions release run `33686166203` completed successfully and published [release 0.5.0](https://github.com/KAmanowski/obsidian-rpg-audio/releases/tag/0.5.0) as a non-draft, non-prerelease release.
- Verified the release contains the required individual assets: `main.js` (274,796 bytes), `manifest.json` (322 bytes), and `styles.css` (44,723 bytes).
