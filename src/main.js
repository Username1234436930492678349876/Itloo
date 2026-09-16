import { SURAHS, BASMALAH, ISTIATHA, getSurah, parseVerseRanges, fetchSelectedAyahs, formatRangeLabel, makeBasmalahAyah, makeIstiathaAyah } from './quran.js';
import {
  decodeAudioFile,
  buildEnvelope,
  splitArabicWordObjects,
  alignAyahsToEnvelope,
  alignWordsWithinAyah,
  buildContextAwareGroups,
  rebuildGroupsFromBreaks,
  findActiveGroup,
  finalTimelineDuration,
} from './sync.js';

import { loadArabicFonts, resolveArabicFont, measureArabicToken, measureArabicTokenBounds, layoutTextRows, wrapIndexedArabic } from './fonts.js';

let arabicFonts = null;
const API = '';
const $ = id => document.getElementById(id);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
const fmt = seconds => Number(seconds || 0).toFixed(3);

const state = {
  step: 0,
  audioFile: null,
  sourceMode: 'upload',
  librarySelection: null,
  audioUrl: null,
  audioBuffer: null,
  envelope: null,
  duration: 0,
  ayahs: [],
  selectedNumbers: [],
  syncMode: 'ai',
  wordTimings: [],
  groups: [],
  phraseStyle: 'auto',
  translation: true,
  selectedWord: 0,
  selectedLetter: 0,
  groupBreaks: {},
  translationOverrides: {},
  highlightOverrides: {},
  backend: null,
  backgroundClips: [],
  selectedBackgroundClip: 0,
  backgroundSuggestions: [],
  backgroundSeed: 1,
  backgroundTheme: 'calm',
  backgroundLoading: false,
  watermarkType: 'none',
  watermarkFile: null,
  watermarkUrl: null,
  watermarkElement: null,
  watermarkSettings: { text: '@maqamulajam', position: 'bottom-right', size: 20, opacity: 65, offsetX: 0, offsetY: 0, removeBlack: false },
  shadowOverlay: { enabled: false, file: null, url: null, element: null, x: 50, y: 76, size: 100, opacity: 100 },
  globalFade: { in: 0, out: 0 },
  intro: { enabled: false, arabic: 'مَقَامُ الْعَجَمِ', english: 'Maqam al-Ajam', duration: 2.6, sound: 'deep' },
  retention: { enabled: true, smartOpening: true, hook: 'A verse that calms the heart', hookDuration: 1.4, targetDuration: 22, motion: true },
  introPreviewRaf: null,
  introAudioContext: null,
  previewRaf: null,
  zoom: 1,
  drag: null,
  alignmentReviewReady: false,
  pendingWordDeletions: new Set(),
  currentProjectId: null,
  currentProjectName: 'Untitled project',
  projectSaveBusy: false,
};



const app = document.querySelector('#app');
app.innerHTML = `
  <section class="project-dashboard" id="projectDashboard" aria-label="Project dashboard">
    <div class="dashboard-shell">
      <div class="dashboard-head">
        <div><div class="eyebrow">Project dashboard</div><h1>Your recitation projects.</h1><p class="lead">Continue an edit saved on this browser, start a new one, or import a portable project file.</p></div>
        <div class="dashboard-actions">
          <button class="secondary" id="importProjectBtn" type="button">Import project</button>
          <input id="importProjectFile" type="file" accept=".qsync,.json,application/json" hidden />
          <button class="primary" id="newProjectBtn" type="button">New project</button>
        </div>
      </div>
      <div class="dashboard-status" id="dashboardStatus"></div>
      <div class="project-grid" id="projectGrid"></div>
    </div>
  </section>
  <main class="shell">
    <header class="header">
      <button class="brand" id="brandHome" type="button">Qur'an <span>Sync</span></button>
      <div class="steps" id="steps"></div>
      <div class="project-header-actions">
        <span class="step-label" id="stepLabel"></span>
        <button class="header-save" id="saveProjectBtn" type="button">Save</button>
      </div>
    </header>

    <section class="stage">
      <section class="panel active" data-step="0">
        <div class="eyebrow">Recitation</div>
        <h1>Choose the recitation.</h1>
        <p class="lead">Upload your own recording, or pick a reciter and ayah range from the built-in library.</p>
        <div class="source-tabs" role="tablist" aria-label="Recitation source">
          <button class="source-tab selected" data-source="upload" type="button">Upload my audio</button>
          <button class="source-tab" data-source="library" type="button">Built-in recitation library</button>
        </div>
        <div class="source-pane active" data-source-pane="upload">
          <label class="upload-box" for="audioFile">
            <input id="audioFile" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg" />
            <span class="upload-title">Choose recitation</span>
            <span class="upload-sub" id="audioFileName">MP3, WAV, M4A, AAC or OGG</span>
          </label>
          <div class="status" id="audioStatus">Choose a file to continue.</div>
        </div>
        <div class="source-pane" data-source-pane="library">
          <div class="library-card">
            <div class="field">
              <label for="libraryReciter">Reciter</label>
              <select id="libraryReciter">
                <option value="mishary_alafasi">Mishary Rashid Alafasy</option>
                <option value="khalifa_altunaiji">Khalifa Al Tunaiji</option>
                <option value="yasser_aldosari">Yasser Al Dosari</option>
              </select>
            </div>
            <div class="field">
              <label for="librarySurah">Surah</label>
              <select id="librarySurah"></select>
            </div>
            <div class="grid-2 verse-picker-grid">
              <div class="field">
                <label for="libraryStart">Start ayah</label>
                <input id="libraryStart" type="number" min="1" value="1" inputmode="numeric" />
              </div>
              <div class="field">
                <label for="libraryEnd">End ayah</label>
                <input id="libraryEnd" type="number" min="1" value="7" inputmode="numeric" />
              </div>
            </div>
            <div class="library-prefix-options">
              <label class="toggle-row compact-toggle">
                <div><strong>Add isti'adhah</strong><span>أَعُوذُ بِاللَّهِ مِنَ الشَّيْطَانِ الرَّجِيمِ</span></div>
                <input id="libraryIstiatha" type="checkbox" />
              </label>
              <label class="toggle-row compact-toggle">
                <div><strong>Add basmalah</strong><span>بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</span></div>
                <input id="libraryBasmalah" type="checkbox" />
              </label>
            </div>
            <div class="help" id="libraryPrefixHelp">Optional opening phrases are added before the selected ayahs and handled separately by the synchronizer.</div>
            <button class="primary wide" id="loadLibraryRecitation" type="button">Get recitation</button>
            <div class="status" id="libraryStatus">Choose the reciter, Surah and ayah range.</div>
            <div class="help">Internet required the first time. Selected ayahs are downloaded from EveryAyah and combined locally. Downloaded ayahs are cached for faster reuse.</div>
          </div>
        </div>
      </section>

      <section class="panel" data-step="1">
        <div class="eyebrow">Passage</div>
        <h1>Which ayahs are being recited?</h1>
        <p class="lead">This is the transcript the aligner will force against the recitation, so it does not have to guess the Qur'anic words.</p>
        <div class="field">
          <label for="surah">Surah</label>
          <select id="surah"></select>
        </div>
        <div class="field">
          <label for="verseRanges">Ayah order / range(s)</label>
          <input id="verseRanges" type="text" placeholder="31-34" autocomplete="off" />
          <div class="help">Repeats and going backwards are supported. Examples: 31-34 · 31-34,31 · 95-97,95 repeats ayah 95.</div>
        </div>
        <div class="field">
          <label for="istiathaMode">Isti'adhah at the beginning</label>
          <select id="istiathaMode">
            <option value="auto">Auto detect · recommended</option>
            <option value="always">Included in this recitation</option>
            <option value="never">Not included</option>
          </select>
          <div class="help">Isti'adhah is aligned separately before the selected ayahs and cannot shift their timings.</div>
        </div>
        <div class="field">
          <label for="basmalahMode">Basmalah at the beginning</label>
          <select id="basmalahMode">
            <option value="auto">Auto detect · recommended</option>
            <option value="always">Included in this recitation</option>
            <option value="never">Not included</option>
          </select>
          <div class="help">Auto checks only the opening audio before the first aligned ayah. It cannot shift the selected ayahs.</div>
        </div>
        <div class="status" id="passageStatus">Enter the passage to continue.</div>
      </section>

      <section class="panel" data-step="2">
        <div class="eyebrow">Synchronization</div>
        <h1>Choose the alignment quality.</h1>
        <p class="lead">AI Precise is the default. It uses forced alignment against the exact Qur'anic text, then refines word boundaries with a Qur'an-specific acoustic model.</p>
        <div class="choice-grid">
          <button class="choice selected" data-sync="ai" type="button">
            <span class="choice-title">AI Precise <b>Recommended</b></span>
            <span>Exact-text CTC alignment + Qur'an boundary refinement. Best for finished edits.</span>
          </button>
          <button class="choice" data-sync="fast" type="button">
            <span class="choice-title">Fast</span>
            <span>Browser-only acoustic estimate. Useful for a quick draft when the AI backend is unavailable.</span>
          </button>
        </div>
        <div class="backend-card" id="backendCard">
          <div><span class="dot" id="backendDot"></span><strong id="backendTitle">Checking AI backend…</strong></div>
          <p id="backendText">The first AI run may download about 1.6 GB of models.</p>
        </div>
        <button class="primary wide" id="analyzeBtn" type="button">Analyze word timing</button>
        <div class="status" id="syncStatus">Ready.</div>
      </section>

      <section class="panel wide-panel" data-step="3">
        <div class="eyebrow">Precision editor</div>
        <h1>Fine-tune any word.</h1>
        <p class="lead">Low-confidence words are highlighted. Drag word edges on the waveform, click a word to play it, or set its start/end from the playhead.</p>

        <div class="alignment-review" id="alignmentReview" hidden>
          <div class="alignment-review-copy">
            <strong>Delete a timeline block from the AI check</strong>
            <p>Click the exact word block on the timeline, mark only that block for deletion, then ask AI to re-check. Other words in the same ayah stay in place.</p>
          </div>
          <div class="alignment-review-controls">
            <button class="danger-action" id="deleteSelectedBlockBtn" type="button">Mark selected block for deletion</button>
            <button class="secondary" id="undoBlockDeletionsBtn" type="button" disabled>Undo pending deletions</button>
            <button class="primary" id="recheckBlocksBtn" type="button" disabled>Re-check after deletions</button>
          </div>
          <div class="status" id="alignmentReviewStatus">Select a word block from the timeline. Your current alignment stays unchanged until the AI re-check succeeds.</div>
        </div>

        <audio id="audioPreview" controls preload="metadata"></audio>
        <div class="timeline-toolbar">
          <div class="zoom-group">
            <button class="icon-btn" id="zoomOut" type="button" title="Zoom out">−</button>
            <span id="zoomLabel">1×</span>
            <button class="icon-btn" id="zoomIn" type="button" title="Zoom in">+</button>
          </div>
          <div class="legend"><span class="legend-dot high"></span>high <span class="legend-dot medium"></span>medium <span class="legend-dot low"></span>low confidence</div>
        </div>
        <div class="timeline-viewport" id="timelineViewport">
          <div class="timeline" id="timeline">
            <canvas id="waveCanvas"></canvas>
            <div id="wordTrack" class="word-track"></div>
            <div id="playhead" class="playhead"></div>
          </div>
        </div>

        <div class="editor-card" id="wordEditor"></div>
        <div class="phrase-tools">
          <div>
            <strong>Phrase grouping</strong>
            <p>The app groups words using meaning, waqf marks, translation clauses, phrase duration and the reciter's real pauses.</p>
          </div>
          <select id="phraseStyle">
            <option value="auto">Automatic by meaning</option>
            <option value="compact">Shorter phrases</option>
            <option value="spacious">Longer phrases</option>
          </select>
        </div>
        <div class="phrase-strip" id="phraseStrip"></div>
        <div class="preview-inline" id="editorPreview"></div>
      </section>

      <section class="panel" data-step="4">
        <div class="eyebrow">Appearance</div>
        <h1>Customize the look.</h1>
        <p class="lead">Adjust the background and subtitle styling before export. The preview updates live, and large text can wrap onto more lines automatically.</p>
        <div class="preview-stage">
          <div class="preview-stage-head">
            <strong>Live preview</strong>
            <span>Use this to test readability before exporting.</span>
          </div>
          <div class="preview-inline compact" id="backgroundPreview"></div>
          <div class="preview-playback">
            <button class="secondary mini" id="settingsPlayPause" type="button">▶ Play preview</button>
            <input id="settingsScrubber" type="range" min="0" max="1000" value="0" />
            <span id="settingsTime">0.0s / 0.0s</span>
          </div>
        </div>
        <div class="preset-bar">
          <span>Quick styles</span>
          <button class="secondary mini" type="button" data-style-preset="balanced">Balanced</button>
          <button class="secondary mini" type="button" data-style-preset="readable">Readable</button>
          <button class="secondary mini" type="button" data-style-preset="huge">Huge Arabic</button>
          <button class="secondary mini" type="button" data-style-preset="minimal">Minimal</button>
          <button class="secondary mini" type="button" id="resetAppearance">Reset</button>
        </div>
        <div class="appearance-grid">
          <div class="appearance-block">
            <div class="block-heading">
              <strong>Background clips</strong>
              <span>Pick a fresh stock video from Wikimedia Commons or add your own. Five suggestions are shown at a time.</span>
            </div>
            <div class="background-browser-head">
              <div>
                <div class="builtin-title">Fresh video backgrounds</div>
                <div class="help">Reusable videos fetched from Wikimedia Commons. Check the license shown on each card.</div>
              </div>
              <div class="background-browser-actions">
                <select id="backgroundTheme" aria-label="Background theme">
                  <option value="calm">Calm mix</option>
                  <option value="sky">Sky & stars</option>
                  <option value="nature">Nature</option>
                  <option value="dark">Dark / moody</option>
                </select>
                <button class="secondary mini" id="refreshBackgrounds" type="button">↻ Refresh</button>
              </div>
            </div>
            <div class="builtin-backgrounds" id="builtinBackgrounds"><div class="quiet-card">Loading background suggestions…</div></div>
            <label class="upload-box compact" for="backgroundFile">
              <input id="backgroundFile" type="file" accept="video/*,image/*,.mp4,.mov,.webm,.jpg,.jpeg,.png,.webp" multiple />
              <span class="upload-title">Add background clip(s)</span>
              <span class="upload-sub" id="backgroundFileName">You can add more than one image or video</span>
            </label>
            <div class="clip-timeline" id="bgTimeline"></div>
            <div class="clip-list" id="bgClipList"></div>
            <div id="bgClipEditor" class="clip-editor quiet-card">Add a background clip to start customizing it.</div>
          </div>
          <div class="appearance-block">
            <div class="block-heading">
              <strong>Text</strong>
              <span>Control size, wrapping, spacing, margins, colors and verse-label placement.</span>
            </div>
            <div class="grid-2">
              <div class="field"><label for="arabicFont">Arabic font</label><select id="arabicFont" aria-describedby="arabicFontStatus"><option value="qpc-v2">Amiri Quran</option><option value="naskh">Classic Naskh</option></select><div id="arabicFontStatus" class="help" data-font-status role="status"></div><div class="arabic-font-sample" lang="ar" dir="rtl">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</div></div>
              <div class="field"><label for="textGap">Arabic/English gap <span id="textGapValue">12px</span></label><input id="textGap" type="range" min="0" max="50" value="12" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="textArabicSize">Arabic size <span id="textArabicSizeValue">44px</span></label><input id="textArabicSize" type="range" min="28" max="200" value="44" /></div>
              <div class="field"><label for="textEnglishSize">Translation size <span id="textEnglishSizeValue">19px</span></label><input id="textEnglishSize" type="range" min="12" max="200" value="19" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="textWidth">Text width <span id="textWidthValue">84%</span></label><input id="textWidth" type="range" min="35" max="95" value="84" /></div>
              <div class="field"><label for="textY">Vertical position <span id="textYValue">50%</span></label><input id="textY" type="range" min="20" max="80" value="50" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="textMarginX">Side margin <span id="textMarginXValue">8%</span></label><input id="textMarginX" type="range" min="0" max="20" value="8" /></div>
              <div class="field"><label for="textMarginY">Top/Bottom margin <span id="textMarginYValue">6%</span></label><input id="textMarginY" type="range" min="0" max="20" value="6" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="textArabicSpacing">Arabic line spacing <span id="textArabicSpacingValue">1.48×</span></label><input id="textArabicSpacing" type="range" min="100" max="260" value="148" /></div>
              <div class="field"><label for="textEnglishSpacing">Translation line spacing <span id="textEnglishSpacingValue">1.42×</span></label><input id="textEnglishSpacing" type="range" min="100" max="260" value="142" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="textArabicColor">Arabic color</label><input id="textArabicColor" type="color" value="#ffffff" /></div>
              <div class="field"><label for="textEnglishColor">Translation color</label><input id="textEnglishColor" type="color" value="#f2f2f2" /></div>
            </div>
            <label class="toggle-row compact-toggle">
              <div><strong>Highlight recitation progress</strong><span>Change the current word or letter color as the reciter reads.</span></div>
              <input id="wordHighlightEnabled" type="checkbox" checked />
            </label>
            <div class="grid-2">
              <div class="field"><label for="highlightGranularity">Highlight style</label><select id="highlightGranularity"><option value="word" selected>Word by word · recommended</option><option value="letter">Letter by letter</option></select><div class="help">Word by word is the default and usually looks smoother. Letter mode uses the editable letter timings.</div></div>
              <div class="field"><label for="wordHighlightColor">Highlight color</label><input id="wordHighlightColor" type="color" value="#f6c453" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="textStrokeWidth">Outline width <span id="textStrokeWidthValue">3px</span></label><input id="textStrokeWidth" type="range" min="0" max="10" value="3" /></div>
              <div class="field"><label for="textStrokeOpacity">Outline opacity <span id="textStrokeOpacityValue">52%</span></label><input id="textStrokeOpacity" type="range" min="0" max="100" value="52" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="textShadowBlur">Shadow blur <span id="textShadowBlurValue">11px</span></label><input id="textShadowBlur" type="range" min="0" max="30" value="11" /></div>
              <div class="field"><label for="textShadowOpacity">Shadow opacity <span id="textShadowOpacityValue">80%</span></label><input id="textShadowOpacity" type="range" min="0" max="100" value="80" /></div>
            </div>
            <label class="toggle-row compact-toggle">
              <div><strong>Verse reference</strong><span>Show the surah:ayah label under each phrase.</span></div>
              <input id="verseLabelEnabled" type="checkbox" checked />
            </label>
            <div class="grid-2">
              <div class="field"><label for="verseLabelSize">Verse label size <span id="verseLabelSizeValue">12px</span></label><input id="verseLabelSize" type="range" min="8" max="200" value="12" /></div>
              <div class="field"><label for="verseLabelY">Surah / verse block position <span id="verseLabelYValue">27%</span></label><input id="verseLabelY" type="range" min="8" max="88" value="27" /></div>
            </div>
          </div>
          <div class="appearance-block shadow-overlay-block">
            <div class="block-heading">
              <strong>Circular shadow overlay</strong>
              <span>Add the included soft black shadow behind the subtitles, or upload another transparent PNG. Position and resize it freely.</span>
            </div>
            <label class="toggle-row compact-toggle">
              <div><strong>Enable shadow overlay</strong><span>The shadow is placed above the background and behind all subtitle text.</span></div>
              <input id="shadowEnabled" type="checkbox" />
            </label>
            <div class="shadow-source-actions">
              <button class="secondary" id="useIncludedShadow" type="button">Use included circular shadow</button>
              <label class="secondary shadow-upload" for="shadowFile">Upload shadow PNG<input id="shadowFile" type="file" accept="image/png,image/webp,.png,.webp" hidden /></label>
              <span id="shadowFileName">No shadow selected</span>
            </div>
            <div class="grid-2">
              <div class="field"><label for="shadowX">Horizontal position <span id="shadowXValue">50%</span></label><input id="shadowX" type="range" min="-25" max="125" value="50" /></div>
              <div class="field"><label for="shadowY">Vertical position <span id="shadowYValue">76%</span></label><input id="shadowY" type="range" min="-25" max="125" value="76" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="shadowSize">Size <span id="shadowSizeValue">100%</span></label><input id="shadowSize" type="range" min="20" max="220" value="100" /></div>
              <div class="field"><label for="shadowOpacity">Opacity <span id="shadowOpacityValue">100%</span></label><input id="shadowOpacity" type="range" min="0" max="100" value="100" /></div>
            </div>
            <div class="help">The X/Y sliders can move the shadow partially outside the frame, so you can place only the soft edge where you want it.</div>
          </div>
        </div>
      </section>

      <section class="panel" data-step="5">
        <div class="eyebrow">Watermark</div>
        <h1>Add a watermark.</h1>
        <p class="lead">Optional. Use text, a transparent image, or an animated video watermark.</p>
        <div class="segmented" id="watermarkType">
          <button data-wm="none" class="selected" type="button">None</button>
          <button data-wm="text" type="button">Text</button>
          <button data-wm="image" type="button">Image</button>
          <button data-wm="video" type="button">Video</button>
        </div>
        <div id="watermarkControls"></div>
        <div class="preview-inline" id="watermarkPreview"></div>
      </section>

      <section class="panel" data-step="6">
        <div class="eyebrow">Export</div>
        <h1>Make the video.</h1>
        <p class="lead">Rendering uses the local Python FFmpeg backend, so there is no FFmpeg.wasm worker or Vite video-engine issue.</p>

        <div class="retention-card">
          <label class="toggle-row retention-toggle">
            <div><strong>Shorts Retention Mode</strong><span>Starts on the voice, uses a first-second hook and motion, and makes a phrase-safe 15–25 second cut.</span></div>
            <input id="retentionEnabled" type="checkbox" checked />
          </label>
          <div id="retentionControls">
            <div class="grid-2">
              <div class="field"><label for="retentionHook">Opening hook</label><input id="retentionHook" type="text" value="A verse that calms the heart" /></div>
              <div class="field"><label for="retentionDuration">Target length <span id="retentionDurationValue">22s</span></label><input id="retentionDuration" type="range" min="15" max="25" step="1" value="22" /></div>
            </div>
            <div class="grid-2">
              <label class="toggle-row compact-toggle"><div><strong>Strongest detected opening</strong><span>Begins at the highest-energy ayah opening.</span></div><input id="retentionSmartOpening" type="checkbox" checked /></label>
              <label class="toggle-row compact-toggle"><div><strong>Motion from frame 1</strong><span>Adds a subtle cinematic push to every background.</span></div><input id="retentionMotion" type="checkbox" checked /></label>
            </div>
            <div class="help" id="retentionPlan">The final cut will be calculated from the synchronized phrases.</div>
          </div>
        </div>

        <div class="intro-card">
          <label class="toggle-row intro-toggle">
            <div><strong>Enable Intro Title Card</strong><span>Play a short kinetic-typography reveal before the recitation begins.</span></div>
            <input id="introEnabled" type="checkbox" />
          </label>
          <div id="introControls">
            <div class="grid-2">
              <div class="field"><label for="introArabic">Arabic intro text</label><input id="introArabic" type="text" dir="rtl" value="مَقَامُ الْعَجَمِ" /></div>
              <div class="field"><label for="introEnglish">English subtitle</label><input id="introEnglish" type="text" value="Maqam al-Ajam" /></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="introDuration">Intro duration <span id="introDurationValue">2.6s</span></label><input id="introDuration" type="range" min="1" max="5" step="0.1" value="2.6" /></div>
              <div class="field"><label for="introSound">Sound design</label><select id="introSound"><option value="deep">Deep cinematic hit</option><option value="swoosh">Soft swoosh</option><option value="none">No sound effect</option></select></div>
            </div>
            <div class="intro-actions">
              <button class="secondary mini" id="introUseSurah" type="button">Use Surah name</button>
              <button class="primary mini" id="introPreviewBtn" type="button">▶ Preview intro</button>
            </div>
            <div class="intro-preview-shell"><canvas id="introPreviewCanvas"></canvas></div>
            <div class="help" data-font-status role="status"></div>
            <div class="help">The recitation audio begins only after this intro finishes, so enabling the intro does not change any word-sync timings.</div>
          </div>
        </div>

        <div class="field">
          <label for="format">Format</label>
          <select id="format">
            <option value="9:16">9:16 · Reel / TikTok</option>
            <option value="16:9">16:9 · YouTube</option>
            <option value="1:1">1:1 · Square</option>
          </select>
        </div>
        <div class="field">
          <label for="quality">Resolution</label>
          <select id="quality">
            <option value="720">720p · Faster</option>
            <option value="1080">1080p · Higher quality</option>
          </select>
        </div>
        <label class="toggle-row">
          <div><strong>Saheeh International</strong><span>Show the translation under each Arabic phrase.</span></div>
          <input id="translationToggle" type="checkbox" checked />
        </label>
        <div class="grid-2">
          <div class="field"><label for="globalFadeIn">Whole clip fade in <span id="globalFadeInValue">0.0s</span></label><input id="globalFadeIn" type="range" min="0" max="5" step="0.1" value="0" /></div>
          <div class="field"><label for="globalFadeOut">Whole clip fade out <span id="globalFadeOutValue">0.0s</span></label><input id="globalFadeOut" type="range" min="0" max="5" step="0.1" value="0" /></div>
        </div>
        <div class="summary" id="exportSummary"></div>
        <button class="primary wide" id="generateBtn" type="button">Generate MP4</button>
        <div class="status" id="exportStatus">Ready.</div>
        <div class="progress"><div id="renderProgress"></div></div>
        <a id="downloadLink" class="download" hidden>Download finished video</a>
      </section>

      <footer class="nav">
        <button class="secondary" id="backBtn" type="button">Back</button>
        <button class="primary" id="nextBtn" type="button">Next</button>
      </footer>
    </section>
  </main>
`;

