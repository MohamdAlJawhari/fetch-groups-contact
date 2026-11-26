/**
 * Download names (docs/specs/05-export.md 4.6). Pure functions: no platform names, no I/O.
 * One group → `<title> - <date>.xlsx`; several → `<n> groups - <date>.xlsx` (merged) or `.zip` (separate files).
 */

/** Characters Windows forbids in file names, control characters, and bidi controls (they can disguise an extension). */
const UNSAFE = /[\u0000-\u001F\u007F"*/:<>?\\|‎‏‪-‮⁦-⁩]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const MAX_TITLE_CHARS = 80;

/** A group title made safe for a file name. Arabic and other scripts are kept. */
export function safeTitle(title: string): string {
  const clean = title.replace(LONE_SURROGATE, '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const cut = [...clean].slice(0, MAX_TITLE_CHARS).join('').replace(/[. ]+$/, '').trim();
  return cut || 'Group';
}

export type ExportFiles = 'merged' | 'separate';

export function exportFilename(titles: readonly string[], date: string, files: ExportFiles): string {
  if (titles.length === 1) return `${safeTitle(titles[0]!)} - ${date}.xlsx`;
  return `${titles.length} groups - ${date}.${files === 'separate' ? 'zip' : 'xlsx'}`;
}

/** One name per group inside the zip, in order; repeated titles get ` (2)`, ` (3)`, … (case-insensitive). */
export function zipEntryNames(titles: readonly string[], date: string): string[] {
  const used = new Set<string>();
  return titles.map(title => {
    const base = `${safeTitle(title)} - ${date}`;
    let name = `${base}.xlsx`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).xlsx`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** RFC 6266: an ASCII `filename` for old clients plus the real UTF-8 name in `filename*`. */
export function contentDisposition(filename: string, asciiFallback: string): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
