# Monetization playbook — Fareloop / cheapest-flight-finder

Status of every affiliate lever, what is already wired in code, and the exact
account-side steps only the site owner can perform. Research verified against
partner documentation (key sources cited at the end).

---

## 1. What the code already supports (env-gated, zero code changes later)

All variables are **public build-time** vars set in Vercel → Project →
Settings → Environment Variables, then redeploy.

| Variable | Wired at | Placeholders replaced per click | Fallback when unset |
|---|---|---|---|
| `VITE_TRAVELPAYOUTS_AFFILIATE_URL` | Flight "Check fare / Book now" button | `{subid}` `{origin}` `{destination}` `{depart}` `{return}` `{passengers}` | Fixed `https://kiwi.tpk.lu/BqdFdqYN` link |
| `VITE_BOOKING_AFFILIATE_URL` | Stays search submit | `{location}` `{start}` `{end}` `{guests}` | Plain `booking.com/searchresults.html` URL |
| `VITE_RENTALCARS_AFFILIATE_URL` | Cars search submit | `{location}` `{start}` `{end}` `{guests}` | Plain `rentalcars.com/search-results` URL |
| `VITE_TRAVELPAYOUTS_WIDGET_SNIPPET` | Full-width slot in the About/SEO section (every page) | none — pasted **verbatim** (ToS forbids modifying widget code) | slot hidden |

Existing compliance already in place: `rel="noopener noreferrer sponsored"` on
every booking anchor, visible affiliate disclosure in the SEO copy and in the
`/faq` page, sitewide disclosure question in FAQPage JSON-LD.

---

## 2. TravelPayouts setup (do once — your account login required)

Your account is registered against the Manus domain; keep it and **add the
ranking domain**: Travelpayouts → Profile → Websites → add
`https://cheapest-flight-finder.vercel.app`.

1. **API token** (issued automatically at signup): Profile → **API token** tab
   → Copy. Aviasales-specific token: `app.travelpayouts.com/programs/100/tools/api`.
2. **Flight deep link**: open a program (e.g. Aviasales) → **Links → Create
   link** → copy the generated URL (it embeds your `shmarker`) → paste into
   Vercel as `VITE_TRAVELPAYOUTS_AFFILIATE_URL`.
   - Fixed short link (`tp.media`, `cNN.travelpayouts.com/click?...`): works as-is;
     add `{subid}` if the link builder offers a sub-id field.
   - Route-aware link: any URL containing the placeholders above is rewritten
     per result, e.g. an Aviasales search URL
     `https://www.aviasales.com/search/{origin}{depart}{destination}{return}c3{passengers}`
     (date format = `DDMM`; cabin/passenger digits — confirm the exact suffix
     with the dashboard link builder, passenger count is mandatory).
3. **Widget**: Aviasales program → **Tools → Widgets → Set up** (new IDs:
   Aviasales `7879`, Hotellook `7873`) → copy the exact snippet
   (`//www.travelpayouts.com/widgets/<handle>.js?v=2235` — note: the old
   `software/sdk.js` URL no longer exists, HTTP 404) → paste entire snippet
   into Vercel as `VITE_TRAVELPAYOUTS_WIDGET_SNIPPET`. Never edit the snippet.
4. **Payout setup**: `app.travelpayouts.com/finance/requisites` → choose
   PayPal (**$50 min**), bank transfer USD/EUR (**$400 min**) or WebMoney
   ($10). Payouts are automatic and monthly (Aviasales pays 10th–20th).

Kiwi.com Tequila **API** requires ≥50,000 MAU — use Kiwi links/widgets instead
(3% per booking, 30-day cookie, ~$450 average order ≈ $13.50/sale).

---

## 3. Program launch ranking (small site, no API approvals)

