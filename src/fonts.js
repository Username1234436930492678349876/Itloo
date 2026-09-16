export async function loadArabicFonts({ FontFaceClass = FontFace, fontSet = document.fonts } = {}) {
  async function load(family, source, label) {
    try {
      const face = await new FontFaceClass(family, source, { weight: '400 700' }).load();
      fontSet.add(face);
      return { family: `"${family}", serif`, label };
    } catch {
      return null;
    }
  }
  const [quran, traditional, noto] = await Promise.all([
    load('Quran Sync Amiri', `url("${new URL('./fonts/AmiriQuran.ttf', import.meta.url)}")`, 'Amiri Quran'),
    load('Quran Sync Traditional', 'local("Traditional Arabic")', 'Traditional Arabic'),
    load('Quran Sync Noto', 'local("Noto Naskh Arabic")', 'Noto Naskh Arabic'),
  ]);
  return { quran, classic: traditional || noto };
}

export function resolveArabicFont(selection, fonts) {
  const classic = selection === 'naskh';
  const requested = classic ? 'Classic Naskh' : 'Amiri Quran';
  if (!fonts) {
    return { family: 'serif', warning: false, message: `Loading ${requested}… Preview temporarily uses a system font.` };
  }
  const selected = classic ? fonts.classic : fonts.quran;
  const actual = selected || (classic ? fonts.quran : fonts.classic);
  const label = actual?.label || 'the system Arabic fallback';
  return {
    family: actual?.family || 'serif',
    warning: !selected,
    message: selected
      ? `Font loaded successfully: ${label}. Applied to previews and exports.`
      : `${requested} could not be used. Previews and exports are using ${label} instead.${classic ? ' Install Traditional Arabic or Noto Naskh Arabic, then reload.' : ' Reload the app to retry loading the included font.'}`,
  };
}

export function measureArabicToken(ctx, token) {
  return measureArabicTokenBounds(ctx, token).width;
}

export function measureArabicTokenBounds(ctx, token) {
  ctx.save();
  if (token.font) ctx.font = token.font;
  ctx.textAlign = 'right';
  const metrics = ctx.measureText(token.text);
  const right = Math.max(0, metrics.actualBoundingBoxRight || 0);
  const width = Math.max(metrics.width, metrics.actualBoundingBoxLeft || 0) + right;
  ctx.restore();
  return { width, right, ascent: metrics.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent };
}

// Use the visible glyph bounds, including Qur'anic marks, rather than assuming
// that a font-size multiplier contains all the ink above and below a baseline.
export function layoutTextRows(rows, gap = 0) {
  let height = 0;
  const positioned = rows.map((row, index) => {
    if (index) height += Math.max(0, row.gapBefore ?? gap);
    const rowHeight = Math.max(row.minHeight || 0, row.ascent + row.descent + 2 * row.padding);
    const baseline = height + (rowHeight - row.ascent - row.descent) / 2 + row.ascent;
    height += rowHeight;
    return { ...row, baseline };
  });
  return { rows: positioned, height };
}

export function wrapIndexedArabic(ctx, tokens, maxWidth) {
  if (!tokens.length) return [];
  const lines = [];
  let line = [];
  const spaceWidth = ctx.measureText(' ').width;
  for (let i = 0; i < tokens.length; i += 1) {
    // Keep the ayah ornament with its preceding word, even on narrow previews.
    const unit = [tokens[i]];
    if (tokens[i + 1]?.ayahEnd) unit.push(tokens[++i]);
    const test = [...line, ...unit];
    const width = test.reduce((sum, token) => sum + measureArabicToken(ctx, token), 0) + spaceWidth * (test.length - 1);
    if (line.length && width > maxWidth) { lines.push(line); line = unit; }
    else line.push(...unit);
  }
  if (line.length) lines.push(line);
  return lines;
}
