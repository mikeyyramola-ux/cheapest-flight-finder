import { ArrowRight } from "lucide-react";
import { Link, useParams } from "wouter";
import NotFound from "@/pages/NotFound";
import {
  DESTINATIONS,
  DESTINATION_REGIONS,
  MONTH_ABBRS,
  POPULAR_ORIGIN_HUBS,
  cheapestMonthLabel,
  destinationBySlug,
  destinationPath,
  hubLabel,
  type Destination,
} from "@shared/destinations";

/** Unique, city-specific Q&A pairs rendered on the page and in FAQPage JSON-LD. */
function destinationFaqs(dest: Destination) {
  return [
    {
      q: `What is the cheapest time to fly to ${dest.city}?`,
      a: `The cheapest months to fly to ${dest.city} are usually ${cheapestMonthLabel(dest)}. ${dest.season}`,
    },
    {
      q: `Which airport do flights to ${dest.city} land at?`,
      a: `Flights to ${dest.city} use ${dest.airport} (${dest.code}) in ${dest.country}. ${dest.blurb}`,
    },
    {
      q: `How far in advance should I book flights to ${dest.city}?`,
      a: `Aim for about one to three months ahead on shorter routes and two to six months for long-haul flights to ${dest.city}, and add a month if you are traveling in a peak window. Inside that window, watch the route's 90-day trend on Fareloop and book when the fare sits in its lowest range instead of guessing a magic booking day.`,
    },
    {
      q: `How do I find cheap flights to ${dest.city} on Fareloop?`,
      a: `Set your origin and ${dest.city} (${dest.code}) as the destination on the Fareloop flight finder, then sort by cheapest total price. Every fare card shows the total price for your travelers plus stops, duration, baggage, and the airline, and you can watch the route's 90-day trend to book when prices sit in their lowest range.`,
    },
  ];
}

const faqJsonLd = (faqs: { q: string; a: string }[]) =>
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map(item => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  }).replace(/</g, "\\u003c");

const breadcrumbJsonLd = (dest: Destination) =>
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "/" },
      { "@type": "ListItem", position: 2, name: "Destinations", item: "/flights-to" },
      { "@type": "ListItem", position: 3, name: `Flights to ${dest.city}`, item: destinationPath(dest.slug) },
    ],
  }).replace(/</g, "\\u003c");

const placeJsonLd = (dest: Destination) =>
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "TouristDestination",
    name: `Flights to ${dest.city}`,
    description: dest.blurb,
    address: { "@type": "PostalAddress", addressCountry: dest.country },
  }).replace(/</g, "\\u003c");

/** 12-cell seasonal strip: highlighted cells are the destination's cheapest months (static guidance, never prices). */
function MonthStrip({ dest }: { dest: Destination }) {
  const cheap = new Set(dest.cheapestMonths);
  return (
    <span className="month-strip" role="img" aria-label={`Cheapest months to fly to ${dest.city}: ${cheapestMonthLabel(dest)}`}>
      {MONTH_ABBRS.map((abbr, index) => (
        <span key={abbr} className={`month-cell${cheap.has(index + 1) ? " is-cheap" : ""}`}>{abbr}</span>
      ))}
    </span>
  );
}

/** Region-grouped internal links to every other destination page. */
function DestinationDirectory({ currentSlug }: { currentSlug?: string }) {
  return (
    <>
      {DESTINATION_REGIONS.map(region => {
        const items = DESTINATIONS.filter(d => d.region === region && d.slug !== currentSlug);
        if (items.length === 0) return null;
        return (
          <div className="seo-copy" key={region}>
            <h2>Cheap flights to {region} destinations</h2>
            <p>
              {items.map((d, index) => (
                <span key={d.slug}>
                  <Link href={destinationPath(d.slug)}>{d.city}</Link>
                  {index < items.length - 1 ? " · " : ""}
                </span>
              ))}
            </p>
          </div>
        );
      })}
    </>
  );
}

