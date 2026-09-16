export const SURAHS = [
  [1,'Al-Fatihah','الفاتحة',7],[2,'Al-Baqarah','البقرة',286],[3,'Ali Imran','آل عمران',200],[4,'An-Nisa','النساء',176],[5,'Al-Ma\'idah','المائدة',120],[6,'Al-An\'am','الأنعام',165],[7,'Al-A\'raf','الأعراف',206],[8,'Al-Anfal','الأنفال',75],[9,'At-Tawbah','التوبة',129],[10,'Yunus','يونس',109],[11,'Hud','هود',123],[12,'Yusuf','يوسف',111],[13,'Ar-Ra\'d','الرعد',43],[14,'Ibrahim','إبراهيم',52],[15,'Al-Hijr','الحجر',99],[16,'An-Nahl','النحل',128],[17,'Al-Isra','الإسراء',111],[18,'Al-Kahf','الكهف',110],[19,'Maryam','مريم',98],[20,'Taha','طه',135],[21,'Al-Anbiya','الأنبياء',112],[22,'Al-Hajj','الحج',78],[23,'Al-Mu\'minun','المؤمنون',118],[24,'An-Nur','النور',64],[25,'Al-Furqan','الفرقان',77],[26,'Ash-Shu\'ara','الشعراء',227],[27,'An-Naml','النمل',93],[28,'Al-Qasas','القصص',88],[29,'Al-\'Ankabut','العنكبوت',69],[30,'Ar-Rum','الروم',60],[31,'Luqman','لقمان',34],[32,'As-Sajdah','السجدة',30],[33,'Al-Ahzab','الأحزاب',73],[34,'Saba','سبأ',54],[35,'Fatir','فاطر',45],[36,'Ya-Sin','يس',83],[37,'As-Saffat','الصافات',182],[38,'Sad','ص',88],[39,'Az-Zumar','الزمر',75],[40,'Ghafir','غافر',85],[41,'Fussilat','فصلت',54],[42,'Ash-Shura','الشورى',53],[43,'Az-Zukhruf','الزخرف',89],[44,'Ad-Dukhan','الدخان',59],[45,'Al-Jathiyah','الجاثية',37],[46,'Al-Ahqaf','الأحقاف',35],[47,'Muhammad','محمد',38],[48,'Al-Fath','الفتح',29],[49,'Al-Hujurat','الحجرات',18],[50,'Qaf','ق',45],[51,'Adh-Dhariyat','الذاريات',60],[52,'At-Tur','الطور',49],[53,'An-Najm','النجم',62],[54,'Al-Qamar','القمر',55],[55,'Ar-Rahman','الرحمن',78],[56,'Al-Waqi\'ah','الواقعة',96],[57,'Al-Hadid','الحديد',29],[58,'Al-Mujadilah','المجادلة',22],[59,'Al-Hashr','الحشر',24],[60,'Al-Mumtahanah','الممتحنة',13],[61,'As-Saff','الصف',14],[62,'Al-Jumu\'ah','الجمعة',11],[63,'Al-Munafiqun','المنافقون',11],[64,'At-Taghabun','التغابن',18],[65,'At-Talaq','الطلاق',12],[66,'At-Tahrim','التحريم',12],[67,'Al-Mulk','الملك',30],[68,'Al-Qalam','القلم',52],[69,'Al-Haqqah','الحاقة',52],[70,'Al-Ma\'arij','المعارج',44],[71,'Nuh','نوح',28],[72,'Al-Jinn','الجن',28],[73,'Al-Muzzammil','المزمل',20],[74,'Al-Muddaththir','المدثر',56],[75,'Al-Qiyamah','القيامة',40],[76,'Al-Insan','الإنسان',31],[77,'Al-Mursalat','المرسلات',50],[78,'An-Naba','النبأ',40],[79,'An-Nazi\'at','النازعات',46],[80,'Abasa','عبس',42],[81,'At-Takwir','التكوير',29],[82,'Al-Infitar','الانفطار',19],[83,'Al-Mutaffifin','المطففين',36],[84,'Al-Inshiqaq','الانشقاق',25],[85,'Al-Buruj','البروج',22],[86,'At-Tariq','الطارق',17],[87,'Al-A\'la','الأعلى',19],[88,'Al-Ghashiyah','الغاشية',26],[89,'Al-Fajr','الفجر',30],[90,'Al-Balad','البلد',20],[91,'Ash-Shams','الشمس',15],[92,'Al-Layl','الليل',21],[93,'Ad-Duha','الضحى',11],[94,'Ash-Sharh','الشرح',8],[95,'At-Tin','التين',8],[96,'Al-\'Alaq','العلق',19],[97,'Al-Qadr','القدر',5],[98,'Al-Bayyinah','البينة',8],[99,'Az-Zalzalah','الزلزلة',8],[100,'Al-\'Adiyat','العاديات',11],[101,'Al-Qari\'ah','القارعة',11],[102,'At-Takathur','التكاثر',8],[103,'Al-\'Asr','العصر',3],[104,'Al-Humazah','الهمزة',9],[105,'Al-Fil','الفيل',5],[106,'Quraysh','قريش',4],[107,'Al-Ma\'un','الماعون',7],[108,'Al-Kawthar','الكوثر',3],[109,'Al-Kafirun','الكافرون',6],[110,'An-Nasr','النصر',3],[111,'Al-Masad','المسد',5],[112,'Al-Ikhlas','الإخلاص',4],[113,'Al-Falaq','الفلق',5],[114,'An-Nas','الناس',6]
].map(([number, englishName, arabicName, ayahCount]) => ({ number, englishName, arabicName, ayahCount }));


