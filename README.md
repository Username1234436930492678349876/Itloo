# Qur'an Word Sync Maker v7.2

A local browser app for making Qur'an recitation edits with word-level timing, context-aware phrase grouping, Saheeh International subtitles, backgrounds, and watermarks.

## Project dashboard and saved work

- The app opens on a dashboard containing projects saved in this browser.
- Press **Save** while editing to name a project and store its audio, backgrounds, watermark, alignment, timings, subtitles, and appearance settings.
- Once a project has been saved, it is automatically updated every 45 seconds while the app remains open.
- Dashboard cards can be opened, renamed, exported, or deleted.
- **Export** creates a portable `.qsync` project file containing the project and its media. **Import project** restores that file on the same or another computer.

## Positionable circular shadow

- The Appearance page includes the supplied transparent bottom-center circular shadow.
- Enable it with **Use included circular shadow**, or upload another transparent PNG/WebP.
- Horizontal position, vertical position, size, and opacity can be changed independently, including partially outside the video frame.
- The live preview, final FFmpeg export, dashboard saves, and portable `.qsync` files all preserve the shadow layer.

## New in v7.2 — Shorts Retention Mode

- Starts the reciter's voice at `0.0s` by trimming only the opening before the first exported synchronized phrase.
- Can choose the strongest detected ayah opening using the recitation's vocal energy, while keeping the cut on Qur'anic phrase boundaries.
- Adds an editable, large first-second text hook over the recitation instead of delaying the voice with a title card.
- Adds subtle cinematic background motion from frame 1, including for still-image backgrounds.
- Creates a phrase-safe short between 15 and 25 seconds (22 seconds by default).
- Automatically disables the separate cinematic intro while Retention Mode is active, so there is no dead air before the recitation.
- Keeps the v7.1 square-pixel (`SAR 1:1`) render pipeline for intro and no-intro exports.
- Keeps every phrase visible while highlighting the exact Arabic word currently being recited; the highlight uses each word's synchronized start/end time and has an editable color.

## What changed in v5.1

v5.1 keeps the v5 AI word-alignment pipeline unchanged and focuses on export speed/reliability:

- subtitle PNGs are decoded once instead of being loop-decoded at 30 FPS for the whole clip;
- still-image backgrounds are scaled/blurred once and then repeated as prepared frames;
- video backgrounds are capped to 30 FPS before compositing, preventing 60/120-FPS sources from multiplying filter work;
- 720p exports use x264 `superfast` by default and 1080p uses `veryfast`;
- rendering runs as an asynchronous local job so the browser remains responsive;
- the progress bar now reflects FFmpeg's real encoded timestamp and shows realtime encoding speed;
- the finished-video button remains hidden until the new render is genuinely finished.

The AI Precise synchronization behavior is intentionally unchanged from v5.

## AI synchronization

The main synchronization mode is now **AI Precise forced alignment**. The app already knows the exact ayahs you selected, so it does not ask speech recognition to guess the Qur'anic words. It aligns the known text to the waveform and returns timings for each word.

AI Precise uses a layered pipeline:

1. whole-clip Arabic CTC forced alignment;
2. a second alignment pass inside each ayah to reduce drift;
3. optional Qur'an-specific phonetic alignment using Quran-MD transliterations;
4. confidence-aware fusion of the Arabic and Qur'an-specific models;
5. very small local boundary refinement from the waveform / CTC blank evidence.

The displayed text remains Uthmani Arabic. A normalized Arabic form is used only internally for the alignment model.

There is also a **Fast** mode that uses the browser waveform only. It is useful for drafts, but AI Precise is intended for the final edit.

## Phrase grouping

After word timing is known, the app decides how many words should appear on each screen automatically. It considers:

- Qur'anic waqf marks;
- punctuation / clause structure in the Saheeh International ayah translation;
- Arabic connector words;
- actual pauses between aligned words;
- phrase duration;
- visual phrase length.

You can choose **Automatic by meaning**, **Shorter phrases**, or **Longer phrases**. You can also split or join a phrase manually in the timing editor.

## Timing editor