| # | Program | Rate | Cookie | How to add (no code change needed) |
|---|---|---|---|---|
| 1 | Aviasales (TP) | ~1.1–1.3% of ticket | 30 d | deep link → `VITE_TRAVELPAYOUTS_AFFILIATE_URL` + widget snippet |
| 2 | Viator or GetYourGuide | 8% | 30/31 d | TP "Create link" → destination/tour blocks (future content pages) |
| 3 | Tiqets | 3.5–8% | 30 d | TP links/widgets for city/attraction pages |
| 4 | Booking.com | 5% | **1 session only** | TP link (or direct via CJ) → `VITE_BOOKING_AFFILIATE_URL`; keep it adjacent to the search CTA because the cookie dies in one session |
| 5 | Kiwi.com | 3% ($450 AOV) | 30 d | TP link → flight button (currently the fallback host) |
| 6 | WayAway | 50% rev-share + $10/Plus sale | 30 d web / 180 d app | apply via TP directory |
| 7 | Amazon Associates | up to 10% | ~24 h | future "travel gear" listicles; `affiliate-program.amazon.com/signup` |

Later, with steady traffic: **KAYAK Affiliate Network** (`affiliates.kayak.com`
— search boxes + whitelabel + ad-revenue share, manual approval) and
**Skimlinks** (free, auto-monetizes merchant mentions; 48,500 merchants incl.
Expedia Group).

Ads ladder: **Google AdSense** first (no published numeric minimum; needs
privacy policy + ads.txt + original content) → **Ezoic** when AdSense RPMs
stagnate → **Mediavine** only at ~50k sessions/month (verify before planning
around it). Media.net suits English/US traffic once content is steady.

---

## 4. Rules that must not be broken

- **Never modify widget/tool code** (TP ToS §5.2) — the snippet slot pastes verbatim.
- Keep the visible affiliate **disclosure** (already present in SEO copy + FAQ).
- Aviasales: no ad hijacking, no direct linking to aviasales.com, no trademark
  bidding, don't disorient users.
- Concurrent affiliate programs are allowed (no exclusivity clause).
- Vercel hosting is allowed (tools must sit on resources you administer).
- Only mark links "affiliate-enabled" after the partner URL is approved and tested.

---

## 5. QA tools in this repo

```bash
npm run check:affiliate-links -- --url https://cheapest-flight-finder.vercel.app --affiliate-host tp.media,travelpayouts.com
npm run test:e2e:affiliate        # asserts rel="sponsored" on every booking button
```

`server/partner-health.ts` monitors the live Kiwi affiliate link, Booking.com
and Rentalcars endpoints on the `monitoring.partners` tRPC route.

---

## 6. CJ Affiliate network — applications log

Account: superuser VIPIN Ramola · CID 8079657 · member 7767794 · W-8BEN filed.
Property used: **Fareloop – Cheap Flight Finder** →
`https://cheapest-flight-finder.vercel.app` (models: Content/Blog/Media +
Product Comparison; status Active [Primary]). Property #1 ("Mingle",
101889008) kept untouched.

Applied 2026-09-23 (search via the **Keyword(s)** box + exact **Search** button —
the Advertiser(s) box corrupts input; result rows are `div.adv-row` carrying EPC
text; confirmation opens a **new tab titled "Application submitted for review"
that AUTO-CLOSES** — read fast; a decline returns a tab titled
"Application declined"):

| Advertiser | ID | Result |
|---|---|---|
| Trip.com (Global) | 4368684 | submitted for review |
| Priceline.com Europe | 4441431 | submitted for review |
| Booking.com North America | 7864295 | submitted for review |
| Booking.com APAC | 7854081 | submitted for review |
| Whimstay | 7625430 | submitted for review |
| Priceline.com (Hotel) | 1464653 | **declined by advertiser** (final) |
| Booking.com United Kingdom | 4297311 | blocked — Apply button absent |
| Booking.com Australia | 7864353 | blocked — Apply button absent |

Earlier pending (first CJ session): Groupon ×2 + GetYourGuide.
**Pending total: 8.**

UK/AU blocker, verbatim: *"The superuser on this account must complete the
onboarding checklist and activate the account before you can apply to join
advertiser programs."* → Network Profile opens at
`/member/app/publisher/account/network-profile/general`; finish every
non-agreement field, hand any agreement/attestation tick to the owner.

Next wave after the checklist: **CheapAir, CheapOair, JustFly** (P0 flight
OTAs), then Expedia / Agoda / Rentalcars / Tripadvisor (P1). Not on CJ at all:
Kiwi, Tiqets, Airalo, KAYAK, Omio, Klook, Trainline — keep via TravelPayouts.

