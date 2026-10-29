"use strict";

// Mark the current page in the nav.
const here = location.pathname.replace(/index\.html$/, "").replace(/\/+$/, "/") || "/";
document.querySelectorAll(".links a").forEach((a) => {
  const p = new URL(a.href).pathname.replace(/\/+$/, "/");
  if (p === here) a.setAttribute("aria-current", "page");
});

const menu = document.querySelector(".menu");
if (menu) {
  menu.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    menu.setAttribute("aria-expanded", String(open));
  });
}

// CA bar: stays hidden until token.json is live with a valid address.
async function loadToken() {
  const bar = document.getElementById("caBar");
  if (!bar) return;
  try {
    const r = await fetch("/token.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const t = await r.json();
    if (!t.live || !/^0x[a-fA-F0-9]{40}$/.test(t.ca || "")) return;
    document.getElementById("caTicker").textContent = "$" + String(t.ticker || "").replace(/[^A-Z0-9]/gi, "");
    document.getElementById("caAddr").textContent = t.ca;
    const buy = document.getElementById("caBuy");
    const chart = t.links && t.links.chart;
    if (typeof chart === "string" && chart.startsWith("https://")) {
      buy.href = chart;
      buy.hidden = false;
    }
    const btn = document.getElementById("caCopy");
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(t.ca);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = t.ca;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1400);
    });
    bar.hidden = false;
  } catch {
    /* stay hidden */
  }
}
loadToken();
