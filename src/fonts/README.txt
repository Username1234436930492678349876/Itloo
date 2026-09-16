Arabic fonts
============

The Amiri Quran option loads the bundled AmiriQuran.ttf through src/fonts.js.
Source: https://github.com/aliftype/amiri/releases/tag/1.003
License: SIL Open Font License, included in Amiri-OFL.txt.
It supports the Arabic characters and Qur'anic marks used by the text provider.
Verse-end ornaments also use this font when Classic Naskh is selected.
Classic Naskh checks for Traditional Arabic and Noto Naskh Arabic locally.
If a selection is unavailable, previews and exports use the available alternative
or the system serif, with a visible message explaining the substitution.

The older QPCV2.woff2 and KFGQPC Uthmanic Script HAFS Regular.otf files are not
loaded: they are incompatible with characters used by the text provider.
Existing projects retain their qpc-v2 setting, now using Amiri Quran.
