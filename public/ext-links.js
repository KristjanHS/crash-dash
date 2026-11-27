/*
 * External public-chart links for the detail tab — a DOM-free seam (frontend.md §Testable slices go in a pure seam module)
 * rendering the `links` field of indicator-desc.js and the `holdings` field of leg-desc.js as one
 * compact line of new-tab anchors. Every URL is https on an allowlisted chart host; anything else
 * renders no anchor at all (fail-closed), and every label/URL is esc()'d at the write.
 */
import { esc } from "./chart-primitives.js";

/** Hosts a hand-authored chart link may point at. ext-links.test.js pins every entry against it. */
export const LINK_HOSTS = ["www.trading212.com"];

/** True for an https URL on an allowlisted host. */
export function isChartUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && LINK_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

function anchor(label, url) {
  if (!isChartUrl(url)) return "";
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}↗</a>`;
}

/** `links: [{label, url}]` → "NVDA↗ · futures↗" ("" when none survive the allowlist). */
export function linkList(links = []) {
  return links.map((l) => anchor(l.label, l.url)).filter(Boolean).join(" · ");
}

/** `holdings: [{name}]` → "Micron · TSMC · …" — plain escaped names, no anchors ("" when none). */
export function holdingList(holdings = []) {
  return holdings.map((h) => `<span class="ext-holding">${esc(h.name)}</span>`).join(" · ");
}
