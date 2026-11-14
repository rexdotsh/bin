export function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "light" ? "dark" : "light";
  root.dataset.theme = next;
  document.cookie = `theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#fcfcfb" : "#0a0a0a");
}

document.getElementById("theme")?.addEventListener("click", toggleTheme);