const STEP_NAMES = ['Recitation', 'Passage', 'Sync', 'Edit', 'Finish'];
const PROJECT_DB_NAME = 'quran-sync-projects-v1';
const PROJECT_STORE = 'projects';
const PROJECT_CONTROL_IDS = [
  'surah','verseRanges','istiathaMode','basmalahMode','libraryReciter','librarySurah','libraryStart','libraryEnd','libraryIstiatha','libraryBasmalah',
  'phraseStyle','arabicFont','textArabicSize','textEnglishSize','textWidth','textY','textMarginX','textMarginY','textArabicSpacing','textEnglishSpacing','textGap',
  'textArabicColor','textEnglishColor','wordHighlightEnabled','highlightGranularity','wordHighlightColor','textStrokeWidth','textStrokeOpacity','textShadowBlur','textShadowOpacity',
  'verseLabelEnabled','verseLabelSize','verseLabelY','format','quality','translationToggle','globalFadeIn','globalFadeOut','retentionEnabled','retentionHook','retentionDuration',
  'retentionSmartOpening','retentionMotion','introEnabled','introArabic','introEnglish','introDuration','introSound',
  'shadowEnabled','shadowX','shadowY','shadowSize','shadowOpacity'
];

function openProjectDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the project database.'));
  });
}

async function projectDbRequest(mode, action) {
  const db = await openProjectDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PROJECT_STORE, mode);
    const request = action(transaction.objectStore(PROJECT_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Project database request failed.'));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error || new Error('Project database transaction failed.'));
  });
}

const listSavedProjects = () => projectDbRequest('readonly', store => store.getAll());
const getSavedProject = id => projectDbRequest('readonly', store => store.get(id));
const putSavedProject = project => projectDbRequest('readwrite', store => store.put(project));
const removeSavedProject = id => projectDbRequest('readwrite', store => store.delete(id));

