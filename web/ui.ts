type Area = "localStorage" | "sessionStorage";

export function stored(area: Area, key: string): string | null {
  try {
    return window[area].getItem(key);
  } catch {
    return null;
  }
}

export function store(area: Area, key: string, value: string | null): boolean {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function cookie(name: string): string | undefined {
  try {
    return document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];
  } catch {
    return undefined;
  }
}

export function setCookie(name: string, value: string) {
  try {
    document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {}
}

export function toast(msg: string, ms = 1400) {
  let el = document.querySelector<HTMLDivElement>(".toast");
  const fresh = !el;
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  const t = el;
  t.textContent = msg;
  clearTimeout(Number(t.dataset.timer));
  if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("on")));
  else t.classList.add("on");
  t.dataset.timer = String(setTimeout(() => t.classList.remove("on"), ms));
}
