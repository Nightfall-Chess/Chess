/* Small, dependency-free interaction polish adapted from Orbit's menu cards. */
(() => {
  "use strict";
  const selector = [
    ".home-shortcut", ".mode-card", ".profile-stat",
    ".lobby-nav-button", ".settings-nav-button",
    ".theme-option", ".lesson-item", ".online-card"
  ].join(",");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!finePointer.matches || reducedMotion.matches) return;

  function attach(root) {
    if (!root || root.nodeType !== 1) return;
    const elements = [];
    if (root.matches?.(selector)) elements.push(root);
    if (root.querySelectorAll) elements.push(...root.querySelectorAll(selector));
    for (const element of elements) {
      if (element.dataset.orbitSurface === "ready") continue;
      element.dataset.orbitSurface = "ready";
      element.addEventListener("pointermove", event => {
        if (event.pointerType === "touch") return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
        element.style.setProperty("--orbit-x", (x * 100).toFixed(1) + "%");
        element.style.setProperty("--orbit-y", (y * 100).toFixed(1) + "%");
        element.style.setProperty("--orbit-tilt-x", ((x - .5) * 2.2).toFixed(2) + "deg");
        element.style.setProperty("--orbit-tilt-y", ((.5 - y) * 2.2).toFixed(2) + "deg");
      }, { passive: true });
      element.addEventListener("pointerleave", () => {
        element.style.setProperty("--orbit-tilt-x", "0deg");
        element.style.setProperty("--orbit-tilt-y", "0deg");
      }, { passive: true });
    }
  }

  const scan = () => document.querySelectorAll(selector).forEach(el => attach(el));
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else scan();

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) attach(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
