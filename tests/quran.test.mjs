import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem(key) { return store.has(key) ? store.get(key) : null; },
  setItem(key, value) { store.set(key, String(value)); },
};

const calls = [];
globalThis.fetch = async url => {
  calls.push(String(url));
  if (String(url).includes('api.quran.com')) {
    const ayah = String(url).includes('/1:2?') ? 2 : 1;
    const words = ayah === 1
      ? [
          { char_type_name: 'word', translation: { text: 'All praise' } },
          { char_type_name: 'word', translation: null },
          { char_type_name: 'end' },
        ]
      : [
          { char_type_name: 'word', translation: { text: 'The Entirely Merciful' } },
          { char_type_name: 'word', translation: { text: 'the Especially Merciful' } },
          { char_type_name: 'end' },
        ];
    return { ok: true, status: 200, async json() { return { verse: { words } }; } };
  }
  const isSahih = String(url).endsWith('/en.sahih');
  const data = isSahih
    ? [{ numberInSurah: 1, text: 'Test translation one.' }, { numberInSurah: 2, text: 'Test translation two.' }]
    : [{ numberInSurah: 1, text: 'الْحَمْدُ لِلَّهِ' }, { numberInSurah: 2, text: 'الرَّحْمَٰنِ الرَّحِيمِ' }];
  return {
    ok: true,
    status: 200,
    async json() { return { code: 200, data: { ayahs: data } }; },
  };
};

const { fetchSelectedAyahs, parseVerseRanges } = await import('../src/quran.js');
const result = await fetchSelectedAyahs(1, [1, 2]);
assert.equal(result.length, 2);
assert.equal(result[0].text, 'الْحَمْدُ لِلَّهِ');
assert.equal(result[0].translation, 'Test translation one.');
assert.deepEqual(result[0].wordTranslations, ['All praise', ''], 'missing word gloss should preserve its slot');
assert.ok(calls.some(url => url.endsWith('/quran-uthmani-quran-academy')));
assert.ok(calls.some(url => url.endsWith('/en.sahih')));

const before = calls.length;
const cached = await fetchSelectedAyahs(1, [2]);
assert.equal(cached[0].translation, 'Test translation two.');
assert.equal(calls.length, before, 'second fetch should use local cache');

console.log('Qur’an fetch/translation merge tests passed.');

assert.deepEqual(parseVerseRanges('95-97,95', 100), [95,96,97,95]);
assert.deepEqual(parseVerseRanges('3,1-2,3', 10), [3,1,2,3]);
console.log('Repeat/backtrack verse-order parsing tests passed.');
