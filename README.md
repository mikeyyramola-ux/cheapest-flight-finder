# Cheapest Flight Finder

A mobile-first dark micro-SaaS for discovering low fares and tracking routes against a target budget. The UI ships with seeded global-hub data so the product feels operational before external credentials are connected.

## What is included

- React 19 + Tailwind 4 dashboard with flight search, sorted result cards, comparison table, route tracker, history view, and premium paywall.
- tRPC + Express backend with a modular flight-data engine, five-minute in-memory cache, seed offers, route history, tracker mutations, and a scanner endpoint.
- Amadeus Self-Service compatible placeholder path: set `AMADEUS_CLIENT_ID` and `AMADEUS_CLIENT_SECRET` and replace the provider call inside `server/flight-data.ts` with the Flight Offers Search request. Until then, deterministic seed data and route-based fallbacks keep the demo usable.
- Stripe subscription module in `server/stripe.ts`. It opens a demo paywall without keys and creates a real Checkout Session when `STRIPE_SECRET_KEY` and `STRIPE_PREMIUM_PRICE_ID` are configured.
- Stripe webhook handler at `/api/stripe/webhook`. The signature is verified with `STRIPE_WEBHOOK_SECRET`; checkout completion logs the Stripe customer/subscription identifiers for persistence in the user row.
- Telegram and WhatsApp notification framework. Telegram sends through the Bot API when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set. The WhatsApp branch is ready for Twilio credentials.

## Local development

```bash
pnpm install
pnpm dev
```

Open the generated preview URL. The dashboard is responsive at mobile widths and supports demo search without authentication.

## Environment keys

Do not commit real secrets. Configure them in the project environment or the managed project Settings UI:

```bash
AMADEUS_CLIENT_ID=
AMADEUS_CLIENT_SECRET=
STRIPE_SECRET_KEY=
VITE_STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PREMIUM_PRICE_ID=
APP_ORIGIN=https://your-domain.example
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_WHATSAPP_TO=whatsapp:+15551234567
```

Stripe test mode: create a recurring USD price at $9.99/month, copy its Price ID to `STRIPE_PREMIUM_PRICE_ID`, and use card `4242 4242 4242 4242` in Checkout. Register `POST /api/stripe/webhook` in the Stripe Dashboard and subscribe to `checkout.session.completed` and `invoice.paid`.

## Scheduled scanner

The application exposes `POST /api/scheduled/scan-flight-deals` as a platform-friendly handler. It performs a deterministic scan of every saved route and sends alerts when either the target price is met or the current price is at least 15% below its historical average. Configure a platform heartbeat with the six-field UTC cron expression `0 0 */12 * * *` after deployment. The handler is idempotent and does not use an in-process timer.

## Production notes

The current in-memory store is deliberately a launch-ready simulation layer for the generated demo. For production, persist `TrackedRoute` records and Stripe IDs in the existing Drizzle/MySQL database, then replace `listTrackedRoutes`, `addTrackedRoute`, and `scanTrackedRoutes` with database helpers. Keep the route ownership check and verify cron identity from the platform scheduler before mutating rows.


## Affiliate booking links

The Book now buttons intentionally fall back to direct airline links until a real Travelpayouts link is configured. To enable commission tracking, generate a flight-partner deep link in Travelpayouts and add it in Vercel as the public variable `VITE_TRAVELPAYOUTS_AFFILIATE_URL`. You may include the literal `{subid}` placeholder in the generated link; Faredrop replaces it with a route-specific marker such as `faredrop-jfk-lhr-sample-1`. If the generated URL does not support a placeholder, the exact generated URL is used unchanged. Do not label or advertise a link as affiliate-enabled until the partner URL is approved and tested.

## SEO and custom domain

Fareloop now uses server-side rendering for the initial HTML response. The root response contains the Fareloop title, a sub-160-character description, canonical URL, Open Graph and Twitter Card tags, SoftwareApplication JSON-LD, one H1, descriptive H2 sections, and visible copy explaining the product, pricing, supported regions, and affiliate disclosure. `robots.txt` and `sitemap.xml` are served at the site root by the Express server. There are currently no raster images in the public dashboard, so there are no image elements missing alt text; future images must use descriptive alt text.

Set these deployment variables to replace the temporary Manus-space canonical origin when a domain you own is connected:

```bash
SITE_NAME=Fareloop
CANONICAL_ORIGIN=https://your-owned-domain.example
```

The domain cannot be registered or DNS-configured without a domain owned by the account holder. After the domain is purchased or selected, add it in the hosting provider, point its DNS records to the provider's instructions, and set `CANONICAL_ORIGIN` to the final HTTPS URL before publishing. The generated sitemap and canonical/OG URLs will then update automatically.
