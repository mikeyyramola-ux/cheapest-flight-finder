#!/usr/bin/env node

/**
 * Check booking/affiliate links exposed in a live page or local HTML file.
 * Usage:
 *   node scripts/check-affiliate-links.mjs --url https://example.com
 *   node scripts/check-affiliate-links.mjs --url https://example.com --require-affiliate --affiliate-host tp.media
 *   node scripts/check-affiliate-links.mjs --file dist/public/index.html
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);
const source = valueFor("--url") ?? valueFor("--file");
const sourceType = valueFor("--url") ? "url" : valueFor("--file") ? "file" : null;
const timeoutMs = Number(valueFor("--timeout") ?? 15000);
const requiredHosts = (valueFor("--affiliate-host") ?? process.env.AFFILIATE_HOSTS ?? "")
  .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);

if (!source) {
  console.error("Usage: node scripts/check-affiliate-links.mjs --url <url> [--require-affiliate] [--affiliate-host tp.media]");
  process.exit(2);
}

const html = sourceType === "file"
  ? await readFile(source, "utf8")
  : await fetchText(source);

const candidates = extractLinks(html, sourceType === "url" ? source : undefined);
const unique = [...new Map(candidates.map((item) => [item.href, item])).values()];
const bookingLinks = unique.filter((item) => /book|fare|flight|deal|partner|affiliate|travel/i.test(`${item.text} ${item.href}`));
const links = bookingLinks.length ? bookingLinks : unique;

console.log(`Source: ${source}`);
console.log(`Discovered anchors: ${unique.length}`);
console.log(`Booking/affiliate candidates: ${bookingLinks.length}`);

if (!links.length) {
  console.error("FAIL: No booking or affiliate links were found in the supplied page.");
  process.exit(1);
}

const results = [];
for (const link of links) {
  const result = await checkUrl(link.href);
  const affiliate = requiredHosts.length > 0 ? requiredHosts.some((host) => result.finalHost === host || result.finalHost.endsWith(`.${host}`) || link.href.includes(host)) : null;
  results.push({ ...link, ...result, affiliate });
  const status = result.ok ? "OK" : "FAIL";
  const affiliateLabel = affiliate === true ? " affiliate" : affiliate === false ? " non-affiliate" : "";
  console.log(`${status} ${result.status ?? "ERR"} ${result.finalUrl}${affiliateLabel}${link.text ? ` — ${link.text}` : ""}`);
}

const broken = results.filter((result) => !result.ok);
const missingAffiliate = has("require-affiliate") ? results.filter((result) => result.affiliate === false) : [];
console.log(`\nSummary: ${results.length} checked, ${broken.length} broken, ${missingAffiliate.length} missing required affiliate host.`);
if (requiredHosts.length) console.log(`Allowed affiliate hosts: ${requiredHosts.join(", ")}`);
if (broken.length || missingAffiliate.length) process.exit(1);

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "faredrop-affiliate-link-checker/1.0" } });
  if (!response.ok) throw new Error(`Could not fetch source ${url}: HTTP ${response.status}`);
  return response.text();
}

function extractLinks(markup, baseUrl) {
  const result = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of markup.matchAll(anchorPattern)) {
    const href = normalizeUrl(match[1], baseUrl);
    if (!href) continue;
    result.push({ href, text: stripTags(match[2]).replace(/\s+/g, " ").trim() });
  }
  return result;
}

function normalizeUrl(value, baseUrl) {
  if (!/^https?:\/\//i.test(value) && !baseUrl) return null;
  try {
    const url = new URL(value, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

function stripTags(value) { return value.replace(/<[^>]*>/g, " "); }

async function checkUrl(url) {
  try {
    let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "faredrop-affiliate-link-checker/1.0" } });
    if ([405, 403, 501].includes(response.status)) {
      response = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "faredrop-affiliate-link-checker/1.0", accept: "text/html,*/*" } });
    }
    return { ok: response.status >= 200 && response.status < 400, status: response.status, finalUrl: response.url, finalHost: new URL(response.url).hostname };
  } catch (error) {
    return { ok: false, status: null, finalUrl: url, finalHost: null, error: error instanceof Error ? error.message : String(error) };
  }
}