export function DestinationHub() {
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Flight destinations",
    hasPart: DESTINATIONS.map(d => ({
      "@type": "WebPage",
      name: `Cheap flights to ${d.city}`,
      url: destinationPath(d.slug),
    })),
  }).replace(/</g, "\\u003c");

  return (
    <div className="app-shell">
      <main className="content-wrap" style={{ maxWidth: 1060 }}>
        <header className="page-header">
          <div>
            <p className="eyebrow accent-text">Destination guides</p>
            <h1 className="page-title">Cheap flights to <em>every destination</em></h1>
            <p className="hero-subtitle">
              Fare guides for {DESTINATIONS.length} major cities: when to fly, which airport to use, and how to watch the price trend before you book.
            </p>
          </div>
          <Link className="primary-cta small" href="/">Search flights <ArrowRight size={14} /></Link>
        </header>
        <section className="seo-content" aria-label="Destination directory">
          <div className="seo-copy">
            <h2>How to use these guides</h2>
            <p>
              Each destination page explains the best season for that city, the airport your flights will use, and example routes you can compare instantly.
              Open a guide, then use its search link to land on the flight finder with the destination already filled in — sort by cheapest total price and
              watch the 90-day trend before you book. Searching is free, and Fareloop never adds a markup to the fare you see.
            </p>
          </div>
          <div className="seo-copy seo-block-wide">
            <h2>Cheapest months to fly — every destination</h2>
            <p>
              A month-by-month view of when flights to each city are typically cheapest, distilled from each guide's own season notes. These are honest
              seasonal heuristics — Fareloop never publishes invented prices — so use the highlighted window as your starting point, shift your dates
              inside it, and confirm the live fare with a search.
            </p>
            <div className="table-scroll">
              <table className="month-table">
                <thead>
                  <tr>
                    <th scope="col">Destination</th>
                    <th scope="col">Region</th>
                    <th scope="col">Cheapest months to fly</th>
                  </tr>
                </thead>
                <tbody>
                  {DESTINATIONS.map(dest => (
                    <tr key={dest.slug}>
                      <td><Link href={destinationPath(dest.slug)}>Flights to {dest.city} ({dest.code})</Link></td>
                      <td>{dest.region}</td>
                      <td>{cheapestMonthLabel(dest)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <DestinationDirectory />
        </section>
        <footer className="faq-footer">
          <p>
            New here? Read the <Link href="/faq">cheap flights FAQ</Link>, watch a route in the <Link href="/tracker">deal tracker</Link>, or see what{" "}
            <Link href="/paywall">Fareloop Premium</Link> unlocks.
          </p>
        </footer>
      </main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
    </div>
  );
}

export default function DestinationPage() {
  const params = useParams<{ slug?: string }>();
  const dest = params.slug ? destinationBySlug(params.slug) : undefined;
  if (!dest) return <NotFound />;

  const faqs = destinationFaqs(dest);
  const routes = POPULAR_ORIGIN_HUBS.filter(code => code !== dest.code);

  return (
    <div className="app-shell">
      <main className="content-wrap" style={{ maxWidth: 1060 }}>
        <header className="page-header">
          <div>
            <p className="eyebrow accent-text">Destination guide · {dest.region}</p>
            <h1 className="page-title">Cheap flights to {dest.city}: <em>{dest.code} fares</em></h1>
            <p className="hero-subtitle">
              {dest.airport} · {dest.country}. Compare total prices, watch the 90-day trend, and get alerts when fares to {dest.city} drop.
            </p>
          </div>
          <Link className="primary-cta small" href={`/?to=${dest.code}`}>Search flights to {dest.city} <ArrowRight size={14} /></Link>
        </header>
        <section className="seo-content" aria-label={`Flights to ${dest.city}`}>
          <div className="seo-copy">
            <h2>Flying to {dest.city} ({dest.code})</h2>
            <p>{dest.blurb}</p>
          </div>
          <div className="seo-copy">
            <h2>When to fly to {dest.city}</h2>
            <p>{dest.season}</p>
          </div>
          <div className="seo-copy">
            <h2>Cheapest months to fly to {dest.city}</h2>
            <MonthStrip dest={dest} />
            <p>
              Seasonal guidance from this guide — never a fabricated price. The cheapest months to fly to {dest.city} are usually{" "}
              <strong className="month-strong">{cheapestMonthLabel(dest)}</strong>; the highlighted cells mark that window and everything else sits in the
              typical band. Shift your dates inside the highlighted months, then compare on the <Link href={`/?to=${dest.code}`}>flight finder for {dest.city}</Link>{" "}
              — or watch the route's 90-day trend and book when the curve dips.
            </p>
          </div>
          <div className="seo-copy">
            <h2>Airports and arrival</h2>
            <p>
              Flights to {dest.city} arrive at {dest.airport} ({dest.code}), serving {dest.country} in {dest.region}. Compare fares against nearby
              airports when your dates are flexible — switching arrival airport or flying midweek is often the fastest way to cut the total price,
              including baggage and seat fees.
            </p>
          </div>
          <div className="seo-copy">
            <h2>Popular routes to {dest.city}</h2>
            <p>
              {routes.map((code, index) => (
                <span key={code}>
                  <Link href={`/?from=${code}&to=${dest.code}`}>{hubLabel(code)} to {dest.city}</Link>
                  {index < routes.length - 1 ? " · " : ""}
                </span>
              ))}
            </p>
          </div>
          <div className="seo-copy">
            <h2>{dest.city} flight questions</h2>
            {faqs.map(item => (
              <div key={item.q}>
                <h3>{item.q}</h3>
                <p>{item.a}</p>
              </div>
            ))}
          </div>
          <DestinationDirectory currentSlug={dest.slug} />
        </section>
        <footer className="faq-footer">
          <p>
            <Link href="/">Search cheap flights</Link> · <Link href="/flights-to">All destinations</Link> · <Link href="/faq">Cheap flights FAQ</Link> ·{" "}
            <Link href="/tracker">Deal tracker</Link> · <Link href="/paywall">Fareloop Premium</Link>
          </p>
        </footer>
      </main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqJsonLd(faqs) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: breadcrumbJsonLd(dest) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: placeJsonLd(dest) }} />
    </div>
  );
}
