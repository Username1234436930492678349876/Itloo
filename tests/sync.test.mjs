import assert from 'node:assert/strict';
import {
  splitArabicWordObjects,
  normalizeArabicForAlignment,
  buildContextAwareGroups,
  rebuildGroupsFromBreaks,
  distributeTranslationWithWordAnchors,
} from '../src/sync.js';

assert.equal(normalizeArabicForAlignment('ٱلرَّحْمَٰنِ'), 'الرحمن');
const words = splitArabicWordObjects('فَلَمَّا ذَاقَا الشَّجَرَةَ بَدَتْ لَهُمَا سَوْءَاتُهُمَا');
assert.equal(words.length, 6);

const ayahs = [{
  number: 22,
  text: 'فَلَمَّا ذَاقَا الشَّجَرَةَ بَدَتْ لَهُمَا سَوْءَاتُهُمَا',
  translation: 'But when they tasted of the tree, their private parts became apparent to them.',
}];
const timedWords = words.map((word, i) => ({
  ayahNumber: 22,
  wordIndex: i,
  display: word.display,
  start: [0, .65, 1.25, 2.65, 3.2, 3.7][i],
  end: [.6, 1.2, 2.1, 3.15, 3.65, 4.6][i],
  confidence: .9,
  boundaryConfidence: .8,
}));
const groups = buildContextAwareGroups(ayahs, timedWords, 'auto');
assert.ok(groups.length >= 2 && groups.length <= 3, `expected context-aware groups, got ${groups.length}`);
assert.equal(groups.at(-1).wordEnd, 5);
assert.ok(groups.every(g => g.end > g.start));

const custom = rebuildGroupsFromBreaks(ayahs, timedWords, { 22: [2, 5] });
assert.equal(custom.length, 2);
assert.equal(custom[0].wordEnd, 2);
assert.equal(custom[1].wordStart, 3);
console.log('Context-aware phrase grouping tests passed.');

const preciseAyah = [{
  number: 80,
  text: 'وَقُل رَّبِّ أَدْخِلْنِي مُدْخَلَ صِدْقٍ وَأَخْرِجْنِي مُخْرَجَ صِدْقٍ',
  translation: "And say, 'My Lord, cause me to enter a sound entrance and to exit a sound exit.'",
  wordTranslations: ['And say','my Lord','cause me to enter','an entrance','sound','and cause me to exit','an exit','sound'],
}];
const preciseWords = splitArabicWordObjects(preciseAyah[0].text);
const preciseTimings = preciseWords.map((word, i) => ({ ayahNumber:80, wordIndex:i, display:word.display, start:i*.7, end:i*.7+.55, confidence:.95, boundaryConfidence:.9 }));
const preciseGroups = rebuildGroupsFromBreaks(preciseAyah, preciseTimings, {80:[4,7]});
assert.equal(preciseGroups.length, 2);
assert.match(preciseGroups[0].translation.toLowerCase(), /enter/);
assert.doesNotMatch(preciseGroups[0].translation.toLowerCase(), /exit/);
assert.match(preciseGroups[1].translation.toLowerCase(), /exit/);
console.log('Phrase-level translation anchor test passed.');

// Regression: morphology-style fragments must not become one-letter subtitle cards.
const repaired = splitArabicWordObjects('ذَ ٰلِكُمُ ٱللَّهُ رَبُّكُمْ');
assert.equal(repaired[0].display.replace(/\s/g, ''), 'ذَٰلِكُمُ');
assert.equal(repaired[0].bare, 'ذلكم');
assert.equal(repaired.length, 3);

// Preserve true standalone muqatta'at letters.
const qaf = splitArabicWordObjects('ق وَالْقُرْآنِ الْمَجِيدِ');
assert.equal(qaf[0].bare, 'ق');
assert.equal(qaf.length, 3);

// Manual display corrections must survive phrase rebuilding without changing timing.
const editedTimings = preciseTimings.map(item => ({ ...item }));
editedTimings[0].display = 'وَقُلْ';
const editedGroups = rebuildGroupsFromBreaks(preciseAyah, editedTimings, {80:[4,7]});
assert.match(editedGroups[0].arabic, /^وَقُلْ/);
console.log('Arabic fragment repair/manual display tests passed.');


