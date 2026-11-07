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

// Motion: reveal on scroll, a lantern over dark sheets, and counting figures. Skipped when the user asks for less motion.
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!calm && "IntersectionObserver" in window) {
  document.documentElement.classList.add("js-motion");
  const groups = [".disp", ".kicker", ".three article", ".ramparts li", ".index a", ".road li", ".status > div", ".prin article", ".order li", ".rampart", ".tcard", ".band-in > div", ".chron li", ".faq details"];
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      seen.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  for (const sel of groups) {
    // live vault and token sections appear and disappear with the data, so they are never held back
    [...document.querySelectorAll(sel)].filter((el) => !el.closest("#tBody, .table-sec")).forEach((el, i) => {
      // stagger siblings so a row of cards lands one after another
      el.style.setProperty("--d", Math.min(i % 6, 5) * 0.08 + "s");
      el.classList.add("rv");
      seen.observe(el);
    });
  }

  document.querySelectorAll(".sec.dark, .hero, .phead").forEach((sec) => {
    sec.classList.add("lantern");
    sec.addEventListener("pointermove", (ev) => {
      const r = sec.getBoundingClientRect();
      sec.style.setProperty("--mx", ev.clientX - r.left + "px");
      sec.style.setProperty("--my", ev.clientY - r.top + "px");
      sec.classList.add("lit");
    });
    sec.addEventListener("pointerleave", () => sec.classList.remove("lit"));
  });
}

/** Count a figure up to its final text the first time it is seen. Non-numeric text is left alone. */
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
function countUp(el) {
  // a second call mid-animation would read a half-counted number as the target
  if (calm || el.dataset.counting) return;
  const final = el.textContent.trim();
  const roman = ROMAN[final];
  const m = final.match(/^([\d,]+)(.*)$/);
  if (!roman && !m) return;
  el.dataset.counting = "1";
  const target = roman ?? Number(m[1].replace(/,/g, ""));
  const tail = roman ? "" : m[2];
  const t0 = performance.now(), dur = 1100;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur), v = Math.round(target * (1 - Math.pow(1 - p, 3)));
    el.textContent = p < 1 ? (roman ? (Object.keys(ROMAN).find((k) => ROMAN[k] === Math.max(1, v)) ?? final) : v.toLocaleString("en-US") + tail) : final;
    if (p < 1) requestAnimationFrame(step);
    else delete el.dataset.counting;
  };
  requestAnimationFrame(step);
}
window.vaubanCount = countUp;
if (!calm && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { countUp(e.target); io.unobserve(e.target); } }), { threshold: 0.5 });
  document.querySelectorAll(".band b").forEach((b) => io.observe(b));
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
