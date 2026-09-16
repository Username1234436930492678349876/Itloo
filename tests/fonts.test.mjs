import assert from 'node:assert/strict';
import { loadArabicFonts, resolveArabicFont, measureArabicToken, layoutTextRows, wrapIndexedArabic } from '../src/fonts.js';

async function fontsWith(...available) {
  const added = [];
  class FontFaceMock {
    constructor(family) { this.family = family; }
    async load() {
      if (!available.includes(this.family)) throw new Error('Unavailable font');
      return this;
    }
  }
  const fonts = await loadArabicFonts({ FontFaceClass: FontFaceMock, fontSet: { add: face => added.push(face.family) } });
  assert.deepEqual(added.sort(), available.sort());
  return fonts;
}

const both = await fontsWith('Quran Sync Amiri', 'Quran Sync Traditional');
assert.equal(resolveArabicFont('qpc-v2', both).warning, false);
assert.equal(resolveArabicFont('naskh', both).warning, false);
assert.notEqual(resolveArabicFont('qpc-v2', both).family, resolveArabicFont('naskh', both).family);

const missingQuran = resolveArabicFont('qpc-v2', await fontsWith('Quran Sync Traditional'));
assert.equal(missingQuran.warning, true);
assert.match(missingQuran.message, /could not be used.*Traditional Arabic instead/);
assert.match(missingQuran.family, /Quran Sync Traditional/);

const missingClassic = resolveArabicFont('naskh', await fontsWith('Quran Sync Amiri'));
assert.equal(missingClassic.warning, true);
assert.match(missingClassic.message, /Classic Naskh could not be used.*Amiri Quran instead/);
assert.match(missingClassic.family, /Quran Sync Amiri/);

const noto = resolveArabicFont('naskh', await fontsWith('Quran Sync Noto'));
assert.equal(noto.warning, false);
assert.match(noto.message, /Noto Naskh Arabic/);
const missingAll = resolveArabicFont('qpc-v2', await fontsWith());
assert.equal(missingAll.warning, true);
assert.equal(missingAll.family, 'serif');
assert.match(missingAll.message, /system Arabic fallback/);
assert.match(resolveArabicFont('naskh', null).message, /Loading.*temporarily/);
console.log('Arabic font loading and fallback notification tests passed.');

const fontStack = [];
const context = {
  font: 'classic',
  save() { fontStack.push(this.font); },
  restore() { this.font = fontStack.pop(); },
  measureText(text) { return { width: text === ' ' ? 5 : this.font === 'ornament' ? 45 : 35 }; },
};
const words = [{ text: 'إِنِّی' }, { text: 'وَهَنَ' }];
const marker = { text: '\u06dd\u0661\u0662\u0663', ayahEnd: true, font: 'ornament' };
assert.equal(measureArabicToken(context, marker), 45, 'Measure the marker in the font that draws it');
assert.equal(context.font, 'classic', 'Marker measurement must preserve the selected text font');
assert.deepEqual(wrapIndexedArabic(context, [...words, marker], 100), [[words[0]], [words[1], marker]], 'Keep the final word and its ornament together');
assert.deepEqual(wrapIndexedArabic(context, [words[1], marker], 40), [[words[1], marker]], 'Never orphan a verse marker, even on an extremely narrow line');
assert.deepEqual(wrapIndexedArabic(context, [...words, marker], 125), [[...words, marker]], 'Use the exact combined token widths for fitting');
assert.deepEqual(wrapIndexedArabic(context, [], 100), []);
assert.equal(words[0].text, 'إِنِّی', 'Preserve the source letters and marks');
console.log('Arabic mixed-font wrapping and verse-ornament tests passed.');

const layout = layoutTextRows([
  { ascent: 100, descent: 55, padding: 4, minHeight: 80 },
  { ascent: 110, descent: 20, padding: 4, minHeight: 80 },
  { ascent: 20, descent: 7, padding: 4, minHeight: 25, gapBefore: 12 },
]);
for (let i = 1; i < layout.rows.length; i++) {
  const previous = layout.rows[i - 1], current = layout.rows[i];
  const clearance = current.baseline - current.ascent - (previous.baseline + previous.descent);
  assert.ok(clearance >= previous.padding + current.padding + (current.gapBefore || 0), 'Tall marks, descenders, and translation must not overlap');
}
assert.ok(layout.rows[0].baseline - layout.rows[0].ascent >= 4);
assert.ok(layout.rows.at(-1).baseline + layout.rows.at(-1).descent <= layout.height - 4);
assert.equal(layoutTextRows([{ ascent: 40, descent: 10, padding: 2, minHeight: 150 }]).height, 150, 'Respect larger user line spacing');
assert.deepEqual(layoutTextRows([]), { rows: [], height: 0 });
const overhangContext = { ...context, measureText: () => ({ width: 50, actualBoundingBoxLeft: 58, actualBoundingBoxRight: 9 }) };
assert.equal(measureArabicToken(overhangContext, { text: 'مِنِّی' }), 67, 'Reserve space for ink extending beyond a word advance');
console.log('Measured Arabic line spacing and overhang tests passed.');
