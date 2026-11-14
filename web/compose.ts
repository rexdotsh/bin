import { encrypt } from "./crypto";
import "./theme";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const t = $<HTMLTextAreaElement>("t");
const title = $<HTMLInputElement>("title");
const lang = $<HTMLSelectElement>("lang");
const ttl = $<HTMLSelectElement>("ttl");
const lock = $<HTMLInputElement>("lock");
const pw = $<HTMLInputElement>("pw");
const status = $<HTMLSpanElement>("status");
const saveBtn = $<HTMLButtonElement>("save");

let name = "";
let holdPaste = false;
let busy = false;

const draft = sessionStorage.getItem("bin:draft");
if (draft) {
  sessionStorage.removeItem("bin:draft");
  const d = JSON.parse(draft) as { text: string; name?: string; lang?: string };
  t.value = d.text;
  name = d.name ?? "";
  if (d.lang && [...lang.options].some((o) => o.value === d.lang)) lang.value = d.lang;
}

lock.addEventListener("change", () => {
  pw.hidden = !lock.checked;
  if (lock.checked) pw.focus();
});

async function save(copyLink: boolean) {
  if (busy) return;
  const body = t.value;
  if (!body) return void (status.textContent = "nothing to save");
  if (lock.checked && !pw.value) {
    status.textContent = "enter a password";
    return pw.focus();
  }
  busy = true;
  saveBtn.disabled = true;
  status.textContent = lock.checked ? "encrypting…" : "saving…";
  try {
    const params = new URLSearchParams();
    if (title.value.trim()) params.set("title", title.value.trim());
    if (lang.value !== "auto") params.set("lang", lang.value);
    if (ttl.value !== "never") params.set("ttl", ttl.value);
    if (name) params.set("name", name);
    let payload = body;
    if (lock.checked) {
      payload = await encrypt(body, pw.value);
      params.set("enc", "1");
    }
    const res = await fetch(`/?${params}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "text/plain; charset=utf-8" },
      body: payload,
    });
    const r = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
      ok: boolean;
      error?: string;
      id?: string;
      url?: string;
      delete?: string;
    };
    if (!r.ok || !r.url || !r.id) throw new Error(r.error || "couldn't save");
    if (r.delete) localStorage.setItem(`bin:del:${r.id}`, r.delete);
    if (copyLink) await navigator.clipboard.writeText(r.url).catch(() => {});
    location.href = r.url;
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
    busy = false;
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", () => save(false));

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save(false);
  } else if (mod && e.shiftKey && e.key.toLowerCase() === "v") holdPaste = true;
});

document.addEventListener("paste", (e) => {
  const hold = holdPaste;
  holdPaste = false;
  if (hold || t.value || title.value || lock.checked) return;
  const pasted = e.clipboardData?.getData("text/plain") ?? "";
  if (!pasted) return;
  if (e.target !== t) {
    e.preventDefault();
    t.value = pasted;
  }
  setTimeout(() => t.value && save(true), 0);
});

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  t.value = await file.text();
  name = file.name;
  if (!title.value) title.placeholder = file.name;
  status.textContent = `${file.name} · ctrl+s to save`;
});