function projectControlValues() {
  const values = {};
  PROJECT_CONTROL_IDS.forEach(id => {
    const el = $(id);
    if (el) values[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return values;
}

function serializableBackgroundClip(clip) {
  const { file, url, element, ...settings } = clip || {};
  return { settings, file: file || null };
}

function createProjectSnapshot(id, name, createdAt = Date.now()) {
  syncWatermarkStateFromControls();
  syncShadowStateFromControls();
  syncRetentionState();
  syncIntroState();
  state.translation = $('translationToggle')?.checked ?? state.translation;
  return {
    id, name, createdAt, updatedAt: Date.now(), version: 1,
    data: {
      controls: projectControlValues(),
      state: {
        step: state.step, sourceMode: state.sourceMode, librarySelection: state.librarySelection, duration: state.duration,
        ayahs: state.ayahs, selectedNumbers: state.selectedNumbers, syncMode: state.syncMode, wordTimings: state.wordTimings, groups: state.groups,
        phraseStyle: state.phraseStyle, translation: state.translation, selectedWord: state.selectedWord, selectedLetter: state.selectedLetter,
        groupBreaks: state.groupBreaks, translationOverrides: state.translationOverrides, highlightOverrides: state.highlightOverrides,
        selectedBackgroundClip: state.selectedBackgroundClip, watermarkType: state.watermarkType, watermarkSettings: state.watermarkSettings,
        globalFade: state.globalFade, intro: state.intro, retention: state.retention, zoom: state.zoom,
        shadowOverlay: { enabled: state.shadowOverlay.enabled, x: state.shadowOverlay.x, y: state.shadowOverlay.y, size: state.shadowOverlay.size, opacity: state.shadowOverlay.opacity },
        alignmentReviewReady: state.alignmentReviewReady, pendingWordDeletions: [...state.pendingWordDeletions],
      },
      audioFile: state.audioFile,
      backgroundClips: state.backgroundClips.map(serializableBackgroundClip),
      watermarkFile: state.watermarkFile,
      shadowFile: state.shadowOverlay.file,
    },
  };
}

function suggestedProjectName() {
  const surah = currentSurah();
  const range = formatRangeLabel(state.selectedNumbers) || $('verseRanges')?.value?.trim();
  return range ? `${surah?.englishName || 'Qur’an'} ${range}` : state.audioFile?.name?.replace(/\.[^.]+$/, '') || 'Untitled project';
}

async function saveCurrentProject({ askName = false, quiet = false } = {}) {
  if (state.projectSaveBusy) return;
  let name = state.currentProjectName;
  if (!state.currentProjectId || askName) {
    name = prompt('Project name', state.currentProjectId ? name : suggestedProjectName());
    if (name == null) return;
    name = name.trim() || suggestedProjectName();
  }
  state.projectSaveBusy = true;
  const button = $('saveProjectBtn');
  if (button) { button.disabled = true; button.textContent = 'Saving…'; }
  try {
    const id = state.currentProjectId || (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const existing = state.currentProjectId ? await getSavedProject(id) : null;
    await putSavedProject(createProjectSnapshot(id, name, existing?.createdAt || Date.now()));
    state.currentProjectId = id;
    state.currentProjectName = name;
    if (!quiet) setStatus('dashboardStatus', `Saved “${name}” on this browser.`, 'ok');
  } catch (error) {
    if (!quiet) alert(error.message || String(error));
  } finally {
    state.projectSaveBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = quiet ? 'Save' : 'Saved ✓';
      if (!quiet) setTimeout(() => { if (!state.projectSaveBusy) button.textContent = 'Save'; }, 1400);
    }
  }
}

function applyProjectControls(values = {}) {
  Object.entries(values).forEach(([id, value]) => setControlValue(id, value));
  updateLibraryVerseBounds();
  updateAppearanceLabels();
}

async function restoreProject(project) {
  if (!project?.data) throw new Error('This project file is invalid.');
  const saved = project.data.state || {};
  $('audioPreview')?.pause();
  if (project.data.audioFile) await loadAudio(project.data.audioFile, { preserveLibrary: true });
  else {
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioFile = null; state.audioUrl = null; state.audioBuffer = null; state.envelope = null; state.duration = 0;
    if ($('audioPreview')) $('audioPreview').removeAttribute('src');
  }
  state.backgroundClips.forEach(clip => { if (clip.url) URL.revokeObjectURL(clip.url); });
  state.backgroundClips = [];
  if (project.data.backgroundClips?.length) {
    await addBackgroundFiles(project.data.backgroundClips.map(item => item.file).filter(Boolean));
    project.data.backgroundClips.forEach((item, index) => {
      if (state.backgroundClips[index]) Object.assign(state.backgroundClips[index], item.settings || {});
    });
  }
  Object.assign(state, saved, {
    currentProjectId: project.id, currentProjectName: project.name || 'Untitled project',
    pendingWordDeletions: new Set(saved.pendingWordDeletions || []), backgroundClips: state.backgroundClips, projectSaveBusy: false,
  });
  applyProjectControls(project.data.controls || {});
  setSourceMode(saved.sourceMode || 'upload');
  document.querySelectorAll('[data-sync]').forEach(button => button.classList.toggle('selected', button.dataset.sync === state.syncMode));
  state.watermarkFile = project.data.watermarkFile || null;
  state.watermarkType = saved.watermarkType || 'none';
  document.querySelectorAll('[data-wm]').forEach(button => button.classList.toggle('selected', button.dataset.wm === state.watermarkType));
  renderWatermarkControls();
  if (state.watermarkFile) await loadWatermarkMedia();
  const savedShadow = saved.shadowOverlay || {};
  state.shadowOverlay = { ...state.shadowOverlay, ...savedShadow, file: project.data.shadowFile || null, url: null, element: null };
  if (state.shadowOverlay.file) await loadShadowFile(state.shadowOverlay.file, { enable: state.shadowOverlay.enabled });
  syncShadowControls();
  state.selectedBackgroundClip = clamp(Number(saved.selectedBackgroundClip || 0), 0, Math.max(0, state.backgroundClips.length - 1));
  $('audioFileName').textContent = state.audioFile?.name || 'MP3, WAV, M4A, AAC or OGG';
  if (state.audioFile) setStatus('audioStatus', `${state.audioFile.name} · ${state.duration.toFixed(1)} seconds`, 'ok');
  $('zoomLabel').textContent = `${Number(state.zoom || 1).toFixed(state.zoom % 1 ? 1 : 0)}×`;
  syncRetentionState(); syncIntroState(); hideProjectDashboard(); renderSteps();
}

function blobToDataUrl(blob) {
  if (!blob) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: blob.name || 'media.bin', type: blob.type || 'application/octet-stream', data: reader.result });
    reader.onerror = () => reject(reader.error || new Error('Could not read project media.'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToFile(media) {
  if (!media?.data) return null;
  const [head, body] = media.data.split(',', 2);
  const mime = media.type || head.match(/^data:([^;]+)/)?.[1] || 'application/octet-stream';
  const binary = atob(body || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], media.name || 'media.bin', { type: mime });
}

async function portableProject(project) {
  const copy = structuredClone(project);
  copy.magic = 'quran-sync-project';
  copy.data.audioFile = await blobToDataUrl(project.data.audioFile);
  copy.data.watermarkFile = await blobToDataUrl(project.data.watermarkFile);
  copy.data.shadowFile = await blobToDataUrl(project.data.shadowFile);
  copy.data.backgroundClips = await Promise.all((project.data.backgroundClips || []).map(async item => ({ settings: item.settings, file: await blobToDataUrl(item.file) })));
  return copy;
}

async function downloadProject(project) {
  const portable = await portableProject(project);
  const blob = new Blob([JSON.stringify(portable)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${String(project.name || 'quran-project').replace(/[^a-z0-9_-]+/gi, '-')}.qsync`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importPortableProject(file) {
  const payload = JSON.parse(await file.text());
  if (payload.magic !== 'quran-sync-project' || !payload.data) throw new Error('That is not a Qur’an Sync project file.');
  payload.id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  payload.name = `${payload.name || 'Imported project'} (imported)`;
  payload.createdAt = Date.now(); payload.updatedAt = Date.now();
  payload.data.audioFile = dataUrlToFile(payload.data.audioFile);
  payload.data.watermarkFile = dataUrlToFile(payload.data.watermarkFile);
  payload.data.shadowFile = dataUrlToFile(payload.data.shadowFile);
  payload.data.backgroundClips = (payload.data.backgroundClips || []).map(item => ({ settings: item.settings || {}, file: dataUrlToFile(item.file) }));
  await putSavedProject(payload);
  await restoreProject(payload);
}

async function renderProjectDashboard() {
  const grid = $('projectGrid');
  if (!grid) return;
  try {
    const projects = (await listSavedProjects()).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    grid.innerHTML = projects.length ? projects.map(project => {
      const saved = project.data?.state || {};
      const surahNumber = project.data?.controls?.surah;
      const surah = getSurah(Number(surahNumber));
      const passage = project.data?.controls?.verseRanges || formatRangeLabel(saved.selectedNumbers || []);
      return `<article class="project-card" data-project-id="${escapeHtml(project.id)}"><button class="project-open" type="button"><span class="project-icon">${surahNumber || '۞'}</span><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(surah?.englishName || 'Qur’an project')}${passage ? ` · ${escapeHtml(passage)}` : ''}</span><small>Saved ${new Date(project.updatedAt).toLocaleString()}</small></button><div class="project-card-actions"><button data-project-action="rename" type="button">Rename</button><button data-project-action="export" type="button">Export</button><button class="danger-text" data-project-action="delete" type="button">Delete</button></div></article>`;
    }).join('') : '<div class="dashboard-empty"><strong>No saved projects yet.</strong><span>Start a new edit, then press Save. It will appear here.</span></div>';
    grid.querySelectorAll('.project-open').forEach(button => button.addEventListener('click', async () => {
      await restoreProject(await getSavedProject(button.closest('[data-project-id]').dataset.projectId));
    }));
    grid.querySelectorAll('[data-project-action]').forEach(button => button.addEventListener('click', async () => {
      const id = button.closest('[data-project-id]').dataset.projectId;
      const project = await getSavedProject(id);
      if (button.dataset.projectAction === 'export') await downloadProject(project);
      if (button.dataset.projectAction === 'rename') {
        const name = prompt('Project name', project.name);
        if (name?.trim()) {
          project.name = name.trim(); project.updatedAt = Date.now(); await putSavedProject(project);
          if (state.currentProjectId === id) state.currentProjectName = project.name;
          await renderProjectDashboard();
        }
      }
      if (button.dataset.projectAction === 'delete' && confirm(`Delete “${project.name}”?`)) {
        await removeSavedProject(id);
        if (state.currentProjectId === id) { state.currentProjectId = null; state.currentProjectName = 'Untitled project'; }
        await renderProjectDashboard();
      }
    }));
  } catch (error) {
    grid.innerHTML = `<div class="dashboard-empty"><strong>Could not load projects.</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
  }
}

async function showProjectDashboard() {
  $('projectDashboard')?.classList.add('visible');
  await renderProjectDashboard();
}

function hideProjectDashboard() { $('projectDashboard')?.classList.remove('visible'); }

function setStatus(id, text, tone = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `status ${tone}`.trim();
}

function renderSteps() {
  $('steps').innerHTML = STEP_NAMES.map((_, i) => `<span class="step-dot ${i === state.step ? 'active' : ''} ${i < state.step ? 'done' : ''}"></span>`).join('');
  $('stepLabel').textContent = `${state.step + 1} / ${STEP_NAMES.length}`;
  document.querySelectorAll('.panel').forEach((panel, i) => {
    const show = state.step === 4 ? [4, 5, 6].includes(i) : i === state.step;
    panel.classList.toggle('active', show);
    panel.classList.toggle('stacked', state.step === 4 && [4, 5, 6].includes(i));
  });
  $('backBtn').hidden = state.step === 0;
  $('nextBtn').hidden = state.step === 2 || state.step === 4;
  $('nextBtn').textContent = state.step === 3 ? 'Finish setup' : 'Next';
  const titleMap = ['Choose the recitation', 'Choose the passage', 'Analyze word timing', 'Fine-tune word timing', 'Customize, watermark and export'];
  $('nextBtn').title = titleMap[state.step] || 'Next';
  if (state.step === 3) {
    requestAnimationFrame(() => {
      renderAlignmentReview();
      renderTimeline();
      renderWordEditor();
      renderPhraseStrip();
      renderEditorPreview();
    });
  }
  if (state.step !== 4 && $('audioPreview')) $('audioPreview').volume = 1;
  if (state.step === 4) {
    renderBuiltinBackgrounds();
    syncBackgroundEditorControls();
    renderBackgroundClipList();
    syncShadowControls();
    renderAppearancePreview();
    renderWatermarkControls();
    renderWatermarkPreview();
    renderIntroPreviewStatic();
    renderExportSummary();
  }
}

function currentSurah() {
  return getSurah(Number($('surah').value));
}

function populateSurahs() {
  const options = SURAHS.map(s => `<option value="${s.number}">${s.number}. ${escapeHtml(s.englishName)} · ${escapeHtml(s.arabicName)}</option>`).join('');
  $('surah').innerHTML = options;
  $('surah').value = '1';
  if ($('librarySurah')) {
    $('librarySurah').innerHTML = options;
    $('librarySurah').value = '1';
    updateLibraryVerseBounds();
  }
}

function setSourceMode(mode) {
  state.sourceMode = mode === 'library' ? 'library' : 'upload';
  document.querySelectorAll('[data-source]').forEach(button => button.classList.toggle('selected', button.dataset.source === state.sourceMode));
  document.querySelectorAll('[data-source-pane]').forEach(pane => pane.classList.toggle('active', pane.dataset.sourcePane === state.sourceMode));
}


function updateLibraryPrefixOptions() {
  const surahNumber = Number($('librarySurah')?.value || 1);
  const start = Number($('libraryStart')?.value || 1);
  const basmalah = $('libraryBasmalah');
  const help = $('libraryPrefixHelp');
  if (!basmalah) return;
  const unavailable = surahNumber === 9 || (surahNumber === 1 && start === 1);
  basmalah.disabled = unavailable;
  if (unavailable) basmalah.checked = false;
  if (help) {
    if (surahNumber === 9) help.textContent = "Basmalah is disabled for At-Tawbah. Isti'adhah remains optional.";
    else if (surahNumber === 1 && start === 1) help.textContent = "Al-Fatihah 1 already is the basmalah, so a second copy is not added. Isti'adhah remains optional.";
    else help.textContent = "Optional opening phrases are added before the selected ayahs and handled separately by the synchronizer.";
  }
}

function updateLibraryVerseBounds() {
  if (!$('librarySurah') || !$('libraryStart') || !$('libraryEnd')) return;
  const surah = getSurah(Number($('librarySurah').value || 1)) || SURAHS[0];
  const max = Number(surah.ayahCount || 1);
  $('libraryStart').max = String(max);
  $('libraryEnd').max = String(max);
  let start = clamp(Number($('libraryStart').value || 1), 1, max);
  let end = clamp(Number($('libraryEnd').value || start), 1, max);
  if (end < start) end = start;
  $('libraryStart').value = String(start);
  $('libraryEnd').value = String(end);
  updateLibraryPrefixOptions();
}

async function loadLibraryRecitation() {
  const reciter = $('libraryReciter')?.value || 'mishary_alafasi';
  const surahNumber = Number($('librarySurah')?.value || 1);
  const surah = getSurah(surahNumber);
  if (!surah) throw new Error('Choose a valid Surah.');
  updateLibraryVerseBounds();
  const start = Number($('libraryStart').value || 1);
  const end = Number($('libraryEnd').value || start);
  const wantIstiatha = !!$('libraryIstiatha')?.checked;
  let wantBasmalah = !!$('libraryBasmalah')?.checked;
  if (start < 1 || end < start || end > surah.ayahCount) throw new Error(`Choose ayahs between 1 and ${surah.ayahCount}.`);
  if (surahNumber === 9) wantBasmalah = false;
  if (surahNumber === 1 && start === 1) wantBasmalah = false;
  const button = $('loadLibraryRecitation');
  button.disabled = true;
  setStatus('libraryStatus', `Downloading ${surah.englishName} ${start}${end !== start ? `–${end}` : ''}…`);
  try {
    const params = new URLSearchParams({
      reciter,
      surah: String(surahNumber),
      start: String(start),
      end: String(end),
      istiatha: wantIstiatha ? 'true' : 'false',
      basmalah: wantBasmalah ? 'true' : 'false',
    });
    const response = await fetch(`${API}/api/library/recitation?${params.toString()}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || `Could not load recitation (HTTP ${response.status}).`);
    }
    const blob = await response.blob();
    const reciterName = decodeURIComponent(response.headers.get('X-Quran-Reciter') || $('libraryReciter').selectedOptions[0]?.textContent || 'Quran reciter');
    const filename = `${reciter.replace(/[^a-z0-9_-]+/gi, '-')}-${surahNumber}-${start}-${end}.m4a`;
    const file = new File([blob], filename, { type: blob.type || 'audio/mp4' });
    const includedIstiatha = response.headers.get('X-Quran-Istiatha') === '1';
    const includedBasmalah = response.headers.get('X-Quran-Basmalah') === '1';
    state.librarySelection = { reciter, reciterName, surahNumber, start, end, istiatha: includedIstiatha, basmalah: includedBasmalah };
    state.sourceMode = 'library';
    $('surah').value = String(surahNumber);
    $('verseRanges').value = start === end ? String(start) : `${start}-${end}`;
    if ($('istiathaMode')) $('istiathaMode').value = includedIstiatha ? 'always' : 'never';
    if ($('basmalahMode')) $('basmalahMode').value = includedBasmalah ? 'always' : 'never';
    await loadAudio(file, { preserveLibrary: true });
    const prefixBits = [includedIstiatha ? "isti'adhah" : '', includedBasmalah ? 'basmalah' : ''].filter(Boolean);
    setStatus('libraryStatus', `${reciterName} · ${surah.englishName} ${start}${end !== start ? `–${end}` : ''}${prefixBits.length ? ` · + ${prefixBits.join(' + ')}` : ''} · ${state.duration.toFixed(1)}s`, 'ok');
  } finally {
    button.disabled = false;
  }
}

async function loadAudio(file, options = {}) {
  if (!file) return;
  try {
    setStatus('audioStatus', 'Analyzing audio…');
    if (!options.preserveLibrary) {
      state.sourceMode = 'upload';
      state.librarySelection = null;
      setSourceMode('upload');
    }
    state.audioFile = file;
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    $('audioFileName').textContent = file.name;
    state.audioBuffer = await decodeAudioFile(file);
    state.envelope = buildEnvelope(state.audioBuffer, 14);
    state.duration = state.audioBuffer.duration;
    $('audioPreview').src = state.audioUrl;
    state.wordTimings = [];
    state.groups = [];
    state.alignmentReviewReady = false;
    state.pendingWordDeletions.clear();
    setStatus('audioStatus', `${file.name} · ${state.duration.toFixed(1)} seconds`, 'ok');
  } catch (error) {
    setStatus('audioStatus', error.message || String(error), 'error');
  }
}

async function loadPassage() {
  const surah = currentSurah();
  if (!surah) throw new Error('Choose a Surah.');
  const numbers = parseVerseRanges($('verseRanges').value, surah.ayahCount);
  setStatus('passageStatus', 'Loading Qur’an text and Saheeh International…');
  const ayahs = await fetchSelectedAyahs(surah.number, numbers);
  state.ayahs = ayahs;
  state.selectedNumbers = numbers;
  state.wordTimings = [];
  state.groups = [];
  state.groupBreaks = {};
  state.translationOverrides = {};
  state.highlightOverrides = {};
  state.alignmentReviewReady = false;
  state.pendingWordDeletions.clear();
  const count = ayahs.reduce((sum, ayah) => sum + splitArabicWordObjects(ayah.text).length, 0);
  setStatus('passageStatus', `${surah.englishName} ${formatRangeLabel(numbers)} · ${count} words`, 'ok');
}

function flattenWords() {
  const out = [];
  let global = 0;
  for (const ayah of state.ayahs) {
    splitArabicWordObjects(ayah.text).forEach((word, wordIndex) => {
      out.push({
        index: global++,
        ayahNumber: ayah.number,
        sequenceIndex: ayah.sequenceIndex ?? 0,
        occurrenceIndex: ayah.occurrenceIndex ?? 0,
        occurrenceKey: ayah.occurrenceKey || `${ayah.number}@${ayah.sequenceIndex ?? 0}`,
        wordIndex,
        display: word.display,
        bare: word.bare,
        stop: word.stop,
      });
    });
  }
  return out;
}

async function checkBackend() {
  try {
    const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.backend = await response.json();
    const deps = state.backend.dependencies || {};
    const ready = deps.torch && deps.transformers && deps.soundfile && deps.imageio_ffmpeg;
    $('backendDot').className = `dot ${ready ? 'ok' : 'warn'}`;
    $('backendTitle').textContent = ready ? 'AI backend ready' : 'AI backend running, setup incomplete';
    $('backendText').textContent = ready
      ? `AI Precise: ${state.backend.alignment_model}. First run downloads models if needed.`
      : 'Run setup-ai.ps1 so Torch, Transformers and FFmpeg dependencies are installed.';
    return ready;
  } catch {
    state.backend = null;
    $('backendDot').className = 'dot error';
    $('backendTitle').textContent = 'AI backend is not running';
    $('backendText').textContent = 'Start this version with start.bat or start.ps1. Fast mode still works without the backend.';
    return false;
  }
}

function buildFastWordTimings() {
  const ayahTimings = alignAyahsToEnvelope(state.ayahs, state.envelope);
  const result = [];
  let global = 0;
  for (let occurrence = 0; occurrence < ayahTimings.length; occurrence += 1) {
    const ayahTiming = ayahTimings[occurrence];
    const ayah = state.ayahs[occurrence];
    const aligned = alignWordsWithinAyah(ayah, ayahTiming, state.envelope);
    aligned.forEach((word, wordIndex) => {
      const acoustic = clamp(Number(word.acoustic || 0), 0, 1);
      const confidence = 0.35 + acoustic * 0.45;
      result.push({
        index: global++, ayahNumber: ayah.number, sequenceIndex: ayah.sequenceIndex ?? occurrence, occurrenceIndex: ayah.occurrenceIndex ?? 0,
        occurrenceKey: ayah.occurrenceKey || `${ayah.number}@${ayah.sequenceIndex ?? occurrence}`, wordIndex, display: word.display, bare: word.bare,
        start: word.start, end: word.end, confidence, confidenceLabel: confidence >= 0.72 ? 'high' : confidence >= 0.52 ? 'medium' : 'low',
        ctcConfidence: 0, boundaryConfidence: acoustic,
      });
    });
  }
  return result.map(word => ({ ...word, letters: buildLetterTimings(word) }));
}

function occurrenceKeyFor(item) {
  return item?.occurrenceKey || `${Number(item?.ayahNumber ?? item?.number ?? 0)}@${Number(item?.sequenceIndex ?? 0)}`;
}

function wordTimingKey(item) {
  return `${occurrenceKeyFor(item)}:${Number(item?.wordIndex ?? 0)}`;
}

function arabicGraphemes(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter('ar', { granularity: 'grapheme' }).segment(value)]
      .map(item => item.segment)
      .filter(segment => segment.trim());
  }
  const graphemes = [];
  for (const char of Array.from(value)) {
    if (/\p{Mark}/u.test(char) && graphemes.length) graphemes[graphemes.length - 1] += char;
    else if (char.trim()) graphemes.push(char);
  }
  return graphemes;
}

function buildLetterTimings(word, acousticTokens = null) {
  const letters = arabicGraphemes(word?.display || word?.bare);
  const start = Number(word?.start || 0);
  const end = Math.max(start + 0.001, Number(word?.end || start + 0.001));
  const duration = end - start;
  const tokens = Array.isArray(acousticTokens) ? acousticTokens.filter(token => Number.isFinite(Number(token.start)) && Number.isFinite(Number(token.end))) : [];
  const acousticBoundaries = tokens.length ? [Number(tokens[0].start), ...tokens.map(token => Number(token.end))] : [];
  const boundaryAt = position => {
    if (!acousticBoundaries.length) return start + duration * position;
    const scaled = clamp(position, 0, 1) * tokens.length;
    const left = Math.min(tokens.length, Math.floor(scaled));
    const right = Math.min(tokens.length, Math.ceil(scaled));
    const fraction = scaled - left;
    const value = acousticBoundaries[left] + (acousticBoundaries[right] - acousticBoundaries[left]) * fraction;
    return clamp(value, start, end);
  };
  return letters.map((text, index) => ({
    index,
    text,
    start: index === 0 ? start : boundaryAt(index / Math.max(1, letters.length)),
    end: index === letters.length - 1 ? end : boundaryAt((index + 1) / Math.max(1, letters.length)),
    confidence: tokens.length ? Number(tokens[Math.min(tokens.length - 1, Math.floor(index * tokens.length / Math.max(1, letters.length)))]?.confidence || 0) : 0,
    source: tokens.length ? 'ai' : 'estimated',
    manuallyEdited: false,
  }));
}

function ensureLetterTimings(word) {
  const graphemes = arabicGraphemes(word?.display || word?.bare);
  if (!Array.isArray(word?.letters) || word.letters.length !== graphemes.length || word.letters.some((letter, index) => letter.text !== graphemes[index])) {
    word.letters = buildLetterTimings(word);
  }
  return word.letters;
}

function fitLetterTimingsToWord(word, oldStart = word.start, oldEnd = word.end) {
  const letters = ensureLetterTimings(word);
  if (!letters.length) return;
  const previousDuration = Math.max(0.001, Number(oldEnd) - Number(oldStart));
  const nextDuration = Math.max(0.001, Number(word.end) - Number(word.start));
  for (const letter of letters) {
    const relativeStart = clamp((Number(letter.start) - Number(oldStart)) / previousDuration, 0, 1);
    const relativeEnd = clamp((Number(letter.end) - Number(oldStart)) / previousDuration, relativeStart, 1);
    letter.start = Number(word.start) + relativeStart * nextDuration;
    letter.end = Number(word.start) + relativeEnd * nextDuration;
  }
  letters[0].start = Number(word.start);
  letters[letters.length - 1].end = Number(word.end);
}

function initializePhraseBreaks() {
  state.groupBreaks = {};
  for (const group of state.groups) {
    const key = occurrenceKeyFor(group);
    if (!state.groupBreaks[key]) state.groupBreaks[key] = [];
    if (!state.groupBreaks[key].includes(group.wordEnd)) state.groupBreaks[key].push(group.wordEnd);
  }
}

function groupTranslationKey(group) {
  return `${occurrenceKeyFor(group)}:${group.wordStart}-${group.wordEnd}`;
}

function highlightModeForGroup(group, fallback = null) {
  const override = state.highlightOverrides[groupTranslationKey(group)];
  if (override === 'word' || override === 'letter') return override;
  const defaultMode = fallback || $('highlightGranularity')?.value || 'word';
  return defaultMode === 'letter' ? 'letter' : 'word';
}

function applyTranslationOverrides() {
  state.groups = state.groups.map(group => {
    const override = state.translationOverrides[groupTranslationKey(group)];
    return override !== undefined ? { ...group, translation: override } : group;
  });
}

function rebuildGroups(useExistingBreaks = false) {
  if (useExistingBreaks && Object.keys(state.groupBreaks).length) {
    state.groups = rebuildGroupsFromBreaks(state.ayahs, state.wordTimings, state.groupBreaks);
  } else {
    state.groups = buildContextAwareGroups(state.ayahs, state.wordTimings, state.phraseStyle);
    initializePhraseBreaks();
  }
  applyTranslationOverrides();
}

function applyAyahSequence(sequence) {
  if (!Array.isArray(sequence) || !sequence.length) return;
  const templates = new Map();
  for (const ayah of state.ayahs) if (!templates.has(ayah.number)) templates.set(ayah.number, ayah);
  const counts = new Map();
  const rebuilt = [];
  sequence.forEach((ayahNumber, sequenceIndex) => {
    const number = Number(ayahNumber);
    let template = templates.get(number);
    if (number === -1) {
      template = makeIstiathaAyah(sequenceIndex);
      template = {
        ...template,
        text: ISTIATHA.text,
        translation: ISTIATHA.translation,
        wordTranslations: [...ISTIATHA.wordTranslations],
        isIstiatha: true,
      };
    } else if (number === 0) {
      template = makeBasmalahAyah(sequenceIndex);
      template = {
        ...template,
        text: BASMALAH.text,
        translation: BASMALAH.translation,
        wordTranslations: [...BASMALAH.wordTranslations],
        isBasmalah: true,
      };
    }
    if (!template) return;
    const occurrenceIndex = counts.get(number) || 0;
    counts.set(number, occurrenceIndex + 1);
    const occurrenceName = number === -1 ? 'istiatha' : number === 0 ? 'basmalah' : String(number);
    rebuilt.push({
      ...template,
      sequenceIndex,
      occurrenceIndex,
      occurrenceKey: `${occurrenceName}@${sequenceIndex}`,
      isIstiatha: number === -1 || !!template.isIstiatha,
      isBasmalah: number === 0 || !!template.isBasmalah,
    });
  });
  if (rebuilt.length) {
    state.ayahs = rebuilt;
    state.selectedNumbers = rebuilt.filter(ayah => Number(ayah.number) > 0).map(ayah => ayah.number);
  }
}


async function runAiAlignment({ detectRepeats = true, preserveTranscript = false } = {}) {
  const ready = await checkBackend();
  if (!ready) throw new Error('AI backend is unavailable. Run start.bat/start.ps1, or use Fast mode.');
  const words = flattenWords();
  const form = new FormData();
  form.append('audio', state.audioFile, state.audioFile.name);
  form.append('transcript', JSON.stringify({ surahNumber: currentSurah().number, words: words.map(word => ({ index: word.index, ayahNumber: word.ayahNumber, sequenceIndex: word.sequenceIndex, occurrenceIndex: word.occurrenceIndex, occurrenceKey: word.occurrenceKey, wordIndex: word.wordIndex, text: word.bare })) }));
  form.append('quran_refine', 'true');
  form.append('detect_repeats', detectRepeats ? 'true' : 'false');
  form.append('istiatha_mode', $('istiathaMode')?.value || 'auto');
  form.append('basmalah_mode', $('basmalahMode')?.value || 'auto');
  setStatus('syncStatus', 'AI Precise is aligning the exact Qur’anic text. On the first run, model downloads can take several minutes…');
  const response = await fetch(`${API}/api/align`, { method: 'POST', body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `AI alignment failed (HTTP ${response.status}).`);
  if (!preserveTranscript && Array.isArray(payload.ayahSequence) && payload.ayahSequence.length) {
    applyAyahSequence(payload.ayahSequence);
  }
  // Re-assert Basmalah metadata after sequence expansion so no repeat/reorder
  // operation can ever inherit the first selected ayah's translation.
  state.ayahs = state.ayahs.map(ayah => {
    if (ayah.isIstiatha || Number(ayah.number) === -1) return {
      ...ayah,
      text: preserveTranscript ? ayah.text : ISTIATHA.text,
      translation: ISTIATHA.translation,
      wordTranslations: preserveTranscript ? [...(ayah.wordTranslations || [])] : [...ISTIATHA.wordTranslations],
      isIstiatha: true,
    };
    if (ayah.isBasmalah || Number(ayah.number) === 0) return {
      ...ayah,
      text: preserveTranscript ? ayah.text : BASMALAH.text,
      translation: BASMALAH.translation,
      wordTranslations: preserveTranscript ? [...(ayah.wordTranslations || [])] : [...BASMALAH.wordTranslations],
      isBasmalah: true,
    };
    return ayah;
  });
  const alignedWords = flattenWords();
  if (!Array.isArray(payload.words) || payload.words.length !== alignedWords.length) {
    throw new Error(`Alignment safety check failed: expected ${alignedWords.length} word timings but received ${Array.isArray(payload.words) ? payload.words.length : 0}. Nothing was applied.`);
  }
  const timingKey = word => `${word.occurrenceKey || `${Number(word.ayahNumber || 0)}@${Number(word.sequenceIndex || 0)}`}:${Number(word.wordIndex || 0)}`;
  const byKey = new Map(payload.words.map(word => [timingKey(word), word]));
  state.wordTimings = alignedWords.map(word => {
    const timing = byKey.get(timingKey(word));
    if (!timing) throw new Error(`Alignment safety check failed for ${word.display || word.bare || 'a word'}. Nothing was applied.`);
    const aligned = { ...word, ...timing };
    aligned.letters = buildLetterTimings(aligned, timing.letterTimings);
    return aligned;
  });
  let previousEnd = -0.001;
  for (const word of state.wordTimings) {
    const start = Number(word.start), end = Number(word.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < -0.01 || end <= start || start + 0.08 < previousEnd) {
      throw new Error('Alignment safety check rejected non-monotonic or invalid word timings. Try AI Precise again or set Basmalah to Not included.');
    }
    previousEnd = Math.max(previousEnd, end);
  }
  state.duration = Number(payload.duration || state.duration);
  const low = state.wordTimings.filter(word => word.confidenceLabel === 'low').length;
  const phonetic = payload.quranPhoneticForcedAlignmentUsed
    ? 'dual Arabic + Qur’an-phonetic forced alignment'
    : payload.quranRefinerUsed ? 'Arabic forced alignment + Qur’an acoustic refinement' : 'Arabic forced alignment';
  const metadataCoverage = Number(payload.phoneticMetadata?.coverage || 0);
  const metadataNote = metadataCoverage > 0 && metadataCoverage < 0.999 ? ` · phonetic metadata ${Math.round(metadataCoverage * 100)}%` : '';
  const repeatSequence = (payload.ayahSequence || []).filter(number => Number(number) > 0);
  const repeatNote = payload.repeatDetected ? ` · repeated ayah detected: ${formatRangeLabel(repeatSequence)}` : '';
  const istiathaNote = payload.leadingIstiatha ? " · isti'adhah aligned separately" : '';
  const basmalahNote = payload.leadingBasmalah ? ' · introductory basmalah aligned separately' : '';
  const stabilityNote = String(payload.engine || '').includes('stable') ? ' · stable selected-ayah timing' : '';
  setStatus('syncStatus', `Aligned ${state.wordTimings.length} words · ${low} low-confidence · ${phonetic}${metadataNote}${stabilityNote}${istiathaNote}${basmalahNote}${repeatNote}`, low ? 'warn' : 'ok');
  state.alignmentReviewReady = true;
  return payload;
}

function renderAlignmentReview() {
  const card = $('alignmentReview');
  if (!card) return;
  card.hidden = !state.alignmentReviewReady || state.syncMode !== 'ai';
  if (card.hidden) return;
  const pendingCount = state.pendingWordDeletions.size;
  $('deleteSelectedBlockBtn').disabled = !state.wordTimings[state.selectedWord];
  $('undoBlockDeletionsBtn').disabled = pendingCount === 0;
  $('recheckBlocksBtn').disabled = pendingCount === 0;
}

function wordBlockLabel(word) {
  const prefix = Number(word?.ayahNumber) === -1 ? "Isti'adhah" : Number(word?.ayahNumber) === 0 ? 'Basmalah' : `Ayah ${word?.ayahNumber}`;
  return `${prefix} · “${word?.display || word?.bare || 'word'}”`;
}

function markSelectedBlockForDeletion() {
  const word = state.wordTimings[state.selectedWord];
  if (!word) return;
  state.pendingWordDeletions.add(wordTimingKey(word));
  renderAlignmentReview();
  renderTimeline();
  setStatus('alignmentReviewStatus', `${wordBlockLabel(word)} marked for deletion. No other word in this ayah will be deleted.`, 'warn');
}

function undoPendingBlockDeletions() {
  state.pendingWordDeletions.clear();
  renderAlignmentReview();
  renderTimeline();
  setStatus('alignmentReviewStatus', 'Pending deletions cleared. The current AI alignment was not changed.', 'ok');
}

function ayahsWithoutPendingWordBlocks() {
  const rebuilt = [];
  for (const ayah of state.ayahs) {
    const occurrenceKey = occurrenceKeyFor(ayah);
    const keptWords = state.wordTimings
      .filter(word => occurrenceKeyFor(word) === occurrenceKey && !state.pendingWordDeletions.has(wordTimingKey(word)))
      .sort((a, b) => Number(a.wordIndex) - Number(b.wordIndex));
    if (!keptWords.length) continue;
    rebuilt.push({
      ...ayah,
      text: keptWords.map(word => word.display || word.bare).join(' '),
      wordTranslations: keptWords.map(word => ayah.wordTranslations?.[Number(word.wordIndex)] || ''),
    });
  }
  const counts = new Map();
  return rebuilt.map((ayah, sequenceIndex) => {
    const number = Number(ayah.number);
    const occurrenceIndex = counts.get(number) || 0;
    counts.set(number, occurrenceIndex + 1);
    const name = number === -1 ? 'istiatha' : number === 0 ? 'basmalah' : String(number);
    return { ...ayah, sequenceIndex, occurrenceIndex, occurrenceKey: `${name}@${sequenceIndex}` };
  });
}

async function recheckPendingBlockDeletions() {
  const button = $('recheckBlocksBtn');
  if (!currentSurah() || !state.audioFile || !state.pendingWordDeletions.size) return;
  const removedWords = state.wordTimings.filter(word => state.pendingWordDeletions.has(wordTimingKey(word)));
  const revisedAyahs = ayahsWithoutPendingWordBlocks();
  if (!revisedAyahs.some(ayah => Number(ayah.number) > 0)) {
    setStatus('alignmentReviewStatus', 'At least one word from a normal ayah must remain for AI alignment.', 'error');
    return;
  }
  const snapshot = {
    ayahs: state.ayahs,
    selectedNumbers: state.selectedNumbers,
    wordTimings: state.wordTimings,
    groups: state.groups,
    groupBreaks: state.groupBreaks,
    translationOverrides: state.translationOverrides,
    highlightOverrides: state.highlightOverrides,
    selectedWord: state.selectedWord,
    selectedLetter: state.selectedLetter,
    pendingWordDeletions: state.pendingWordDeletions,
    basmalahMode: $('basmalahMode')?.value || 'auto',
    istiathaMode: $('istiathaMode')?.value || 'auto',
  };
  button.disabled = true;
  const removedLabels = removedWords.map(wordBlockLabel);
  setStatus('alignmentReviewStatus', `Removing ${removedLabels.join(', ')} and asking AI to check the remaining blocks…`);
  try {
    if (removedWords.some(word => Number(word.ayahNumber) === 0) && $('basmalahMode')) $('basmalahMode').value = 'never';
    if (removedWords.some(word => Number(word.ayahNumber) === -1) && $('istiathaMode')) $('istiathaMode').value = 'never';
    state.ayahs = revisedAyahs;
    state.selectedNumbers = revisedAyahs.filter(ayah => Number(ayah.number) > 0).map(ayah => Number(ayah.number));
    state.wordTimings = [];
    state.groups = [];
    state.groupBreaks = {};
    state.translationOverrides = {};
    state.highlightOverrides = {};
    await runAiAlignment({ detectRepeats: false, preserveTranscript: true });
    state.pendingWordDeletions = new Set();
    state.selectedWord = 0;
    state.selectedLetter = 0;
    rebuildGroups(false);
    renderAlignmentReview();
    renderTimeline();
    renderWordEditor();
    renderPhraseStrip();
    renderEditorPreview();
    const low = state.wordTimings.filter(word => word.confidenceLabel === 'low').length;
    const prefixNote = removedWords.some(word => Number(word.ayahNumber) === 0) ? ' Basmalah detection is now set to Not included.' : '';
    setStatus('alignmentReviewStatus', `Deleted only ${removedLabels.join(', ')}. AI re-check complete · ${low} low-confidence word${low === 1 ? '' : 's'}.${prefixNote}`, low ? 'warn' : 'ok');
  } catch (error) {
    Object.assign(state, snapshot);
    if ($('basmalahMode')) $('basmalahMode').value = snapshot.basmalahMode;
    if ($('istiathaMode')) $('istiathaMode').value = snapshot.istiathaMode;
    renderAlignmentReview();
    renderTimeline();
    renderWordEditor();
    renderPhraseStrip();
    renderEditorPreview();
    setStatus('alignmentReviewStatus', `The revised AI check failed, so the previous alignment was restored. ${error.message || String(error)}`, 'error');
  } finally {
    button.disabled = false;
    renderAlignmentReview();
  }
}


function applyManualLeadingSpecialsForFast() {
  const mainSequence = state.ayahs.filter(ayah => Number(ayah.number) > 0).map(ayah => Number(ayah.number));
  if (!mainSequence.length) return;
  const sequence = [];
  if (($('istiathaMode')?.value || 'auto') === 'always') sequence.push(-1);
  const firstMain = mainSequence[0];
  const alreadyBasmalah = currentSurah().number === 1 && firstMain === 1;
  if (($('basmalahMode')?.value || 'auto') === 'always' && !alreadyBasmalah) sequence.push(0);
  sequence.push(...mainSequence);
  if (sequence.length !== mainSequence.length) applyAyahSequence(sequence);
}

async function analyze() {
  if (!state.audioFile) { setStatus('syncStatus', 'Upload a recitation first.', 'error'); return; }
  if (!state.ayahs.length) { setStatus('syncStatus', 'Choose the ayahs first.', 'error'); return; }
  $('analyzeBtn').disabled = true;
  try {
    if (state.syncMode === 'ai') await runAiAlignment();
    else {
      setStatus('syncStatus', 'Running fast local estimate…');
      applyManualLeadingSpecialsForFast();
      state.wordTimings = buildFastWordTimings();
      setStatus('syncStatus', `Estimated ${state.wordTimings.length} word timings.`, 'ok');
    }
    state.selectedWord = 0;
    rebuildGroups(false);
    state.step = 3;
    renderSteps();
  } catch (error) {
    setStatus('syncStatus', error.message || String(error), 'error');
  } finally {
    $('analyzeBtn').disabled = false;
  }
}

function wordGlobalIndex(ayahNumber, wordIndex, occurrenceKey = null) {
  return state.wordTimings.findIndex(word => word.ayahNumber === ayahNumber && word.wordIndex === wordIndex && (!occurrenceKey || occurrenceKeyFor(word) === occurrenceKey));
}

function groupForWord(word) {
  const key = occurrenceKeyFor(word);
  return state.groups.find(group => occurrenceKeyFor(group) === key && word.wordIndex >= group.wordStart && word.wordIndex <= group.wordEnd) || null;
}

function drawWaveform() {
  const canvas = $('waveCanvas');
  if (!canvas || !state.audioBuffer) return;
  const viewportWidth = Math.max(900, $('timelineViewport').clientWidth || 900);
  const cssWidth = Math.round(viewportWidth * state.zoom);
  const cssHeight = 160;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const channel = state.audioBuffer.getChannelData(0);
  const middle = cssHeight / 2;
  const samplesPerPixel = Math.max(1, Math.floor(channel.length / cssWidth));
  ctx.strokeStyle = 'rgba(25,29,27,.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < cssWidth; x += 1) {
    const start = x * samplesPerPixel;
    const end = Math.min(channel.length, start + samplesPerPixel);
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i += Math.max(1, Math.floor(samplesPerPixel / 20))) {
      const v = channel[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = middle + min * middle * 0.82;
    const y2 = middle + max * middle * 0.82;
    ctx.moveTo(x + 0.5, y1);
    ctx.lineTo(x + 0.5, y2);
  }
  ctx.stroke();
  $('timeline').style.width = `${cssWidth}px`;
  $('timeline').style.height = '232px';
}

function renderTimeline() {
  if (!state.wordTimings.length) return;
  drawWaveform();
  const track = $('wordTrack');
  track.innerHTML = '';
  state.wordTimings.forEach((word, index) => {
    const el = document.createElement('button');
    el.type = 'button';
    const pending = state.pendingWordDeletions.has(wordTimingKey(word));
    el.className = `word-segment ${word.confidenceLabel || 'medium'} ${index === state.selectedWord ? 'selected' : ''}${pending ? ' pending-delete' : ''}`;
    el.dataset.index = String(index);
    el.style.left = `${(word.start / state.duration) * 100}%`;
    el.style.width = `${Math.max(0.12, ((word.end - word.start) / state.duration) * 100)}%`;
    el.innerHTML = `<span class="handle left" data-edge="start"></span><span class="word-label" dir="rtl">${escapeHtml(word.display)}</span><span class="handle right" data-edge="end"></span>`;
    el.addEventListener('click', event => {
      if (event.target.classList.contains('handle')) return;
      selectWord(index, true);
    });
    el.addEventListener('pointerdown', event => startDrag(event, index, event.target.dataset.edge || 'move'));
    track.appendChild(el);
  });
  updatePlayhead();
}

function startDrag(event, index, kind) {
  if (!['start','end','move'].includes(kind)) return;
  event.preventDefault();
  const word = state.wordTimings[index];
  state.drag = {
    index, kind, pointerId: event.pointerId, startX: event.clientX,
    originalStart: word.start, originalEnd: word.end,
    originalPrevEnd: index ? state.wordTimings[index - 1].end : null,
    originalNextStart: index < state.wordTimings.length - 1 ? state.wordTimings[index + 1].start : null,
    affectedWords: [index - 1, index, index + 1].filter(i => i >= 0 && i < state.wordTimings.length).map(i => ({
      index: i,
      start: Number(state.wordTimings[i].start),
      end: Number(state.wordTimings[i].end),
      letters: ensureLetterTimings(state.wordTimings[i]).map(letter => ({ ...letter })),
    })),
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  selectWord(index, false);
}

function adjustBoundary(index, edge, newTime) {
  const words = state.wordTimings;
  const minDur = 0.025;
  const word = words[index];
  if (!word) return;
  const affected = [index - 1, index, index + 1]
    .filter(i => i >= 0 && i < words.length)
    .map(i => ({ word: words[i], start: Number(words[i].start), end: Number(words[i].end) }));
  if (edge === 'start') {
    const low = index ? words[index - 1].start + minDur : 0;
    const high = word.end - minDur;
    const value = clamp(newTime, low, high);
    word.start = value;
    if (index) words[index - 1].end = value;
  } else if (edge === 'end') {
    const low = word.start + minDur;
    const high = index < words.length - 1 ? words[index + 1].end - minDur : state.duration;
    const value = clamp(newTime, low, high);
    word.end = value;
    if (index < words.length - 1) words[index + 1].start = value;
  }
  for (const item of affected) fitLetterTimingsToWord(item.word, item.start, item.end);
  word.confidenceLabel = 'edited';
  rebuildGroups(true);
}

function moveWord(index, delta) {
  const words = state.wordTimings;
  const word = words[index];
  if (!word) return;
  const affected = [index - 1, index, index + 1]
    .filter(i => i >= 0 && i < words.length)
    .map(i => ({ word: words[i], start: Number(words[i].start), end: Number(words[i].end) }));
  const duration = word.end - word.start;
  const low = index ? words[index - 1].start + 0.025 : 0;
  const high = index < words.length - 1 ? words[index + 1].end - 0.025 : state.duration;
  let start = clamp(word.start + delta, low, high - duration);
  let end = start + duration;
  word.start = start;
  word.end = end;
  if (index) words[index - 1].end = start;
  if (index < words.length - 1) words[index + 1].start = end;
  for (const item of affected) fitLetterTimingsToWord(item.word, item.start, item.end);
  word.confidenceLabel = 'edited';
  rebuildGroups(true);
}

window.addEventListener('pointermove', event => {
  if (!state.drag) return;
  const timeline = $('timeline');
  const rect = timeline.getBoundingClientRect();
  const secondsPerPixel = state.duration / Math.max(1, rect.width);
  const delta = (event.clientX - state.drag.startX) * secondsPerPixel;
  for (const snapshot of state.drag.affectedWords || []) {
    const item = state.wordTimings[snapshot.index];
    if (!item) continue;
    item.start = snapshot.start;
    item.end = snapshot.end;
    item.letters = snapshot.letters.map(letter => ({ ...letter }));
  }
  if (state.drag.kind === 'start') adjustBoundary(state.drag.index, 'start', state.drag.originalStart + delta);
  else if (state.drag.kind === 'end') adjustBoundary(state.drag.index, 'end', state.drag.originalEnd + delta);
  else {
    const word = state.wordTimings[state.drag.index];
    word.start = state.drag.originalStart;
    word.end = state.drag.originalEnd;
    if (state.drag.index && state.drag.originalPrevEnd != null) state.wordTimings[state.drag.index - 1].end = state.drag.originalPrevEnd;
    if (state.drag.index < state.wordTimings.length - 1 && state.drag.originalNextStart != null) state.wordTimings[state.drag.index + 1].start = state.drag.originalNextStart;
    moveWord(state.drag.index, delta);
  }
  renderTimeline();
  renderWordEditor();
  renderPhraseStrip();
  renderEditorPreview();
});
window.addEventListener('pointerup', () => { state.drag = null; });

function selectWord(index, play = false) {
  state.selectedWord = clamp(index, 0, state.wordTimings.length - 1);
  state.selectedLetter = 0;
  renderTimeline();
  renderWordEditor();
  renderPhraseStrip();
  renderEditorPreview();
  if (play) playSelectedWord();
}

function playSelectedWord() {
  const word = state.wordTimings[state.selectedWord];
  if (!word) return;
  const audio = $('audioPreview');
  audio.currentTime = Math.max(0, word.start - 0.08);
  audio.play();
  const stop = () => {
    if (audio.currentTime >= word.end + 0.08) {
      audio.pause();
      audio.removeEventListener('timeupdate', stop);
    }
  };
  audio.addEventListener('timeupdate', stop);
}

function setSelectedEdge(edge) {
  const time = $('audioPreview').currentTime || 0;
  adjustBoundary(state.selectedWord, edge, time);
  renderTimeline(); renderWordEditor(); renderPhraseStrip(); renderEditorPreview();
}

function splitAfterSelected() {
  const word = state.wordTimings[state.selectedWord];
  if (!word) return;
  const key = occurrenceKeyFor(word);
  const ayahWords = state.wordTimings.filter(item => occurrenceKeyFor(item) === key);
  if (word.wordIndex >= ayahWords.length - 1) return;
  const arr = state.groupBreaks[key] || (state.groupBreaks[key] = []);
  if (!arr.includes(word.wordIndex)) arr.push(word.wordIndex);
  arr.sort((a,b)=>a-b);
  rebuildGroups(true);
  renderPhraseStrip(); renderWordEditor(); renderEditorPreview();
}

function joinAtSelected() {
  const word = state.wordTimings[state.selectedWord];
  if (!word) return;
  const key = occurrenceKeyFor(word);
  const arr = state.groupBreaks[key] || [];
  const group = groupForWord(word);
  if (!group || group.groupInAyah >= group.groupCountInAyah) return;
  state.groupBreaks[key] = arr.filter(value => value !== group.wordEnd);
  rebuildGroups(true);
  renderPhraseStrip(); renderWordEditor(); renderEditorPreview();
}

function adjustLetterBoundary(wordIndex, letterIndex, edge, newTime) {
  const word = state.wordTimings[wordIndex];
  const letters = word ? ensureLetterTimings(word) : [];
  const letter = letters[letterIndex];
  if (!letter) return;
  const minDuration = 0.008;
  if (edge === 'start' && letterIndex > 0) {
    const value = clamp(Number(newTime), Number(letters[letterIndex - 1].start) + minDuration, Number(letter.end) - minDuration);
    letter.start = value;
    letters[letterIndex - 1].end = value;
    letters[letterIndex - 1].manuallyEdited = true;
  } else if (edge === 'end' && letterIndex < letters.length - 1) {
    const value = clamp(Number(newTime), Number(letter.start) + minDuration, Number(letters[letterIndex + 1].end) - minDuration);
    letter.end = value;
    letters[letterIndex + 1].start = value;
    letters[letterIndex + 1].manuallyEdited = true;
  }
  letter.manuallyEdited = true;
  word.confidenceLabel = 'edited';
}

function playSelectedLetter() {
  const word = state.wordTimings[state.selectedWord];
  const letter = word ? ensureLetterTimings(word)[state.selectedLetter] : null;
  if (!letter) return;
  const audio = $('audioPreview');
  audio.currentTime = Math.max(0, Number(letter.start) - 0.025);
  audio.play();
  const stop = () => {
    if (audio.currentTime >= Number(letter.end) + 0.025) {
      audio.pause();
      audio.removeEventListener('timeupdate', stop);
    }
  };
  audio.addEventListener('timeupdate', stop);
}

function renderWordEditor() {
  const word = state.wordTimings[state.selectedWord];
  if (!word) { $('wordEditor').innerHTML = ''; return; }
  const group = groupForWord(word);
  const letters = ensureLetterTimings(word);
  const groupHighlightMode = group ? highlightModeForGroup(group) : ($('highlightGranularity')?.value || 'word');
  state.selectedLetter = clamp(state.selectedLetter, 0, Math.max(0, letters.length - 1));
  const selectedLetter = letters[state.selectedLetter];
  $('wordEditor').innerHTML = `
    <div class="word-main">
      <div class="word-ar" dir="rtl">${escapeHtml(word.display)}</div>
      <div class="word-meta">${Number(word.ayahNumber) === -1 ? "Isti'adhah" : Number(word.ayahNumber) === 0 ? "Basmalah" : `Ayah ${word.ayahNumber}${Number(word.occurrenceIndex || 0) > 0 ? ` · repeat ${Number(word.occurrenceIndex) + 1}` : ""}`} · word ${word.wordIndex + 1} · <span class="confidence ${word.confidenceLabel}">${escapeHtml(word.confidenceLabel || 'edited')}</span></div>
    </div>
    <div class="field compact-field">
      <label for="editArabic">Arabic word / letters <span>Edit only the displayed text; timing stays unchanged</span></label>
      <input id="editArabic" dir="rtl" type="text" value="${escapeHtml(word.display)}" autocomplete="off" />
    </div>
    ${group ? `<div class="field compact-field phrase-highlight-field"><label for="phraseHighlightMode">Highlight this phrase block <span>Overrides the default for this block only</span></label><select id="phraseHighlightMode"><option value="word" ${groupHighlightMode === 'word' ? 'selected' : ''}>Word by word</option><option value="letter" ${groupHighlightMode === 'letter' ? 'selected' : ''}>Letter by letter</option></select></div>` : ''}
    ${groupHighlightMode === 'letter' ? `<div class="letter-timing-editor">
      <div class="letter-editor-head"><strong>Letter-by-letter highlight</strong><span>Select a letter and adjust its boundary inside this word.</span></div>
      <div class="letter-chip-list" dir="rtl">${letters.map((letter, index) => `<button type="button" class="letter-chip ${index === state.selectedLetter ? 'selected' : ''} ${letter.manuallyEdited ? 'edited' : ''}" data-letter-index="${index}"><b>${escapeHtml(letter.text)}</b><small>${fmt(letter.start)}–${fmt(letter.end)}s</small></button>`).join('')}</div>
      ${selectedLetter ? `<div class="time-pair letter-time-pair">
        <label>Letter start<input id="letterStart" type="number" step="0.001" value="${fmt(selectedLetter.start)}" ${state.selectedLetter === 0 ? 'disabled' : ''}></label>
        <label>Letter end<input id="letterEnd" type="number" step="0.001" value="${fmt(selectedLetter.end)}" ${state.selectedLetter === letters.length - 1 ? 'disabled' : ''}></label>
      </div><div class="editor-actions"><button type="button" id="playLetter">Play selected letter</button><button type="button" id="letterStartPlayhead" ${state.selectedLetter === 0 ? 'disabled' : ''}>Start = playhead</button><button type="button" id="letterEndPlayhead" ${state.selectedLetter === letters.length - 1 ? 'disabled' : ''}>End = playhead</button></div>` : ''}
    </div>` : ''}
    <div class="time-pair"><label>Start<input id="editStart" type="number" step="0.001" value="${fmt(word.start)}"></label><label>End<input id="editEnd" type="number" step="0.001" value="${fmt(word.end)}"></label></div>
    <div class="editor-actions">
      <button type="button" id="playWord">Play word</button>
      <button type="button" id="setStart">Start = playhead</button>
      <button type="button" id="setEnd">End = playhead</button>
      <button type="button" id="nudgeLeft">−10 ms</button>
      <button type="button" id="nudgeRight">+10 ms</button>
    </div>
    <div class="editor-actions secondary-actions">
      <button type="button" id="splitPhrase">Split phrase after this word</button>
      <button type="button" id="joinPhrase" ${group && group.groupInAyah < group.groupCountInAyah ? '' : 'disabled'}>Join with next phrase</button>
    </div>
    ${group ? `<div class="translation-editor"><label for="phraseTranslation">Phrase translation <span>Auto-aligned from Saheeh International; edit if needed</span></label><textarea id="phraseTranslation" rows="2">${escapeHtml(group.translation || '')}</textarea></div>` : ''}
    <div class="keyboard-hint">Keyboard: ← / → moves the selected word by 10 ms · Shift + arrow = 50 ms</div>
  `;
  $('playWord').onclick = playSelectedWord;
  $('setStart').onclick = () => setSelectedEdge('start');
  $('setEnd').onclick = () => setSelectedEdge('end');
  $('nudgeLeft').onclick = () => { moveWord(state.selectedWord, -0.01); renderTimeline(); renderWordEditor(); renderPhraseStrip(); };
  $('nudgeRight').onclick = () => { moveWord(state.selectedWord, 0.01); renderTimeline(); renderWordEditor(); renderPhraseStrip(); };
  $('splitPhrase').onclick = splitAfterSelected;
  $('joinPhrase').onclick = joinAtSelected;
  $('phraseHighlightMode')?.addEventListener('change', event => {
    if (!group) return;
    state.highlightOverrides[groupTranslationKey(group)] = event.target.value === 'letter' ? 'letter' : 'word';
    renderWordEditor();
    renderPhraseStrip();
    renderEditorPreview();
  });
  $('wordEditor').querySelectorAll('[data-letter-index]').forEach(button => button.addEventListener('click', () => {
    state.selectedLetter = Number(button.dataset.letterIndex || 0);
    renderWordEditor();
    playSelectedLetter();
  }));
  $('playLetter')?.addEventListener('click', playSelectedLetter);
  $('letterStartPlayhead')?.addEventListener('click', () => {
    adjustLetterBoundary(state.selectedWord, state.selectedLetter, 'start', Number($('audioPreview').currentTime || 0));
    renderWordEditor(); renderTimeline(); renderEditorPreview();
  });
  $('letterEndPlayhead')?.addEventListener('click', () => {
    adjustLetterBoundary(state.selectedWord, state.selectedLetter, 'end', Number($('audioPreview').currentTime || 0));
    renderWordEditor(); renderTimeline(); renderEditorPreview();
  });
  $('letterStart')?.addEventListener('change', event => {
    adjustLetterBoundary(state.selectedWord, state.selectedLetter, 'start', Number(event.target.value));
    renderWordEditor(); renderTimeline(); renderEditorPreview();
  });
  $('letterEnd')?.addEventListener('change', event => {
    adjustLetterBoundary(state.selectedWord, state.selectedLetter, 'end', Number(event.target.value));
    renderWordEditor(); renderTimeline(); renderEditorPreview();
  });
  $('editStart').onchange = event => { adjustBoundary(state.selectedWord, 'start', Number(event.target.value)); renderTimeline(); renderWordEditor(); renderPhraseStrip(); };
  $('editEnd').onchange = event => { adjustBoundary(state.selectedWord, 'end', Number(event.target.value)); renderTimeline(); renderWordEditor(); renderPhraseStrip(); };
  $('editArabic').oninput = event => {
    const value = String(event.target.value || '').trim();
    if (!value) return;
    word.display = value;
    word.manuallyEditedText = true;
    rebuildGroups(true);
    renderPhraseStrip();
    renderEditorPreview();
    const title = $('wordEditor')?.querySelector('.word-ar');
    if (title) title.textContent = value;
  };
  $('editArabic').onchange = () => {
    word.letters = buildLetterTimings(word);
    state.selectedLetter = 0;
    renderWordEditor();
    renderEditorPreview();
  };
  if ($('phraseTranslation') && group) $('phraseTranslation').oninput = event => { const value = event.target.value; state.translationOverrides[groupTranslationKey(group)] = value; group.translation = value; renderPhraseStrip(); renderEditorPreview(); };
}

function renderPhraseStrip() {
  $('phraseStrip').innerHTML = state.groups.map((group, index) => {
    const activeWord = state.wordTimings[state.selectedWord];
    const active = activeWord && occurrenceKeyFor(group) === occurrenceKeyFor(activeWord) && activeWord.wordIndex >= group.wordStart && activeWord.wordIndex <= group.wordEnd;
    const highlightLabel = highlightModeForGroup(group) === 'letter' ? 'Letter highlight' : 'Word highlight';
    return `<button class="phrase-chip ${active ? 'active' : ''}" data-group="${index}" type="button"><span dir="rtl">${escapeHtml(group.arabic)}</span><em>${escapeHtml(group.translation || '')}</em><small>${fmt(group.start)}–${fmt(group.end)}s · ${highlightLabel}</small></button>`;
  }).join('');
  document.querySelectorAll('.phrase-chip').forEach(button => button.addEventListener('click', () => {
    const group = state.groups[Number(button.dataset.group)];
    const idx = wordGlobalIndex(group.ayahNumber, group.wordStart, occurrenceKeyFor(group));
    if (idx >= 0) selectWord(idx, true);
  }));
}

function dimensions() {
  const quality = Number($('quality')?.value || 720);
  const format = $('format')?.value || '9:16';
  if (format === '16:9') return quality === 1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  if (format === '1:1') return { width: quality, height: quality };
  return quality === 1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
}


function rgba(hex, opacity = 1) {
  const clean = String(hex || '#ffffff').replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map(ch => ch + ch).join('') : clean.padEnd(6, 'f').slice(0, 6);
  const value = Number.parseInt(full, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${clamp(opacity, 0, 1)})`;
}

function textStyle() {
  return {
    arabicFont: $('arabicFont')?.value || 'qpc-v2',
    arabicSize: Number($('textArabicSize')?.value || 70),
    englishSize: Number($('textEnglishSize')?.value || 18),
    maxWidth: Number($('textWidth')?.value || 76) / 100,
    centerY: Number($('textY')?.value || 47) / 100,
    marginX: Number($('textMarginX')?.value || 10) / 100,
    marginY: Number($('textMarginY')?.value || 6) / 100,
    arabicSpacing: Number($('textArabicSpacing')?.value || 136) / 100,
    englishSpacing: Number($('textEnglishSpacing')?.value || 136) / 100,
    gap: Number($('textGap')?.value || 12),
    arabicColor: $('textArabicColor')?.value || '#ffffff',
    wordHighlightEnabled: $('wordHighlightEnabled')?.checked ?? true,
    highlightGranularity: $('highlightGranularity')?.value || 'word',
    wordHighlightColor: $('wordHighlightColor')?.value || '#f6c453',
    englishColor: $('textEnglishColor')?.value || '#f2f2f2',
    strokeWidth: Number($('textStrokeWidth')?.value || 2),
    strokeOpacity: Number($('textStrokeOpacity')?.value || 36) / 100,
    shadowBlur: Number($('textShadowBlur')?.value || 9),
    shadowOpacity: Number($('textShadowOpacity')?.value || 58) / 100,
    verseLabelEnabled: $('verseLabelEnabled')?.checked ?? true,
    verseLabelSize: Number($('verseLabelSize')?.value || 16),
    verseLabelY: Number($('verseLabelY')?.value || 27) / 100,
  };
}

function selectedBackgroundClip() {
  return state.backgroundClips[state.selectedBackgroundClip] || null;
}

function defaultBackgroundClip(partial = {}) {
  return {
    id: Math.random().toString(36).slice(2, 10),
    // New clips start visually untouched: no dimming, color shift, blur,
    // zoom, crop animation or fade. "Contain" preserves the whole uploaded frame.
    fit: 'contain',
    zoom: 100,
    offsetX: 0,
    offsetY: 0,
    brightness: 100,
    saturation: 100,
    darkness: 0,
    blur: 0,
    autoDim: false,
    autoDimStrength: 0,
    share: 100,
    fadeIn: 0,
    fadeOut: 0,
    ...partial,
  };
}

function backgroundStyle(index = state.selectedBackgroundClip) {
  const clip = state.backgroundClips[index] || defaultBackgroundClip();
  return {
    fit: clip.fit ?? 'contain',
    zoom: Number(clip.zoom ?? 100) / 100,
    offsetX: Number(clip.offsetX ?? 0) / 100,
    offsetY: Number(clip.offsetY ?? 0) / 100,
    brightness: Number(clip.brightness ?? 100) / 100,
    saturation: Number(clip.saturation ?? 100) / 100,
    darkness: Number(clip.darkness ?? 0) / 100,
    blur: Number(clip.blur ?? 0),
    autoDim: !!clip.autoDim,
    autoDimStrength: Number(clip.autoDimStrength ?? 0) / 100,
    fadeIn: Number(clip.fadeIn ?? 0),
    fadeOut: Number(clip.fadeOut ?? 0),
    share: Math.max(1, Number(clip.share ?? 100)),
  };
}


const APPEARANCE_DEFAULTS = {
  arabicFont: 'qpc-v2',
  textGap: 12,
  textArabicSize: 70, textEnglishSize: 18, textWidth: 76, textY: 47, textMarginX: 10, textMarginY: 6,
  textArabicSpacing: 136, textEnglishSpacing: 136, textArabicColor: '#ffffff', textEnglishColor: '#f3f1eb',
  wordHighlightEnabled: true, highlightGranularity: 'word', wordHighlightColor: '#f6c453',
  textStrokeWidth: 2, textStrokeOpacity: 36, textShadowBlur: 9, textShadowOpacity: 58,
  verseLabelEnabled: true, verseLabelSize: 16, verseLabelY: 27,
};

function setControlValue(id, value) {
  const el = $(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

function updateAppearanceLabels() {
  const clip = selectedBackgroundClip();
  const pairs = {
    textArabicSizeValue: `${$('textArabicSize')?.value || 70}px`,
    textEnglishSizeValue: `${$('textEnglishSize')?.value || 18}px`,
    textWidthValue: `${$('textWidth')?.value || 76}%`,
    textYValue: `${$('textY')?.value || 47}%`,
    textMarginXValue: `${$('textMarginX')?.value || 10}%`,
    textMarginYValue: `${$('textMarginY')?.value || 6}%`,
    textArabicSpacingValue: `${(Number($('textArabicSpacing')?.value || 136) / 100).toFixed(2)}×`,
    textEnglishSpacingValue: `${(Number($('textEnglishSpacing')?.value || 136) / 100).toFixed(2)}×`,
    textGapValue: `${$('textGap')?.value || 12}px`,
    textStrokeWidthValue: `${$('textStrokeWidth')?.value || 2}px`,
    textStrokeOpacityValue: `${$('textStrokeOpacity')?.value || 36}%`,
    textShadowBlurValue: `${$('textShadowBlur')?.value || 9}px`,
    textShadowOpacityValue: `${$('textShadowOpacity')?.value || 58}%`,
    verseLabelSizeValue: `${$('verseLabelSize')?.value || 16}px`,
    verseLabelYValue: `${$('verseLabelY')?.value || 27}%`,
    bgZoomValue: `${clip?.zoom ?? 100}%`,
    bgOffsetXValue: `${clip?.offsetX ?? 0}%`,
    bgOffsetYValue: `${clip?.offsetY ?? 0}%`,
    bgBrightnessValue: `${clip?.brightness ?? 100}%`,
    bgSaturationValue: `${clip?.saturation ?? 100}%`,
    darknessValue: `${clip?.darkness ?? 0}%`,
    blurValue: `${clip?.blur ?? 0}px`,
    bgAutoDimStrengthValue: `${clip?.autoDimStrength ?? 0}%`,
    bgShareValue: `${clip?.share ?? 100}`,
    bgFadeInValue: `${Number(clip?.fadeIn ?? 0).toFixed(1)}s`,
    bgFadeOutValue: `${Number(clip?.fadeOut ?? 0).toFixed(1)}s`,
  };
  Object.entries(pairs).forEach(([id, value]) => { const el = $(id); if (el) el.textContent = value; });
}

function renderAppearancePreview() {
  document.documentElement.style.setProperty('--arabic-font', selectedArabicFont());
  updateAppearanceLabels();
  renderBackgroundPreview();
  renderWatermarkPreview();
  renderIntroPreviewStatic();
  renderEditorPreview();
  const font = resolveArabicFont($('arabicFont')?.value, arabicFonts);
  document.querySelectorAll('[data-font-status]').forEach(element => {
    element.textContent = font.message;
    element.classList.toggle('font-warning', font.warning);
  });
}

function applyAppearancePreset(name = 'balanced') {
  const presets = {
    balanced: { ...APPEARANCE_DEFAULTS },
    readable: { ...APPEARANCE_DEFAULTS, textArabicSize: 66, textEnglishSize: 24, textWidth: 78, textShadowBlur: 14 },
    huge: { ...APPEARANCE_DEFAULTS, textArabicSize: 110, textEnglishSize: 28, textWidth: 62, textArabicSpacing: 132, textY: 46 },
    minimal: { ...APPEARANCE_DEFAULTS, textArabicSize: 40, textEnglishSize: 16, textWidth: 88, textStrokeWidth: 1, textStrokeOpacity: 28, textShadowBlur: 6, textGap: 8 },
  };
  const bgPresets = {
    balanced: { fit: 'contain', zoom: 100, offsetX: 0, offsetY: 0, brightness: 100, saturation: 100, darkness: 0, blur: 0, autoDim: false, autoDimStrength: 0, fadeIn: 0, fadeOut: 0 },
    readable: { darkness: 42, autoDim: true, autoDimStrength: 50, blur: 1 },
    huge: { darkness: 40, autoDim: true, autoDimStrength: 42 },
    minimal: { darkness: 26, autoDim: true, autoDimStrength: 25, blur: 0 },
  };
  const preset = presets[name] || presets.balanced;
  Object.entries(preset).forEach(([id, value]) => setControlValue(id, value));
  const clip = selectedBackgroundClip();
  if (clip) Object.assign(clip, bgPresets[name] || bgPresets.balanced);
  syncBackgroundEditorControls();
  renderBackgroundClipList();
  renderAppearancePreview();
}

function clipTimeline() {
  const clips = state.backgroundClips;
  if (!clips.length || !state.duration) return [];
  const totalShare = clips.reduce((sum, clip) => sum + Math.max(1, Number(clip.share || 100)), 0);
  let start = 0;
  return clips.map((clip, index) => {
    const share = Math.max(1, Number(clip.share || 100));
    const rawDuration = index === clips.length - 1 ? Math.max(0, state.duration - start) : state.duration * (share / totalShare);
    const duration = Math.max(0.05, rawDuration);
    const item = { index, start, end: Math.min(state.duration, start + duration), duration, clip };
    start += duration;
    return item;
  });
}

function activeBackgroundTimelineItem(time = ($('audioPreview')?.currentTime || 0)) {
  const timeline = clipTimeline();
  if (!timeline.length) return null;
  return timeline.find(item => time >= item.start && time < item.end) || timeline[timeline.length - 1];
}

function currentBackgroundElementForTime(time = ($('audioPreview')?.currentTime || 0)) {
  const item = activeBackgroundTimelineItem(time);
  if (!item) return null;
  const el = item.clip.element;
  if (el?.tagName === 'VIDEO' && el.duration) {
    const local = Math.max(0, time - item.start);
    try { el.currentTime = local % Math.max(0.1, el.duration); } catch {}
  }
  return el || null;
}

function seekPreviewToBackgroundClip(index = state.selectedBackgroundClip) {
  const item = clipTimeline()[index];
  const audio = $('audioPreview');
  if (!item || !audio || !state.duration) return;
  const target = clamp(item.start + Math.min(item.duration * 0.5, Math.max(0.05, item.duration - 0.02)), 0, Math.max(0, state.duration - 0.01));
  audio.currentTime = target;
  updateSettingsPlaybackUI();
}

function syncBackgroundEditorControls() {
  const clip = selectedBackgroundClip();
  const editor = $('bgClipEditor');
  if (!editor) return;
  if (!clip) {
    editor.innerHTML = '<div class="quiet-card">Add a background clip to start customizing it.</div>';
    updateAppearanceLabels();
    return;
  }
  editor.innerHTML = `
    <div class="editor-head"><strong>Editing clip ${state.selectedBackgroundClip + 1}</strong><span>${escapeHtml(clip.file?.name || 'Background clip')}</span></div>
    <div class="grid-2">
      <div class="field"><label for="bgFit">Fit</label><select id="bgFit"><option value="cover">Cover</option><option value="contain">Contain</option></select></div>
      <div class="field"><label for="bgShare">Timeline share <span id="bgShareValue"></span></label><input id="bgShare" type="range" min="1" max="300" value="${clip.share}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label for="bgZoom">Zoom <span id="bgZoomValue"></span></label><input id="bgZoom" type="range" min="60" max="220" value="${clip.zoom}"></div>
      <div class="field"><label for="bgBrightness">Brightness <span id="bgBrightnessValue"></span></label><input id="bgBrightness" type="range" min="50" max="180" value="${clip.brightness}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label for="bgOffsetX">Horizontal position <span id="bgOffsetXValue"></span></label><input id="bgOffsetX" type="range" min="-100" max="100" value="${clip.offsetX}"></div>
      <div class="field"><label for="bgOffsetY">Vertical position <span id="bgOffsetYValue"></span></label><input id="bgOffsetY" type="range" min="-100" max="100" value="${clip.offsetY}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label for="bgSaturation">Saturation <span id="bgSaturationValue"></span></label><input id="bgSaturation" type="range" min="0" max="180" value="${clip.saturation}"></div>
      <div class="field"><label for="blur">Blur <span id="blurValue"></span></label><input id="blur" type="range" min="0" max="16" value="${clip.blur}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label for="darkness">Manual dimming <span id="darknessValue"></span></label><input id="darkness" type="range" min="0" max="85" value="${clip.darkness}"></div>
      <div class="field"><label for="bgAutoDimStrength">Auto-dimming strength <span id="bgAutoDimStrengthValue"></span></label><input id="bgAutoDimStrength" type="range" min="0" max="100" value="${clip.autoDimStrength}"></div>
    </div>
    <label class="toggle-row compact-toggle">
      <div><strong>Automatic dim assist</strong><span>Darkens bright backgrounds a little more to keep the text readable.</span></div>
      <input id="bgAutoDim" type="checkbox" ${clip.autoDim ? 'checked' : ''} />
    </label>
    <div class="grid-2">
      <div class="field"><label for="bgFadeIn">Fade in <span id="bgFadeInValue"></span></label><input id="bgFadeIn" type="range" min="0" max="3" step="0.1" value="${clip.fadeIn}"></div>
      <div class="field"><label for="bgFadeOut">Fade out <span id="bgFadeOutValue"></span></label><input id="bgFadeOut" type="range" min="0" max="3" step="0.1" value="${clip.fadeOut}"></div>
    </div>
  `;
  $('bgFit').value = clip.fit ?? 'contain';
  bindBackgroundClipControls();
  updateAppearanceLabels();
}

function bindBackgroundClipControls() {
  const clip = selectedBackgroundClip();
  if (!clip) return;
  const update = (key, value) => {
    clip[key] = value;
    const active = activeBackgroundTimelineItem();
    if (!active || active.index !== state.selectedBackgroundClip) seekPreviewToBackgroundClip();
    renderBackgroundClipList();
    renderAppearancePreview();
  };
  $('bgFit')?.addEventListener('change', () => update('fit', $('bgFit').value));
  [['bgShare','share'],['bgZoom','zoom'],['bgOffsetX','offsetX'],['bgOffsetY','offsetY'],['bgBrightness','brightness'],['bgSaturation','saturation'],['darkness','darkness'],['blur','blur'],['bgAutoDimStrength','autoDimStrength'],['bgFadeIn','fadeIn'],['bgFadeOut','fadeOut']].forEach(([id,key]) => {
    $(id)?.addEventListener('input', () => update(key, Number($(id).value)));
  });
  $('bgAutoDim')?.addEventListener('change', () => update('autoDim', $('bgAutoDim').checked));
}

function renderBackgroundClipList() {
  const list = $('bgClipList');
  const timelineHost = $('bgTimeline');
  if (!list || !timelineHost) return;
  const timeline = clipTimeline();
  list.innerHTML = state.backgroundClips.map((clip, index) => {
    const active = index === state.selectedBackgroundClip;
    const item = timeline[index];
    const range = item ? `${item.start.toFixed(1)}s → ${item.end.toFixed(1)}s` : 'not placed yet';
    const license = clip.license ? ` · ${clip.license}` : '';
    return `<button type="button" class="clip-chip ${active ? 'selected' : ''}" data-bg-index="${index}"><b>Clip ${index + 1}</b><span>${escapeHtml(clip.file?.name || 'Background')}</span><small>${range}${escapeHtml(license)}</small></button>`;
  }).join('') + (state.backgroundClips.length ? '<button type="button" class="clip-chip danger" id="removeBgClip">Remove selected</button>' : '');
  const total = timeline.length || 1;
  timelineHost.innerHTML = timeline.map(item => `<div class="clip-segment" style="width:${(item.duration / Math.max(0.01, state.duration))*100}%"><span>${item.index + 1}</span></div>`).join('') || '<div class="quiet-card">No background clips yet.</div>';
  list.querySelectorAll('[data-bg-index]').forEach(btn => btn.addEventListener('click', () => {
    state.selectedBackgroundClip = Number(btn.dataset.bgIndex || 0);
    seekPreviewToBackgroundClip();
    renderBuiltinBackgrounds();
    syncBackgroundEditorControls();
    renderBackgroundClipList();
    renderAppearancePreview();
  }));
  $('removeBgClip')?.addEventListener('click', () => {
    if (!state.backgroundClips.length) return;
    const [removed] = state.backgroundClips.splice(state.selectedBackgroundClip, 1);
    if (removed?.url) URL.revokeObjectURL(removed.url);
    state.selectedBackgroundClip = clamp(state.selectedBackgroundClip, 0, Math.max(0, state.backgroundClips.length - 1));
    $('backgroundFileName').textContent = state.backgroundClips.length ? `${state.backgroundClips.length} clips loaded` : 'You can add more than one image or video';
    renderBuiltinBackgrounds();
    syncBackgroundEditorControls();
    renderBackgroundClipList();
    renderAppearancePreview();
  });
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const test = `${line} ${words[i]}`;
    if (ctx.measureText(test).width <= maxWidth) line = test;
    else { lines.push(line); line = words[i]; }
  }
  lines.push(line);
  return lines;
}

function toArabicIndicDigits(value) {
  return String(value ?? '').replace(/\d/g, digit => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]);
}

function ayahEndSign(ayahNumber) {
  // U+06DD is the Qur'anic end-of-ayah sign. With the Arabic-Indic digits that
  // follow it, Qur'anic fonts render the familiar numbered ayah ornament.
  return `۝${toArabicIndicDigits(ayahNumber)}`;
}

function drawPhraseOverlay(ctx, width, height, group, includeVerse = true, activeWordIndex = null, activeLetterIndex = null) {
  if (!group) return;
  const portrait = height > width;
  const scale = width / (portrait ? 720 : 1280);
  const style = textStyle();
  const groupHighlightMode = highlightModeForGroup(group, style.highlightGranularity);
  const arabicSize = style.arabicSize * scale;
  const englishSize = style.englishSize * scale;
  const marginX = width * style.marginX;
  const marginY = height * style.marginY;
  const maxWidth = Math.min(width * style.maxWidth, width - marginX * 2);
  const arabicFontFamily = selectedArabicFont(style.arabicFont);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const headerAnchorY = clamp(height * style.verseLabelY, marginY + 18 * scale, height - marginY - 18 * scale);
  if (includeVerse && style.verseLabelEnabled) {
    const surah = currentSurah();
    const headerArabicSize = Math.max(14, style.verseLabelSize * 1.85 * scale);
    const headerEnglishSize = Math.max(10, style.verseLabelSize * 1.15 * scale);
    const headerAyahSize = Math.max(12, style.verseLabelSize * 1.55 * scale);
    const arabicY = headerAnchorY - headerArabicSize * 1.9;
    const englishY = headerAnchorY - headerEnglishSize * 0.3;
    const ayahY = headerAnchorY + headerAyahSize * 1.7;

    ctx.direction = 'rtl';
    ctx.font = `700 ${headerArabicSize}px ${arabicFontFamily}`;
    ctx.fillStyle = rgba('#ffffff', 0.94);
    ctx.shadowColor = rgba('#000000', 0.35);
    ctx.shadowBlur = 6 * scale;
    ctx.fillText(surah?.arabicName || '', width / 2, arabicY);

    ctx.direction = 'ltr';
    ctx.font = `500 ${headerEnglishSize}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = rgba('#ffffff', 0.92);
    ctx.fillText(`[${surah?.englishName || ''}]`, width / 2, englishY);

    ctx.font = `400 ${headerAyahSize}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = rgba('#ffffff', 0.9);
    const specialLabel = Number(group.ayahNumber) === -1 ? "Isti'adhah" : Number(group.ayahNumber) === 0 ? 'Bismillah' : `${surah?.number || ''}:${group.ayahNumber}`;
    ctx.fillText(specialLabel, width / 2, ayahY);
  }

  ctx.direction = 'rtl';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${arabicSize}px ${arabicFontFamily}`;
  const isFinalPhraseOfAyah = Number(group.groupInAyah) === Number(group.groupCountInAyah);
  const isSpecialOpening = Number(group.ayahNumber) <= 0 || group.isBasmalah || group.isIstiatha;
  const arabicTokens = (group.words || String(group.arabic || '').split(/\s+/)).map((text, offset) => ({ text, wordIndex: Number(group.wordStart || 0) + offset }));
  if (isFinalPhraseOfAyah && !isSpecialOpening) {
    // Amiri shapes U+06DD and its digits into one numbered ornament. Other
    // fonts may produce duplicate ornaments or separate, unsupported glyphs.
    const ornamentFont = arabicFonts?.quran;
    arabicTokens.push({
      text: ornamentFont ? ayahEndSign(group.ayahNumber) : `(${toArabicIndicDigits(group.ayahNumber)})`,
      wordIndex: null,
      ayahEnd: true,
      font: `700 ${arabicSize}px ${ornamentFont?.family || arabicFontFamily}`,
    });
  }
  const arabicLines = wrapIndexedArabic(ctx, arabicTokens, maxWidth);
  const arLineHeight = arabicSize * style.arabicSpacing;
  const inkPadding = Math.max(2 * scale, style.strokeWidth * scale / 2 + 2 * scale);
  const arabicRows = arabicLines.map(tokens => {
    const bounds = tokens.map(token => measureArabicTokenBounds(ctx, token));
    return {
      ascent: Math.max(0, ...bounds.map(box => box.ascent ?? arabicSize)),
      descent: Math.max(0, ...bounds.map(box => box.descent ?? arabicSize * 0.4)),
      padding: inkPadding, minHeight: arLineHeight,
    };
  });
  let englishLines = [];
  if (state.translation && group.translation) {
    ctx.direction = 'ltr';
    ctx.font = `500 ${englishSize}px Georgia, "Times New Roman", serif`;
    englishLines = wrapText(ctx, group.translation, Math.min(width * style.maxWidth * 0.95, width - marginX * 2));
  }
  const enLineHeight = englishSize * style.englishSpacing;
  const gap = englishLines.length ? style.gap * scale : 0;
  const englishRows = englishLines.map((text, index) => {
    const metrics = ctx.measureText(text);
    return {
      ascent: Math.max(0, metrics.actualBoundingBoxAscent ?? englishSize),
      descent: Math.max(0, metrics.actualBoundingBoxDescent ?? englishSize * 0.3),
      padding: inkPadding, minHeight: enLineHeight, gapBefore: index === 0 ? gap : 0,
    };
  });
  const layout = layoutTextRows([...arabicRows, ...englishRows]);
  // Fit unusually tall blocks inside the safe area instead of clipping them.
  const fit = Math.min(1, Math.max(1, height - 2 * marginY) / Math.max(1, layout.height));
  const totalHeight = layout.height * fit;
  const minCenter = marginY + totalHeight / 2;
  const maxCenter = height - marginY - totalHeight / 2;
  const centerY = clamp(height * style.centerY, minCenter, maxCenter);
  ctx.translate(width / 2, centerY - totalHeight / 2);
  ctx.scale(fit, fit);
  ctx.translate(-width / 2, 0);

  ctx.direction = 'rtl';
  ctx.font = `700 ${arabicSize}px ${arabicFontFamily}`;
  ctx.fillStyle = style.arabicColor;
  ctx.strokeStyle = rgba('#000000', style.strokeOpacity);
  ctx.lineWidth = Math.max(0, style.strokeWidth * scale);
  ctx.shadowColor = rgba('#000000', style.shadowOpacity);
  ctx.shadowBlur = style.shadowBlur * scale;
  const spaceWidth = ctx.measureText(' ').width;
  for (const [lineIndex, line] of arabicLines.entries()) {
    const y = layout.rows[lineIndex].baseline;
    const lineWidth = line.reduce((sum, token) => sum + measureArabicToken(ctx, token), 0) + spaceWidth * (line.length - 1);
    let cursorX = width / 2 + lineWidth / 2;
    ctx.textAlign = 'right';
    for (const token of line) {
      ctx.save();
      if (token.font) ctx.font = token.font;
      const bounds = measureArabicTokenBounds(ctx, token);
      const tokenWidth = ctx.measureText(token.text).width;
      const drawX = cursorX - bounds.right;
      ctx.fillStyle = style.arabicColor;
      if (ctx.lineWidth > 0.05) ctx.strokeText(token.text, drawX, y);
      ctx.fillText(token.text, drawX, y);
      const highlightToken = style.wordHighlightEnabled && token.wordIndex != null && activeWordIndex != null
        && Number(token.wordIndex) === Number(activeWordIndex);
      if (highlightToken && groupHighlightMode === 'word') {
        ctx.fillStyle = style.wordHighlightColor;
        if (ctx.lineWidth > 0.05) ctx.strokeText(token.text, drawX, y);
        ctx.fillText(token.text, drawX, y);
      }
      const highlightLetter = highlightToken && groupHighlightMode === 'letter' && activeLetterIndex != null;
      if (highlightLetter) {
        const graphemes = arabicGraphemes(token.text);
        const letterIndex = clamp(Number(activeLetterIndex), 0, Math.max(0, graphemes.length - 1));
        const beforeText = graphemes.slice(0, letterIndex).join('');
        const throughText = graphemes.slice(0, letterIndex + 1).join('');
        const measuredWordWidth = Math.max(1, ctx.measureText(graphemes.join('')).width);
        const widthCorrection = tokenWidth / measuredWordWidth;
        const beforeWidth = ctx.measureText(beforeText).width * widthCorrection;
        const throughWidth = ctx.measureText(throughText).width * widthCorrection;
        const clipRight = drawX - beforeWidth;
        const clipLeft = drawX - throughWidth;
        const metrics = ctx.measureText(token.text);
        const ascent = Math.max(arabicSize * 1.2, metrics.actualBoundingBoxAscent || 0);
        const descent = Math.max(arabicSize * 0.5, metrics.actualBoundingBoxDescent || 0);
        const letterPadding = Math.max(2, 2.5 * scale);
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          clipLeft - letterPadding,
          y - ascent - letterPadding,
          Math.max(2, clipRight - clipLeft + letterPadding * 2),
          ascent + descent + letterPadding * 2,
        );
        ctx.clip();
        ctx.fillStyle = style.wordHighlightColor;
        if (ctx.lineWidth > 0.05) ctx.strokeText(token.text, drawX, y);
        ctx.fillText(token.text, drawX, y);
        ctx.restore();
      }
      ctx.restore();
      cursorX -= bounds.width + spaceWidth;
    }
  }
  if (englishLines.length) {
    ctx.direction = 'ltr';
    ctx.textAlign = 'center';
    ctx.font = `500 ${englishSize}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = style.englishColor;
    ctx.lineWidth = Math.max(0, Math.min(style.strokeWidth * 0.45, 2) * scale);
    for (const [lineIndex, line] of englishLines.entries()) {
      const y = layout.rows[arabicLines.length + lineIndex].baseline;
      if (ctx.lineWidth > 0.05) ctx.strokeText(line, width / 2, y);
      ctx.fillText(line, width / 2, y);
    }
  }
  ctx.restore();
}

function previewMarkup(id) {
  const font = resolveArabicFont($('arabicFont')?.value, arabicFonts);
  return `<div class="phone-preview" id="${id}Phone"><canvas id="${id}Canvas"></canvas></div><div class="help ${font.warning ? 'font-warning' : ''}" data-font-status role="status">${escapeHtml(font.message)}</div>`;
}

function previewFadeOpacity(time = ($('audioPreview')?.currentTime || 0)) {
  const duration = Math.max(0.001, state.duration || 0.001);
  const fadeIn = Number($('globalFadeIn')?.value || 0);
  const fadeOut = Number($('globalFadeOut')?.value || 0);
  let opacity = 0;
  if (fadeIn > 0) opacity = Math.max(opacity, 1 - clamp(time / fadeIn, 0, 1));
  if (fadeOut > 0) opacity = Math.max(opacity, 1 - clamp((duration - time) / fadeOut, 0, 1));
  return clamp(opacity, 0, 1);
}

function drawPreviewCanvas(canvas, group, includeWatermark = false) {
  if (!canvas) return;
  const { width, height } = dimensions();
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#202522'; ctx.fillRect(0, 0, width, height);
  drawBackground(ctx, width, height);
  drawShadowOverlay(ctx, width, height);
  const previewTime = Number($('audioPreview')?.currentTime || 0);
  const activeWord = state.wordTimings.find(word => occurrenceKeyFor(word) === occurrenceKeyFor(group) && previewTime >= word.start && previewTime < word.end);
  const activeLetter = activeWord ? ensureLetterTimings(activeWord).find(letter => previewTime >= Number(letter.start) && previewTime < Number(letter.end)) : null;
  drawPhraseOverlay(ctx, width, height, group, true, activeWord?.wordIndex ?? null, activeLetter?.index ?? null);
  if (includeWatermark) drawWatermarkPreview(ctx, width, height);
  const fadeOpacity = previewFadeOpacity();
  if (fadeOpacity > 0.001) {
    ctx.fillStyle = `rgba(0,0,0,${fadeOpacity})`;
    ctx.fillRect(0, 0, width, height);
  }
}

function syncShadowStateFromControls() {
  const shadow = state.shadowOverlay;
  if ($('shadowEnabled')) shadow.enabled = $('shadowEnabled').checked;
  if ($('shadowX')) shadow.x = Number($('shadowX').value || 0);
  if ($('shadowY')) shadow.y = Number($('shadowY').value || 0);
  if ($('shadowSize')) shadow.size = Number($('shadowSize').value || 100);
  if ($('shadowOpacity')) shadow.opacity = Number($('shadowOpacity').value || 0);
}

function syncShadowControls() {
  const shadow = state.shadowOverlay;
  setControlValue('shadowEnabled', shadow.enabled);
  setControlValue('shadowX', shadow.x);
  setControlValue('shadowY', shadow.y);
  setControlValue('shadowSize', shadow.size);
  setControlValue('shadowOpacity', shadow.opacity);
  if ($('shadowXValue')) $('shadowXValue').textContent = `${shadow.x}%`;
  if ($('shadowYValue')) $('shadowYValue').textContent = `${shadow.y}%`;
  if ($('shadowSizeValue')) $('shadowSizeValue').textContent = `${shadow.size}%`;
  if ($('shadowOpacityValue')) $('shadowOpacityValue').textContent = `${shadow.opacity}%`;
  if ($('shadowFileName')) $('shadowFileName').textContent = shadow.file?.name || 'No shadow selected';
}

async function loadShadowFile(file, { enable = true } = {}) {
  if (!file) return;
  const shadow = state.shadowOverlay;
  if (shadow.url) URL.revokeObjectURL(shadow.url);
  shadow.file = file;
  shadow.url = URL.createObjectURL(file);
  const image = new Image();
  image.src = shadow.url;
  await new Promise((resolve, reject) => {
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', () => reject(new Error('Could not load that shadow image. Use a transparent PNG or WebP.')), { once: true });
  });
  shadow.element = image;
  shadow.enabled = !!enable;
  syncShadowControls();
  renderAppearancePreview();
}

async function useIncludedShadow() {
  const response = await fetch('/assets/bottom-center-circular-shadow.png', { cache: 'force-cache' });
  if (!response.ok) throw new Error('The included circular shadow could not be loaded.');
  const blob = await response.blob();
  await loadShadowFile(new File([blob], 'bottom-center-circular-shadow.png', { type: blob.type || 'image/png' }), { enable: true });
}

function drawShadowOverlay(ctx, width, height) {
  const shadow = state.shadowOverlay;
  const image = shadow?.element;
  if (!shadow?.enabled || !image?.naturalWidth || !image?.naturalHeight) return;
  const scale = Math.max(0.2, Number(shadow.size || 100) / 100);
  const drawWidth = width * scale;
  const drawHeight = drawWidth * image.naturalHeight / image.naturalWidth;
  const centerX = width * Number(shadow.x ?? 50) / 100;
  const centerY = height * Number(shadow.y ?? 50) / 100;
  ctx.save();
  ctx.globalAlpha = clamp(Number(shadow.opacity ?? 100) / 100, 0, 1);
  ctx.drawImage(image, centerX - drawWidth / 2, centerY - drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
}

function drawBackground(ctx, width, height, time = ($('audioPreview')?.currentTime || 0)) {
  const clipItem = activeBackgroundTimelineItem(time);
  const el = currentBackgroundElementForTime(time);
  if (!clipItem || !el) return;
  const sw = el.tagName === 'VIDEO' ? el.videoWidth : el.naturalWidth;
  const sh = el.tagName === 'VIDEO' ? el.videoHeight : el.naturalHeight;
  if (!sw || !sh) return;
  const style = backgroundStyle(clipItem.index);
  const zoom = style.fit === 'contain' ? Math.min(style.zoom, 1) : Math.max(style.zoom, 1);
  const baseScale = style.fit === 'contain' ? Math.min(width / sw, height / sh) : Math.max(width / sw, height / sh);
  const scale = baseScale * zoom;
  const dw = sw * scale, dh = sh * scale;
  const rangeX = Math.max(0, dw - width);
  const rangeY = Math.max(0, dh - height);
  const x = (width - dw) / 2 - (rangeX / 2) * style.offsetX;
  const y = (height - dh) / 2 - (rangeY / 2) * style.offsetY;
  const localTime = Math.max(0, time - clipItem.start);
  const fadeInFactor = style.fadeIn > 0 ? clamp(localTime / style.fadeIn, 0, 1) : 1;
  const fadeOutFactor = style.fadeOut > 0 ? clamp((clipItem.duration - localTime) / style.fadeOut, 0, 1) : 1;
  const alpha = Math.min(fadeInFactor, fadeOutFactor);
  const autoDimBoost = style.autoDim ? Math.max(0, style.brightness - 1) * 0.25 * style.autoDimStrength : 0;
  const dim = clamp(style.darkness + autoDimBoost, 0, 0.9);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = alpha;
  ctx.filter = `blur(${style.blur}px) brightness(${style.brightness}) saturate(${style.saturation})`;
  ctx.drawImage(el, x, y, dw, dh);
  ctx.restore();
  ctx.fillStyle = `rgba(0,0,0,${dim})`;
  ctx.fillRect(0, 0, width, height);
}

function currentPreviewGroup() {
  const audio = $('audioPreview');
  return findActiveGroup(state.groups, audio.currentTime || 0) || state.groups.find(group => {
    const word = state.wordTimings[state.selectedWord];
    return word && occurrenceKeyFor(group) === occurrenceKeyFor(word) && word.wordIndex >= group.wordStart && word.wordIndex <= group.wordEnd;
  }) || state.groups[0];
}

function renderEditorPreview() {
  $('editorPreview').innerHTML = previewMarkup('editor');
  drawPreviewCanvas($('editorCanvas'), currentPreviewGroup(), false);
}

async function fetchBackgroundSuggestions(force = false) {
  if (state.backgroundLoading) return;
  if (!force && state.backgroundSuggestions.length) {
    renderBuiltinBackgrounds();
    return;
  }
  state.backgroundLoading = true;
  const host = $('builtinBackgrounds');
  if (host) host.innerHTML = '<div class="quiet-card">Finding fresh video backgrounds…</div>';
  try {
    const theme = $('backgroundTheme')?.value || state.backgroundTheme || 'calm';
    state.backgroundTheme = theme;
    if (force) state.backgroundSeed += 1 + Math.floor(Math.random() * 10000);
    const response = await fetch(`${API}/api/backgrounds/discover?theme=${encodeURIComponent(theme)}&seed=${state.backgroundSeed}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Background search failed (HTTP ${response.status}).`);
    state.backgroundSuggestions = Array.isArray(payload.items) ? payload.items : [];
    renderBuiltinBackgrounds();
  } catch (error) {
    if (host) host.innerHTML = `<div class="quiet-card">${escapeHtml(error.message || String(error))}<br><small>You can still upload your own background below.</small></div>`;
  } finally {
    state.backgroundLoading = false;
  }
}

function renderBuiltinBackgrounds() {
  const host = $('builtinBackgrounds');
  if (!host) return;
  if (!state.backgroundSuggestions.length) {
    if (!state.backgroundLoading) fetchBackgroundSuggestions(false);
    return;
  }
  host.innerHTML = state.backgroundSuggestions.slice(0, 5).map((bg, index) => `
    <article class="builtin-bg-card online-bg-card">
      <button type="button" class="background-pick" data-online-bg="${index}" title="Add ${escapeHtml(bg.name)}">
        ${bg.thumb ? `<img src="${escapeHtml(bg.thumb)}" alt="${escapeHtml(bg.name)}" loading="lazy" />` : '<div class="bg-placeholder">Video</div>'}
        <span class="background-card-name">${escapeHtml(bg.name.replace(/\.(webm|ogv|ogg|mp4)$/i, ''))}</span>
      </button>
      <div class="background-meta">
        <span>${escapeHtml(bg.license || 'See source')}</span>
        <a href="${escapeHtml(bg.source || 'https://commons.wikimedia.org/')}" target="_blank" rel="noopener">Source ↗</a>
      </div>
    </article>`).join('');
  host.querySelectorAll('[data-online-bg]').forEach(button => button.addEventListener('click', async () => {
    const item = state.backgroundSuggestions[Number(button.dataset.onlineBg || 0)];
    if (!item?.url) return;
    button.disabled = true;
    const previous = button.textContent;
    button.classList.add('loading');
    try {
      const response = await fetch(`${API}/api/backgrounds/fetch?url=${encodeURIComponent(item.url)}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || `Could not download this background (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      const extension = (new URL(item.url).pathname.match(/\.(webm|ogv|ogg|mp4)$/i)?.[0] || '.webm').toLowerCase();
      const safeName = String(item.name || `commons-background${extension}`).replace(/[\/:*?"<>|]+/g, '-');
      const file = new File([blob], safeName.endsWith(extension) ? safeName : `${safeName}${extension}`, { type: blob.type || item.mime || 'video/webm' });
      await addBackgroundFiles([file]);
      const added = state.backgroundClips.at(-1);
      if (added) {
        added.source = item.source || '';
        added.license = item.license || '';
        added.artist = item.artist || '';
      }
      renderBackgroundClipList();
    } catch (error) {
      alert(error.message || String(error));
    } finally {
      button.disabled = false;
      button.classList.remove('loading');
      if (previous && !button.textContent) button.textContent = previous;
    }
  }));
}


async function addBackgroundFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) { renderAppearancePreview(); return; }
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith('video/');
    const el = document.createElement(isVideo ? 'video' : 'img');
    el.src = url;
    if (isVideo) { el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'auto'; }
    await new Promise((resolve, reject) => {
      el.addEventListener(isVideo ? 'loadeddata' : 'load', resolve, { once: true });
      el.addEventListener('error', () => reject(new Error(`Could not preview background clip: ${file.name}`)), { once: true });
    });
    state.backgroundClips.push(defaultBackgroundClip({ file, url, element: el }));
    if (isVideo) el.play().catch(() => {});
  }
  state.selectedBackgroundClip = state.backgroundClips.length - 1;
  $('backgroundFileName').textContent = `${state.backgroundClips.length} clip${state.backgroundClips.length === 1 ? '' : 's'} loaded`;
  seekPreviewToBackgroundClip();
  syncBackgroundEditorControls();
  renderBackgroundClipList();
  renderAppearancePreview();
}

function renderBackgroundPreview() {
  const host = $('backgroundPreview');
  if (!host) return;
  if (!$('backgroundCanvas')) host.innerHTML = previewMarkup('background');
  drawPreviewCanvas($('backgroundCanvas'), currentPreviewGroup(), true);
  updateSettingsPlaybackUI();
}

function getWatermarkSettings() {
  return state.watermarkSettings;
}

function syncWatermarkStateFromControls() {
  const wm = getWatermarkSettings();
  if ($('wmText')) wm.text = $('wmText').value || '@maqamulajam';
  if ($('wmPosition')) wm.position = $('wmPosition').value || 'bottom-right';
  if ($('wmSize')) wm.size = Number($('wmSize').value || 20);
  if ($('wmOpacity')) wm.opacity = Number($('wmOpacity').value || 65);
  if ($('wmOffsetX')) wm.offsetX = Number($('wmOffsetX').value || 0);
  if ($('wmOffsetY')) wm.offsetY = Number($('wmOffsetY').value || 0);
  if ($('wmRemoveBlack')) wm.removeBlack = !!$('wmRemoveBlack').checked;
}

function updateWatermarkLabels() {
  const wm = getWatermarkSettings();
  if ($('wmSizeValue')) $('wmSizeValue').textContent = `${wm.size}%`;
  if ($('wmOpacityValue')) $('wmOpacityValue').textContent = `${wm.opacity}%`;
  if ($('wmOffsetXValue')) $('wmOffsetXValue').textContent = `${wm.offsetX}%`;
  if ($('wmOffsetYValue')) $('wmOffsetYValue').textContent = `${wm.offsetY}%`;
}

function renderWatermarkControls() {
  const host = $('watermarkControls');
  const wm = getWatermarkSettings();
  if (state.watermarkType === 'none') { host.innerHTML = '<div class="quiet-card">No watermark will be added.</div>'; return; }
  host.innerHTML = `
    ${state.watermarkType === 'text' ? `<div class="field"><label for="wmText">Watermark text</label><input id="wmText" type="text" value="${escapeHtml(wm.text)}" placeholder="@username"></div>` : `
      <label class="upload-box compact" for="wmFile"><input id="wmFile" type="file" accept="${state.watermarkType === 'image' ? 'image/*,.png,.jpg,.jpeg,.webp' : 'video/*,.mp4,.mov,.webm'}"><span class="upload-title">Choose ${state.watermarkType} watermark</span><span class="upload-sub" id="wmFileName">${state.watermarkFile?.name || 'Transparent media works best'}</span></label>`}
    <div class="grid-2">
      <div class="field"><label for="wmPosition">Anchor</label><select id="wmPosition"><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option><option value="top-right">Top right</option><option value="top-left">Top left</option><option value="center">Center</option></select></div>
      <div class="field"><label for="wmSize">Size <span id="wmSizeValue"></span></label><input id="wmSize" type="range" min="5" max="75" value="${wm.size}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label for="wmOffsetX">Horizontal adjust <span id="wmOffsetXValue"></span></label><input id="wmOffsetX" type="range" min="-100" max="100" value="${wm.offsetX}"></div>
      <div class="field"><label for="wmOffsetY">Vertical adjust <span id="wmOffsetYValue"></span></label><input id="wmOffsetY" type="range" min="-100" max="100" value="${wm.offsetY}"></div>
    </div>
    <div class="field"><label for="wmOpacity">Opacity <span id="wmOpacityValue"></span></label><input id="wmOpacity" type="range" min="10" max="100" value="${wm.opacity}"></div>
    ${state.watermarkType !== 'text' ? `
      <label class="toggle-row compact-toggle">
        <div><strong>Remove black background</strong><span>Makes black and near-black pixels transparent.</span></div>
        <input id="wmRemoveBlack" type="checkbox" ${wm.removeBlack ? 'checked' : ''} />
      </label>
    ` : ''}
  `;
  if ($('wmPosition')) $('wmPosition').value = wm.position;
  const rerender = () => { syncWatermarkStateFromControls(); updateWatermarkLabels(); renderWatermarkPreview(); };
  if ($('wmText')) $('wmText').addEventListener('input', rerender);
  if ($('wmFile')) $('wmFile').addEventListener('change', async event => {
    state.watermarkFile = event.target.files[0] || null;
    if ($('wmFileName')) $('wmFileName').textContent = state.watermarkFile?.name || 'Choose media';
    await loadWatermarkMedia();
  });
  ['wmPosition','wmSize','wmOpacity','wmOffsetX','wmOffsetY','wmRemoveBlack'].forEach(id => $(id)?.addEventListener('input', rerender));
  updateWatermarkLabels();
  renderWatermarkPreview();
}


async function loadWatermarkMedia() {
  state.watermarkElement = null;
  if (state.watermarkUrl) URL.revokeObjectURL(state.watermarkUrl);
  if (!state.watermarkFile) { renderWatermarkPreview(); return; }
  state.watermarkUrl = URL.createObjectURL(state.watermarkFile);
  const video = state.watermarkType === 'video';
  const el = document.createElement(video ? 'video' : 'img');
  el.src = state.watermarkUrl;
  if (video) { el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'auto'; }
  await new Promise((resolve, reject) => {
    el.addEventListener(video ? 'loadeddata' : 'load', resolve, { once: true });
    el.addEventListener('error', () => reject(new Error('Could not preview that watermark.')), { once: true });
  });
  state.watermarkElement = el;
  if (video) el.play().catch(() => {});
  renderWatermarkPreview();
}

function positionPoint(position, width, height, itemW, itemH, pad) {
  if (position === 'bottom-left') return { x: pad, y: height - pad - itemH };
  if (position === 'top-right') return { x: width - pad - itemW, y: pad };
  if (position === 'top-left') return { x: pad, y: pad };
  if (position === 'center') return { x: (width - itemW) / 2, y: (height - itemH) / 2 };
  return { x: width - pad - itemW, y: height - pad - itemH };
}

function removeNearBlackFromContext(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const maxCh = Math.max(r, g, b);
    if (maxCh <= 45) {
      data[i + 3] = 0;
    } else if (maxCh <= 75) {
      const keep = (maxCh - 45) / 30;
      data[i + 3] = Math.round(data[i + 3] * keep);
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function drawWatermarkPreview(ctx, width, height) {
  if (state.watermarkType === 'none') return;
  const wm = getWatermarkSettings();
  const size = Number(wm.size || 20) / 100;
  const opacity = Number(wm.opacity || 65) / 100;
  const position = wm.position || 'bottom-right';
  const offsetX = Number(wm.offsetX || 0) / 100;
  const offsetY = Number(wm.offsetY || 0) / 100;
  const pad = Math.max(20, width * 0.04);
  ctx.save(); ctx.globalAlpha = opacity;
  if (state.watermarkType === 'text') {
    const text = (wm.text || '@maqamulajam').trim() || '@maqamulajam';
    const fontSize = Math.max(16, width * size * 0.13);
    ctx.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`;
    const w = ctx.measureText(text).width, h = fontSize * 1.3;
    const base = positionPoint(position, width, height, w, h, pad);
    const p = { x: base.x + ((width - w) / 2) * offsetX, y: base.y + ((height - h) / 2) * offsetY };
    ctx.textBaseline = 'top'; ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 7;
    ctx.fillText(text, p.x, p.y);
  } else if (state.watermarkElement) {
    const el = state.watermarkElement;
    const sw = el.tagName === 'VIDEO' ? el.videoWidth : el.naturalWidth;
    const sh = el.tagName === 'VIDEO' ? el.videoHeight : el.naturalHeight;
    if (sw && sh) {
      const w = width * size, h = w * sh / sw;
      const base = positionPoint(position, width, height, w, h, pad);
      const p = { x: base.x + ((width - w) / 2) * offsetX, y: base.y + ((height - h) / 2) * offsetY };
      if (wm.removeBlack) {
        const temp = document.createElement('canvas');
        temp.width = Math.max(1, Math.round(w));
        temp.height = Math.max(1, Math.round(h));
        const tctx = temp.getContext('2d', { willReadFrequently: true });
        tctx.drawImage(el, 0, 0, temp.width, temp.height);
        removeNearBlackFromContext(tctx, temp.width, temp.height);
        ctx.drawImage(temp, p.x, p.y, w, h);
      } else {
        ctx.drawImage(el, p.x, p.y, w, h);
      }
    }
  }
  ctx.restore();
}


function renderWatermarkPreview() {
  const host = $('watermarkPreview');
  if (!host) return;
  if (!$('watermarkCanvas')) host.innerHTML = previewMarkup('watermark');
  drawPreviewCanvas($('watermarkCanvas'), currentPreviewGroup(), true);
}

function updateSettingsPlaybackUI() {
  const audio = $('audioPreview');
  if (!audio) return;
  const time = Number(audio.currentTime || 0);
  const duration = Number(state.duration || audio.duration || 0);
  if ($('settingsScrubber') && document.activeElement !== $('settingsScrubber')) {
    $('settingsScrubber').value = duration ? String(Math.round(time / duration * 1000)) : '0';
  }
  if ($('settingsTime')) $('settingsTime').textContent = `${time.toFixed(1)}s / ${duration.toFixed(1)}s`;
  if ($('settingsPlayPause')) $('settingsPlayPause').textContent = audio.paused ? '▶ Play preview' : '❚❚ Pause preview';
  if (state.step === 4) audio.volume = 1 - previewFadeOpacity(time);
  else audio.volume = 1;
}

function updatePlayhead() {
  const ph = $('playhead');
  if (!ph || !state.duration) return;
  const time = $('audioPreview').currentTime || 0;
  ph.style.left = `${clamp(time / state.duration * 100, 0, 100)}%`;
}

function startPreviewRaf() {
  cancelAnimationFrame(state.previewRaf);
  const tick = () => {
    updatePlayhead();
    updateSettingsPlaybackUI();
    if (state.step === 3) renderEditorPreview();
    if (state.step === 4) { renderBackgroundPreview(); renderWatermarkPreview(); }
    if (!$('audioPreview').paused) state.previewRaf = requestAnimationFrame(tick);
  };
  state.previewRaf = requestAnimationFrame(tick);
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create phrase overlay.')), 'image/png'));
}

async function phraseOverlayBlob(group, activeWordIndex = null, activeLetterIndex = null) {
  await arabicFontsReady;
  const { width, height } = dimensions();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  drawPhraseOverlay(canvas.getContext('2d'), width, height, group, true, activeWordIndex, activeLetterIndex);
  return canvasBlob(canvas);
}

function timedWordsForGroup(group) {
  return state.wordTimings
    .filter(word => occurrenceKeyFor(word) === occurrenceKeyFor(group) && Number(word.wordIndex) >= Number(group.wordStart) && Number(word.wordIndex) <= Number(group.wordEnd))
    .sort((a, b) => Number(a.start) - Number(b.start));
}

async function textWatermarkBlob() {
  if (state.watermarkType !== 'text') return null;
  const { width } = dimensions();
  const size = Number($('wmSize')?.value || 20) / 100;
  const fontSize = Math.max(16, width * size * 0.13);
  const text = $('wmText')?.value?.trim() || '@maqamulajam';
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  const w = Math.ceil(probe.measureText(text).width + fontSize * 0.7);
  const h = Math.ceil(fontSize * 1.7);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = Math.max(4, fontSize * 0.16);
  ctx.fillText(text, w / 2, h / 2);
  return canvasBlob(canvas);
}

function retentionSettings() {
  const fallback = state.retention || {};
  return {
    enabled: $('retentionEnabled') ? $('retentionEnabled').checked : (fallback.enabled ?? true),
    smartOpening: $('retentionSmartOpening') ? $('retentionSmartOpening').checked : (fallback.smartOpening ?? true),
    hook: ($('retentionHook')?.value || fallback.hook || '').trim(),
    hookDuration: clamp(Number(fallback.hookDuration || 1.4), 0.8, 2.0),
    targetDuration: clamp(Number($('retentionDuration')?.value || fallback.targetDuration || 22), 15, 25),
    motion: $('retentionMotion') ? $('retentionMotion').checked : (fallback.motion ?? true),
  };
}

function audioEnergy(start, end) {
  const buffer = state.audioBuffer;
  if (!buffer || end <= start) return 0;
  const channel = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const from = clamp(Math.floor(start * rate), 0, channel.length - 1);
  const to = clamp(Math.ceil(end * rate), from + 1, channel.length);
  const stride = Math.max(1, Math.floor((to - from) / 12000));
  let sum = 0, count = 0;
  for (let i = from; i < to; i += stride) { sum += channel[i] * channel[i]; count += 1; }
  return count ? Math.sqrt(sum / count) : 0;
}

function retentionPlan() {
  const settings = retentionSettings();
  const all = state.groups || [];
  if (!settings.enabled || !all.length) return { enabled: false, start: 0, end: state.duration, duration: state.duration, groups: all, settings };
  const ayahStarts = all.filter(group => Number(group.ayahNumber) > 0 && Number(group.wordStart || 0) === 0);
  const candidates = ayahStarts.length ? ayahStarts : all;
  let opening = candidates[0] || all[0];
  if (settings.smartOpening && candidates.length > 1) {
    opening = candidates.reduce((best, group) => {
      const score = audioEnergy(group.start, Math.min(state.duration, group.start + settings.targetDuration));
      return !best || score > best.score ? { group, score } : best;
    }, null).group;
  }
  const start = Math.max(0, Number(opening?.start || 0));
  const desired = Math.min(state.duration, start + settings.targetDuration);
  const eligibleEnds = all.map(group => Number(group.end || 0)).filter(end => end > start + 0.25 && end <= Math.min(state.duration, start + 25.001));
  const preferred = eligibleEnds.filter(end => end >= Math.min(state.duration, start + 15));
  const pool = preferred.length ? preferred : eligibleEnds;
  const end = pool.length ? pool.reduce((best, value) => Math.abs(value - desired) < Math.abs(best - desired) ? value : best, pool[0]) : Math.min(state.duration, start + settings.targetDuration);
  const groups = all.filter(group => group.end > start + 0.01 && group.start < end - 0.01);
  return { enabled: true, start, end, duration: Math.max(0.25, end - start), groups, settings };
}

async function retentionHookBlob(text) {
  if (!text) return null;
  const { width, height } = dimensions();
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const fontSize = Math.max(24, Math.round(width * 0.052));
  ctx.font = `800 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  const maxWidth = width * 0.82;
  const shown = text.length > 72 ? `${text.slice(0, 69)}…` : text;
  const textWidth = Math.min(maxWidth, ctx.measureText(shown).width);
  const boxW = textWidth + fontSize * 1.35, boxH = fontSize * 2.05;
  const x = (width - boxW) / 2, y = height * 0.105;
  ctx.fillStyle = 'rgba(0,0,0,.58)'; ctx.beginPath(); ctx.roundRect(x, y, boxW, boxH, boxH / 2); ctx.fill();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = Math.max(6, fontSize * .22);
  ctx.fillText(shown, width / 2, y + boxH / 2, maxWidth);
  return canvasBlob(canvas);
}

function syncRetentionState() {
  state.retention = retentionSettings();
  if ($('retentionControls')) $('retentionControls').hidden = !state.retention.enabled;
  if ($('introEnabled')) $('introEnabled').disabled = state.retention.enabled;
  if ($('retentionDurationValue')) $('retentionDurationValue').textContent = `${state.retention.targetDuration.toFixed(0)}s`;
  if (state.retention.enabled && $('introEnabled')?.checked) {
    $('introEnabled').checked = false;
    syncIntroState();
  }
  const plan = retentionPlan();
  if ($('retentionPlan')) $('retentionPlan').textContent = plan.enabled
    ? `Planned cut: ${plan.start.toFixed(1)}s–${plan.end.toFixed(1)}s (${plan.duration.toFixed(1)}s), ending on a phrase boundary.`
    : 'Retention mode is off; the complete synchronized recitation will be exported.';
}

function introSettings() {
  const fallback = state.intro || {};
  return {
    enabled: $('introEnabled') ? $('introEnabled').checked : (fallback.enabled ?? true),
    arabic: ($('introArabic')?.value || fallback.arabic || 'مَقَامُ الْعَجَمِ').trim(),
    english: ($('introEnglish')?.value || fallback.english || 'Maqam al-Ajam').trim(),
    duration: clamp(Number($('introDuration')?.value || fallback.duration || 2.6), 1, 5),
    sound: $('introSound')?.value || fallback.sound || 'deep',
  };
}

function syncIntroState() {
  state.intro = introSettings();
  if ($('introDurationValue')) $('introDurationValue').textContent = `${state.intro.duration.toFixed(1)}s`;
  if ($('introControls')) $('introControls').hidden = !state.intro.enabled;
}

function selectedArabicFont(selection = $('arabicFont')?.value) {
  return resolveArabicFont(selection, arabicFonts).family;
}

function drawIntroTypography(ctx, width, height, settings, alpha = 1, scale = 1, slideY = 0) {
  const portrait = height > width;
  const arabicSize = width * (portrait ? 0.105 : 0.078);
  const englishSize = width * (portrait ? 0.036 : 0.027);
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.translate(width / 2, height / 2 + slideY);
  ctx.scale(scale, scale);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';
  ctx.font = `700 ${arabicSize}px ${selectedArabicFont()}`;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(255,255,255,.16)';
  ctx.shadowBlur = Math.max(8, width * 0.012);
  ctx.fillText(settings.arabic || 'مَقَامُ الْعَجَمِ', 0, -englishSize * 0.8);
  ctx.direction = 'ltr';
  ctx.font = `500 ${englishSize}px Inter, "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = 'rgba(232,235,237,.84)';
  ctx.shadowBlur = 0;
  ctx.fillText(settings.english || 'Maqam al-Ajam', 0, arabicSize * 0.82);
  ctx.restore();
}

function introAnimationState(time, duration) {
  const reveal = Math.min(0.72, duration * 0.32);
  const fadeIn = Math.min(0.34, duration * 0.18);
  const fadeOut = Math.min(0.42, duration * 0.22);
  const fadeOutStart = Math.max(fadeIn + 0.05, duration - fadeOut);
  const revealP = clamp((time - 0.03) / Math.max(0.08, reveal), 0, 1);
  const eased = 1 - Math.pow(1 - revealP, 3);
  let alpha = clamp((time - 0.08) / Math.max(0.08, fadeIn), 0, 1);
  if (time >= fadeOutStart) alpha *= clamp((duration - time) / Math.max(0.08, fadeOut), 0, 1);
  return {
    alpha,
    scale: 0.88 + 0.12 * eased,
    slideY: 30 * (1 - eased),
  };
}

function renderIntroPreviewFrame(time = 0) {
  const canvas = $('introPreviewCanvas');
  if (!canvas) return;
  const { width, height } = dimensions();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const settings = introSettings();
  if (!settings.enabled) return;
  const anim = introAnimationState(clamp(time, 0, settings.duration), settings.duration);
  drawIntroTypography(ctx, width, height, settings, anim.alpha, anim.scale, anim.slideY);
}

function renderIntroPreviewStatic() {
  syncIntroState();
  renderIntroPreviewFrame(Math.min(0.72, state.intro.duration * 0.35));
}

function playIntroPreviewSfx(settings) {
  if (!settings.enabled || settings.sound === 'none') return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (state.introAudioContext) state.introAudioContext.close().catch(() => {});
    const ac = new AudioCtx();
    state.introAudioContext = ac;
    const now = ac.currentTime;
    if (settings.sound === 'swoosh') {
      const frames = Math.max(1, Math.round(ac.sampleRate * settings.duration));
      const buffer = ac.createBuffer(1, frames, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * 0.28;
      const source = ac.createBufferSource();
      source.buffer = buffer;
      const filter = ac.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(450, now);
      filter.frequency.exponentialRampToValueAtTime(2400, now + Math.min(0.85, settings.duration * 0.55));
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + Math.min(0.28, settings.duration * 0.22));
      gain.gain.exponentialRampToValueAtTime(0.001, now + settings.duration);
      source.connect(filter).connect(gain).connect(ac.destination);
      source.start(now);
      source.stop(now + settings.duration);
    } else {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(68, now);
      osc.frequency.exponentialRampToValueAtTime(46, now + Math.min(0.85, settings.duration * 0.5));
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.32, now + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, now + Math.min(settings.duration, 1.35));
      osc.connect(gain).connect(ac.destination);
      osc.start(now);
      osc.stop(now + settings.duration);
    }
  } catch {}
}

function playIntroPreview() {
  syncIntroState();
  if (!state.intro.enabled) return;
  cancelAnimationFrame(state.introPreviewRaf);
  const settings = { ...state.intro };
  const started = performance.now();
  playIntroPreviewSfx(settings);
  if ($('introPreviewBtn')) $('introPreviewBtn').textContent = 'Playing…';
  const tick = now => {
    const elapsed = (now - started) / 1000;
    renderIntroPreviewFrame(Math.min(elapsed, settings.duration));
    if (elapsed < settings.duration) {
      state.introPreviewRaf = requestAnimationFrame(tick);
    } else {
      if ($('introPreviewBtn')) $('introPreviewBtn').textContent = '▶ Preview intro';
      setTimeout(renderIntroPreviewStatic, 180);
    }
  };
  state.introPreviewRaf = requestAnimationFrame(tick);
}

async function introTitleBlob() {
  const settings = introSettings();
  if (!settings.enabled) return null;
  await arabicFontsReady;
  const { width, height } = dimensions();
  // Tight transparent layer: FFmpeg animates this image over a pitch-black clip.
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(320, Math.round(width * 0.88));
  canvas.height = Math.max(180, Math.round(height * (height > width ? 0.27 : 0.42)));
  const ctx = canvas.getContext('2d');
  drawIntroTypography(ctx, canvas.width, canvas.height, settings, 1, 1, 0);
  return canvasBlob(canvas);
}

function renderExportSummary() {
  const surah = currentSurah();
  const low = state.wordTimings.filter(word => word.confidenceLabel === 'low').length;
  const plan = retentionPlan();
  const intro = introSettings();
  const effectiveIntro = plan.enabled ? { ...intro, enabled: false } : intro;
  const totalDuration = finalTimelineDuration(plan.duration, effectiveIntro);
  $('exportSummary').innerHTML = `
    <strong>${escapeHtml(surah?.englishName || '')} ${escapeHtml(formatRangeLabel(state.selectedNumbers))}</strong>
    <span>${state.wordTimings.length} words · ${plan.groups.length} exported phrases · ${state.syncMode === 'ai' ? 'AI Precise' : 'Fast'} sync · ${effectiveIntro.enabled ? `${effectiveIntro.duration.toFixed(1)}s intro · ` : ''}${totalDuration.toFixed(1)}s final video${plan.enabled ? ' · retention cut' : ''} · full fade ${Number($('globalFadeIn')?.value || 0).toFixed(1)}s / ${Number($('globalFadeOut')?.value || 0).toFixed(1)}s</span>
  `;
}

async function generateVideo() {
  if (!state.audioFile || !state.backgroundClips.length || !state.groups.length) {
    setStatus('exportStatus', 'Audio, ayahs, timing and at least one background clip are required.', 'error');
    return;
  }
  const ready = await checkBackend();
  if (!ready) { setStatus('exportStatus', 'The local Python backend is required for rendering. Start with start.bat.', 'error'); return; }
  $('generateBtn').disabled = true;
  $('downloadLink').hidden = true;
  $('renderProgress').style.width = '8%';
  try {
    setStatus('exportStatus', 'Creating subtitle overlay images…');
    state.translation = $('translationToggle').checked;
    const plan = retentionPlan();
    const exportGroups = plan.groups;
    const overlayBlobs = [];
    const overlayTimings = [];
    for (let i = 0; i < exportGroups.length; i += 1) {
      overlayBlobs.push(await phraseOverlayBlob(exportGroups[i]));
      overlayTimings.push({ start: Math.max(0, exportGroups[i].start - plan.start), end: Math.min(plan.duration, exportGroups[i].end - plan.start) });
      $('renderProgress').style.width = `${8 + (i + 1) / exportGroups.length * 28}%`;
    }
    const highlightStyle = textStyle();
    if (highlightStyle.wordHighlightEnabled) {
      for (const group of exportGroups) {
        const groupHighlightMode = highlightModeForGroup(group, highlightStyle.highlightGranularity);
        for (const word of timedWordsForGroup(group)) {
          const highlightUnits = groupHighlightMode === 'letter'
            ? ensureLetterTimings(word).map(letter => ({ start: letter.start, end: letter.end, letterIndex: letter.index }))
            : [{ start: word.start, end: word.end, letterIndex: null }];
          for (const unit of highlightUnits) {
            const start = Math.max(0, Number(unit.start) - plan.start);
            const end = Math.min(plan.duration, Number(unit.end) - plan.start);
            if (end <= start + 0.003) continue;
            overlayBlobs.push(await phraseOverlayBlob(group, word.wordIndex, unit.letterIndex));
            overlayTimings.push({ start, end });
          }
        }
      }
    }
    const hookBlob = plan.enabled ? await retentionHookBlob(plan.settings.hook) : null;
    if (hookBlob) {
      overlayBlobs.push(hookBlob);
      overlayTimings.push({ start: 0, end: Math.min(plan.duration, plan.settings.hookDuration) });
    }
    let watermarkBlob = null;
    let watermarkName = null;
    let watermarkType = null;
    if (state.watermarkType === 'text') {
      watermarkBlob = await textWatermarkBlob(); watermarkName = 'watermark.png'; watermarkType = 'image/png';
    } else if ((state.watermarkType === 'image' || state.watermarkType === 'video') && state.watermarkFile) {
      watermarkBlob = state.watermarkFile; watermarkName = state.watermarkFile.name; watermarkType = state.watermarkFile.type;
    }
    const intro = introSettings();
    if (plan.enabled) intro.enabled = false;
    const introBlob = intro.enabled ? await introTitleBlob() : null;
    syncShadowStateFromControls();
    const shadowFile = state.shadowOverlay.enabled ? state.shadowOverlay.file : null;

    const { width, height } = dimensions();
    const timeline = clipTimeline().map(item => ({ ...item, start: item.start / Math.max(state.duration, .001) * plan.duration, end: item.end / Math.max(state.duration, .001) * plan.duration, duration: item.duration / Math.max(state.duration, .001) * plan.duration }));
    const meta = {
      width, height, duration: plan.duration,
      backgrounds: timeline.map(item => ({
        fit: item.clip.fit,
        zoom: Number(item.clip.zoom || 100) / 100,
        offsetX: Number(item.clip.offsetX || 0) / 100,
        offsetY: Number(item.clip.offsetY || 0) / 100,
        brightness: Number(item.clip.brightness || 100) / 100,
        saturation: Number(item.clip.saturation || 100) / 100,
        darkness: Number(item.clip.darkness ?? 0) / 100,
        blur: Number(item.clip.blur || 0),
        autoDim: !!item.clip.autoDim,
        autoDimStrength: Number(item.clip.autoDimStrength ?? 0) / 100,
        fadeIn: Number(item.clip.fadeIn ?? 0),
        fadeOut: Number(item.clip.fadeOut ?? 0),
        share: Math.max(1, Number(item.clip.share || 100)),
        start: item.start,
        end: item.end,
        duration: item.duration,
        motion: plan.enabled && plan.settings.motion,
      })),
      text: textStyle(),
      overlays: overlayTimings,
      retention: { enabled: plan.enabled, startOffset: plan.start, motion: plan.enabled && plan.settings.motion },
      watermark: {
        enabled: !!watermarkBlob,
        position: $('wmPosition')?.value || 'bottom-right',
        size: Number($('wmSize')?.value || 20) / 100,
        opacity: Number($('wmOpacity')?.value || 65) / 100,
        offsetX: Number($('wmOffsetX')?.value || 0) / 100,
        offsetY: Number($('wmOffsetY')?.value || 0) / 100,
        removeBlack: $('wmRemoveBlack')?.checked || false,
      },
      shadowOverlay: {
        enabled: !!shadowFile,
        x: Number(state.shadowOverlay.x ?? 50) / 100,
        y: Number(state.shadowOverlay.y ?? 76) / 100,
        size: Number(state.shadowOverlay.size ?? 100) / 100,
        opacity: Number(state.shadowOverlay.opacity ?? 100) / 100,
      },
      globalFade: {
        fadeIn: Number($('globalFadeIn')?.value || 0),
        fadeOut: Number($('globalFadeOut')?.value || 0),
      },
      intro: {
        enabled: intro.enabled,
        arabic: intro.arabic,
        english: intro.english,
        duration: intro.duration,
        sound: intro.sound,
      },
    };
    const form = new FormData();
    form.append('audio', state.audioFile, state.audioFile.name);
    state.backgroundClips.forEach((clip, index) => form.append('backgrounds', clip.file, clip.file?.name || `background-${index + 1}.bin`));
    form.append('metadata', JSON.stringify(meta));
    overlayBlobs.forEach((blob, i) => form.append('overlays', blob, `phrase-${String(i).padStart(3,'0')}.png`));
    if (watermarkBlob) form.append('watermark', watermarkBlob, watermarkName || 'watermark.bin');
    if (shadowFile) form.append('shadow_overlay', shadowFile, shadowFile.name || 'shadow-overlay.png');
    if (introBlob) form.append('intro_title', introBlob, 'intro-title.png');
    $('renderProgress').style.width = '40%';
    setStatus('exportStatus', 'Starting optimized FFmpeg render…');
    const startResponse = await fetch(`${API}/api/render/start`, { method: 'POST', body: form });
    const startPayload = await startResponse.json().catch(() => ({}));
    if (!startResponse.ok) {
      throw new Error(startPayload.detail || `Render failed to start (HTTP ${startResponse.status}).`);
    }
    const jobId = startPayload.jobId;
    if (!jobId) throw new Error('The render server did not return a job ID.');

    let finished = false;
    while (!finished) {
      await new Promise(resolve => setTimeout(resolve, 450));
      const statusResponse = await fetch(`${API}/api/render/${jobId}/status`, { cache: 'no-store' });
      const status = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(status.detail || `Could not read render progress (HTTP ${statusResponse.status}).`);
      if (status.status === 'error') throw new Error(status.error || 'FFmpeg render failed.');
      const ffmpegProgress = clamp(Number(status.progress || 0), 0, 1);
      const overall = 40 + ffmpegProgress * 54;
      $('renderProgress').style.width = `${overall.toFixed(1)}%`;
      const pct = Math.round(ffmpegProgress * 100);
      const speed = status.speed && status.speed !== 'N/A' ? ` · ${status.speed} realtime` : '';
      setStatus('exportStatus', `Rendering video… ${pct}%${speed}`);
      finished = status.status === 'done';
    }

    $('renderProgress').style.width = '95%';
    setStatus('exportStatus', 'Finalizing MP4…');
    const response = await fetch(`${API}/api/render/${jobId}/download`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || `Could not download finished render (HTTP ${response.status}).`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = $('downloadLink');
    link.href = url;
    link.download = `quran-${currentSurah().number}-${formatRangeLabel(state.selectedNumbers).replace(/[^0-9,-]/g,'') || 'edit'}.mp4`;
    link.hidden = false;
    $('renderProgress').style.width = '100%';
    setStatus('exportStatus', 'Finished. Your MP4 is ready.', 'ok');
  } catch (error) {
    setStatus('exportStatus', error.message || String(error), 'error');
    $('renderProgress').style.width = '0%';
  } finally {
    $('generateBtn').disabled = false;
  }
}

async function canAdvance(step) {
  if (step === 0) {
    if (!state.audioFile || !state.audioBuffer) throw new Error(state.sourceMode === 'library' ? 'Choose a reciter and load a recitation first.' : 'Upload a recitation first.');
    if (state.sourceMode === 'library' && !state.librarySelection) throw new Error('Load a recitation from the built-in library first.');
  }
  if (step === 1) await loadPassage();
  if (step === 3) {
    if (!state.wordTimings.length) throw new Error('Run synchronization first.');
  }
  return true;
}

$('nextBtn').addEventListener('click', async () => {
  try {
    await canAdvance(state.step);
    if (state.step === 0 && state.sourceMode === 'library' && state.librarySelection) {
      // Library selection already defines the exact Surah + range, so skip the
      // redundant Passage page and load its transcript automatically.
      await loadPassage();
      state.step = 2;
    } else {
      state.step = Math.min(4, state.step + 1);
    }
    if (state.step === 2) checkBackend();
    renderSteps();
  } catch (error) {
    if (state.step === 1) setStatus('passageStatus', error.message || String(error), 'error');
    else if (state.step === 0 && state.sourceMode === 'library') setStatus('libraryStatus', error.message || String(error), 'error');
    else alert(error.message || String(error));
  }
});
$('backBtn').addEventListener('click', () => { state.step = Math.max(0, state.step - 1); renderSteps(); });
$('brandHome').addEventListener('click', showProjectDashboard);
$('saveProjectBtn')?.addEventListener('click', () => saveCurrentProject({ askName: !state.currentProjectId }));
$('newProjectBtn')?.addEventListener('click', () => { sessionStorage.setItem('quranSyncStartNew', '1'); location.reload(); });
$('importProjectBtn')?.addEventListener('click', () => $('importProjectFile')?.click());
$('importProjectFile')?.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try { await importPortableProject(file); }
  catch (error) { setStatus('dashboardStatus', error.message || String(error), 'error'); }
  event.target.value = '';
});
document.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => setSourceMode(button.dataset.source)));
$('librarySurah')?.addEventListener('change', () => {
  const surah = getSurah(Number($('librarySurah').value || 1));
  if (surah) {
    $('libraryStart').value = '1';
    $('libraryEnd').value = String(Math.min(surah.ayahCount, 7));
  }
  updateLibraryVerseBounds();
  state.librarySelection = null;
  setStatus('libraryStatus', 'Choose the ayah range, then get the recitation.');
});
$('libraryStart')?.addEventListener('input', () => { updateLibraryVerseBounds(); state.librarySelection = null; });
$('libraryEnd')?.addEventListener('input', () => { updateLibraryVerseBounds(); state.librarySelection = null; });
$('libraryReciter')?.addEventListener('change', () => { state.librarySelection = null; setStatus('libraryStatus', 'Ready to get this recitation.'); });
$('libraryIstiatha')?.addEventListener('change', () => { state.librarySelection = null; setStatus('libraryStatus', 'Ready to get this recitation.'); });
$('libraryBasmalah')?.addEventListener('change', () => { state.librarySelection = null; setStatus('libraryStatus', 'Ready to get this recitation.'); });
$('loadLibraryRecitation')?.addEventListener('click', () => loadLibraryRecitation().catch(error => setStatus('libraryStatus', error.message || String(error), 'error')));
$('audioFile').addEventListener('change', event => loadAudio(event.target.files[0]));
$('surah').addEventListener('change', () => { state.ayahs = []; state.wordTimings = []; state.groups = []; state.alignmentReviewReady = false; state.pendingWordDeletions.clear(); setStatus('passageStatus', 'Enter the passage to continue.'); });
$('verseRanges').addEventListener('input', () => { state.ayahs = []; state.wordTimings = []; state.groups = []; state.alignmentReviewReady = false; state.pendingWordDeletions.clear(); });
document.querySelectorAll('[data-sync]').forEach(button => button.addEventListener('click', () => {
  state.syncMode = button.dataset.sync;
  document.querySelectorAll('[data-sync]').forEach(item => item.classList.toggle('selected', item === button));
  if (state.syncMode === 'ai') checkBackend();
}));
$('analyzeBtn').addEventListener('click', analyze);
$('deleteSelectedBlockBtn')?.addEventListener('click', markSelectedBlockForDeletion);
$('undoBlockDeletionsBtn')?.addEventListener('click', undoPendingBlockDeletions);
$('recheckBlocksBtn')?.addEventListener('click', recheckPendingBlockDeletions);
$('phraseStyle').addEventListener('change', () => { state.phraseStyle = $('phraseStyle').value; rebuildGroups(false); renderPhraseStrip(); renderEditorPreview(); });
$('audioPreview').addEventListener('play', startPreviewRaf);
$('audioPreview').addEventListener('pause', () => { updatePlayhead(); if (state.step === 4) { renderBackgroundPreview(); renderWatermarkPreview(); } });
$('audioPreview').addEventListener('timeupdate', () => { updatePlayhead(); if (state.step === 4) { renderBackgroundPreview(); renderWatermarkPreview(); } });
$('audioPreview').addEventListener('ended', updateSettingsPlaybackUI);
$('settingsPlayPause')?.addEventListener('click', async () => {
  const audio = $('audioPreview');
  if (!audio) return;
  if (audio.paused) {
    if (audio.currentTime >= (state.duration || 0) - 0.03) audio.currentTime = 0;
    await audio.play().catch(() => {});
  } else audio.pause();
  updateSettingsPlaybackUI();
});
$('settingsScrubber')?.addEventListener('input', () => {
  const audio = $('audioPreview');
  if (!audio || !state.duration) return;
  audio.currentTime = Number($('settingsScrubber').value || 0) / 1000 * state.duration;
  renderBackgroundPreview();
  renderWatermarkPreview();
  updateSettingsPlaybackUI();
});
$('zoomIn').addEventListener('click', () => { state.zoom = clamp(state.zoom * 1.5, 1, 8); $('zoomLabel').textContent = `${state.zoom.toFixed(state.zoom % 1 ? 1 : 0)}×`; renderTimeline(); });
$('zoomOut').addEventListener('click', () => { state.zoom = clamp(state.zoom / 1.5, 1, 8); $('zoomLabel').textContent = `${state.zoom.toFixed(state.zoom % 1 ? 1 : 0)}×`; renderTimeline(); });
$('backgroundFile').addEventListener('change', event => addBackgroundFiles(event.target.files).catch(error => alert(error.message || String(error))));
$('refreshBackgrounds')?.addEventListener('click', () => fetchBackgroundSuggestions(true));
$('backgroundTheme')?.addEventListener('change', () => { state.backgroundSuggestions = []; state.backgroundTheme = $('backgroundTheme').value; fetchBackgroundSuggestions(true); });
const bindAppearance = (id, suffix = '', formatter = value => `${value}${suffix}`) => {
  $(id)?.addEventListener('input', () => {
    const label = $(`${id}Value`);
    if (label) label.textContent = formatter($(id).value);
    renderAppearancePreview();
  });
};
bindAppearance('textArabicSize', 'px');
bindAppearance('textEnglishSize', 'px');
bindAppearance('textWidth', '%');
bindAppearance('textY', '%');
bindAppearance('textMarginX', '%');
bindAppearance('textMarginY', '%');
bindAppearance('textArabicSpacing', '×', value => `${(Number(value) / 100).toFixed(2)}×`);
bindAppearance('textEnglishSpacing', '×', value => `${(Number(value) / 100).toFixed(2)}×`);
bindAppearance('textGap', 'px');
bindAppearance('textStrokeWidth', 'px');
bindAppearance('textStrokeOpacity', '%');
bindAppearance('textShadowBlur', 'px');
bindAppearance('textShadowOpacity', '%');
bindAppearance('verseLabelSize', 'px');
bindAppearance('verseLabelY', '%');
$('arabicFont')?.addEventListener('change', renderAppearancePreview);
$('textArabicColor')?.addEventListener('input', renderAppearancePreview);
$('textEnglishColor')?.addEventListener('input', renderAppearancePreview);
$('wordHighlightEnabled')?.addEventListener('change', renderAppearancePreview);
$('highlightGranularity')?.addEventListener('change', () => {
  renderAppearancePreview();
  renderWordEditor();
  renderPhraseStrip();
  renderEditorPreview();
});
$('wordHighlightColor')?.addEventListener('input', renderAppearancePreview);
$('verseLabelEnabled')?.addEventListener('change', renderAppearancePreview);
$('shadowEnabled')?.addEventListener('change', async () => {
  try {
    if ($('shadowEnabled').checked && !state.shadowOverlay.file) await useIncludedShadow();
    else { syncShadowStateFromControls(); renderAppearancePreview(); }
  } catch (error) {
    $('shadowEnabled').checked = false;
    state.shadowOverlay.enabled = false;
    alert(error.message || String(error));
  }
});
$('useIncludedShadow')?.addEventListener('click', () => useIncludedShadow().catch(error => alert(error.message || String(error))));
$('shadowFile')?.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) loadShadowFile(file, { enable: true }).catch(error => alert(error.message || String(error)));
  event.target.value = '';
});
['shadowX','shadowY','shadowSize','shadowOpacity'].forEach(id => $(id)?.addEventListener('input', () => {
  syncShadowStateFromControls(); syncShadowControls(); renderAppearancePreview();
}));
document.querySelectorAll('[data-wm]').forEach(button => button.addEventListener('click', () => {
  state.watermarkType = button.dataset.wm;
  state.watermarkFile = null; state.watermarkElement = null;
  document.querySelectorAll('[data-wm]').forEach(item => item.classList.toggle('selected', item === button));
  renderWatermarkControls(); renderWatermarkPreview();
}));
$('format').addEventListener('change', () => { renderExportSummary(); renderIntroPreviewStatic(); renderBackgroundPreview(); renderWatermarkPreview(); });
$('quality').addEventListener('change', () => { renderExportSummary(); renderIntroPreviewStatic(); renderBackgroundPreview(); renderWatermarkPreview(); });
$('retentionEnabled')?.addEventListener('change', () => { syncRetentionState(); renderExportSummary(); });
['retentionHook','retentionDuration','retentionSmartOpening','retentionMotion'].forEach(id => $(id)?.addEventListener('input', () => { syncRetentionState(); renderExportSummary(); }));
$('introEnabled')?.addEventListener('change', () => { syncIntroState(); renderIntroPreviewStatic(); renderExportSummary(); });
['introArabic','introEnglish','introDuration','introSound'].forEach(id => $(id)?.addEventListener('input', () => { syncIntroState(); renderIntroPreviewStatic(); renderExportSummary(); }));
$('introPreviewBtn')?.addEventListener('click', playIntroPreview);
$('introUseSurah')?.addEventListener('click', () => {
  const surah = currentSurah();
  if (!surah) return;
  if ($('introArabic')) $('introArabic').value = `سُورَةُ ${surah.arabicName}`;
  if ($('introEnglish')) $('introEnglish').value = `Surah ${surah.englishName}`;
  syncIntroState();
  renderIntroPreviewStatic();
  renderExportSummary();
});
bindAppearance('globalFadeIn', 's', value => `${Number(value).toFixed(1)}s`);
bindAppearance('globalFadeOut', 's', value => `${Number(value).toFixed(1)}s`);
$('globalFadeIn')?.addEventListener('input', () => { renderExportSummary(); renderBackgroundPreview(); updateSettingsPlaybackUI(); });
$('globalFadeOut')?.addEventListener('input', () => { renderExportSummary(); renderBackgroundPreview(); updateSettingsPlaybackUI(); });
$('translationToggle').addEventListener('change', () => { state.translation = $('translationToggle').checked; renderExportSummary(); renderAppearancePreview(); renderWatermarkPreview(); });
document.querySelectorAll('[data-style-preset]').forEach(button => button.addEventListener('click', () => applyAppearancePreset(button.dataset.stylePreset)));
$('resetAppearance')?.addEventListener('click', () => applyAppearancePreset('balanced'));
$('generateBtn').addEventListener('click', generateVideo);

window.addEventListener('keydown', event => {
  if (state.step !== 3 || !state.wordTimings.length) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const amount = (event.shiftKey ? 0.05 : 0.01) * (event.key === 'ArrowLeft' ? -1 : 1);
    moveWord(state.selectedWord, amount);
    renderTimeline(); renderWordEditor(); renderPhraseStrip(); renderEditorPreview();
  }
});
window.addEventListener('resize', () => { if (state.step === 3) renderTimeline(); });

// Canvas text must be redrawn after the bundled face loads, and exports must wait.
const arabicFontsReady = loadArabicFonts().then(fonts => {
  arabicFonts = fonts;
  renderAppearancePreview();
});

populateSurahs();
setSourceMode('upload');
applyAppearancePreset('balanced');
syncShadowControls();
syncRetentionState();
renderSteps();
checkBackend();
if (sessionStorage.getItem('quranSyncStartNew') === '1') {
  sessionStorage.removeItem('quranSyncStartNew');
  hideProjectDashboard();
} else showProjectDashboard();
setInterval(() => { if (state.currentProjectId && !state.projectSaveBusy) saveCurrentProject({ quiet: true }); }, 45000);
