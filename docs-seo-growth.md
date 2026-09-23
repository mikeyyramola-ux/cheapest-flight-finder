# SEO & Traffic Growth — Fareloop → $100/week affiliate

Goal: grow organic traffic and affiliate actions until weekly commission is **≥ $100**.
This doc covers search-console submission, IndexNow, the traffic math, backlink targets, and the weekly checklist.

## 1. Traffic math: what $100/week actually needs

Assumed commission per conversion (see `docs-monetization.md` for sources):

| Program | Rate | Typical order | Commission |
|---|---|---|---|
| Aviasales (TravelPayouts) | ~1.1–1.3% / ticket | $450 flight | **~$5–6** |
| Kiwi (current fallback link) | 3% | $450 flight | **~$13.50** |
| Booking.com | ~5% | hotel stay | **~$10–20** |
| Viator / GetYourGuide | 8% | $220 activity | **~$17.60** |

Funnel assumptions (conservative, industry-standard for flight meta search):

- **10% of organic sessions** click an outbound partner link (search CTA + Book buttons).
- **1.5–3% of outbound clicks** become a paid booking/action.
- Blended commission **$6–13 per booking**.

**Per 100 sessions → ~10 outbound clicks → 0.15–0.30 bookings → ~$1.50–$3.50.**
Call it **≈ $2 per 100 sessions** blended.

| Weekly commission | Sessions/week | Sessions/day |
|---|---|---|
| $100 (target) | ~5,000 | **~700/day** |
| $100 with hotel/activity mix (~$4/100) | ~2,500 | ~350/day |
| $400/month run-rate | ~2,000 | ~300/day |

Equivalent view — outbound clicks are the real lever:

- Need ≈ **$100 ÷ $0.09 (value of one partner click) ≈ 1,100 outbound clicks/week ≈ 160/day.**
- At a 10% session→click rate that is ~1,600 sessions/day pure-flight, or **500–1,200/day with a mixed funnel**.

Levers that reduce the traffic needed: add hotel + activity affiliate links (higher EPC),
raise outbound CTR with URL-prefilled search CTAs (shipped), and rank for
"flights to {city}" long-tail pages (shipped: `/flights-to/:slug` ×32).

**Honest ramp expectation** for a domain weeks old:

- Month 1: GSC/Bing indexing, ~10–50 sessions/day.
- Month 2–3: destination pages start ranking on page 2–3, ~100–300 sessions/day.
- Month 4–6: page 1 for long-tail "flights to {city}" queries, ~500–1,500 sessions/day → target zone.

## 1b. Execution status (dated log — update when steps complete)

**Baseline (22 Sept 2026):** `site:cheapest-flight-finder.vercel.app` on Google → **0 results**
(never crawled: brand-new domain, zero referring links). Root cause of zero views.

Done — 22 Sept 2026:

- [x] **IndexNow live**: `INDEXNOW_KEY` set (64-hex, Vercel secret), `/{key}.txt` serves 200 and
      echoes the key, **all 37 sitemap URLs submitted → HTTP 202** at `api.indexnow.org`
      (Bing/DuckDuckGo/Naver/Seznam crawl from here within days).
- [x] **GSC property verified** via HTML tag → `GOOGLE_SITE_VERIFICATION` env set + redeployed,
      "Ownership verified" (URL-prefix property `https://cheapest-flight-finder.vercel.app/`).
- [x] **Sitemap submitted in GSC**: `/sitemap.xml` → **Success, 37 pages discovered**, read same day.
- [x] **Indexing requested (3/3 daily quota)**: `/`, `/flights-to`, `/faq` → "Indexing requested"
      (priority crawl queue). New properties get a low ~3/day request quota.
