// Imports a wastebin export (entries.jsonl) into bin under the old ids.
// usage: BIN_URL=https://bin.rex.wf BIN_TOKEN=... bun scripts/import.ts path/to/bin-export
import { readFileSync } from "node:fs";
import path from "node:path";

type Entry = {
  slug: string;
  slug_upstream: string;
  title: string | null;
  expires: string | null;
  expired: boolean;
  encrypted: boolean;
  text?: string;
};

const dir = process.argv[2];
const base = process.env.BIN_URL;
const token = process.env.BIN_TOKEN;
if (!dir || !base || !token) {
  console.error("usage: BIN_URL=... BIN_TOKEN=... bun scripts/import.ts <export dir>");
  process.exit(1);
}

const entries = readFileSync(path.join(dir, "entries.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Entry);

const counts = { imported: 0, alias: 0, existed: 0, encrypted: 0, expired: 0, empty: 0, failed: 0 };
const jobs: (() => Promise<void>)[] = [];

for (const e of entries) {
  if (e.encrypted) counts.encrypted++;
  else if (e.expired) counts.expired++;
  else if (!e.text) counts.empty++;
  else {
    const ids = e.slug_upstream !== e.slug ? [e.slug, e.slug_upstream] : [e.slug];
    for (const id of ids) jobs.push(() => put(id, e, id !== e.slug));
  }
}

async function put(id: string, e: Entry, alias: boolean) {
  const q = new URLSearchParams({ id });
  if (e.title) q.set("title", e.title);
  if (e.expires) q.set("expires", String(Math.floor(Date.parse(`${e.expires.replace(" ", "T")}Z`) / 1000)));
  const res = await fetch(`${base}/?${q}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "text/plain; charset=utf-8" },
    body: e.text,
  });
  if (res.status === 201) counts[alias ? "alias" : "imported"]++;
  else if (res.status === 409) counts.existed++;
  else {
    counts.failed++;
    console.error(`${id}: HTTP ${res.status} ${await res.text()}`);
  }
}

const queue = [...jobs];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let job; (job = queue.shift()); ) await job();
  }),
);
console.log(counts);
