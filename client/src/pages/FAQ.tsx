import { ArrowRight } from "lucide-react";
import { Link } from "wouter";

type FaqItem = { q: string; a: string };

/** Plain-text Q&A pairs. Rendered on the page and reused for FAQPage JSON-LD. */
const FAQ_ITEMS: FaqItem[] = [
  {
    q: "How do I find the cheapest flights?",
    a: "Search your origin and destination on the Fareloop flight finder, then sort results by cheapest total price. Every fare card shows the total price for your travelers plus stops, duration, baggage, and the airline, so you compare the real cost of the trip instead of a misleading headline fare.",
  },
  {
    q: "When is the best time to book a cheap flight?",
    a: "Airfares change daily, so there is no single magic booking day. Prices usually settle one to three months before departure for domestic trips and two to six months ahead for long-haul international routes. The reliable approach is to watch the route's 90-day price trend on Fareloop and book when the fare sits in its lowest range.",
  },
  {
    q: "What is a price-drop alert?",
    a: "A price-drop alert tells you the moment a fare you are watching falls meaningfully below its recent reference price or reaches your target budget. Instead of re-checking the route every day, you get a notification when the number actually moves.",
  },
  {
    q: "How does the Fareloop deal tracker work?",
    a: "Save a route such as JFK to LHR together with a target price and an alert channel. Fareloop scans the route on your schedule, compares the current fare with its 90-day average, and surfaces an alert when a meaningful drop appears, so you can decide to book now or keep watching.",
  },
  {
    q: "Does Fareloop add markup to flight prices?",
    a: "No. Fareloop never adds a booking markup: you pay whatever the airline or partner site charges at checkout. Partner sites control final taxes, baggage rules, and availability, so always review the final itinerary before paying.",
  },
  {
    q: "Are the booking links affiliate links?",
    a: "Yes, some of them are. Fareloop may earn a commission when you open a partner booking page, and it costs you nothing extra. Affiliate revenue keeps the flight finder free and funds route monitoring, price history, and alert tools.",
  },
  {
    q: "Which airlines and routes does Fareloop cover?",
    a: "Fareloop searches popular routes across North America, Europe, the Middle East, Asia, Africa, Oceania, and South America, covering more than 700 airlines across 190+ countries — from New York to London and Dubai to Mumbai to Toronto to Paris and Tokyo to Singapore.",
  },
  {
    q: "How much does Fareloop Premium cost?",
    a: "Premium is $9.99 per month. It unlocks unlimited route tracking, 90-day price history, target-budget alerts, flexible-date deal radar, and priority scans, with no booking markups. You can cancel anytime and keep your saved routes.",
  },
  {
    q: "Is searching flights on Fareloop free?",
    a: "Yes. The flight finder is free to use: search routes, compare fares, sort by cheapest or fastest, and open partner booking pages without paying anything. Premium is optional and only adds tracking, history, and alerts.",
  },
];

const faqJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map(item => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
}).replace(/</g, "\\u003c");

export default function FAQ() {
  return (
    <div className="app-shell">
      <main className="content-wrap" style={{ maxWidth: 1060 }}>
        <header className="page-header">
          <div>
            <p className="eyebrow accent-text">Help center</p>
            <h1 className="page-title">Cheap flights &amp; price-drop alerts: <em>FAQ</em></h1>
            <p className="hero-subtitle">How Fareloop finds lower fares, how alerts work, and what partner booking links mean for you.</p>
          </div>
          <Link className="primary-cta small" href="/">Search flights <ArrowRight size={14} /></Link>
        </header>
        <section className="seo-content" aria-label="Frequently asked questions">
          {FAQ_ITEMS.map(item => (
            <div className="seo-copy" key={item.q}>
              <h2>{item.q}</h2>
              <p>{item.a}</p>
            </div>
          ))}
        </section>
        <footer className="faq-footer">
          <p>Ready to compare fares? <Link href="/">Search cheap flights</Link>, watch a route in the <Link href="/tracker">deal tracker</Link>, see what <Link href="/paywall">Premium</Link> unlocks, or open a <Link href="/flights-to">destination fare guide</Link>.</p>
        </footer>
      </main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqJsonLd }} />
    </div>
  );
}
