export function normalizeMcLangFileStem(input: string): string {
  // Accept: en_us, en_US, en-US, EN_us, en_us.json
  const s = input.trim().replace(/\.json$/i, "");
  const m = /^([a-zA-Z]{2,3})[\-_]([a-zA-Z]{2,3})$/.exec(s);
  if (m) {
    const a = m[1];
    const b = m[2];
    if (a && b) return `${a.toLowerCase()}_${b.toLowerCase()}`;
  }
  return s.toLowerCase();
}

export function toGoogleLang(mcLangFileStem: string): string {
  const stem = normalizeMcLangFileStem(mcLangFileStem);
  const parts = stem.split("_");
  return parts[0] ?? stem;
}