The editor includes a waveform and one block per Qur'anic word. You can:

- click a word to play it;
- drag the whole word timing;
- drag its start/end edge;
- set start or end to the current audio playhead;
- nudge by 10 ms with the arrow keys;
- nudge by 50 ms with Shift + arrow;
- see high / medium / low confidence;
- split a phrase after the selected word;
- join it with the next phrase.

## Watermarks

Supported watermark types:

- text / `@username`;
- image (PNG/JPG/WebP etc.);
- video (MP4/MOV/WebM).

You can adjust position, size, and opacity. Video watermarks loop for the duration of the exported video. Transparent image/video formats are best when you want only the logo visible.

## Windows setup

No administrator access is required.

1. Extract the ZIP to a normal folder.
2. Double-click **`setup-ai.ps1`** once, or right-click it and choose **Run with PowerShell**.
3. When setup finishes, double-click **`start.bat`**.
4. The app opens at `http://127.0.0.1:8765`.

If PowerShell blocks the setup script, open PowerShell in the project folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-ai.ps1
```

Then launch with:

```powershell
.\start.bat
```

### First AI Precise run

The first AI Precise analysis downloads the model files from Hugging Face. This is a large one-time download and can take several minutes. They are cached on the PC after that. CPU-only alignment works but can be slow; a supported GPU is faster.

The app itself does **not** need npm or Vite. The Python backend serves the frontend and native FFmpeg performs MP4 rendering.

## Normal workflow

The interface intentionally shows one task at a time:

1. Recitation
2. Passage
3. Sync quality
4. Word timing / phrase editor
5. Background
6. Watermark
7. Export

For the passage, enter ranges such as:

- `31-34`
- `31-34, 36`
- `1, 3-5`

The Qur'an text and Saheeh International translation are fetched automatically.

## Export

Exports use H.264 video + AAC audio. The renderer is optimized for local CPU export and reports true FFmpeg progress rather than a fixed waiting percentage. A normal 720p edit should now render dramatically faster than v5, though exact speed depends on the PC, source codec, effects, and video length.

Supported exports include:

- 9:16 Reel/TikTok
- 16:9 YouTube
- 1:1 square
- 720p
- 1080p
- image or video backgrounds
- darkness / blur
- Saheeh International subtitles
- text / image / video watermarks

## Verification

An optional local verification script is included:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1
```

The test suite checks the phrase grouping, Qur'an/translation merge logic, frontend architecture, forced-alignment core, and a real FFmpeg render with a looping video watermark.

## Important accuracy note

Forced alignment is much more appropriate than silence-only timing for Qur'anic recitation, especially with madd, ghunnah, connected ayahs, and uneven recitation speed. It can still make mistakes with unusual recitation styles, very noisy recordings, a passage that does not exactly match the selected ayahs, or model/tokenizer limitations. The waveform editor is there so the final few inconsistencies can be corrected precisely.


## New in v5.2

- Much deeper **Appearance** step for live customization.
- Subtitle controls for Arabic size, translation size, text width, side/top-bottom margins, vertical placement, Arabic/English line spacing, colors, outline width/opacity, shadow blur/opacity, and verse-reference toggle/placement.
- Background controls for fit mode (cover/contain), zoom, horizontal/vertical framing, brightness, saturation, darkness, and blur.
- Live preview reflects both the text and background styling before export.


## New in v5.3

- Arabic, translation, and verse-label sizes can now be increased up to **200 px**.
- Large phrases wrap more gracefully across multiple lines during preview and export.
- The phrase-overlay render canvas now uses the full video frame, reducing clipping when using very large text.
- Improved Appearance UI/UX with a live preview card, quick style presets, reset button, and a cleaner two-column desktop layout.


## New in v5.4

- The **default subtitle style** now matches the calm centered look you requested: Surah title in Arabic at the top, English surah name in brackets, ayah reference below it, large centered Arabic phrase, and smaller serif translation underneath.
- Reset and Balanced preset now both return to this new default style.
- Final exported phrase overlays now include the same top metadata block as the preview.


## New in v6

