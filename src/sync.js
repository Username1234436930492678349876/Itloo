function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

function smooth(values, radius = 2) {
  if (radius <= 0) return Float32Array.from(values);
  const out = new Float32Array(values.length);
  let sum = 0;
  let left = 0;
  let right = -1;
  for (let i = 0; i < values.length; i += 1) {
    const targetLeft = Math.max(0, i - radius);
    const targetRight = Math.min(values.length - 1, i + radius);
    while (right < targetRight) { right += 1; sum += values[right]; }
    while (left < targetLeft) { sum -= values[left]; left += 1; }
    out[i] = sum / (right - left + 1);
  }
  return out;
}

function normalizeSeries(values) {
  let max = 1e-9;
  for (const value of values) if (value > max) max = value;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = values[i] / max;
  return out;
}

export function buildEnvelope(audioBuffer, frameMs = 18) {
  const sampleRate = audioBuffer.sampleRate;
  const frameSize = Math.max(128, Math.round(sampleRate * frameMs / 1000));
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c += 1) channels.push(audioBuffer.getChannelData(c));
  const frames = Math.ceil(audioBuffer.length / frameSize);
  const rms = new Float32Array(frames);
  const hf = new Float32Array(frames);

  for (let f = 0; f < frames; f += 1) {
    const start = f * frameSize;
    const end = Math.min(audioBuffer.length, start + frameSize);
    const step = Math.max(1, Math.floor((end - start) / 420));
    let sumSq = 0;
    let sumDiffSq = 0;
    let count = 0;
    let previous = null;
    for (let i = start; i < end; i += step) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample /= channels.length;
      sumSq += sample * sample;
      if (previous != null) {
        const diff = sample - previous;
        sumDiffSq += diff * diff;
      }
      previous = sample;
      count += 1;
    }
    rms[f] = Math.sqrt(sumSq / Math.max(1, count));
    hf[f] = Math.sqrt(sumDiffSq / Math.max(1, count - 1));
  }

  return {
    values: smooth(normalizeSeries(rms), 2),
    hf: smooth(normalizeSeries(hf), 1),
    frameSeconds: frameSize / sampleRate,
    duration: audioBuffer.duration,
  };
}

