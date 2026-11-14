const ITER = 600_000;

const toB64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(text: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await key(password, salt, ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(text)));
  return JSON.stringify({ v: 1, kdf: "pbkdf2-sha256", iter: ITER, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
}

export async function decrypt(envelope: string, password: string): Promise<string> {
  const e = JSON.parse(envelope) as { iter: number; salt: string; iv: string; ct: string };
  if (!(e.iter >= 100_000 && e.iter <= 5_000_000)) throw new Error("unsupported key setting");
  const k = await key(password, fromB64(e.salt), e.iter);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(e.iv) as BufferSource }, k, fromB64(e.ct) as BufferSource);
  return new TextDecoder().decode(pt);
}
