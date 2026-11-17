import { $ } from "bun";
import { Blob as HbBlob, Face } from "harfbuzzjs";
import subsetFont from "subset-font";

const out = "dist";
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)).join("");
const CORE = range(0x20, 0x7e) + "\u00a0·–—‘’“”…→⇧";
const EXT = [...(range(0xa1, 0x17f) + range(0x2010, 0x205e) + "€™" + range(0x2190, 0x21ff) + range(0x2300, 0x23ff) + range(0x2500, 0x25ff))].filter((c) => !CORE.includes(c)).join("");

function unicodeRange(cps: number[]) {
  const hex = (n: number) => n.toString(16).toUpperCase();
  const out: string[] = [];
  for (let i = 0, j = 0; i < cps.length; i = ++j) {
    while (cps[j + 1] === cps[j] + 1) j++;
    out.push(j > i ? `U+${hex(cps[i])}-${hex(cps[j])}` : `U+${hex(cps[i])}`);
  }
  return out.join(",");
}

async function build(opts: Parameters<typeof Bun.build>[0]) {
  const res = await Bun.build({ minify: true, ...opts });
  if (!res.success) throw new AggregateError(res.logs, "build failed");
  return res;
}

await $`rm -rf ${out} && mkdir -p ${out}/fonts ${out}/a/hl`;
await $`bun build cli/bin.ts --target=node --outfile=${out}/cli`.quiet();

const worker = await Bun.file("src/worker.ts").text();
const langs = [...new Set([...worker.match(/const EXT_LANG[^{]*\{([^}]*)\}/)![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]))].filter(
  (l) => !["log", "text", "diff"].includes(l),
);
const assets: Record<string, string> = {};
const hashed = async (opts: Parameters<typeof Bun.build>[0], dir: string) => {
  const res = await build({ naming: "[name].[ext]", ...opts, outdir: `/tmp/bin-build-${process.pid}` });
  for (const o of res.outputs) {
    const code = await o.text();
    const name = o.path.split("/").pop()!.replace(/\.js$/, "");
    const file = `${dir}${name}.${new Bun.CryptoHasher("sha256").update(code).digest("hex").slice(0, 8)}.js`;
    await Bun.write(`${out}/a/${file}`, code);
    assets[`${dir}${name}.js`] = `/a/${file}`;
  }
  await $`rm -rf /tmp/bin-build-${process.pid}`;
  await Bun.write(`${out}/assets.json`, JSON.stringify(assets));
};
const hljs = "node_modules/highlight.js/es";
await hashed({ entrypoints: [`${hljs}/core.js`, ...langs.map((l) => `${hljs}/languages/${l}.js`)] }, "hl/");
const auto = `/tmp/bin-hl-${process.pid}/auto.js`;
await Bun.write(
  auto,
  `import hljs from "${process.cwd()}/${hljs}/core.js";\n${langs
    .map((l, i) => `import l${i} from "${process.cwd()}/${hljs}/languages/${l}.js";\nhljs.registerLanguage("${l}", l${i});`)
    .join("\n")}\nexport default hljs;\n`,
);
await hashed({ entrypoints: [auto] }, "hl/");
await $`rm -rf ${auto.replace(/\/auto\.js$/, "")}`;
await hashed({ entrypoints: ["web/hl-worker.ts"] }, "");
await hashed({ entrypoints: ["web/view.ts"], define: { MD: "false" } }, "");

const lexerOnly: Bun.BunPlugin = {
  name: "marked-lexer-only",
  setup(b) {
    b.onLoad({ filter: /marked\.esm\.js$/ }, async ({ path }) => {
      const src = await Bun.file(path).text();
      const names = Object.fromEntries([...(src.match(/export\{([^}]*)\};?\s*(?:\/\/.*\s*)?$/)?.[1] ?? "").matchAll(/(\w+) as (\w+)/g)].map((m) => [m[2], m[1]]));
      const cut = names.Marked && src.search(new RegExp(`var \\w+=new ${names.Marked.replace(/\$/g, "\\$")};`));
      if (!names.Lexer || !cut || cut < 0) throw new Error("marked's bundle changed shape; update the marked-lexer-only plugin");
      return { contents: `${src.slice(0, cut)}export{${names.Lexer} as Lexer};`, loader: "js" };
    });
  },
};
await hashed({ entrypoints: ["web/md.ts"], plugins: [lexerOnly] }, "");