- [x] **robots.txt/canonical audit**: `Allow: /` for all crawlers (incl. AI bots), every page
      self-canonicals to the Vercel origin (old Manus duplicate won't cannibalize).
- [x] **GitHub backlinks live**: main repo made **PUBLIC** (secrets scan first: no `.env` history,
      zero key patterns) → homepage field + README link the site; new profile README repo
      `mikeyyramola-ux/mikeyyramola-ux` renders 8 links. Both pages `noindex: false`.

**Update — 23 Sept 2026:**

- [x] 🎉 **HOME PAGE INDEXED ON GOOGLE** — URL Inspection → "URL is on Google /
      Page is indexed" (verified twice with exact-URL match). Request → indexed in <24h.
- [x] **`/flights-to/new-york`** → "Indexing requested" (priority crawl queue).
- [x] **Quota behavior learned**: the indexing-request quota is a **rolling ~24h window of
      ~3 accepted requests**, *not* a midnight reset (yesterday's 3 + today's 1st filled it;
      the 2nd request today hit "Quota exceeded"). Space requests out; **inspection lookups
      are free** (unlimited status checks, only *Request indexing* counts).
- [x] 🎉 **`/flights-to/new-york` INDEXED** — requested the same morning, "Page is indexed"
      within hours. Priority-queue requests are processing fast (<24h for home, hours here).
- [x] Status sweep (free lookups): `/flights-to` → "URL is unknown to Google" (queued),
      `/faq` → "URL is unknown to Google" (queued). GSC *Pages* aggregate report shows
      "Processing data – check again in a day or so" (normal for a new property).
- [x] Quota detail: the request runs the full pipeline (live-URL test **passes** →
      "Submitting request") and only then gets rejected with `[alertdialog] Quota exceeded`
      when the rolling window is full. Failed attempts appear to consume time; **do not
      hammer retries** — wait for the window (≈24h after the last accepted requests).
- [ ] **Next window**: `/flights-to/san-francisco` (rejected this round — quota gave exactly
      one slot), then `chicago`, `toronto`, `vancouver`… — one request per window, do not hammer.

**Update 3 — 23 Sept 2026 (round 3):**

- [x] ✅ **`/flights-to/san-francisco` accepted** — window freed exactly one slot again
      (confirmed pattern: ~1 request per rolling window).
- [x] `/flights-to/chicago` → rejected (Quota exceeded) right after; stopped retries.
- [x] 🎉 **`/faq` INDEXED** — third indexed page (after `/` and `/flights-to/new-york`).
- [x] Sweep: `/flights-to` (day 3) + `/flights-to/los-angeles` (day 2) still
      "URL is unknown to Google" — in queue, sitemap-assisted.
- [x] GSC *Pages* + *Performance* aggregate reports both still "Processing data"
      (property <72h old; Performance shows "Last update: 6 hours ago").
- [x] External `site:` search still returns 0 — lags behind GSC for new sites;
      GSC exact-URL checks are authoritative (3 pages confirmed indexed there).

**Update 2 — 23 Sept 2026 (later):**

- [x] ✅ **`/flights-to/los-angeles` accepted** — the rolling window freed exactly **one** slot
      this round; request submitted to the priority crawl queue.
- [x] `/flights-to/san-francisco` → rejected (Quota exceeded) right after; stopped retries.
- [x] Sweep: `/flights-to` + `/faq` still "URL is unknown to Google" (day 2 in queue — normal;
      home and new-york set the fast precedent, others catch up via sitemap).
- [x] GSC *Pages* aggregate report still "Processing data – check again in a day or so"
      (property is <48h old; aggregates populate on the daily boundary).
- [ ] Optional: Bing Webmaster sign-in → *Import from Google Search Console* (IndexNow already
      covers Bing's crawler; webmaster account only adds reporting). Yandex Webmaster likewise.
- [ ] Watch GSC *Pages* report: expect "Discovered – not indexed" → "Indexed" waves as the
      sitemap gets worked through; then the weekly checklist below kicks in.

## 2. Env vars to add (Vercel → Settings → Environment Variables)

Server-side (SSR head / sitemap route):

| Env var | Where to get it | Effect when set |
|---|---|---|
| `GOOGLE_SITE_VERIFICATION` | Google Search Console → add property → HTML tag method → content value | emits `<meta name="google-site-verification">` |
| `BING_SITE_VERIFICATION` | Bing Webmaster Tools → add site → HTML tag → content value | emits `<meta name="msvalidate.01">` |
| `YANDEX_SITE_VERIFICATION` | Yandex Webmaster → add site → meta tag → content value | emits `<meta name="yandex-verification">` |
| `INDEXNOW_KEY` | Any 32-char hex string you generate, e.g. `python -c "import uuid;print(uuid.uuid4().hex)"` | serves `https://…/{key}.txt` for IndexNow proof |

All are optional and env-gated — unset means nothing changes.

Client-side (affiliate, from `docs-monetization.md`): `VITE_TRAVELPAYOUTS_AFFILIATE_URL`,
`VITE_TRAVELPAYOUTS_WIDGET_SNIPPET`, `VITE_BOOKING_AFFILIATE_URL`, `VITE_RENTALCARS_AFFILIATE_URL`.

## 3. One-time search console submission (do in this order)

1. **Google Search Console** — https://search.google.com/search-console → *Add property* →
   *HTML tag* method → copy the content value → set `GOOGLE_SITE_VERIFICATION` on Vercel → redeploy →
   *Verify*. Then *Sitemaps* → submit `https://cheapest-flight-finder.vercel.app/sitemap.xml`.
   Use *URL Inspection* on `/`, `/faq`, `/flights-to`, and 3–4 `/flights-to/...` pages → *Request indexing*.
2. **Bing Webmaster Tools** — https://www.bing.com/webmasters → *Add your site* →
   can *Import from Google Search Console* (fastest path, brings sitemap over). Otherwise set
   `BING_SITE_VERIFICATION`. Bing also picks up IndexNow automatically once pinging (below).
3. **Yandex Webmaster** — https://webmaster.yandex.com → add site → meta tag →
   set `YANDEX_SITE_VERIFICATION`. Lower priority; English travel queries are mostly Google/Bing.
4. **IndexNow ping** (after every deploy that changes URLs/content):

```powershell
$body = @{
  host = "cheapest-flight-finder.vercel.app"
  key  = "<YOUR_INDEXNOW_KEY>"
  keyLocation = "https://cheapest-flight-finder.vercel.app/<YOUR_INDEXNOW_KEY>.txt"
  urlList = @(
    "https://cheapest-flight-finder.vercel.app/",
    "https://cheapest-flight-finder.vercel.app/faq",
    "https://cheapest-flight-finder.vercel.app/flights-to",
    "https://cheapest-flight-finder.vercel.app/flights-to/london",
    "https://cheapest-flight-finder.vercel.app/flights-to/dubai"
  )
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.indexnow.org/indexnow" `
  -ContentType "application/json; charset=utf-8" -Body $body
```

(Bing, Yandex, Seznam and others consume this endpoint. 10,000 URLs per submission, batch freely.)

## 4. Shipped SEO architecture (already live)

- Distinct per-route titles/descriptions/OG tags, FAQPage + SoftwareApplication + WebSite JSON-LD.
- `/faq` content page, `/flights-to` hub, **32 programmatic `/flights-to/:slug` city pages** with
  unique body copy, BreadcrumbList + TouristDestination + FAQPage JSON-LD, region-grouped internal links.
- Dynamic `sitemap.xml` (37 URLs), robots.txt, soft-404 → real 404 + `noindex`.
- URL-prefilled search CTAs: `/?from=JFK&to=LHR` lands with the search already run.
- Internal linking: Home ↔ FAQ ↔ hub ↔ every destination page ↔ prefill CTAs back to search.

## 5. Backlink & distribution targets (off-site work, highest leverage now)

Ordered by effort-to-value:

1. **Google Search Console + Bing Webmaster** submissions above (technical, not optional).
2. **Product Hunt launch** — travel-tool launches regularly get 500+ visitors and durable backlinks.
   Prepare gallery images, tagline "Never overpay for a flight again", and a PH-exclusive demo.
3. **r/travel, r/shoestring, r/flights** — genuinely useful "how I track fare drops" posts linking to
   the tracker (read subreddit self-promo rules first; participate before posting).
4. **Quora / Reddit answers** for "how do I find cheap flights 2026" type questions — long-tail,
   compounding referral traffic.
5. **Tool directories**: AlternativeTo (listed under Google Flights alternatives), There's An AI/Tool
   for That-style travel directories, SaaSHub, G2 (free tier), BetaList if still pre-launch.
6. **Travel blogs — guest posts or link-worthy assets**: publish the 90-day fare-trend data as a
   "cheapest month to fly to {city}" statistic post; data posts earn links naturally.
7. **Press angle**: "flight price drop alerts" is journalist-friendly — pitch small travel desks and
   use free HARO/Featured.com queries.
8. **Partnerships**: link swaps with complementary non-competing travel blogs (only relevant,
   editorially placed links — never buy links).

Anchor-text mix: mostly branded ("Fareloop", "Fareloop flight tracker") + some exact-match
("cheap flights to London") — keep it natural.

## 6. Weekly checklist (30 min/week)

- [ ] Ping IndexNow with new/changed URLs.
- [ ] GSC: Coverage/Errors tab → fix any new "Crawled – currently not indexed" spikes.
- [ ] GSC: top queries report → find page-2 queries → strengthen that page's copy/internal links.
- [ ] Umami + Vercel Analytics: sessions, top pages, outbound-click events.
- [ ] TravelPayouts dashboard: clicks, bookings, pending commission → track path to $100/week.
- [ ] Ship one incremental improvement (new destination pages, route pages, or a blog post).

## 7. Next content phases (after destination pages)

1. **Route pages** (`/flights-to/london/from/new-york`) — the real high-intent tail; generate from
   the same dataset × `POPULAR_ORIGIN_HUBS`.
2. **Blog**: "cheapest month to fly to {city}" posts with 90-day trend data — link magnets.
3. **Hotel + activity links** on destination pages (Booking/Viator/GYG) — biggest EPC jump.
4. Expand the airport dataset from 32 → 100+ cities once the template is proven in GSC.
