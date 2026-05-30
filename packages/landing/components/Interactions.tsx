"use client";

import { useEffect } from "react";

/**
 * Light client-side behavior for the landing page. Renders nothing — it runs
 * effects against the server-rendered markup: reveal-on-scroll, the chart
 * draw-on, terminal tabs, copy-to-clipboard, the year, and the scope readout.
 */
export default function Interactions() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    // current year
    document.querySelectorAll<HTMLElement>("[data-year]").forEach((el) => {
      el.textContent = String(new Date().getFullYear());
    });

    // reveal on scroll
    const reveals = document.querySelectorAll<HTMLElement>(".reveal");
    if ("IntersectionObserver" in window && reveals.length) {
      const io = new IntersectionObserver(
        (entries, obs) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("in-view");
              obs.unobserve(e.target);
            }
          }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
      );
      reveals.forEach((el) => io.observe(el));
      cleanups.push(() => io.disconnect());
    } else {
      reveals.forEach((el) => el.classList.add("in-view"));
    }

    // the precision chart draws when scrolled into view
    const chart = document.querySelector<HTMLElement>(".chart");
    if (chart && "IntersectionObserver" in window) {
      const io2 = new IntersectionObserver(
        (entries, obs) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("in-view");
              obs.unobserve(e.target);
            }
          }
        },
        { threshold: 0.3 },
      );
      io2.observe(chart);
      cleanups.push(() => io2.disconnect());
    } else if (chart) {
      chart.classList.add("in-view");
    }

    // terminal tabs
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
    const panes = Array.from(document.querySelectorAll<HTMLElement>(".snippet"));
    const tabHandlers: Array<[HTMLButtonElement, () => void]> = [];
    tabs.forEach((tab) => {
      const handler = () => {
        const key = tab.getAttribute("data-tab");
        tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
        panes.forEach((p) => p.classList.toggle("is-active", p.getAttribute("data-pane") === key));
      };
      tab.addEventListener("click", handler);
      tabHandlers.push([tab, handler]);
    });
    cleanups.push(() => tabHandlers.forEach(([t, h]) => t.removeEventListener("click", h)));

    // copy buttons
    const copyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".copy"));
    const copyHandlers: Array<[HTMLButtonElement, () => void]> = [];
    copyButtons.forEach((btn) => {
      const handler = async () => {
        const text = btn.getAttribute("data-copy") || "";
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
          } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
          }
          const prev = btn.textContent;
          btn.textContent = "copied ✓";
          btn.classList.add("copied");
          setTimeout(() => {
            btn.textContent = prev;
            btn.classList.remove("copied");
          }, 1600);
        } catch {
          btn.textContent = "press ⌘C";
          setTimeout(() => (btn.textContent = "copy"), 1600);
        }
      };
      btn.addEventListener("click", handler);
      copyHandlers.push([btn, handler]);
    });
    cleanups.push(() => copyHandlers.forEach(([b, h]) => b.removeEventListener("click", h)));

    // a little life in the scope readout
    const readout = document.querySelector<HTMLElement>("[data-snr]");
    if (readout && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = setInterval(() => {
        const snr = (18.4 + Math.random() * 1.3).toFixed(1);
        readout.textContent = `SNR ${snr} dB`;
      }, 1400);
      cleanups.push(() => clearInterval(id));
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return null;
}