export async function decodeAudioFile(file) {
  const bytes = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('This browser cannot analyze audio. Use a recent Chrome or Edge.');
  const ctx = new AudioCtx();
  try {
    return await ctx.decodeAudioData(bytes.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }
}

const DECORATION_RE = /[\u06D6-\u06ED]/g;
const DIACRITIC_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const AYAH_MARKER_RE = /^[\u06DD\u0660-\u0669\u06F0-\u06F90-9]+$/;

export function normalizeArabicForAlignment(text) {
  return String(text || '')
    .replace(DIACRITIC_RE, '')
    .replace(/ـ/g, '')
    .replace(/ٱ/g, 'ا')
    .replace(/[^\u0621-\u064A\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stopStrength(token) {
  const text = String(token || '');
  // Common Uthmani pause marks. Positive values encourage a phrase boundary;
  // negative values discourage one.
  if (/\u06D8/.test(text)) return 1.0; // mandatory/strong stop marker
  if (/\u06D7|\u06DA/.test(text)) return 0.9; // stop preferred/permitted
  if (/\u06DB|\u06DC/.test(text)) return 0.72;
  if (/\u06D6/.test(text)) return 0.18; // continuation is often preferred
  if (/\u06D9/.test(text)) return -1.0; // do not stop
  return 0;
}

export function splitArabicWordObjects(text) {
  const raw = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .filter(token => !AYAH_MARKER_RE.test(token));

  const provisional = [];
  for (const token of raw) {
    const bare = normalizeArabicForAlignment(token);
    if (!bare) {
      // Standalone Uthmani marks/diacritics belong to the preceding word.
      // Concatenate without a space so they never become fake subtitle items.
      if (provisional.length && /[\u064B-\u065F\u0670\u06D6-\u06ED]/.test(token)) {
        const previous = provisional.at(-1);
        previous.display = `${previous.display}${token}`;
        previous.stop = stopStrength(token) || previous.stop;
      }
      continue;
    }
    provisional.push({ display: token, bare, stop: stopStrength(token) });
  }

  // Some Qur'an feeds expose morphology fragments as whitespace-separated
  // pieces (for example ذَ + ٰلِكُمُ). Rejoin a lone leading letter to the
  // following piece before timing/grouping. Preserve the standalone muqatta'at
  // single letters that really are intended to appear alone.
  const standaloneLetters = new Set(['ص', 'ق', 'ن']);
  const repaired = [];
  for (let i = 0; i < provisional.length; i += 1) {
    const current = provisional[i];
    const next = provisional[i + 1];
    const letterCount = (current.bare.match(/[\u0621-\u064A]/g) || []).length;
    if (
      next &&
      letterCount === 1 &&
      !standaloneLetters.has(current.bare) &&
      current.stop <= 0 &&
      normalizeArabicForAlignment(next.display)
    ) {
      const display = `${current.display}${next.display}`;
      repaired.push({
        display,
        bare: normalizeArabicForAlignment(display),
        stop: next.stop || current.stop,
      });
      i += 1;
      continue;
    }
    repaired.push(current);
  }

  return repaired.map((word, index) => ({ ...word, index }));
}

export function splitArabicWords(text) {
  return splitArabicWordObjects(text).map(word => word.display);
}

export function phoneticWordWeight(word) {
  const text = String(word?.display ?? word ?? '');
  const core = text.replace(DECORATION_RE, '');
  const letters = (core.match(/[\u0621-\u064A]/g) || []).length;
  const shadda = (core.match(/\u0651/g) || []).length;
  const madd = (core.match(/[\u0653\u0670]/g) || []).length;
  const longVowels = (normalizeArabicForAlignment(core).match(/[اويى]/g) || []).length;
  const tanween = (core.match(/[\u064B-\u064D]/g) || []).length;
  return Math.max(0.8, letters + shadda * 0.8 + madd * 0.95 + longVowels * 0.24 + tanween * 0.08);
}

export function textWeight(text) {
  const words = splitArabicWordObjects(text);
  if (!words.length) return 1;
  return words.reduce((sum, word) => sum + phoneticWordWeight(word), 0);
}

function avg(values, start, end) {
  if (!values.length) return 0;
  const s = Math.max(0, start);
  const e = Math.min(values.length - 1, end);
  if (e < s) return values[Math.max(0, Math.min(values.length - 1, s))] || 0;
  let total = 0;
  for (let i = s; i <= e; i += 1) total += values[i];
  return total / (e - s + 1);
}

export function buildBoundaryStrength(envelope) {
  if (envelope.boundaryStrength?.length === envelope.values.length) return envelope.boundaryStrength;
  const values = envelope.values;
  const hf = envelope.hf?.length === values.length ? envelope.hf : values;
  const raw = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const before = avg(values, i - 5, i - 2);
    const current = avg(values, i - 1, i + 1);
    const after = avg(values, i + 2, i + 6);
    const hfBefore = avg(hf, i - 5, i - 2);
    const hfAfter = avg(hf, i + 2, i + 6);
    const local = (before + after) / 2;
    const valley = Math.max(0, local - current);
    const onset = Math.max(0, after - current) + Math.max(0, hfAfter - hfBefore) * 0.32;
    const quiet = Math.max(0, 1 - current);
    raw[i] = quiet * 0.45 + valley * 1.75 + onset * 1.05;
  }
  const strength = smooth(normalizeSeries(raw), 1);
  envelope.boundaryStrength = strength;
  return strength;
}

function pauseCandidates(envelope) {
  const { values, frameSeconds, duration } = envelope;
  const arr = Array.from(values);
  const q15 = percentile(arr, 0.15);
  const q35 = percentile(arr, 0.35);
  const threshold = Math.max(0.008, Math.min(0.14, q15 * 1.7 + q35 * 0.2 + 0.005));
  const minFrames = Math.max(2, Math.round(0.075 / frameSeconds));
  const candidates = [];

  let start = -1;
  for (let i = 0; i <= values.length; i += 1) {
    const quiet = i < values.length && values[i] <= threshold;
    if (quiet && start < 0) start = i;
    if ((!quiet || i === values.length) && start >= 0) {
      const end = i - 1;
      const count = end - start + 1;
      if (count >= minFrames) {
        let minIndex = start;
        let minValue = values[start];
        let average = 0;
        for (let j = start; j <= end; j += 1) {
          average += values[j];
          if (values[j] < minValue) { minValue = values[j]; minIndex = j; }
        }
        average /= count;
        const pauseDuration = count * frameSeconds;
        const midpoint = ((start + end) / 2) * frameSeconds;
        candidates.push({
          time: Math.max(0, Math.min(duration, pauseDuration > 0.18 ? midpoint : minIndex * frameSeconds)),
          quietness: Math.max(0, Math.min(1, 1 - average / Math.max(threshold, 1e-6))),
          pauseDuration,
        });
      }
      start = -1;
    }
  }
  return candidates;
}

function strongestBoundaryNear(envelope, target, from, to, distancePenalty = 0.72) {
  const strength = buildBoundaryStrength(envelope);
  const { frameSeconds } = envelope;
  const start = Math.max(0, Math.floor(from / frameSeconds));
  const end = Math.min(strength.length - 1, Math.ceil(to / frameSeconds));
  const span = Math.max(0.1, to - from);
  let bestIndex = Math.max(start, Math.min(end, Math.round(target / frameSeconds)));
  let bestScore = -Infinity;
  for (let i = start; i <= end; i += 1) {
    const time = i * frameSeconds;
    const distance = Math.abs(time - target) / span;
    const score = strength[i] * 1.9 - distance * distancePenalty;
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  return bestIndex * frameSeconds;
}

export function alignAyahsToEnvelope(ayahs, envelope) {
  const n = ayahs.length;
  const duration = envelope.duration;
  if (!n) return [];
  if (n === 1) return [{ ...ayahs[0], start: 0, end: duration, confidence: 'auto' }];

  const weights = ayahs.map(a => textWeight(a.text));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const pauses = pauseCandidates(envelope);
  const boundaries = [0];
  let running = 0;
  const averageSeg = duration / n;
  const minSeg = Math.max(0.2, Math.min(1.0, averageSeg * 0.14));

  for (let i = 0; i < n - 1; i += 1) {
    running += weights[i];
    const expected = duration * (running / totalWeight);
    const prev = boundaries.at(-1);
    const remaining = n - i - 1;
    const latest = Math.max(prev + minSeg, duration - remaining * minSeg);
    const target = Math.max(prev + minSeg, Math.min(latest, expected));
    const radius = Math.max(0.9, Math.min(7.5, averageSeg * 0.82));
    const from = Math.max(prev + minSeg, target - radius);
    const to = Math.min(latest, target + radius);

    let best = null;
    let bestScore = -Infinity;
    for (const pause of pauses) {
      if (pause.time < from || pause.time > to) continue;
      const distance = Math.abs(pause.time - target) / Math.max(0.25, radius);
      const score = pause.quietness * 0.9 + Math.min(1, pause.pauseDuration / 0.45) * 0.42 - distance * 0.9;
      if (score > bestScore) { bestScore = score; best = pause; }
    }

    let boundary = best && bestScore > -0.05
      ? best.time
      : strongestBoundaryNear(envelope, target, from, to, 0.7);
    boundary = Math.max(prev + minSeg, Math.min(latest, boundary));
    boundaries.push(boundary);
  }
  boundaries.push(duration);

  return ayahs.map((ayah, index) => ({
    ...ayah,
    start: boundaries[index],
    end: boundaries[index + 1],
    confidence: 'auto',
  }));
}

function translationBoundaryHints(translation) {
  const tokens = String(translation || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length < 2) return [];
  const hints = [];
  const clauseOpeners = new Set(['but', 'then', 'while', 'when', 'because', 'except', 'unless', 'until', 'whereas', 'although']);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    let strength = 0;
    if (/[.!?;:]$/.test(token)) strength = 1;
    else if (/[,—–-]$/.test(token)) strength = 0.7;
    if (strength) hints.push({ ratio: (i + 1) / tokens.length, strength });
    const next = tokens[i + 1].toLowerCase().replace(/[^a-z]/g, '');
    if (clauseOpeners.has(next)) hints.push({ ratio: (i + 1) / tokens.length, strength: 0.45 });
  }
  return hints;
}

const ARABIC_CONNECTORS = new Set([
  'من','في','إلى','الى','على','عن','أن','ان','إن','اذا','إذا','ثم','أو','او','بل','لكن','حتى','كي','لما','لم','لن','ما','ولا','فلا','فإن','فان','وإن','وان','كما','مع'
]);

function boundaryMeaningScore(words, endIndex, hints) {
  if (endIndex >= words.length - 1) return 0;
  const ratio = (endIndex + 1) / words.length;
  let score = Math.max(0, words[endIndex].stop);
  for (const hint of hints) {
    const distance = Math.abs(hint.ratio - ratio);
    const closeness = Math.max(0, 1 - distance * Math.max(4, words.length * 0.72));
    score = Math.max(score, hint.strength * closeness);
  }
  return score;
}

function phraseConfig(style) {
  if (style === 'compact') return { min: 1, max: 4, target: 2.8 };
  if (style === 'spacious') return { min: 3, max: 8, target: 5.0 };
  return { min: 2, max: 6, target: 3.8 };
}

function semanticRanges(words, translation, style = 'auto') {
  const n = words.length;
  if (!n) return [];
  if (n <= 3) return [[0, n - 1]];
  const cfg = phraseConfig(style);
  const hints = translationBoundaryHints(translation);
  const dp = new Array(n + 1).fill(Infinity);
  const back = new Array(n + 1).fill(-1);
  dp[0] = 0;

  for (let end = 1; end <= n; end += 1) {
    const minLen = 1;
    const maxLen = Math.min(cfg.max, end);
    for (let len = minLen; len <= maxLen; len += 1) {
      const start = end - len;
      if (!Number.isFinite(dp[start])) continue;
      const isFinal = end === n;
      let cost = dp[start] + Math.pow(len - cfg.target, 2) * 0.42;

      if (style === 'auto' && len === 1 && n > 4) cost += 2.4;
      if (style === 'spacious' && len < 3 && !isFinal) cost += 3.0;
      if (style === 'compact' && len > 3) cost += 0.65;

      // Avoid crossing meaningful Qur'anic stop marks inside one screen.
      for (let i = start; i < end - 1; i += 1) {
        if (words[i].stop >= 0.7) cost += 4.7 * words[i].stop;
      }

      if (!isFinal) {
        const boundaryWord = words[end - 1];
        const meaning = boundaryMeaningScore(words, end - 1, hints);
        cost -= meaning * 4.0;
        if (boundaryWord.stop < 0) cost += 6.0;
        if (ARABIC_CONNECTORS.has(boundaryWord.bare)) cost += 2.2;

        // Penalize crossing a strong translation clause break.
        const leftRatio = start / n;
        const rightRatio = end / n;
        for (const hint of hints) {
          if (hint.ratio > leftRatio + 0.04 && hint.ratio < rightRatio - 0.04) {
            cost += hint.strength * 1.8;
          }
        }
      }

      // A tiny preference for balanced neighboring screens.
      if (start > 0 && back[start] >= 0) {
        const previousLen = start - back[start];
        cost += Math.abs(previousLen - len) * 0.08;
      }

      if (cost < dp[end]) {
        dp[end] = cost;
        back[end] = start;
      }
    }
  }

  const ranges = [];
  let cursor = n;
  while (cursor > 0) {
    let start = back[cursor];
    if (start < 0) start = Math.max(0, cursor - cfg.max);
    ranges.push([start, cursor - 1]);
    cursor = start;
  }
  ranges.reverse();
  return ranges;
}

function englishConnectorPenalty(token) {
  const bare = String(token || '').toLowerCase().replace(/[^a-z]/g, '');
  return new Set(['and','or','to','of','in','with','for','from','by','as','that','which','who','whose','the','a','an']).has(bare) ? 1 : 0;
}

function distributeTranslationSemantically(translation, groupWeights) {
  const tokens = String(translation || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const n = groupWeights.length;
  if (!n) return [];
  if (!tokens.length) return new Array(n).fill('');
  if (n === 1) return [tokens.join(' ')];

  const totalWeight = groupWeights.reduce((a, b) => a + b, 0) || n;
  const boundaries = [0];
  let cumulative = 0;
  for (let i = 0; i < n - 1; i += 1) {
    cumulative += groupWeights[i];
    const expected = tokens.length * cumulative / totalWeight;
    const min = Math.min(tokens.length, boundaries.at(-1) + (tokens.length >= n ? 1 : 0));
    const remaining = n - i - 1;
    const max = Math.max(min, tokens.length - (tokens.length >= n ? remaining : 0));
    let best = Math.max(min, Math.min(max, Math.round(expected)));
    let bestScore = Infinity;
    const radius = Math.max(2, Math.ceil(tokens.length / Math.max(4, n * 1.8)));
    for (let b = Math.max(min, Math.floor(expected - radius)); b <= Math.min(max, Math.ceil(expected + radius)); b += 1) {
      if (b <= 0 || b >= tokens.length) continue;
      const prevToken = tokens[b - 1];
      const punctuationBonus = /[.!?;:]$/.test(prevToken) ? 1.5 : (/[,—–-]$/.test(prevToken) ? 0.8 : 0);
      const connector = englishConnectorPenalty(prevToken) * 0.75;
      const distance = Math.abs(b - expected) / Math.max(1, radius);
      const score = distance + connector - punctuationBonus;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    boundaries.push(best);
  }
  boundaries.push(tokens.length);
  return groupWeights.map((_, i) => tokens.slice(boundaries[i], boundaries[i + 1]).join(' '));
}


const ENGLISH_ANCHOR_STOP = new Set([
  'a','an','the','and','or','of','to','in','on','at','for','from','by','with','as','is','are','was','were','be','been','being',
  'that','this','these','those','it','its','he','she','they','them','his','her','their','you','your','we','our','i','my','me'
]);

function normalizeAnchorToken(token) {
  let value = String(token || '').toLowerCase().replace(/[^a-z']/g, '');
  value = value.replace(/^'+|'+$/g, '');
  if (value.endsWith("'s")) value = value.slice(0, -2);
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s')) value = value.slice(0, -1);
  return value;
}

function contentTokenSet(tokens) {
  const set = new Set();
  for (const token of tokens) {
    const normalized = normalizeAnchorToken(token);
    if (normalized && !ENGLISH_ANCHOR_STOP.has(normalized)) set.add(normalized);
  }
  return set;
}

function levenshteinDistance(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  const curr = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= y.length; j += 1) prev[j] = curr[j];
  }
  return prev[y.length];
}

function englishTokenSimilarity(a, b) {
  const x = normalizeAnchorToken(a);
  const y = normalizeAnchorToken(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const minLen = Math.min(x.length, y.length);
  if (minLen >= 4 && (x.startsWith(y) || y.startsWith(x))) return 0.88;
  const distance = levenshteinDistance(x, y);
  const ratio = 1 - distance / Math.max(x.length, y.length);
  return ratio >= 0.6 ? ratio * 0.82 : 0;
}

function glossFitCost(glossText, segmentTokens) {
  const glossTokens = String(glossText || '').split(/\s+/).filter(Boolean);
  const normalizedGloss = glossTokens.map(normalizeAnchorToken).filter(Boolean);
  const normalizedSegment = segmentTokens.map(normalizeAnchorToken).filter(Boolean);
  const contentGloss = normalizedGloss.filter(token => !ENGLISH_ANCHOR_STOP.has(token));
  const contentSegment = normalizedSegment.filter(token => !ENGLISH_ANCHOR_STOP.has(token));

  // Some Qur'anic particles legitimately contribute no standalone English token.
  if (!segmentTokens.length) {
    return contentGloss.length ? 3.8 : 0.9;
  }

  const source = contentGloss.length ? contentGloss : normalizedGloss;
  const target = contentSegment.length ? contentSegment : normalizedSegment;
  let coverage = 0;
  for (const token of source) {
    let best = 0;
    for (const candidate of target) best = Math.max(best, englishTokenSimilarity(token, candidate));
    coverage += best;
  }
  coverage = source.length ? coverage / source.length : 0.5;

  let precision = 0;
  for (const token of target) {
    let best = 0;
    for (const candidate of source) best = Math.max(best, englishTokenSimilarity(token, candidate));
    precision += best;
  }
  precision = target.length ? precision / target.length : 0.5;

  const expected = Math.max(0.8, normalizedGloss.length || 1);
  const lengthPenalty = Math.abs(segmentTokens.length - expected) / Math.max(1, expected);
  return (1 - coverage) * 3.3 + (1 - precision) * 0.9 + lengthPenalty * 0.34;
}

function alignSahihTokensToArabicWords(translation, wordTranslations) {
  const tokens = String(translation || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const glosses = Array.isArray(wordTranslations) ? wordTranslations : [];
  const n = glosses.length;
  const m = tokens.length;
  if (!n || !m) return null;

  // dp[i][j] = best cost after mapping the first i Arabic words onto the first j
  // Saheeh tokens. Each Arabic word may own 0..8 English tokens. This gives us a
  // monotonic word-level map first; phrase translations are then exact unions of
  // those word spans, instead of being re-guessed independently for every phrase.
  const inf = 1e12;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(inf));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-1));
  dp[0][0] = 0;

  for (let i = 0; i < n; i += 1) {
    const remainingWords = n - i - 1;
    for (let j = 0; j <= m; j += 1) {
      if (!Number.isFinite(dp[i][j]) || dp[i][j] >= inf) continue;
      const maxTake = Math.min(8, m - j);
      for (let take = 0; take <= maxTake; take += 1) {
        // Leave enough flexibility for the remaining words, but do not force each
        // Arabic word to consume English because particles often translate jointly.
        if (i === n - 1 && j + take !== m) continue;
        if (remainingWords > 0 && m - (j + take) > remainingWords * 8) continue;
        const segment = tokens.slice(j, j + take);
        let cost = glossFitCost(glosses[i], segment);
        // Very long allocations to one word are almost always explanatory spillover.
        if (take > 5) cost += (take - 5) * 0.45;
        // Reward punctuation boundaries slightly; Saheeh clause punctuation is useful.
        const last = segment.at(-1) || '';
        if (/[.!?;:]$/.test(last)) cost -= 0.10;
        const next = dp[i][j] + cost;
        if (next < dp[i + 1][j + take]) {
          dp[i + 1][j + take] = next;
          back[i + 1][j + take] = j;
        }
      }
    }
  }

  if (!Number.isFinite(dp[n][m]) || back[n][m] < 0) return null;
  const boundaries = new Array(n + 1).fill(0);
  boundaries[n] = m;
  let cursor = m;
  for (let i = n; i > 0; i -= 1) {
    cursor = back[i][cursor];
    if (cursor < 0) return null;
    boundaries[i - 1] = cursor;
  }
  return { tokens, boundaries, cost: dp[n][m] / Math.max(1, n) };
}

function alignSahihTokensToPhraseRanges(translation, ranges, wordTranslations) {
  const tokens = String(translation || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const glosses = Array.isArray(wordTranslations) ? wordTranslations : [];
  if (!tokens.length || !ranges?.length || !glosses.length) return null;

  const phraseGlosses = ranges.map(([start, end]) =>
    glosses.slice(start, end + 1).filter(Boolean).join(' ').trim()
  );
  const useful = phraseGlosses.filter(gloss => contentTokenSet(String(gloss).split(/\s+/)).size > 0).length;
  if (useful < Math.ceil(ranges.length * 0.55)) return null;

  // Phrase-level dynamic programming is more faithful than cutting a word-level
  // alignment after the fact. Saheeh International often reorders small particles,
  // while the combined gloss of a displayed Arabic phrase usually identifies its
  // exact English clause very clearly.
  const n = ranges.length;
  const m = tokens.length;
  const inf = 1e12;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(inf));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-1));
  dp[0][0] = 0;

  // The old per-word alignment remains useful as a soft positional prior only.
  const wordPrior = alignSahihTokensToArabicWords(translation, glosses);
  const expectedBoundaries = [0];
  if (wordPrior) {
    for (let i = 0; i < ranges.length - 1; i += 1) {
      expectedBoundaries.push(wordPrior.boundaries[ranges[i][1] + 1] ?? Math.round((i + 1) * m / n));
    }
  }
  expectedBoundaries.push(m);

  for (let i = 0; i < n; i += 1) {
    const remaining = n - i - 1;
    for (let j = 0; j <= m; j += 1) {
      if (!Number.isFinite(dp[i][j]) || dp[i][j] >= inf) continue;
      const minimumTake = m - j >= remaining + 1 ? 1 : 0;
      const maxTake = Math.min(22, m - j - Math.max(0, remaining));
      for (let take = minimumTake; take <= maxTake; take += 1) {
        if (i === n - 1 && j + take !== m) continue;
        const segment = tokens.slice(j, j + take);
        const gloss = phraseGlosses[i];
        let cost = glossFitCost(gloss, segment) * 1.15;

        const expectedEnd = expectedBoundaries[i + 1] ?? ((i + 1) * m / n);
        const positionError = Math.abs((j + take) - expectedEnd) / Math.max(2, m / Math.max(1, n));
        cost += positionError * (wordPrior ? 0.34 : 0.14);

        // Prefer natural Saheeh clause boundaries when semantics are otherwise close.
        const last = segment.at(-1) || '';
        if (/[.!?;:]$/.test(last)) cost -= 0.32;
        else if (/[,—–-]$/.test(last)) cost -= 0.16;
        if (take && englishConnectorPenalty(last)) cost += 0.22;

        // Prevent one phrase from swallowing explanatory text that belongs to the next.
        const glossLen = Math.max(1, String(gloss).split(/\s+/).filter(Boolean).length);
        if (take > glossLen + 7) cost += (take - glossLen - 7) * 0.3;

        const next = dp[i][j] + cost;
        if (next < dp[i + 1][j + take]) {
          dp[i + 1][j + take] = next;
          back[i + 1][j + take] = j;
        }
      }
    }
  }

  if (!Number.isFinite(dp[n][m]) || back[n][m] < 0) return null;
  const boundaries = new Array(n + 1).fill(0);
  boundaries[n] = m;
  let cursor = m;
  for (let i = n; i > 0; i -= 1) {
    cursor = back[i][cursor];
    if (cursor < 0) return null;
    boundaries[i - 1] = cursor;
  }
  const averageCost = dp[n][m] / Math.max(1, n);
  if (averageCost > 4.1) return null;
  return ranges.map((_, i) => tokens.slice(boundaries[i], boundaries[i + 1]).join(' ').trim());
}


export function distributeTranslationWithWordAnchors(translation, ranges, wordTranslations, groupWeights) {
  const fallback = () => distributeTranslationSemantically(translation, groupWeights);
  const n = ranges.length;
  if (!n) return [];
  const tokens = String(translation || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!tokens.length) return new Array(n).fill('');
  if (n === 1) return [tokens.join(' ')];
  const maxWordIndex = Math.max(...ranges.map(range => range[1]));
  if (!Array.isArray(wordTranslations) || wordTranslations.length <= maxWordIndex) return fallback();

  const phraseAlignment = alignSahihTokensToPhraseRanges(translation, ranges, wordTranslations);
  if (phraseAlignment?.length === n && phraseAlignment.every((part, i) => part || !ranges[i])) {
    return phraseAlignment;
  }

  const alignment = alignSahihTokensToArabicWords(translation, wordTranslations);
  if (!alignment || alignment.cost > 3.35) return fallback();
  return ranges.map(([start, end]) => {
    const tokenStart = alignment.boundaries[start] ?? 0;
    const tokenEnd = alignment.boundaries[end + 1] ?? tokenStart;
    return alignment.tokens.slice(tokenStart, tokenEnd).join(' ').trim();
  });
}

function distributeTranslationForRanges(ayah, ranges, groupWeights) {
  // Basmalah is special: never infer/split it from another ayah's translation.
  // Keep a fixed English segment for each of its four Arabic words, then join
  // only the segments that correspond to the displayed Arabic word range.
  if (ayah?.isIstiatha || Number(ayah?.number) === -1) {
    const pieces = ['I seek refuge', 'in Allah', 'from', 'Satan,', 'the accursed.'];
    return ranges.map(([start, end]) => pieces.slice(start, end + 1).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim());
  }
  if (ayah?.isBasmalah || Number(ayah?.number) === 0) {
    const pieces = [
      'In the name',
      'of Allah,',
      'the Entirely Merciful,',
      'the Especially Merciful.'
    ];
    return ranges.map(([start, end]) => pieces.slice(start, end + 1).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim());
  }
  return distributeTranslationWithWordAnchors(ayah.translation, ranges, ayah.wordTranslations, groupWeights);
}

export function buildSemanticGroups(ayahs, style = 'auto') {
  const groups = [];
  for (const ayah of ayahs) {
    const words = splitArabicWordObjects(ayah.text);
    const ranges = semanticRanges(words, ayah.translation, style);
    const weights = ranges.map(([start, end]) => {
      let total = 0;
      for (let i = start; i <= end; i += 1) total += phoneticWordWeight(words[i]);
      return total;
    });
    const translated = distributeTranslationForRanges(ayah, ranges, weights);
    ranges.forEach(([start, end], index) => {
      const slice = words.slice(start, end + 1);
      groups.push({
        id: `${occurrenceKey(ayah)}-${index + 1}`,
        ayahNumber: ayah.number,
        sequenceIndex: ayah.sequenceIndex ?? 0,
        occurrenceIndex: ayah.occurrenceIndex ?? 0,
        occurrenceKey: occurrenceKey(ayah),
        groupInAyah: index + 1,
        groupCountInAyah: ranges.length,
        wordStart: start,
        wordEnd: end,
        words: slice.map(word => word.display),
        arabic: slice.map(word => word.display).join(' '),
        translation: translated[index] || '',
        weight: weights[index],
        wordCount: slice.length,
        semantic: true,
      });
    });
  }
  return groups;
}


function occurrenceKey(item) {
  return item?.occurrenceKey || `${Number(item?.ayahNumber ?? item?.number ?? 0)}@${Number(item?.sequenceIndex ?? 0)}`;
}

function timedWordsForAyah(timedWords, ayah) {
  const key = occurrenceKey(ayah);
  return timedWords
    .filter(word => occurrenceKey(word) === key)
    .sort((a, b) => (a.wordIndex ?? 0) - (b.wordIndex ?? 0));
}

function semanticTimedRanges(words, translation, timings, style = 'auto') {
  const n = words.length;
  if (!n) return [];
  if (n <= 2) return [[0, n - 1]];
  const hints = translationBoundaryHints(translation);
  const cfg = style === 'compact'
    ? { targetDuration: 1.75, maxDuration: 3.6, maxWords: 5, targetWords: 2.6 }
    : style === 'spacious'
      ? { targetDuration: 3.35, maxDuration: 6.2, maxWords: 9, targetWords: 5.2 }
      : { targetDuration: 2.55, maxDuration: 4.8, maxWords: 8, targetWords: 4.0 };

  const dp = new Array(n + 1).fill(Infinity);
  const back = new Array(n + 1).fill(-1);
  dp[0] = 0;

  function boundaryReward(endIndex) {
    if (endIndex >= n - 1) return 1.2;
    const meaning = boundaryMeaningScore(words, endIndex, hints);
    const left = timings[endIndex];
    const right = timings[endIndex + 1];
    const gap = left && right ? Math.max(0, right.start - left.end) : 0;
    const acoustic = Math.min(1.2, gap / 0.32);
    const conf = Math.min(Number(left?.boundaryConfidence ?? 0), Number(right?.boundaryConfidence ?? 0));
    return meaning * 2.5 + acoustic * 1.45 + conf * 0.35;
  }

  for (let end = 1; end <= n; end += 1) {
    const maxLen = Math.min(cfg.maxWords, end);
    for (let len = 1; len <= maxLen; len += 1) {
      const start = end - len;
      if (!Number.isFinite(dp[start])) continue;
      const first = timings[start];
      const last = timings[end - 1];
      const duration = first && last ? Math.max(0.05, last.end - first.start) : len * 0.65;
      const chars = words.slice(start, end).reduce((sum, word) => sum + word.bare.length, 0);
      const isFinal = end === n;
      let cost = dp[start];

      cost += Math.pow((duration - cfg.targetDuration) / Math.max(0.7, cfg.targetDuration), 2) * 0.85;
      cost += Math.pow((len - cfg.targetWords) / Math.max(1.5, cfg.targetWords), 2) * 0.32;
      if (duration > cfg.maxDuration) cost += Math.pow(duration - cfg.maxDuration, 2) * 3.0;
      if (duration < 0.62 && !isFinal) cost += 1.5;
      if (chars > 44) cost += Math.pow((chars - 44) / 12, 2) * 1.25;
      if (len === 1 && n > 4 && duration < 1.05) cost += 1.6;

      for (let i = start; i < end - 1; i += 1) {
        if (words[i].stop >= 0.7) cost += words[i].stop * 5.2;
        const gap = timings[i] && timings[i + 1] ? Math.max(0, timings[i + 1].start - timings[i].end) : 0;
        if (gap > 0.42) cost += Math.min(3.2, gap * 4.0);
      }

      if (!isFinal) {
        cost -= boundaryReward(end - 1) * 1.7;
        if (words[end - 1].stop < 0) cost += 7.0;
        if (ARABIC_CONNECTORS.has(words[end - 1].bare)) cost += 2.6;
      }

      if (cost < dp[end]) {
        dp[end] = cost;
        back[end] = start;
      }
    }
  }

  const ranges = [];
  let cursor = n;
  while (cursor > 0) {
    let start = back[cursor];
    if (start < 0) start = Math.max(0, cursor - Math.min(cfg.maxWords, cursor));
    ranges.push([start, cursor - 1]);
    cursor = start;
  }
  return ranges.reverse();
}

export function buildContextAwareGroups(ayahs, timedWords, style = 'auto') {
  const groups = [];
  for (const ayah of ayahs) {
    const words = splitArabicWordObjects(ayah.text);
    const timings = timedWordsForAyah(timedWords, ayah);
    const usableTimings = words.map((_, i) => timings[i] || { start: i, end: i + 1, confidence: 0 });
    const ranges = semanticTimedRanges(words, ayah.translation, usableTimings, style);
    const weights = ranges.map(([start, end]) => {
      let total = 0;
      for (let i = start; i <= end; i += 1) total += phoneticWordWeight(words[i]);
      return total;
    });
    const translated = distributeTranslationForRanges(ayah, ranges, weights);
    ranges.forEach(([start, end], index) => {
      const slice = words.slice(start, end + 1).map((word, offset) => ({ ...word, display: usableTimings[start + offset]?.display || word.display }));
      const first = usableTimings[start];
      const last = usableTimings[end];
      const confidenceValues = usableTimings.slice(start, end + 1).map(item => Number(item.confidence ?? 0.5));
      const confidence = confidenceValues.length ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length : 0.5;
      groups.push({
        id: `${occurrenceKey(ayah)}-${index + 1}`,
        ayahNumber: ayah.number,
        sequenceIndex: ayah.sequenceIndex ?? 0,
        occurrenceIndex: ayah.occurrenceIndex ?? 0,
        occurrenceKey: occurrenceKey(ayah),
        groupInAyah: index + 1,
        groupCountInAyah: ranges.length,
        wordStart: start,
        wordEnd: end,
        words: slice.map(word => word.display),
        arabic: slice.map(word => word.display).join(' '),
        translation: translated[index] || '',
        start: Number(first?.start ?? 0),
        end: Number(last?.end ?? first?.end ?? 0),
        confidence,
        confidenceLabel: confidence >= 0.78 ? 'high' : confidence >= 0.55 ? 'medium' : 'low',
        semantic: true,
      });
    });
  }
  return groups;
}

export function rebuildGroupsFromBreaks(ayahs, timedWords, breaksByAyah) {
  const groups = [];
  for (const ayah of ayahs) {
    const words = splitArabicWordObjects(ayah.text);
    const timings = timedWordsForAyah(timedWords, ayah);
    if (!words.length) continue;
    const breaks = new Set((breaksByAyah?.[occurrenceKey(ayah)] || breaksByAyah?.[ayah.number] || []).map(Number));
    breaks.add(words.length - 1);
    const ranges = [];
    let start = 0;
    for (let i = 0; i < words.length; i += 1) {
      if (breaks.has(i)) { ranges.push([start, i]); start = i + 1; }
    }
    const weights = ranges.map(([a, b]) => words.slice(a, b + 1).reduce((sum, word) => sum + phoneticWordWeight(word), 0));
    const translations = distributeTranslationForRanges(ayah, ranges, weights);
    ranges.forEach(([a, b], index) => {
      const first = timings[a];
      const last = timings[b];
      const confidenceValues = timings.slice(a, b + 1).map(item => Number(item.confidence ?? 0.5));
      const confidence = confidenceValues.length ? confidenceValues.reduce((x, y) => x + y, 0) / confidenceValues.length : 0.5;
      groups.push({
        id: `${occurrenceKey(ayah)}-${index + 1}`, ayahNumber: ayah.number, sequenceIndex: ayah.sequenceIndex ?? 0,
        occurrenceIndex: ayah.occurrenceIndex ?? 0, occurrenceKey: occurrenceKey(ayah), groupInAyah: index + 1, groupCountInAyah: ranges.length,
        wordStart: a, wordEnd: b, words: words.slice(a, b + 1).map((word, offset) => timings[a + offset]?.display || word.display),
        arabic: words.slice(a, b + 1).map((word, offset) => timings[a + offset]?.display || word.display).join(' '), translation: translations[index] || '',
        start: Number(first?.start ?? 0), end: Number(last?.end ?? first?.end ?? 0), confidence,
        confidenceLabel: confidence >= 0.78 ? 'high' : confidence >= 0.55 ? 'medium' : 'low', semantic: true,
      });
    });
  }
  return groups;
}

function candidateBoundaryTimes(envelope, target, from, to, maxCandidates = 16) {
  const strength = buildBoundaryStrength(envelope);
  const { frameSeconds } = envelope;
  const start = Math.max(1, Math.floor(from / frameSeconds));
  const end = Math.min(strength.length - 2, Math.ceil(to / frameSeconds));
  const span = Math.max(0.08, to - from);
  const candidates = [];

  for (let i = start; i <= end; i += 1) {
    const localMax = strength[i] >= strength[i - 1] && strength[i] >= strength[i + 1];
    if (!localMax) continue;
    const time = i * frameSeconds;
    const distance = Math.abs(time - target) / span;
    const score = strength[i] * 2.0 - distance * 0.72;
    candidates.push({ time, acoustic: strength[i], score });
  }

  const targetIndex = Math.max(start, Math.min(end, Math.round(target / frameSeconds)));
  candidates.push({ time: targetIndex * frameSeconds, acoustic: strength[targetIndex] || 0, score: -0.05 });
  candidates.sort((a, b) => b.score - a.score);

  const picked = [];
  for (const candidate of candidates) {
    if (picked.some(item => Math.abs(item.time - candidate.time) < frameSeconds * 1.5)) continue;
    picked.push(candidate);
    if (picked.length >= maxCandidates) break;
  }
  return picked.sort((a, b) => a.time - b.time);
}

export function alignWordsWithinAyah(ayah, timing, envelope) {
  const words = splitArabicWordObjects(ayah.text);
  const n = words.length;
  if (!n) return [];
  if (n === 1) return [{ ...words[0], start: timing.start, end: timing.end, acoustic: 1 }];

  const duration = Math.max(0.05, timing.end - timing.start);
  const weights = words.map(phoneticWordWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  const expectedDurations = weights.map(weight => duration * weight / total);
  const expectedBoundaries = [];
  let running = 0;
  for (let i = 0; i < n - 1; i += 1) {
    running += expectedDurations[i];
    expectedBoundaries.push(timing.start + running);
  }

  const averageWord = duration / n;
  const minWord = Math.max(0.035, Math.min(0.15, averageWord * 0.16));
  const candidateSets = expectedBoundaries.map((target, i) => {
    const radius = Math.max(0.16, Math.min(1.35, averageWord * 1.05 + expectedDurations[i] * 0.32));
    const earliest = timing.start + minWord * (i + 1);
    const latest = timing.end - minWord * (n - i - 1);
    return candidateBoundaryTimes(envelope, target, Math.max(earliest, target - radius), Math.min(latest, target + radius));
  });

  const states = [];
  for (let i = 0; i < candidateSets.length; i += 1) {
    const target = expectedBoundaries[i];
    const radius = Math.max(0.16, averageWord * 1.1);
    const currentStates = candidateSets[i].map(candidate => ({ cost: Infinity, prev: -1, candidate }));
    if (i === 0) {
      for (const state of currentStates) {
        const actualDur = state.candidate.time - timing.start;
        const durationError = Math.abs(actualDur - expectedDurations[0]) / Math.max(0.08, expectedDurations[0]);
        const distance = Math.abs(state.candidate.time - target) / radius;
        state.cost = durationError * 0.32 + distance * 0.48 - state.candidate.acoustic * 1.35 - Math.max(0, words[0].stop) * 0.3;
      }
    } else {
      const previousStates = states[i - 1];
      for (let c = 0; c < currentStates.length; c += 1) {
        const state = currentStates[c];
        for (let p = 0; p < previousStates.length; p += 1) {
          const previous = previousStates[p];
          if (!Number.isFinite(previous.cost)) continue;
          const segmentDuration = state.candidate.time - previous.candidate.time;
          if (segmentDuration < minWord) continue;
          const expectedDuration = expectedDurations[i];
          const durationError = Math.abs(segmentDuration - expectedDuration) / Math.max(0.08, expectedDuration);
          const distance = Math.abs(state.candidate.time - target) / radius;
          const cost = previous.cost + durationError * 0.30 + distance * 0.45 - state.candidate.acoustic * 1.35 - Math.max(0, words[i].stop) * 0.3;
          if (cost < state.cost) { state.cost = cost; state.prev = p; }
        }
      }
    }
    states.push(currentStates);
  }

  // Encourage a sensible duration for the final word.
  const lastStates = states.at(-1);
  let bestIndex = 0;
  let bestCost = Infinity;
  for (let i = 0; i < lastStates.length; i += 1) {
    const state = lastStates[i];
    if (!Number.isFinite(state.cost)) continue;
    const finalDuration = timing.end - state.candidate.time;
    if (finalDuration < minWord) continue;
    const error = Math.abs(finalDuration - expectedDurations.at(-1)) / Math.max(0.08, expectedDurations.at(-1));
    const cost = state.cost + error * 0.32;
    if (cost < bestCost) { bestCost = cost; bestIndex = i; }
  }

  const selected = new Array(n - 1);
  let cursor = bestIndex;
  for (let i = states.length - 1; i >= 0; i -= 1) {
    const state = states[i][cursor] || states[i][0];
    selected[i] = state?.candidate || { time: expectedBoundaries[i], acoustic: 0 };
    cursor = state?.prev >= 0 ? state.prev : 0;
  }

  const boundaries = [timing.start, ...selected.map(item => item.time), timing.end];
  return words.map((word, i) => ({
    ...word,
    start: boundaries[i],
    end: boundaries[i + 1],
    acoustic: i < selected.length ? selected[i].acoustic : (selected.at(-1)?.acoustic || 0),
  }));
}

export function alignSemanticGroups(ayahTimings, groups, ayahs, envelope) {
  const result = [];
  const groupsByAyah = new Map();
  for (const group of groups) {
    if (!groupsByAyah.has(group.ayahNumber)) groupsByAyah.set(group.ayahNumber, []);
    groupsByAyah.get(group.ayahNumber).push(group);
  }
  const ayahByNumber = new Map(ayahs.map(ayah => [ayah.number, ayah]));

  for (const timing of ayahTimings) {
    const ayah = ayahByNumber.get(timing.number);
    const ayahGroups = groupsByAyah.get(timing.number) || [];
    if (!ayah || !ayahGroups.length) continue;
    const timedWords = alignWordsWithinAyah(ayah, timing, envelope);
    for (const group of ayahGroups) {
      const first = timedWords[group.wordStart];
      const last = timedWords[group.wordEnd];
      if (!first || !last) continue;
      const boundaryAcoustic = Math.max(first.acoustic || 0, last.acoustic || 0);
      result.push({
        ...group,
        start: first.start,
        end: last.end,
        confidence: boundaryAcoustic > 0.62 ? 'strong' : boundaryAcoustic > 0.34 ? 'medium' : 'estimated',
      });
    }
  }
  return result;
}

export function autoSyncSemanticGroups(ayahs, envelope, style = 'auto') {
  const ayahTimings = alignAyahsToEnvelope(ayahs, envelope);
  const groups = buildSemanticGroups(ayahs, style);
  return alignSemanticGroups(ayahTimings, groups, ayahs, envelope);
}

// Kept for older projects/tests that import these names. New UI uses semantic grouping.
export function buildWordGroups(ayahs, wordsPerScreen = 3) {
  const size = Math.max(1, Math.min(10, Number(wordsPerScreen) || 3));
  const groups = [];
  for (const ayah of ayahs) {
    const words = splitArabicWordObjects(ayah.text);
    const ranges = [];
    for (let i = 0; i < words.length; i += size) ranges.push([i, Math.min(words.length - 1, i + size - 1)]);
    const weights = ranges.map(([start, end]) => words.slice(start, end + 1).reduce((sum, word) => sum + phoneticWordWeight(word), 0));
    const translations = distributeTranslationForRanges(ayah, ranges, weights);
    ranges.forEach(([start, end], index) => {
      const slice = words.slice(start, end + 1);
      groups.push({
        id: `${occurrenceKey(ayah)}-${index + 1}`,
        ayahNumber: ayah.number,
        sequenceIndex: ayah.sequenceIndex ?? 0,
        occurrenceIndex: ayah.occurrenceIndex ?? 0,
        occurrenceKey: occurrenceKey(ayah),
        groupInAyah: index + 1,
        groupCountInAyah: ranges.length,
        wordStart: start,
        wordEnd: end,
        words: slice.map(word => word.display),
        arabic: slice.map(word => word.display).join(' '),
        translation: translations[index] || '',
        weight: weights[index],
        wordCount: slice.length,
      });
    });
  }
  return groups;
}

export function alignWordGroups(ayahTimings, groups, envelope, ayahs = null) {
  const sourceAyahs = ayahs || ayahTimings.map(timing => ({ number: timing.number, text: timing.text, translation: timing.translation || '' }));
  return alignSemanticGroups(ayahTimings, groups, sourceAyahs, envelope);
}

export function autoSyncWordGroups(ayahs, wordsPerScreen, envelope) {
  const ayahTimings = alignAyahsToEnvelope(ayahs, envelope);
  const groups = buildWordGroups(ayahs, wordsPerScreen);
  return alignSemanticGroups(ayahTimings, groups, ayahs, envelope);
}

export function findActiveGroup(groups, time) {
  if (!groups?.length) return null;
  return groups.find(group => time >= group.start && time < group.end) || null;
}

export function clampGroupTiming(groups, index, start, end, duration) {
  const minDuration = 0.05;
  const prevEndLimit = index > 0 ? groups[index - 1].end : 0;
  const nextStartLimit = index < groups.length - 1 ? groups[index + 1].start : duration;
  const nextStart = Math.max(prevEndLimit, Math.min(nextStartLimit - minDuration, Number(start)));
  const nextEnd = Math.max(nextStart + minDuration, Math.min(nextStartLimit, Number(end)));
  return { start: Math.max(0, nextStart), end: Math.min(duration, nextEnd) };
}

// Intro helpers intentionally keep forced-alignment timings in recitation time.
// The renderer prepends the intro as a separate segment, so enabling/disabling
// an intro never shifts or mutates word/ayah synchronization data.
export function introOffsetSeconds(intro = {}) {
  if (!intro || !intro.enabled) return 0;
  const duration = Number(intro.duration ?? 2.6);
  return Math.max(1, Math.min(5, Number.isFinite(duration) ? duration : 2.6));
}

export function finalTimelineDuration(recitationDuration, intro = {}) {
  const main = Math.max(0, Number(recitationDuration) || 0);
  return main + introOffsetSeconds(intro);
}

export function finalTimeToRecitationTime(finalTime, intro = {}) {
  return Math.max(0, (Number(finalTime) || 0) - introOffsetSeconds(intro));
}