export const BASMALAH = {
  number: 0,
  text: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
  translation: 'In the name of Allah, the Entirely Merciful, the Especially Merciful.',
  wordTranslations: ['In the name', 'of Allah', 'the Entirely Merciful', 'the Especially Merciful'],
  isBasmalah: true,
};

export function makeBasmalahAyah(sequenceIndex = 0) {
  return {
    ...BASMALAH,
    sequenceIndex,
    occurrenceIndex: 0,
    occurrenceKey: `basmalah@${sequenceIndex}`,
  };
}

export const ISTIATHA = {
  number: -1,
  text: 'أَعُوذُ بِاللَّهِ مِنَ الشَّيْطَانِ الرَّجِيمِ',
  translation: 'I seek refuge in Allah from Satan, the accursed.',
  wordTranslations: ['I seek refuge', 'in Allah', 'from', 'Satan', 'the accursed'],
  isIstiatha: true,
};

export function makeIstiathaAyah(sequenceIndex = 0) {
  return {
    ...ISTIATHA,
    sequenceIndex,
    occurrenceIndex: 0,
    occurrenceKey: `istiatha@${sequenceIndex}`,
  };
}

export function getSurah(number) {
  return SURAHS.find(s => s.number === Number(number));
}

export function parseVerseRanges(input, maxAyah) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a verse range, for example 31-34 or 1-3, 5, 7-9.');

  const normalized = raw
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, '')
    .replace(/،/g, ',');

  const values = [];
  for (const token of normalized.split(',').filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      values.push(Number(token));
      continue;
    }
    const match = token.match(/^(\d+)-(\d+)$/);
    if (!match) throw new Error(`Could not understand “${token}”. Use formats like 31-34, 36, 38-40.`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end < start) throw new Error(`Range ${token} is backwards.`);
    for (let n = start; n <= end; n += 1) values.push(n);
  }

  // Preserve the exact order — including duplicates. This lets the user describe
  // a reciter who goes back and repeats an ayah, e.g. `95-97,95`.
  if (!values.length) throw new Error('No verses were selected.');
  if (values.some(n => n < 1 || n > maxAyah)) {
    throw new Error(`This surah has ${maxAyah} ayahs. Choose numbers from 1 to ${maxAyah}.`);
  }
  if (values.length > 80) {
    throw new Error('For browser rendering, select at most 80 ayah occurrences at a time. Short recitation edits work best.');
  }
  return values;
}

function normalizeArabicAyah(item) {
  return {
    number: Number(item.numberInSurah),
    text: String(item.text || '').trim(),
  };
}

function normalizeTranslationAyah(item) {
  return {
    number: Number(item.numberInSurah),
    translation: String(item.text || '').replace(/<[^>]*>/g, '').trim(),
  };
}


