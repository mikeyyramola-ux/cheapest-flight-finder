# Affiliate-link health checker

Run the checker from the project root. It uses Node's built-in `fetch`, so no extra dependency is required.

## Check a deployed page

```bash
pnpm check:affiliate-links -- --url https://faredrop-snowy.vercel.app
```

The script discovers anchor tags, selects booking/affiliate candidates, follows redirects, and reports HTTP status plus the final destination host.

## Require an affiliate destination

After an approved Travelpayouts URL is configured, specify the host used by that partner. For example:

```bash
pnpm check:affiliate-links -- \
  --url https://faredrop-snowy.vercel.app \
  --require-affiliate \
  --affiliate-host tp.media
```

You can pass multiple allowed hosts as a comma-separated value:

```bash
--affiliate-host tp.media,travelpayouts.com,partner.example
```

The command exits with status `1` when a link is broken or when `--require-affiliate` is enabled and a candidate does not resolve to an allowed affiliate host. This makes it suitable for CI.

## Check a local built HTML file

```bash
pnpm build
pnpm check:affiliate-links -- --file dist/public/index.html
```

A static HTML scan can only check links present in the generated HTML. For React links rendered after hydration, point the checker at a running local site instead:

```bash
pnpm dev
pnpm check:affiliate-links -- --url http://localhost:3000
```

## Browser test for hydrated React buttons

The Playwright test at `tests/e2e/affiliate-buttons.spec.ts` opens the app in Chromium, clicks **Search fares**, waits for React to render the flight cards, and verifies every `.book-button` has an HTTPS destination and the `sponsored` relationship. It is the preferred test for this client-rendered app.

Run it locally:

```bash
pnpm test:e2e:affiliate
```

Run it against a deployed site:

```bash
TEST_BASE_URL=https://your-domain.example pnpm exec playwright test tests/e2e/affiliate-buttons.spec.ts
```

When the affiliate partner host is known, enforce it too:

```bash
TEST_BASE_URL=https://your-domain.example \
TEST_AFFILIATE_HOST=tp.media \
pnpm exec playwright test tests/e2e/affiliate-buttons.spec.ts
```

The test intentionally fails when the deployment does not contain the dashboard search flow, which catches accidentally serving an older marketing deployment.

## Notes

HTTP `HEAD` is attempted first. Some travel partners reject `HEAD`, so the checker automatically retries with a limited `GET`. A `3xx` redirect is considered healthy when it resolves successfully. A `4xx`, `5xx`, timeout, DNS error, or disallowed final affiliate host fails the command.