const minCss = async (src: string) => {
  const tmp = `/tmp/bin-css-${process.pid}.css`;
  await Bun.write(tmp, src);
  const res = await build({ entrypoints: [tmp], external: ["/fonts/*"] });
  await $`rm -f ${tmp}`;
  return (await res.outputs[0].text()).replace(/^\/\*.*\*\/\n/gm, "").trim();
};
const mdCss = await minCss(await Bun.file("web/md.css").text());
const mdCssName = `md.${new Bun.CryptoHasher("sha256").update(mdCss).digest("hex").slice(0, 8)}.css`;
await Bun.write(`${out}/md.css`, mdCss);
await Bun.write(`${out}/a/${mdCssName}`, mdCss);
assets["md.css"] = `/a/${mdCssName}`;
await Bun.write(`${out}/assets.json`, JSON.stringify(assets));
await hashed({ entrypoints: ["web/view.ts"], define: { MD: "true" }, naming: "view-md.[ext]" }, "");
await hashed({ entrypoints: ["web/compose.ts"] }, "");

let css = await Bun.file("web/bin.css").text();
for (const [face, file, features] of [
  ["geist", "geist-sans/Geist-Variable.ttf", ["kern", "liga"]],
  ["geist-mono", "geist-mono/GeistMono-Variable.ttf", []],
] as const) {
  const src = await Bun.file(`node_modules/geist/dist/fonts/${file}`).arrayBuffer();
  const cmap = new Set(new Face(new HbBlob(src)).collectUnicodes());
  for (const [suffix, glyphs] of [["", CORE], ["-ext", EXT]]) {
    const cps = [...glyphs].map((c) => c.codePointAt(0)!).filter((c) => cmap.has(c)).sort((a, b) => a - b);
    const woff2 = await subsetFont(Buffer.from(src), String.fromCodePoint(...cps), { targetFormat: "woff2", keepFeatures: [...features], variationAxes: { wght: { min: 400, max: 600 } } });
    const name = `${face}${suffix}.${new Bun.CryptoHasher("sha256").update(woff2).digest("hex").slice(0, 8)}.woff2`;
    await Bun.write(`${out}/fonts/${name}`, woff2);
    const fontUrl = `url("/fonts/${face}${suffix}.woff2") format("woff2");`;
    if (!css.includes(fontUrl)) throw new Error(`web/bin.css has no @font-face for /fonts/${face}${suffix}.woff2`);
    css = css.replaceAll(fontUrl, `url("/fonts/${name}") format("woff2"); unicode-range: ${unicodeRange(cps)};`);
  }
}
await Bun.write(`${out}/bin.css`, await minCss(css));

await $`cp skill/bin/SKILL.md ${out}/skill.md && cp cli/install.sh ${out}/install && cp public/* ${out}/`;
await Bun.write(`${out}/_headers`, ["/a/*", "/fonts/*"].map((p) => `${p}\n  cache-control: public, max-age=31536000, immutable\n`).join(""));
await Bun.write(`${out}/.assetsignore`, "assets.json\nbin.css\nmd.css\n");

const files = (await $`cd ${out} && find . -type f | sort`.text()).trim().split("\n").map((f) => f.slice(2));
const expected = [".assetsignore", "_headers", "assets.json", "bin.css", "md.css", "cli", "favicon.ico", "favicon.svg", "install", "llms.txt", "robots.txt", "skill.md", ...Object.values(assets).map((a) => a.slice(1))];
const wanted = ["view.js", "view-md.js", "compose.js", "hl-worker.js", "md.js", "md.css", "hl/core.js", "hl/auto.js", ...langs.map((l) => `hl/${l}.js`)];
const fonts = files.filter((f) => /^fonts\/geist(-mono)?(-ext)?\.[0-9a-f]{8}\.woff2$/.test(f));
const unexpected = files.filter((f) => !expected.includes(f) && !fonts.includes(f));
if (unexpected.length || expected.some((f) => !files.includes(f)) || fonts.length !== 4 || wanted.some((k) => !assets[k]) || Object.keys(assets).length !== wanted.length) {
  throw new Error(`unexpected dist: ${unexpected.join(" ") || files.join(" ")}`);
}