- You can now add **multiple background clips** instead of just one.
- Each background clip has its own **fit mode, zoom, X/Y framing, brightness, saturation, manual dimming, blur, auto-dim strength, timeline share, fade-in, and fade-out** controls.
- The appearance preview now follows the active background clip across the recitation timeline.
- Arabic and English subtitle blocks sit **slightly closer together** with a dedicated gap slider.
- The app now prefers the **QPC V2 Arabic font** when it is available on the system, with graceful fallbacks if it is not installed.
- Watermarks can now be made a little larger and adjusted more freely with **anchor + X/Y offset** controls.
- Exported renders support the same multi-background timing and watermark offset settings as the preview.


## New in v6.1

- Restored the optional **remove black background** setting for image/video watermarks.
- Reduced the workflow to a cleaner **5-step flow** by combining appearance, watermark, and export into one final stage.
- Added **whole-clip fade in/out** controls that apply to both the final video and the audio.
- Kept all previous v6 features, including multi-background clips, per-clip fades, per-clip positioning, dimming, and watermark positioning controls.


## New in v6.2

This update is aimed at making edits closer to the supplied reference video with fewer manual steps.

- Added **six built-in dark 9:16 background presets**: Starry Night, Ocean Cliffs, Misty Forest, Mountain Dusk, Desert Night, and Emerald Bokeh. Clicking one adds it directly to the background sequence; your own image/video clips still work too.
- Improved **phrase-level translation splitting**. Saheeh International remains the displayed translation, but the app now tries to fetch Quran.com word glosses and uses them only as semantic anchors when deciding which English words belong to each Arabic phrase. This avoids simply splitting the English sentence by length.
- Added a **manual phrase translation editor** in the precision editor so any rare mismatch can be corrected instantly without changing timings.
- If the word-gloss service is unavailable, translation automatically falls back to the existing Saheeh-only semantic splitter.
- Kept v6.1's five-step flow, whole-video/audio fades, multi-background sequence, black-removal watermark option, QPC V2 preference, and full appearance controls.


## New in v6.3

- Repairs accidental one-letter Arabic subtitle fragments before alignment/grouping (for example detached `ذَ` + `ٰلِكُمُ`).
- Adds a manual **Arabic word / letters** editor in the precision editor so display text can be corrected without changing timing.
- New uploaded backgrounds now default to their **original appearance**: no dimming, no auto-dimming, no brightness/saturation changes, no blur, no fade, no zoom; `contain` preserves the full source frame.
- Fixed a zero-value bug where setting manual dimming to 0 could still behave like the old 34% default.
- Fixed the Surah/verse block position slider: its range now matches the actual default and its value is no longer clamped to the upper part of the frame.
- Decoupled the Surah/verse block position from the main Arabic/translation block position.
- Added **live settings playback** with play/pause, scrubber, time display, current phrase switching, multi-background switching, watermark preview, and whole-clip fade preview.
- Selecting a background clip now seeks the preview to that clip automatically, so you immediately see the clip you are editing.
- Preview canvases are reused rather than recreated every animation frame, reducing UI overhead while playing.


## New in v6.4

- **Repeated/backtracked ayahs are supported.** AI Precise now performs a repeat-detection pre-pass from the acoustic model and can expand the forced-alignment transcript when a reciter repeats a full selected ayah.
- The passage field also preserves an explicit recitation order, so `95-97,95` means ayahs 95, 96, 97, then ayah 95 again. This is the manual fallback if automatic repeat detection misses an unusual recitation.
- Every final phrase of an ayah now receives the Qur'anic **end-of-ayah sign with the correct Arabic-Indic ayah number** (for example `۝٩٥`). Repeated ayahs keep their original ayah number.
- Phrase grouping, manual timing edits, translation overrides, and preview selection now track an **ayah occurrence**, not only the ayah number, so a repeated verse does not overwrite or merge with its first occurrence.


## New in v6.5

