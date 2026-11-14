import { setCookie } from "./ui";

export function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "light" ? "dark" : "light";
  root.dataset.theme = next;
  setCookie("theme", next);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#fcfcfb" : "#0a0a0a");
}

document.getElementById("theme")?.addEventListener("click", toggleTheme);
