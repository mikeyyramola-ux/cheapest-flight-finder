import { ArrowRight } from "lucide-react";
import { Link } from "wouter";

type FaqItem = { q: string; a: string; link?: { href: string; label: string } };

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
  {
    q: "What is the cheapest month to fly?",
    a: "Across most routes, January and February are the cheapest months to fly, with September and October close behind, while July, August, and the December holidays are the priciest. The right month depends on the destination — June is low season in Sydney but peak season in Paris — so check the cheapest-months table for the city you are flying to.",
    link: { href: "/flights-to", label: "cheapest-months table for every city" },
  },
  {
    q: "How do I find flight price drops?",
    a: "Save the route in the Fareloop deal tracker with a target price, then watch its 90-day trend: when the current fare drops meaningfully below the recent reference price, that is the signal to book. Price drops rarely announce themselves, so an alert beats re-checking the same search every day — fares can move while you sleep.",
    link: { href: "/tracker", label: "open the deal tracker" },
  },
  {
    q: "Do flight prices drop closer to the departure date?",
    a: "Usually not. Fares tend to climb in the final weeks before departure as the remaining seats go to travelers with little choice of date. The reliable window is about one to three months out for shorter routes and two to six months for long-haul, with airline seat sales as the main exception — which is exactly what the 90-day trend is there to catch.",
  },
  {
    q: "Which days of the week are the cheapest to fly?",
    a: "Tuesday, Wednesday, and Saturday departures are consistently the cheapest, because business traffic and weekend leisure demand cluster on Monday, Thursday, Friday, and Sunday. The day you fly matters far more than the day you buy, so if your dates are flexible, move the departure itself before anything else.",
  },
  {
    q: "Where can I see the cheapest months to fly for each city?",
    a: "Every destination guide pairs a month-by-month cheapest-window strip with airport notes and a pre-filled search. The strips come from each city's own season notes — nothing is invented — so pick your window there, then confirm the live fare yourself in the flight finder.",
    link: { href: "/flights-to", label: "browse all destination guides" },
  },
];

const faqJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map(item => ({
    "@type": "Question",
    name: item.q,
    // Keep the JSON-LD answer identical to the visible paragraph text (answer + link label).
    acceptedAnswer: { "@type": "Answer", text: item.link ? `${item.a} ${item.link.label}` : item.a },
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
              <p>
                {item.a}
                {item.link && <> <Link href={item.link.href}>{item.link.label}</Link></>}
              </p>
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