### Round 5 — 24 Sept 2026 (browser + CJ channel recovered)

**Corrections found this round:** the earlier "Pending total: 8" was an
undercount — the authoritative *Status: Pending Applications* filter (dashboard
→ "Review Pending Applications") showed **31 Results** before this round
(Agoda EU/UK, Booking ×8 regions **incl. UK**, Expedia ×6 **incl. Expedia Inc**,
Hotels.com ×6, Vrbo ×2, Trip.com, Priceline EU, Groupon, GetYourGuide US …).
**Whimstay 7625430 was never actually pending** despite the 23 Sept log line —
it submitted successfully this round. Booking.com UK 4297311 is **pending**
(blocker has cleared); Booking.com AU 7864353 still absent.

Applied 2026-09-24 — **18 submitted** (one-click flow; no agreement checkbox
involved in any of these):

| Advertiser | ID | Result |
|---|---|---|
| CheapOair | 2515404 | submitted for review |
| CheapOair.ca | 5018271 | submitted for review |
| Cheapflightsfares | 6061620 | submitted for review |
| CheapTickets (Travel entity) | 7667121 | submitted for review |
| Cheapvuelos | 7947783 | submitted for review |
| EconomyBookings.com | 6385999 | submitted for review |
| AVIANCA WORLDWIDE | 5075736 | submitted for review |
| Suntransfers.com | 4727627 | submitted for review |
| Air India | 7008093 | submitted for review |
| Air Serbia | 5289333 | submitted for review |
| Austrian Airlines – US | 5320930 | submitted for review |
| Booking.com Brazil | 7854073 | submitted for review |
| Booking.com LATAM | 7864342 | submitted for review |
| Arangrant | 7226122 | submitted for review |
| Airport Parking Reservations | 3102643 | submitted for review |
| Aerolite (luggage) | 7218691 | submitted for review |
| airhelp.com INT | 5185191 | submitted for review |
| Whimstay | 7625430 | submitted for review (re-send — see correction) |

Declined this round: **JUSTFLY 4584986**, **AirportRentalCars.com 3677020**
(final — advertiser decision).

Owner gates (special-terms page titled **"Join Advertiser"** with an *Accept and
Apply* button = legal agreement → never clicked by the agent): **CheapTickets
4861279** (Expedia Group T&C), **Brussels Airlines US 7517515**, **Best Western
1686526**. Owner: open Find Advertisers → search the name → Apply → scroll the
terms → press *Accept and Apply* if agreed.

Not on CJ (keyword searches returned 0 / no such advertiser): **CheapAir,
Rentalcars.com, Tripadvisor** — keep via TravelPayouts.

**Final pending: 47 Results** (31 → 47 net; all 18 of today's IDs spot-verified
in the filter). Recipe addendum: confirmation tabs may be **reused across
applies** — always match `advertiserId=` in the tab URL, not just the title;
hidden `a.text-error` anchors ("Please complete your Network Profile…" /
"…onboarding checklist…") exist in every row's DOM — display state, not status.

---

## 7. Key sources

- TP signup/token: support.travelpayouts.com/hc/en-us/articles/13024069738386, /11395179019538
- Widgets (live format + deprecation notice): support…/8505942823954, /360027634052
- Aviasales deep links: support…/5711895629714, /360031977872, /6513071218834
- TP REST API (`X-Access-Token`): api.travelpayouts.com/documentation
- Kiwi 50k MAU limit: support…/360019237899
- TP ToS/rules/payouts: support…/360004162111, /203955673, /115004350388, /206635007, /360012173160
- Program rates: travelpayouts.com/en/offers/{aviasales,kiwi,viator,tiqets,agoda,booking…}-affiliate-program
- KAYAK: affiliates.kayak.com · Expedia: partner.expediagroup.com/en-us · Amazon: affiliate-program.amazon.com/signup · Skimlinks: skimlinks.com/signup
- AdSense eligibility: support.google.com/adsense/answer/1348688 · Ezoic: ezoic.com/get-started · Media.net: media.net
