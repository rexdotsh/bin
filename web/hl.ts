type Hljs = {
  registerLanguage(name: string, lang: unknown): void;
  highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string };
  highlightAuto(code: string): { value: string; relevance: number };
};

const load = (path: string) => import(path);

function splitHtml(htmlText: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const m of htmlText.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else if (m[3]) {
      out.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else cur += m[4];
  }
  out.push(cur);
  return out;
}

export async function highlight(mods: string[], lang: string, text: string): Promise<string[] | null> {
  try {
    const [core, grammar] = await Promise.all(mods.map(load));
    const hljs = core.default as Hljs;
    if (grammar) {
      hljs.registerLanguage(lang, grammar.default);
      return splitHtml(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value);
    }
    const auto = hljs.highlightAuto(text);
    return auto.relevance < 10 ? null : splitHtml(auto.value);
  } catch {
    return null;
  }
}