async function fetchWordTranslationsForAyah(surahNumber, ayahNumber) {
  const cacheKey = `qws:wbw:${surahNumber}:${ayahNumber}:en-v3`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.some(Boolean)) return parsed;
    }
  } catch {}

  try {
    // Quran.com's public v4 endpoint includes an English gloss on each Quranic word.
    // We use those glosses only as semantic anchors for splitting Saheeh International,
    // not as the displayed translation itself. If the endpoint is unavailable, the
    // app falls back to its existing Saheeh-only semantic splitter.
    const url = `https://api.quran.com/api/v4/verses/by_key/${surahNumber}:${ayahNumber}?language=en&words=true&word_fields=text_uthmani,text_uthmani_simple,location`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const payload = await response.json();
    const words = Array.isArray(payload?.verse?.words) ? payload.verse.words : [];
    // Preserve one slot per Qur'anic word. Dropping a missing gloss shifts every
    // later English anchor onto the wrong Arabic word, which causes visibly wrong
    // phrase translations even though the audio timing is correct.
    const translations = words
      .filter(word => word?.char_type_name !== 'end')
      .map(word => String(word?.translation?.text || '').replace(/<[^>]*>/g, '').trim());
    if (translations.some(Boolean)) {
      try { localStorage.setItem(cacheKey, JSON.stringify(translations)); } catch {}
    }
    return translations;
  } catch {
    // Do not permanently cache a transient network/API failure; the next project
    // load should get another chance to retrieve the word-level anchors.
    return [];
  }
}

async function fetchEdition(surahNumber, edition) {
  const response = await fetch(`https://api.alquran.cloud/v1/surah/${surahNumber}/${edition}`);
  if (!response.ok) throw new Error(`Qur'an service returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.code !== 200 || !Array.isArray(payload?.data?.ayahs)) {
    throw new Error(`Unexpected response for edition ${edition}.`);
  }
  return payload.data.ayahs;
}

export async function fetchSelectedAyahs(surahNumber, selectedNumbers) {
  const cacheKey = `qws:surah:${surahNumber}:uthmani-sahih-v3`;
  let merged = null;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) merged = JSON.parse(cached);
  } catch {}

  if (!Array.isArray(merged) || !merged.length) {
    let lastError = null;
    const arabicEditions = ['quran-uthmani-quran-academy', 'quran-uthmani'];
    let arabic = null;
    for (const edition of arabicEditions) {
      try {
        arabic = (await fetchEdition(surahNumber, edition)).map(normalizeArabicAyah);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!arabic) {
      throw new Error(`Could not load the Qur'an text. ${lastError?.message || 'Check your internet connection.'}`);
    }

    let sahih;
    try {
      sahih = (await fetchEdition(surahNumber, 'en.sahih')).map(normalizeTranslationAyah);
    } catch (err) {
      throw new Error(`Could not load the Saheeh International translation. ${err.message || ''}`.trim());
    }

    const translations = new Map(sahih.map(item => [item.number, item.translation]));
    merged = arabic.map(item => ({ ...item, translation: translations.get(item.number) || '' }));
    try { localStorage.setItem(cacheKey, JSON.stringify(merged)); } catch {}
  }

  const byNumber = new Map(merged.map(a => [a.number, a]));
  const selected = selectedNumbers.map(number => byNumber.get(number)).filter(Boolean);
  if (selected.length !== selectedNumbers.length) {
    throw new Error('Some requested ayahs were missing from the Qur’an response.');
  }

  const occurrenceCounts = new Map();
  const enriched = await Promise.all(selected.map(async (ayah, sequenceIndex) => {
    const occurrenceIndex = occurrenceCounts.get(ayah.number) || 0;
    occurrenceCounts.set(ayah.number, occurrenceIndex + 1);
    return {
      ...ayah,
      sequenceIndex,
      occurrenceIndex,
      occurrenceKey: `${ayah.number}@${sequenceIndex}`,
      wordTranslations: await fetchWordTranslationsForAyah(surahNumber, ayah.number),
    };
  }));
  return enriched;
}

export function formatRangeLabel(numbers) {
  if (!numbers?.length) return '';
  const parts = [];
  let start = numbers[0];
  let prev = numbers[0];
  for (let i = 1; i <= numbers.length; i += 1) {
    const current = numbers[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = current;
    prev = current;
  }
  return parts.join(', ');
}