const repeatAyahs = [
  { number: 1, sequenceIndex: 0, occurrenceIndex: 0, occurrenceKey: '1@0', text: 'الْحَمْدُ لِلَّهِ', translation: 'All praise is due to Allah.' },
  { number: 2, sequenceIndex: 1, occurrenceIndex: 0, occurrenceKey: '2@1', text: 'الرَّحْمَٰنِ الرَّحِيمِ', translation: 'The Entirely Merciful, the Especially Merciful.' },
  { number: 1, sequenceIndex: 2, occurrenceIndex: 1, occurrenceKey: '1@2', text: 'الْحَمْدُ لِلَّهِ', translation: 'All praise is due to Allah.' },
];
const repeatTimed = [
  { ayahNumber:1, sequenceIndex:0, occurrenceIndex:0, occurrenceKey:'1@0', wordIndex:0, display:'الْحَمْدُ', start:0, end:.5, confidence:.9 },
  { ayahNumber:1, sequenceIndex:0, occurrenceIndex:0, occurrenceKey:'1@0', wordIndex:1, display:'لِلَّهِ', start:.5, end:1, confidence:.9 },
  { ayahNumber:2, sequenceIndex:1, occurrenceIndex:0, occurrenceKey:'2@1', wordIndex:0, display:'الرَّحْمَٰنِ', start:1, end:1.5, confidence:.9 },
  { ayahNumber:2, sequenceIndex:1, occurrenceIndex:0, occurrenceKey:'2@1', wordIndex:1, display:'الرَّحِيمِ', start:1.5, end:2, confidence:.9 },
  { ayahNumber:1, sequenceIndex:2, occurrenceIndex:1, occurrenceKey:'1@2', wordIndex:0, display:'الْحَمْدُ', start:2, end:2.5, confidence:.9 },
  { ayahNumber:1, sequenceIndex:2, occurrenceIndex:1, occurrenceKey:'1@2', wordIndex:1, display:'لِلَّهِ', start:2.5, end:3, confidence:.9 },
];
const repeatGroups = buildContextAwareGroups(repeatAyahs, repeatTimed, 'auto');
assert.equal(repeatGroups.length, 3);
assert.equal(repeatGroups[0].occurrenceKey, '1@0');
assert.equal(repeatGroups[2].occurrenceKey, '1@2');
assert.ok(repeatGroups[2].start >= 2);
console.log('Repeated/backtracked ayah grouping tests passed.');


const exactTranslation = distributeTranslationWithWordAnchors(
  "And We said, 'O Adam, dwell, you and your wife, in Paradise and eat therefrom in abundance from wherever you will. But do not approach this tree, lest you be among the wrongdoers.'",
  [[0,2],[3,5],[6,10],[11,14]],
  ['And We said','O Adam','Dwell','you','and your wife','Paradise','and eat','from it','abundance','wherever','you will','But do not approach','this tree','lest you be','among the wrongdoers'],
  [3,3,5,4]
);
assert.match(exactTranslation[0], /Adam.*dwell/i);
assert.doesNotMatch(exactTranslation[0], /wife/i);
assert.match(exactTranslation[1], /wife.*Paradise/i);
assert.match(exactTranslation[3], /do not approach.*tree/i);

const basmalahGroups = rebuildGroupsFromBreaks([{
  number: 0, sequenceIndex: 0, occurrenceIndex: 0, occurrenceKey: 'basmalah@0',
  text: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
  translation: 'In the name of Allah, the Entirely Merciful, the Especially Merciful.',
  wordTranslations: ['In the name','of Allah','the Entirely Merciful','the Especially Merciful'],
  isBasmalah: true,
}], [
  {ayahNumber:0,sequenceIndex:0,occurrenceKey:'basmalah@0',wordIndex:0,display:'بِسْمِ',start:0,end:.4,confidence:.95},
  {ayahNumber:0,sequenceIndex:0,occurrenceKey:'basmalah@0',wordIndex:1,display:'اللَّهِ',start:.4,end:.8,confidence:.95},
  {ayahNumber:0,sequenceIndex:0,occurrenceKey:'basmalah@0',wordIndex:2,display:'الرَّحْمَٰنِ',start:.8,end:1.3,confidence:.95},
  {ayahNumber:0,sequenceIndex:0,occurrenceKey:'basmalah@0',wordIndex:3,display:'الرَّحِيمِ',start:1.3,end:1.8,confidence:.95},
], {'basmalah@0':[1,3]});
assert.equal(basmalahGroups.length, 2);
assert.match(basmalahGroups[0].translation, /name of Allah/i);
assert.match(basmalahGroups[1].translation, /Merciful/i);
assert.doesNotMatch(basmalahGroups.map(g => g.translation).join(' '), /first ayah/i);