- **Introductory basmalah detection:** AI Precise now detects a recited `بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ` before the selected passage, inserts it into the forced-alignment target, times it word-by-word, and displays the matching Saheeh-style translation. Al-Fatihah 1:1 is not duplicated.
- **More exact phrase translation:** the app now first builds a monotonic word-level map between Quran.com English word glosses and the complete Saheeh International ayah translation. Each Arabic phrase receives the exact consecutive Saheeh token span owned by its Arabic words. This is more reliable than redistributing the translation separately for each phrase.
- The word-gloss cache preserves empty word slots so a missing gloss cannot shift every later English anchor onto the wrong Arabic word.
- The six built-in still backgrounds have been replaced by **looping MP4 video backgrounds** with subtle motion. Custom uploaded images and videos remain supported.
- Basmalah is treated as an introduction rather than ayah 0 visually, so it does not receive a fake `۝٠` end marker.

## New in v6.6 — synchronization regression fix

v6.6 restores the stable v6.4 selected-ayah alignment path. The v6.5 basmalah feature had been inserted into the forced-alignment target *before* the selected ayahs were aligned. A false-positive basmalah detection could therefore shift the timing of every word after it.

The new design is deliberately safer:

- selected ayahs (including repeated/backtracked ayahs) are aligned first using the same stable dual-CTC pipeline as v6.4;
- only after those timings are final does the app inspect the opening audio for an optional basmalah;
- if a basmalah is accepted, its four timings are prepended without modifying any selected-ayah start/end time;
- **Auto / Included / Not included** basmalah controls are available on the Passage step;
- Auto detection is conservative and uses both prefix recognition and forced-alignment confidence;
- the browser now validates returned word counts, occurrence keys, and monotonic timings before accepting an AI result;
- if that validation fails, the broken result is rejected instead of silently entering the editor.

Translation improvements and the built-in looping video backgrounds from v6.5 are kept, but they are isolated from the acoustic alignment path.

Also fixed two latent fallback-grouping bugs where legacy grouping functions referenced an undefined timing variable. They did not normally affect AI Precise mode, but could break older/Fast-mode code paths.



## New in v6.7

- Fixed the Basmalah translation regression defensively in two places: inserted Basmalah occurrences now always carry their own dedicated Saheeh-style translation metadata, and the phrase splitter uses fixed Basmalah word-to-English segments instead of ever inheriting the first selected ayah translation.
- Bundled six actual looping MP4 background videos under `assets/backgrounds_video`, so the built-in background gallery now works offline instead of showing empty/missing presets.
- Added a regression test that deliberately corrupts the Basmalah source translation with a fake first-ayah translation; the UI grouping must still output the correct Basmalah English.


## New in v6.8 — Engagement Title Card Intro

- Optional **Engagement Title Card Intro** rendered before the recitation starts.
- Pitch-black background with kinetic scale/slide/fade title reveal.
- Arabic intro title defaults to `مَقَامُ الْعَجَمِ`; English defaults to `Maqam al-Ajam`.
- Editable Arabic/English title fields, 1–5 second duration, and a **Use Surah name** shortcut.
- Locally generated sound design options: **Deep cinematic hit**, **Soft swoosh**, or no SFX. No external audio asset is required.
- Live frontend intro preview with synchronized browser sound.
- The intro is rendered as a separate segment and concatenated before the recitation, so **AI word timings are never shifted or recalculated** when the intro is enabled.
- Backend render endpoints accept the browser-rendered Arabic/English intro title layer so final Arabic shaping matches the preview.


## New in v6.9 — tighter sync, better translation matching, fresh backgrounds

