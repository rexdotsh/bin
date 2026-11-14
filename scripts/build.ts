import { $ } from "bun";
import subsetFont from "subset-font";

const out = "dist";
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)).join("");
const GLYPHS = range(0x20, 0x7e) + range(0xa0, 0x17f) + range(0x2010, 0x205e) + "€™" + range(0x2190, 0x21ff) + range(0x2500, 0x25ff) + "✓✗✘⌘⇧⌥⌃⏎";

async function build(opts: Parameters<typeof Bun.build>[0]) {
  const res = await Bun.build({ minify: true, ...opts });
  if (!res.success) throw new AggregateError(res.logs, "build failed");
  return res;
}

await $`rm -rf ${out} && mkdir -p ${out}/fonts ${out}/hl`;
await $`bun build cli/bin.ts --target=node --outfile=${out}/cli`.quiet();
await build({ entrypoints: ["web/view.ts", "web/compose.ts"], outdir: out });

const worker = await Bun.file("src/worker.ts").text();
const langs = [...new Set([...worker.match(/const EXT_LANG[^{]*\{([^}]*)\}/)![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]))].filter(
  (l) => !["log", "text", "diff"].includes(l),
);
const hljs = "node_modules/highlight.js/es";
await build({ entrypoints: [`${hljs}/core.js`, ...langs.map((l) => `${hljs}/languages/${l}.js`)], outdir: `${out}/hl`, naming: "[name].[ext]" });
const auto = `/tmp/bin-hl-auto-${process.pid}.js`;
await Bun.write(
  auto,
  `import hljs from "${process.cwd()}/${hljs}/core.js";\n${langs
    .map((l, i) => `import l${i} from "${process.cwd()}/${hljs}/languages/${l}.js";\nhljs.registerLanguage("${l}", l${i});`)
    .join("\n")}\nexport default hljs;\n`,
);
await build({ entrypoints: [auto], outdir: `${out}/hl`, naming: "auto.[ext]" });
await $`rm -f ${auto}`;

let css = await Bun.file("web/bin.css").text();
for (const [face, file] of [
  ["geist", "geist-sans/Geist-Variable.ttf"],
  ["geist-mono", "geist-mono/GeistMono-Variable.ttf"],
]) {
  const ttf = Buffer.from(await Bun.file(`node_modules/geist/dist/fonts/${file}`).arrayBuffer());
  const woff2 = await subsetFont(ttf, GLYPHS, { targetFormat: "woff2", variationAxes: { wght: { min: 400, max: 600 } } });
  const name = `${face}.${new Bun.CryptoHasher("sha256").update(woff2).digest("hex").slice(0, 8)}.woff2`;
  await Bun.write(`${out}/fonts/${name}`, woff2);
  css = css.replaceAll(`/fonts/${face}.woff2`, `/fonts/${name}`);
}
const tmpCss = `/tmp/bin-css-${process.pid}.css`;
await Bun.write(tmpCss, css);
const cssOut = await build({ entrypoints: [tmpCss], external: ["/fonts/*"] });
await Bun.write(`${out}/bin.css`, (await cssOut.outputs[0].text()).replace(/^\/\*.*\*\/\n/gm, "").trim());
await $`rm -f ${tmpCss}`;

await $`cp skill/bin/SKILL.md ${out}/skill.md && cp cli/install.sh ${out}/install && cp public/* ${out}/`;
await Bun.write(`${out}/_headers`, "/fonts/*\n  cache-control: public, max-age=31536000, immutable\n");

const files = (await $`cd ${out} && find . -type f | sort`.text()).trim().split("\n");
const expected = ["_headers", "bin.css", "cli", "compose.js", "favicon.svg", "install", "llms.txt", "skill.md", "view.js"];
const unexpected = files.map((f) => f.slice(2)).filter((f) => !expected.includes(f) && !/^fonts\/geist(-mono)?\.[0-9a-f]{8}\.woff2$/.test(f) && !/^hl\/[a-z]+\.js$/.test(f));
if (unexpected.length || expected.some((f) => !files.includes(`./${f}`)) || files.length !== expected.length + 2 + langs.length + 2) {
  throw new Error(`unexpected dist: ${unexpected.join(" ") || files.join(" ")}`);
}