// Regression: even if upstream metadata is accidentally polluted with the first
// selected ayah translation, Basmalah grouping must use the dedicated Basmalah
// translation segments and never inherit that text.
const protectedBasmalah = rebuildGroupsFromBreaks([{
  number: 0, sequenceIndex: 0, occurrenceIndex: 0, occurrenceKey: 'basmalah@0',
  text: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
  translation: 'WRONG FIRST AYAH TRANSLATION',
  wordTranslations: ['WRONG','FIRST','AYAH','TRANSLATION'],
  isBasmalah: true,
}], [
  {ayahNumber:0,sequenceIndex:0,occurrenceKey:'basmalah@0',wordIndex:0,display:'بِسْمِ',start:0,end:.4,confidence:.95},
  {ayahNumber:0,sequenceIndex:0,occurrenceKey:'basmalah@0',wordIndex:1,display:'اللَّهِ',start:.4,end:.8,confidence:.95},
  {ayahNumber:0,sequenceIndex:0,occurrenceKey:'basmalah@0',wordIndex:2,display:'الرَّحْمَٰنِ',start:.8,end:1.3,confidence:.95},
  {ayahNumber:0,sequenceIndex:0,occurrenceKey:'basmalah@0',wordIndex:3,display:'الرَّحِيمِ',start:1.3,end:1.8,confidence:.95},
], {'basmalah@0':[0,1,2,3]});
assert.deepEqual(protectedBasmalah.map(g => g.translation), [
  'In the name', 'of Allah,', 'the Entirely Merciful,', 'the Especially Merciful.'
]);
console.log('Word-level Saheeh alignment tests passed.');

import { introOffsetSeconds, finalTimelineDuration, finalTimeToRecitationTime } from '../src/sync.js';
assert.equal(introOffsetSeconds({ enabled: false, duration: 4 }), 0);
assert.equal(introOffsetSeconds({ enabled: true, duration: 2.6 }), 2.6);
assert.equal(finalTimelineDuration(10, { enabled: true, duration: 2.6 }), 12.6);
assert.ok(Math.abs(finalTimeToRecitationTime(4.1, { enabled: true, duration: 2.6 }) - 1.5) < 1e-9);
console.log('Intro timeline helpers passed.');

// Phrase-level semantic matching should keep a short demonstrative phrase from
// swallowing the translation of the following Arabic words.
const semanticTranslation = distributeTranslationWithWordAnchors(
  'That is Allah, your Lord; there is no deity except Him, the Creator of all things, so worship Him.',
  [[0, 2], [3, 6], [7, 9]],
  ['That', 'Allah', 'your Lord', 'there is no', 'deity', 'except', 'Him', 'Creator', 'all things', 'so worship Him'],
  [3, 4, 3]
);
assert.match(semanticTranslation[0], /That is Allah.*Lord/i);
assert.doesNotMatch(semanticTranslation[0], /deity/i);
assert.match(semanticTranslation[1], /deity.*Him/i);
assert.match(semanticTranslation[2], /Creator.*worship/i);
console.log('Improved phrase/word translation matching test passed.');


const istiathaGroups = rebuildGroupsFromBreaks([{
  number: -1, sequenceIndex: 0, occurrenceIndex: 0, occurrenceKey: 'istiatha@0',
  text: 'أَعُوذُ بِاللَّهِ مِنَ الشَّيْطَانِ الرَّجِيمِ',
  translation: 'WRONG TRANSLATION SHOULD NOT LEAK',
  wordTranslations: ['wrong','wrong','wrong','wrong','wrong'],
  isIstiatha: true,
}], [
  {ayahNumber:-1,sequenceIndex:0,occurrenceKey:'istiatha@0',wordIndex:0,display:'أَعُوذُ',start:0,end:.35,confidence:.95},
  {ayahNumber:-1,sequenceIndex:0,occurrenceKey:'istiatha@0',wordIndex:1,display:'بِاللَّهِ',start:.35,end:.75,confidence:.95},
  {ayahNumber:-1,sequenceIndex:0,occurrenceKey:'istiatha@0',wordIndex:2,display:'مِنَ',start:.75,end:1.0,confidence:.95},
  {ayahNumber:-1,sequenceIndex:0,occurrenceKey:'istiatha@0',wordIndex:3,display:'الشَّيْطَانِ',start:1.0,end:1.5,confidence:.95},
  {ayahNumber:-1,sequenceIndex:0,occurrenceKey:'istiatha@0',wordIndex:4,display:'الرَّجِيمِ',start:1.5,end:1.9,confidence:.95},
], {'istiatha@0':[1,4]});
assert.equal(istiathaGroups.length, 2);
assert.match(istiathaGroups[0].translation, /seek refuge.*Allah/i);
assert.match(istiathaGroups[1].translation, /Satan.*accursed/i);
assert.doesNotMatch(istiathaGroups.map(g => g.translation).join(' '), /WRONG/);
console.log("Isti'adhah translation handler test passed.");