- Improved AI word-boundary refinement: the exact-text Arabic CTC blank posterior is now used as a direct local boundary signal, alongside the Qur'an-specific model. High-confidence boundaries are allowed to move only a little; low-confidence boundaries get a wider search window. This reduces drift into madd/ghunnah or quiet portions inside a word.
- Fixed the per-ayah local re-alignment window so it stops at the actual gap between ayahs instead of reaching into the previous/next ayah's word.
- Improved Saheeh International phrase matching with a new phrase-level monotonic alignment. Quran.com word glosses are combined for the exact Arabic words visible on screen, then used to select the corresponding consecutive Saheeh International clause. The old word-level alignment remains as a positional prior/fallback.
- Word-gloss API failures are no longer cached as permanent empty results; a later run can retry and recover better translation matching.
- Replaced the bundled background gallery with a live **Wikimedia Commons video browser**. The app shows up to five suggestions at once, has Calm / Sky / Nature / Dark themes, and a Refresh button for new results.
- Background cards show the Commons license and a source link. Selecting one downloads it through the local backend and adds it to the normal background timeline, so all existing crop, position, fade, dimming, and multi-clip controls still work.
- The online picker only accepts browser-friendly WebM/MP4 files and rejects overly large files for a faster workflow.

## New in v7.0 — Built-in recitation library

The first step now has two source modes:

- **Upload my audio** — keeps the existing local upload workflow.
- **Built-in recitation library** — choose a reciter, Surah, start ayah, and end ayah. The app downloads only those ayah recordings and combines them locally into one clip.

The initial library is intentionally limited to:

- Mishary Rashid Alafasy — EveryAyah `Alafasy_128kbps`
- Khalifa Al Tunaiji — EveryAyah `khalefa_al_tunaiji_64kbps`
- Yasser Al Dosari — EveryAyah `Yasser_Ad-Dussary_128kbps`

Downloaded ayah files are cached under `.cache/recitation-library` so repeated use is faster. When a library recitation is loaded, the app automatically fills the selected Surah and verse range and skips the redundant Passage step when you continue. AI Precise synchronization still runs normally on the resulting clip.

The library needs an internet connection the first time an ayah is used. Audio availability and reuse conditions remain subject to the upstream audio provider.

## New in v7.1 — Isti'adhah/Basmalah library controls + render stability

- The built-in recitation library now has independent **Add isti'adhah** and **Add basmalah** options before the selected ayahs.
- Isti'adhah and Basmalah are handled as separate leading phrases with their own fixed Arabic text and translations, so they cannot inherit the first selected ayah's translation.
- Both leading phrases are aligned **after the selected ayahs' timings are established**, so detecting or inserting them cannot shift the main ayah word synchronization.
- The Basmalah option is automatically disabled for **At-Tawbah (Surah 9)** and is not duplicated when selecting **Al-Fatihah from ayah 1**.
- Built-in isti'adhah extraction uses the same selected reciter and caches the extracted clip locally after the first successful retrieval.
- Fixed the FFmpeg `concat` failure caused by non-square sample aspect ratios such as `SAR 10240:10239`. Every background/main video segment is now normalized to **SAR 1:1** before concatenation, whether the title-card intro is enabled or disabled.
- `start.ps1` now checks port 8765 for an older Qur'an Sync instance. It reuses the server when the same version is already running and attempts to close an older Python instance before starting v7.1, instead of silently showing the old frontend.
- Added a regression render test using two 1080-style video segments with deliberately mismatched SAR values, plus library-prefix tests and an Isti'adhah translation regression test.

## New in v7.2 — block deletion and letter-level highlighting

- Deletion now targets the exact selected word block on the waveform, not its whole ayah. Other blocks in that ayah remain in the AI transcript.
- Mark one or more individual blocks, undo pending deletions if needed, then choose **Re-check after deletions**.
- Removing a Basmalah block changes Basmalah handling to **Not included**, preventing automatic detection from restoring the deleted block.
- Each Arabic word receives AI acoustic token timings mapped onto grapheme-aware letters, keeping diacritics attached to their base letter. Fast mode falls back to proportional letter timing.
- The Precision editor includes a letter panel with individual start/end boundaries and letter-only audio playback for manual corrections.
- Live previews and final video exports use the selected word-level or letter-level highlight style.
- Highlighting can be switched between **Word by word** and **Letter by letter**. Word by word is the default because it is smoother and more reliable; letter mode retains the AI/manual letter controls.
- Every phrase block can override that default independently from the Precision editor. The phrase strip shows whether each block uses Word or Letter highlighting, and preview/export honor the block-level choice.
- If a revised AI check fails, the last successful alignment, letter timings, and prefix settings are restored.
