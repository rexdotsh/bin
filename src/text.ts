export const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()*+\-./][ -~]|\x1b[@-Z\\-_]?/g;
export const OSC_LINES_RE = /\x1b\][^\x07\x1b\n]*\n[^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const SGR_RE = /^\x1b\[([0-9;:]*)m$/;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/;
const STRAY_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const ANSI_STRAY_RE = new RegExp(`${ANSI_RE.source}|${STRAY_RE.source}`, "g");

export function stripAnsi(s: string): string {
  if (!CONTROL_RE.test(s)) return s;
  if (!s.includes("\r")) return s.replace(ANSI_STRAY_RE, "");
  const out = (s.includes("\x1b") ? s.replace(ANSI_RE, "") : s).replaceAll("\r\n", "\n");
  return (out.includes("\r") ? overwrite(out) : out).replace(STRAY_RE, "");
}

function overwrite(s: string): string {
  let out = "";
  let from = 0;
  for (let r = s.indexOf("\r"); r !== -1; r = s.indexOf("\r", from)) {
    const start = s.lastIndexOf("\n", r) + 1;
    const nl = s.indexOf("\n", r);
    const end = nl === -1 ? s.length : nl;
    const line = s.slice(start, end);
    const kept = line.slice(line.lastIndexOf("\r", line.length - 2) + 1);
    out += s.slice(from, start) + (kept.endsWith("\r") ? kept.slice(0, -1) : kept);
    from = end;
  }
  return out + s.slice(from);
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
