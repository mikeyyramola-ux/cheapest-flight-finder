import { ArrowRight } from "lucide-react";
import { Link, useParams } from "wouter";
import NotFound from "@/pages/NotFound";
import {
  DESTINATIONS,
  DESTINATION_REGIONS,
  POPULAR_ORIGIN_HUBS,
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
      a: dest.season,
    },
    {
      q: `Which airport do flights to ${dest.city} land at?`,
      a: `Flights to ${dest.city} use ${dest.airport} (${dest.code}) in ${dest.country}. ${dest.blurb}`,
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
                <h2>{item.q}</h2>
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
