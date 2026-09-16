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

## Notes

HTTP `HEAD` is attempted first. Some travel partners reject `HEAD`, so the checker automatically retries with a limited `GET`. A `3xx` redirect is considered healthy when it resolves successfully. A `4xx`, `5xx`, timeout, DNS error, or disallowed final affiliate host fails the command.
