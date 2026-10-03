try {
  var theme = localStorage.getItem("theme");
  var dark = !theme || theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch {}
