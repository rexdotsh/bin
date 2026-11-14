export const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()*+\-./][ -~]|\x1b[@-Z\\-_]?/g;
export const SGR_RE = /^\x1b\[([0-9;:]*)m$/;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/;
const STRAY_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(s: string): string {
  if (!CONTROL_RE.test(s)) return s;
  let out = s.replace(ANSI_RE, "");
  if (out.includes("\r")) out = out.replace(/\r\n/g, "\n");
  if (out.includes("\r")) out = out.replace(/^[^\n\r]*\r[^\n]*/gm, (l) => l.slice(l.lastIndexOf("\r", l.length - 2) + 1).replace(/\r$/, ""));
  return out.replace(STRAY_RE, "");
}

export function visible(line: string, newline: boolean): [number, number] {
  const u = newline && line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!u.includes("\r")) return [0, u.length];
  const from = u.lastIndexOf("\r", u.length - 2) + 1;
  return [from, Math.max(from, u.endsWith("\r") ? u.length - 1 : u.length)];
}

export const dropStray = (s: string) => s.replace(STRAY_RE, "");

function plainOf(line: string, newline: boolean): string {
  const t = line.includes("\x1b") ? line.replace(ANSI_RE, "") : line;
  const [a, b] = visible(t, newline);
  return dropStray(t.slice(a, b));
}

function splitOutsideEscapes(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of raw.matchAll(new RegExp(`${ANSI_RE.source}|\\n`, "g"))) {
    if (m[0] !== "\n") continue;
    out.push(raw.slice(start, m.index));
    start = m.index + 1;
  }
  out.push(raw.slice(start));
  return out;
}

export function toLines(raw: string): { raw: string[]; plain: string[]; eol: boolean } {
  const parts = raw.includes("\x1b]") ? splitOutsideEscapes(raw) : raw.split("\n");
  const plain = CONTROL_RE.test(raw) ? parts.map((p, i) => plainOf(p, i < parts.length - 1)) : parts;
  const eol = plain[plain.length - 1] === "";
  if (eol) {
    parts.pop();
    if (plain !== parts) plain.pop();
  }
  return { raw: parts, plain, eol };
}
