import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { startLogin } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { airportOptions, DESTINATIONS, destinationPath } from "@shared/destinations";
import ConstraintCoach from "./ConstraintCoach";
import { ArrowRight, Bell, CalendarDays, CarFront, Check, ChevronDown, CircleHelp, Clock3, Crown, ExternalLink, Flame, Gauge, Globe2, History, Hotel, Loader2, LockKeyhole, Menu, Plane, Plus, Search, Settings2, ShieldCheck, Sparkles, Trash2, TrendingDown, Users, Wallet, X, Zap } from "lucide-react";

type View = "search" | "tracker" | "history" | "paywall";
type SearchMode = "flights" | "stays" | "cars";
type AppNotification = { id: number; title: string; body: string; time: string; kind: "drop" | "tracker" | "billing" | "system"; unread: boolean };

type LocalOffer = {
  id: string; airline: string; airlineCode: string; origin: string; destination: string; departureDate: string; departureTime: string; arrivalTime: string; duration: string; stops: number; price: number; currency: string; cabin: string; baggage: string; bookingUrl: string; isBest: boolean; layoverCountry?: string;
};

/** Airport list (and destination dataset) lives in @shared/destinations. */

const sampleOffers: LocalOffer[] = [
  { id: "sample-1", airline: "Virgin Atlantic", airlineCode: "VS", origin: "JFK", destination: "LHR", departureDate: "2026-10-29", departureTime: "19:30", arrivalTime: "07:25", duration: "6h 55m", stops: 0, price: 418, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: "https://www.virginatlantic.com/", isBest: true },
  { id: "sample-2", airline: "British Airways", airlineCode: "BA", origin: "JFK", destination: "LHR", departureDate: "2026-10-29", departureTime: "21:10", arrivalTime: "09:00", duration: "6h 50m", stops: 0, price: 447, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: "https://www.britishairways.com/", isBest: false },
  { id: "sample-3", airline: "Iberia", airlineCode: "IB", origin: "JFK", destination: "LHR", departureDate: "2026-10-29", departureTime: "18:05", arrivalTime: "10:15", duration: "10h 10m", stops: 1, price: 389, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: "https://www.iberia.com/", isBest: false },
];

const formatDate = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const durationMinutes = (value: string) => {
  const hours = Number(value.match(/(\d+)h/)?.[1] ?? 0);
  const minutes = Number(value.match(/(\d+)m/)?.[1] ?? 0);
  return hours * 60 + minutes;
};
const affiliateTemplate = ((import.meta.env.VITE_TRAVELPAYOUTS_AFFILIATE_URL as string | undefined)?.trim() || "https://kiwi.tpk.lu/BqdFdqYN");
const staysTemplate = ((import.meta.env.VITE_BOOKING_AFFILIATE_URL as string | undefined)?.trim() || "");
const carsTemplate = ((import.meta.env.VITE_RENTALCARS_AFFILIATE_URL as string | undefined)?.trim() || "");

type SearchContext = { departureDate: string; returnDate: string; passengers: number; tripType: "roundTrip" | "oneWay" };

/** Replace `{placeholders}` in an affiliate URL template. Unknown placeholders stay untouched. */
const fillTemplate = (template: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((url, [key, value]) => url.split(`{${key}}`).join(encodeURIComponent(value)), template);

/** DDMM date digits (Aviasales-style search URLs) from an ISO yyyy-mm-dd date. */
const aviaDate = (iso: string) => {
  const [, month, day] = iso.split("-");
  return month && day ? `${day}${month}` : "";
};

const bookingDestination = (offer: LocalOffer, search: SearchContext) => {
  if (!affiliateTemplate) return offer.bookingUrl;
  return fillTemplate(affiliateTemplate, {
    subid: `faredrop-${offer.origin}-${offer.destination}-${offer.id}`.toLowerCase(),
    origin: offer.origin,
    destination: offer.destination,
    depart: aviaDate(search.departureDate),
    return: search.tripType === "oneWay" ? "" : aviaDate(search.returnDate),
    passengers: String(search.passengers),
  });
};

function AirportField({ label, value, onChange, icon }: { label: string; value: string; onChange: (value: string) => void; icon: "from" | "to" }) {
  const airport = airportOptions.find(item => item.code === value);
  return (
    <label className="airport-field group">
      <span className="field-label">{label}</span>
      <span className="flex items-center gap-3">
        <span className={`field-icon ${icon === "from" ? "from-icon" : "to-icon"}`}>{icon === "from" ? "↗" : "↘"}</span>
        <span className="min-w-0 flex-1">
          <select value={value} onChange={event => onChange(event.target.value)} aria-label={label} className="airport-select">
            {airportOptions.map(item => <option key={item.code} value={item.code}>{item.code} · {item.city}</option>)}
          </select>
          <span className="field-helper truncate">{airport?.airport}</span>
        </span>
      </span>
    </label>
  );
}

function MetricCard({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div><div className="eyebrow">{label}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div></div></div>;
}

function Logo() {
  return <div className="flex items-center gap-3"><div className="logo-mark"><Plane size={18} strokeWidth={2.4} /></div><div className="logo-type">fare<span>drop</span></div></div>;
}

function SearchModeTabs({ mode, onChange }: { mode: SearchMode; onChange: (mode: SearchMode) => void }) {
  return <div className="mode-tabs" role="tablist" aria-label="Travel search type"><button type="button" role="tab" aria-selected={mode === "flights"} className={mode === "flights" ? "active" : ""} onClick={() => onChange("flights")}><Plane size={15} /> Flights</button><button type="button" role="tab" aria-selected={mode === "stays"} className={mode === "stays" ? "active" : ""} onClick={() => onChange("stays")}><Hotel size={15} /> Stays</button><button type="button" role="tab" aria-selected={mode === "cars"} className={mode === "cars" ? "active" : ""} onClick={() => onChange("cars")}><CarFront size={15} /> Cars</button></div>;
}

function PartnerSearchPanel({ mode }: { mode: Exclude<SearchMode, "flights"> }) {
  const [location, setLocation] = useState("");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10));
  const [guests, setGuests] = useState(2);
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (!location.trim()) { toast.error(`Enter a ${mode === "stays" ? "city or hotel" : "pickup city or airport"}`); return; } if (endDate <= startDate) { toast.error("Return date must be after the start date"); return; } const vars = { location: location.trim(), start: startDate, end: endDate, guests: String(guests) }; const query = encodeURIComponent(location.trim()); const url = mode === "stays" ? (staysTemplate ? fillTemplate(staysTemplate, vars) : `https://www.booking.com/searchresults.html?ss=${query}&checkin=${startDate}&checkout=${endDate}&group_adults=${guests}`) : (carsTemplate ? fillTemplate(carsTemplate, vars) : `https://www.rentalcars.com/search-results?location=${query}&startDate=${startDate}&endDate=${endDate}`); window.open(url, "_blank", "noopener,noreferrer"); toast.success(`Opening live ${mode === "stays" ? "stay" : "car rental"} search`, { description: "Results are supplied by the partner site; this app does not invent listings." }); };
  return <form onSubmit={submit} className="partner-search-panel"><div className="partner-live-note"><span className="live-indicator" /> Live partner search · no simulated listings</div><label className="partner-location"><span className="field-label">{mode === "stays" ? "Where are you staying?" : "Pickup location"}</span><input value={location} onChange={event => setLocation(event.target.value)} placeholder={mode === "stays" ? "City, hotel, or landmark" : "City or airport"} /></label><div className="search-fields"><label className="compact-field"><span className="field-label"><CalendarDays size={13} /> Check-in / pickup</span><input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label className="compact-field"><span className="field-label"><CalendarDays size={13} /> Check-out / return</span><input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>{mode === "stays" && <label className="compact-field"><span className="field-label"><Users size={13} /> Guests</span><select value={guests} onChange={event => setGuests(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count} {count === 1 ? "guest" : "guests"}</option>)}</select></label>}<button className="search-button" type="submit">{mode === "stays" ? <Hotel size={18} /> : <CarFront size={18} />}<span>Search {mode === "stays" ? "stays" : "cars"}</span><ExternalLink size={13} /></button></div></form>;
}

function Paywall({ onClose, onUnlock, checkout }: { onClose: () => void; onUnlock: () => void; checkout: () => void }) {
  const benefits = [
    ["Instant price-drop alerts", "Telegram, WhatsApp & email-ready"],
    ["Historical price intelligence", "90-day trend lines and averages"],
    ["Unlimited route tracking", "Watch every trip on your calendar"],
    ["Global fare coverage", "700+ airlines across 190+ countries"],
    ["Flexible-date deal radar", "See cheaper days before you book"],
    ["Smart buy timing", "Know when a fare is in its lowest range"],
    ["Priority scans", "Checked before free-tier routes"],
    ["No booking markups", "Transparent partner-link pricing"],
  ];
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-5" onClick={onClose}><div className="paywall-modal relative w-full max-w-2xl overflow-hidden rounded-t-[28px] sm:rounded-[28px]" onClick={event => event.stopPropagation()}><button onClick={onClose} className="absolute right-5 top-5 z-10 rounded-full bg-white/10 p-2 text-white/70 transition hover:bg-white/20" aria-label="Close paywall"><X size={18} /></button><div className="paywall-orb orb-one" /><div className="paywall-orb orb-two" /><div className="relative p-7 pb-8 sm:p-10"><div className="mb-8 flex items-center justify-between"><div className="logo-mark glow"><Plane size={18} /></div><div className="premium-pill"><Sparkles size={13} /> Premium</div></div><p className="eyebrow accent-text">Your personal fare advantage</p><h2 className="mt-3 max-w-xl text-3xl font-semibold leading-tight tracking-[-0.04em] text-white">Pay less. Travel farther. Never wonder if you booked too soon.</h2><p className="mt-4 max-w-xl text-[15px] leading-6 text-white/60">Premium turns Faredrop into a full-time travel analyst: it watches routes globally, explains the price, and alerts you before a great fare disappears.</p><div className="my-7 grid grid-cols-1 gap-3 sm:grid-cols-2">{benefits.map(([title, detail]) => <div key={title} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[.05] p-3 text-[12px] font-medium text-white/80"><Check size={14} className="mt-0.5 shrink-0 text-[#a8f08a]" /><span><strong className="block text-white">{title}</strong><span className="mt-1 block text-white/40">{detail}</span></span></div>)}</div><div className="rounded-2xl border border-[#b9ff98]/20 bg-[#b9ff98]/[.06] p-4 text-sm text-white/70"><strong className="text-[#b9ff98]">Built for frequent flyers:</strong> one avoided overpay can cover the monthly plan. Cancel anytime and keep your saved routes and history.</div><div className="mt-7 flex flex-col gap-4 border-t border-white/10 pt-5 sm:flex-row sm:items-end sm:justify-between"><div><span className="text-3xl font-semibold text-white">$9.99</span><span className="ml-1 text-sm text-white/45">/ month</span><p className="mt-1 text-[11px] text-white/40">Less than one airport meal per month</p></div><div className="flex w-full flex-col gap-2 sm:w-64"><button onClick={checkout} className="primary-cta flex w-full items-center justify-center gap-2">Start Premium <ArrowRight size={17} /></button><button onClick={onUnlock} className="flex w-full items-center justify-center gap-2 text-xs font-medium text-white/40 transition hover:text-white/70">Explore demo mode <ChevronDown size={14} /></button><button onClick={onClose} className="flex w-full items-center justify-center gap-2 text-xs font-medium text-white/30 transition hover:text-white/60">Maybe later</button></div></div></div></div></div>;
  }

  function FlightCard({ offer, passengers, search, onTrack }: { offer: LocalOffer; passengers: number; search: SearchContext; onTrack: () => void }) {
  const destination = bookingDestination(offer, search);
  const affiliateReady = Boolean(affiliateTemplate);
  const totalPrice = offer.price * passengers;
  return <article className={`flight-card ${offer.isBest ? "best-card" : ""}`}><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className="airline-badge">{offer.airlineCode}</div><div><h3 className="text-sm font-semibold text-white">{offer.airline}</h3><p className="mt-1 text-[11px] text-white/40">{offer.cabin} · {offer.baggage}</p></div></div>{offer.isBest && <span className="deal-badge"><Flame size={12} /> Best value</span>}</div><div className="flight-route"><div><p className="route-time">{offer.departureTime}</p><p className="route-airport">{offer.origin}</p></div><div className="route-line"><span className="route-duration">{offer.duration}</span><span className="route-stroke"><span className="route-dot" /><span className="route-plane"><Plane size={12} /></span><span className="route-dot" /></span><span className="route-stops">{offer.stops === 0 ? "Nonstop" : `${offer.stops} stop${offer.layoverCountry ? ` · via ${offer.layoverCountry}` : " · via major hub"}`}</span></div><div className="text-right"><p className="route-time">{offer.arrivalTime}</p><p className="route-airport">{offer.destination}</p></div></div><div className="mt-5 flex items-center justify-between border-t border-white/[.07] pt-4"><div><span className="price-dollar">$</span><span className="flight-price">{totalPrice.toLocaleString()}</span><span className="price-meta"> for {passengers} {passengers === 1 ? "traveler" : "travelers"}</span></div><div className="flex gap-2"><button onClick={onTrack} className="icon-action" aria-label="Track this route" title="Track this route"><Bell size={16} /></button><a href={destination} target="_blank" rel="noopener noreferrer sponsored" className="book-button" onClick={() => toast(affiliateReady ? "Opening partner booking" : "Opening airline booking", { description: affiliateReady ? "Your route is tagged for affiliate attribution." : "Add your Travelpayouts link to enable commission tracking." })}>{affiliateReady ? "Check fare" : "Book now"} <ExternalLink size={13} /></a></div></div></article>;
}

const widgetSnippet = ((import.meta.env.VITE_TRAVELPAYOUTS_WIDGET_SNIPPET as string | undefined) || "").trim();

function SeoContent() {
  const widgetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const holder = widgetRef.current;
    if (!holder || !widgetSnippet) return;
    // Partner widget must never block first paint: inject after full load, then idle.
    // The snippet itself is inserted verbatim (partner ToS); only timing changes.
    let cancelled = false;
    const inject = () => {
      if (cancelled || !holder.isConnected) return;
      holder.innerHTML = widgetSnippet;
      // innerHTML-injected scripts never execute — replace each with a live script node.
      holder.querySelectorAll("script").forEach(previous => {
        const script = document.createElement("script");
        for (const attribute of Array.from(previous.attributes)) script.setAttribute(attribute.name, attribute.value);
        if (previous.textContent) script.textContent = previous.textContent;
        previous.replaceWith(script);
      });
    };
    const schedule = () => {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void };
      if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(() => inject(), { timeout: 4000 });
      else w.setTimeout(inject, 2500);
    };
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
    return () => { cancelled = true; window.removeEventListener("load", schedule); };
  }, []);
  return <section className="seo-content" aria-label="About Fareloop">
    {widgetSnippet && <div ref={widgetRef} className="tp-widget-slot" />}
    <div className="seo-copy">
      <p className="eyebrow accent-text">A calmer way to book</p>
      <h2>How Fareloop finds better flight prices</h2>
      <p>Fareloop is a flight price-drop alert service for travelers who care about the lowest practical fare, not just the fastest search result. Search a route between major airports, compare fares by total price and journey time, then save the trips you may book later. Fareloop keeps the search experience simple while giving you useful context: current fare, recent route averages, potential savings, stops, baggage, and the airlines selling each option.</p>
      <p>The free flight finder is designed for quick decisions. It covers popular airports across North America, Europe, the Middle East, Asia, Africa, Oceania, and South America, with routes such as New York to London, Dubai to Mumbai, Toronto to Paris, and Tokyo to Singapore. Choose a return or one-way trip, adjust travelers, sort by cheapest total or fastest journey, and open a partner booking page when you are ready to compare the live offer.</p>
    </div>
    <div className="seo-copy">
      <h2>Pricing and price-drop alerts</h2>
      <p>Fareloop Premium is built for travelers who want to watch a route instead of checking it manually every day. Premium members can save routes, review historical price trends, compare a target budget with the route average, and receive alerts when a meaningful drop is detected. The monthly plan is $9.99, with no booking markup from Fareloop. Partner sites may change availability, taxes, baggage rules, and final prices, so always review the final itinerary before paying.</p>
      <p>Notifications are designed to make timing easier: when a saved fare reaches your target or falls materially below its recent reference price, Fareloop can surface the signal in the tracker. This helps you decide whether to book now, keep watching, or choose a flexible date.</p>
    </div>
    <div className="seo-copy">
      <h2>Supported routes and travel modes</h2>
      <p>Use Flights for global route discovery, Stays for live hotel searches, and Cars for live rental searches. Fareloop does not invent hotel or car inventory: those searches open partner results with your location and dates. Flight booking links may be affiliate links, which means Fareloop can earn a commission if you book through a partner at no additional cost to you. That revenue helps support route coverage, monitoring, and future fare tools.</p>
    </div>
    <div className="seo-copy">
      <h2>Cheapest months to fly</h2>
      <p>
        Fares follow the calendar: the shoulder months between peak season and school holidays are almost always cheaper than July, August, and the
        December–January weeks — but the right window flips with the hemisphere, since June is low season in Sydney and high season in Paris. Each
        Fareloop guide publishes an honest month-by-month cheapest-window strip for its city:{" "}
        {DESTINATIONS.slice(8, 14).map((dest, index) => (
          <span key={dest.slug}>
            <Link href={destinationPath(dest.slug)}>flights to {dest.city}</Link>
            {index < 5 ? " · " : ""}
          </span>
        ))}{" "}
        — then work flexibly inside that window: shifting a trip by two or three days within the cheapest months is the simplest date-flex move, and the
        route's 90-day trend tells you when to actually book. See the <Link href="/flights-to">cheapest-months table for every destination</Link>.
      </p>
    </div>
    <div className="seo-copy">
      <h2>Plan smarter with Fareloop guides</h2>
      <p>New to fare tracking? Read the <Link href="/faq">cheap flights FAQ</Link> for how price-drop alerts work, open the <Link href="/tracker">deal tracker</Link> to watch a route, or see what <Link href="/paywall">Fareloop Premium</Link> unlocks. Searching stays free — start with a popular route like New York to London.</p>
      <p>
        Planning a specific trip? Open a destination fare guide:{" "}
        {DESTINATIONS.slice(0, 8).map((dest, index) => (
          <span key={dest.slug}>
            <Link href={destinationPath(dest.slug)}>flights to {dest.city}</Link>
            {index < 7 ? " · " : ""}
          </span>
        ))}{" "}
        — or browse <Link href="/flights-to">all {DESTINATIONS.length} destinations</Link>.
      </p>
    </div>
  </section>;
}

function PriceChart({ origin, destination }: { origin: string; destination: string }) {
  const historyQuery = trpc.flights.history.useQuery({ origin, destination });
  const points = historyQuery.data?.points ?? [{ date: "Week 1", price: 650 }, { date: "Week 2", price: 610 }, { date: "Week 3", price: 590 }, { date: "Week 4", price: 560 }, { date: "Week 5", price: 520 }, { date: "Now", price: 418 }];
  const max = Math.max(...points.map(point => point.price));
  const min = Math.min(...points.map(point => point.price));
  const polyline = points.map((point, index) => `${(index / (points.length - 1)) * 100},${12 + ((point.price - min) / Math.max(max - min, 1)) * 64}`).join(" ");
  return <div className="chart-card"><div className="flex items-start justify-between"><div><p className="eyebrow">Price trend</p><h3 className="mt-1 text-base font-semibold text-white">{origin} → {destination}</h3></div><div className="text-right"><p className="text-lg font-semibold text-white">${points[points.length - 1]?.price}</p><p className="text-[11px] font-medium text-[#a8f08a]">↓ 22% this month</p></div></div><div className="chart-wrap"><div className="chart-grid"><span /><span /><span /><span /></div><svg viewBox="0 0 100 88" preserveAspectRatio="none" className="price-chart"><defs><linearGradient id="price-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#bcff9b" stopOpacity=".24" /><stop offset="1" stopColor="#bcff9b" stopOpacity="0" /></linearGradient></defs><polygon points={`0,88 ${polyline} 100,88`} fill="url(#price-fill)" /><polyline points={polyline} fill="none" stroke="#b9ff98" strokeWidth="1.7" vectorEffect="non-scaling-stroke" /></svg></div><div className="mt-2 flex justify-between text-[10px] text-white/30"><span>{points[0]?.date}</span><span>{points[Math.floor(points.length / 2)]?.date}</span><span>{points[points.length - 1]?.date}</span></div></div>;
}

const InteractivePriceChart = lazy(() => import("./InteractivePriceChart"));


export default function Home() {
  const { user } = useAuth();
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "search";
    return window.location.pathname === "/paywall" ? "paywall" : window.location.pathname === "/tracker" ? "tracker" : "search";
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [origin, setOrigin] = useState("JFK");
  const [destination, setDestination] = useState("LHR");
  const [searchMode, setSearchMode] = useState<SearchMode>("flights");
  const [tripType, setTripType] = useState<"roundTrip" | "oneWay">("roundTrip");
  const [departureDate, setDepartureDate] = useState("2026-10-29");
  const [returnDate, setReturnDate] = useState("2026-11-05");
  const [passengers, setPassengers] = useState(1);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const paywallPushedRef = useRef(false);
  const closePaywall = () => {
    setPaywallOpen(false);
    if (paywallPushedRef.current) {
      paywallPushedRef.current = false;
      history.back();
    }
  };
  // Back must dismiss the paywall before it leaves the site: push a history
  // entry while the modal is open and treat popstate/Escape/backdrop as close.
  useEffect(() => {
    if (!paywallOpen) return;
    history.pushState({ ...(history.state || {}), farePaywall: true }, "");
    paywallPushedRef.current = true;
    const onPopState = () => {
      if (paywallPushedRef.current) {
        paywallPushedRef.current = false;
        setPaywallOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPaywallOpen(false);
      if (paywallPushedRef.current) {
        paywallPushedRef.current = false;
        history.back();
      }
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [paywallOpen]);
  const [isPremiumDemo, setIsPremiumDemo] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertChannel, setAlertChannel] = useState<"Telegram" | "WhatsApp">("Telegram");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([
    { id: 1, title: "Price drop detected", body: "JFK → LHR is now $418, 22% below its route average.", time: "12 min ago", kind: "drop", unread: true },
    { id: 2, title: "Tracker scan complete", body: "Your saved routes were checked and are still being watched.", time: "12 min ago", kind: "tracker", unread: true },
    { id: 3, title: "Welcome to faredrop", body: "Search flights free and turn on alerts when you find a route worth watching.", time: "Today", kind: "system", unread: false },
  ]);
  const [selectedTrackerRouteId, setSelectedTrackerRouteId] = useState("");

  const [sortMode, setSortMode] = useState<"cheapest" | "fastest">("cheapest");
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const savedSort = localStorage.getItem("fareloop.sortMode");
      if (savedSort === "cheapest" || savedSort === "fastest") setSortMode(savedSort);
      const savedChannel = localStorage.getItem("fareloop.alertChannel");
      if (savedChannel === "Telegram" || savedChannel === "WhatsApp") setAlertChannel(savedChannel);
    } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => { try { localStorage.setItem("fareloop.sortMode", sortMode); } catch { /* ignore */ } }, [sortMode]);
  const searchMutation = trpc.flights.search.useMutation({ onSuccess: data => toast.success(`${data.offers.length} ${data.source === "amadeus-ready" ? "" : "seed "}fares found`, { description: data.source === "amadeus-ready" ? `Live fares${data.cached ? " · five-minute cache" : ""}` : "Demo fares — seed data, no live airline quotes yet" }) });
  const trackerQuery = trpc.tracker.list.useQuery();
  const addRoute = trpc.tracker.add.useMutation({ onSuccess: () => { trackerQuery.refetch(); toast.success("Route added to your tracker", { description: "We’ll keep watching for a better fare." }); } });
  const removeRoute = trpc.tracker.remove.useMutation({ onSuccess: () => { trackerQuery.refetch(); toast.success("Route removed"); } });
  const scanRoutes = trpc.tracker.scan.useMutation({ onSuccess: data => { trackerQuery.refetch(); toast.success(`${data.notifications.length} alert${data.notifications.length === 1 ? "" : "s"} sent`, { description: "Scanner completed just now" }); } });
  const checkout = trpc.billing.checkout.useMutation({ onSuccess: data => { if (data.url?.startsWith("http")) window.open(data.url, "_blank"); else closePaywall(); toast.success(data.mode === "demo" ? "Demo premium unlocked" : "Opening secure Stripe Checkout"); } });

  const rawOffers = (searchMutation.data?.offers ?? sampleOffers) as LocalOffer[];
  const offers = useMemo(() => [...rawOffers].sort((a, b) => sortMode === "cheapest" ? a.price - b.price : durationMinutes(a.duration) - durationMinutes(b.duration)), [rawOffers, sortMode]);
  const searchSummary = `${origin} → ${destination}`;
  const trackerRoutes = trackerQuery.data?.routes ?? [];
  const affiliateReady = Boolean(affiliateTemplate);
  const fareMetrics = useMemo(() => {
    const prices = offers.map(offer => offer.price);
    const cheapest = prices.length ? Math.min(...prices) : 0;
    const marketAverage = prices.length ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length) : 0;
    return {
      cheapestTotal: cheapest * passengers,
      marketAverageTotal: marketAverage * passengers,
      averageSavings: Math.max(0, Math.round((marketAverage - cheapest) * passengers)),
      bestDrop: marketAverage > 0 ? Math.max(0, Math.round((1 - cheapest / marketAverage) * 100)) : 0,
    };
  }, [offers, passengers]);
  const trackerSavings = useMemo(() => trackerRoutes.reduce((sum, route) => sum + Math.max(0, route.historicalAverage - route.currentPrice), 0), [trackerRoutes]);
  const selectedHistory = useMemo(() => ({ origin: trackerRoutes[0]?.origin ?? origin, destination: trackerRoutes[0]?.destination ?? destination }), [trackerRoutes, origin, destination]);
  const selectedTrackerRoute = trackerRoutes.find(route => route.id === selectedTrackerRouteId) ?? trackerRoutes[0];

  const performSearch = (event?: React.FormEvent) => { event?.preventDefault(); searchMutation.mutate({ origin, destination, departureDate, returnDate: tripType === "oneWay" ? "" : returnDate, passengers, tripType }); };
  const applyTripType = (next: "roundTrip" | "oneWay") => {
    if (next === tripType) return;
    setTripType(next);
    searchMutation.mutate({ origin, destination, departureDate, returnDate: next === "oneWay" ? "" : returnDate, passengers, tripType: next });
    toast(next === "oneWay" ? "One-way fares loading" : "Round-trip fares loading", { description: next === "oneWay" ? "Return leg removed — fares re-checked for one-way travel." : `Return leg ${formatDate(returnDate)} — fares re-checked for round-trip travel.` });
  };
  // Prefill the search from ?from= / ?to= query params (used by /flights-to/:slug CTAs)
  // and kick off a live search when a valid code arrives.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const codes = new Set(airportOptions.map(item => item.code));
    const from = (params.get("from") || "").toUpperCase();
    const to = (params.get("to") || "").toUpperCase();
    const nextOrigin = from && codes.has(from) ? from : "JFK";
    const nextDestination = to && codes.has(to) ? to : "LHR";
    if (nextOrigin !== "JFK") setOrigin(nextOrigin);
    if (nextDestination !== "LHR") setDestination(nextDestination);
    if (nextOrigin !== "JFK" || nextDestination !== "LHR") {
      searchMutation.mutate({ origin: nextOrigin, destination: nextDestination, departureDate: "2026-10-29", returnDate: "2026-11-05", passengers: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const requestPremium = () => { if (!isPremiumDemo) setPaywallOpen(true); else setView("tracker"); };
  const addTracked = (offerOrigin = origin, offerDestination = destination) => { if (!isPremiumDemo) return setPaywallOpen(true); addRoute.mutate({ origin: offerOrigin, destination: offerDestination, departDate: departureDate, returnDate, targetPrice: Math.round((offers[0]?.price ?? 450) * .95), alertChannel }); };
  const openCheckout = () => checkout.mutate({ route: searchSummary });

  return <div className="app-shell"><aside className={`app-sidebar ${mobileNavOpen ? "mobile-open" : ""}`}><div className="sidebar-top"><Logo /><button className="mobile-close" onClick={() => setMobileNavOpen(false)} aria-label="Close menu"><X size={18} /></button></div><div className="sidebar-section"><p className="sidebar-label">Workspace</p><button onClick={() => { setView("search"); setMobileNavOpen(false); }} className={`nav-item ${view === "search" ? "active" : ""}`}><Search size={17} /><span>Find flights</span>{view === "search" && <span className="nav-active-dot" />}</button><button onClick={() => { setView("tracker"); setMobileNavOpen(false); }} className={`nav-item ${view === "tracker" ? "active" : ""}`}><Bell size={17} /><span>Deal tracker</span><span className="nav-count">{trackerRoutes.length}</span></button><button onClick={() => { if (!isPremiumDemo) setPaywallOpen(true); else { setView("history"); setMobileNavOpen(false); } }} className={`nav-item ${view === "history" ? "active" : ""}`}><History size={17} /><span>Price history</span>{!isPremiumDemo && <LockKeyhole size={13} className="ml-auto text-white/30" />}</button></div><div className="sidebar-section sidebar-lower"><p className="sidebar-label">Your plan</p><div className="plan-card"><div className="flex items-start justify-between"><div className="plan-icon"><Crown size={15} /></div>{isPremiumDemo ? <span className="status-live">ACTIVE</span> : <span className="status-free">FREE</span>}</div><p className="mt-3 text-sm font-semibold text-white">{isPremiumDemo ? "Premium member" : "Free explorer"}</p><p className="mt-1 text-[11px] leading-4 text-white/40">{isPremiumDemo ? "Your routes are being watched." : "Search unlimited flights for free."}</p>{!isPremiumDemo && <button onClick={() => setPaywallOpen(true)} className="upgrade-link">Upgrade now <ArrowRight size={13} /></button>}</div><button onClick={() => setSettingsOpen(true)} className="nav-item muted"><Settings2 size={17} /><span>Settings</span></button><button onClick={() => setHelpOpen(true)} className="nav-item muted"><CircleHelp size={17} /><span>Help center</span></button></div><div className="sidebar-footer"><div className="avatar">{user?.name?.slice(0, 1).toUpperCase() ?? "J"}</div><div className="min-w-0"><p className="truncate text-xs font-semibold text-white/80">{user?.name ?? "Mikeyy Ramola"}</p><p className="truncate text-[10px] text-white/35">{user?.email ?? "mikeyyramola@gmail.com"}</p></div><ChevronDown size={14} className="ml-auto text-white/30" /></div></aside><main className="main-area"><header className="topbar"><button className="mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open menu"><Menu size={21} /></button><div className="topbar-context"><span className="context-dot" /> {view === "search" ? "Flight search" : view === "tracker" ? "Deal tracker" : view === "history" ? "Price history" : "Premium"}</div><div className="topbar-actions"><button onClick={() => { setNotificationsOpen(open => !open); setNotifications(items => items.map(item => ({ ...item, unread: false }))); }} className="top-icon" aria-label="Open notifications" aria-expanded={notificationsOpen}><Bell size={17} />{notifications.some(item => item.unread) && <span className="notification-dot" />}</button><button onClick={() => setPaywallOpen(true)} className="top-premium"><Sparkles size={13} /> <span>Go premium</span></button></div></header><div className="content-wrap">{view === "search" && <><section className="hero-section"><div className="hero-copy"><p className="eyebrow accent-text"><span className="pulse-dot" /> Smarter ways to fly</p><h1>Catch the <em>drop.</em><br />Keep the <span>trip.</span></h1><p className="hero-subtitle">Find the lowest fare across 700+ airlines and 190+ countries and get the signal when it’s time to book.</p></div><div className="hero-art"><div className="globe-ring ring-one" /><div className="globe-ring ring-two" /><div className="globe-core"><Globe2 size={52} strokeWidth={1.1} /></div><div className="orbit-chip chip-one"><TrendingDown size={13} /> 22% lower</div><div className="orbit-chip chip-two"><span className="mini-plane"><Plane size={12} /></span> JFK → LHR</div></div></section><ConstraintCoach partnerHref={profile => fillTemplate(affiliateTemplate, { subid: `faredrop-profile-${profile}-${origin}-${destination}`.toLowerCase(), origin, destination, depart: aviaDate(departureDate), return: tripType === "oneWay" ? "" : aviaDate(returnDate), passengers: String(passengers) })} onSortCheapest={() => { setSortMode("cheapest"); toast.success("Sorted by cheapest total", { description: "Your default sort is saved on this device." }); }} /><SearchModeTabs mode={searchMode} onChange={setSearchMode} />{searchMode === "flights" ? <form onSubmit={performSearch} className="search-panel"><div className="search-head"><div><p className="eyebrow">Search the world</p><p className="search-title">Where do you want to go?</p></div><button type="button" onClick={() => { const current = origin; setOrigin(destination); setDestination(current); }} className="swap-button" aria-label="Swap airports"><ArrowRight size={15} /></button></div><div className="trip-toggle" role="group" aria-label="Trip type"><button type="button" className={tripType === "roundTrip" ? "active" : ""} onClick={() => applyTripType("roundTrip")}>Return</button><button type="button" className={tripType === "oneWay" ? "active" : ""} onClick={() => applyTripType("oneWay")}>One way</button></div><div className="airport-grid"><AirportField label="Flying from" value={origin} onChange={setOrigin} icon="from" /><AirportField label="Flying to" value={destination} onChange={setDestination} icon="to" /></div><div className="search-fields"><label className="compact-field"><span className="field-label"><CalendarDays size={13} /> Departure</span><input type="date" value={departureDate} onChange={event => setDepartureDate(event.target.value)} /></label><label className="compact-field"><span className="field-label"><CalendarDays size={13} /> Return</span><input type="date" disabled={tripType === "oneWay"} value={returnDate} onChange={event => setReturnDate(event.target.value)} /></label><label className="compact-field"><span className="field-label"><Users size={13} /> Travelers</span><select value={passengers} onChange={event => setPassengers(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count} {count === 1 ? "traveler" : "travelers"}</option>)}</select></label><button disabled={searchMutation.isPending} className="search-button" type="submit">{searchMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}<span>Search fares</span></button></div></form> : <PartnerSearchPanel mode={searchMode} />}<section className="metric-grid"><MetricCard icon={<TrendingDown size={17} />} label="Avg. savings" value={`$${fareMetrics.averageSavings.toLocaleString()}`} detail="vs. market average" tone="mint" /><MetricCard icon={<Gauge size={17} />} label="Routes watched" value={String(trackerRoutes.length).padStart(2, "0")} detail="across 190+ countries" tone="violet" /><MetricCard icon={<Zap size={17} />} label="Best drop today" value={`−${fareMetrics.bestDrop}%`} detail={searchSummary} tone="amber" /></section><section className="results-section"><div className="affiliate-trust-row"><span className="affiliate-trust-dot" /> <span>{affiliateReady ? "Partner booking links enabled" : "Transparent booking links"}</span><span className="affiliate-trust-separator">·</span><span>Prices may change at the partner site</span></div><div className="section-heading"><div><p className="eyebrow">Curated for you</p><h2>Lowest fares <span>right now</span></h2><p className="mt-2 text-xs text-white/40">Longer journeys and smart stopovers included when they save you money.</p></div><div className="results-meta"><span className="live-indicator" /> {searchMutation.data?.source === "amadeus-ready" ? "Live data" : "Seed data (demo)"} · {searchSummary} · {tripType === "oneWay" ? "One way" : `Round trip · return ${formatDate(returnDate)}`} · {airportOptions.length} global hubs</div></div><div className="results-toolbar"><span className="eyebrow">Prioritize</span><div className="sort-toggle" role="group" aria-label="Sort flight results"><button type="button" onClick={() => setSortMode("cheapest")} className={sortMode === "cheapest" ? "active" : ""}>Cheapest total</button><button type="button" onClick={() => setSortMode("fastest")} className={sortMode === "fastest" ? "active" : ""}>Fastest</button></div><span className="text-[11px] text-white/35">Cheapest includes 1+ stop options</span></div><div className="results-layout"><div className="results-list">{offers.map(offer => <FlightCard key={offer.id} offer={offer} passengers={passengers} search={{ departureDate, returnDate, passengers, tripType }} onTrack={() => addTracked(offer.origin, offer.destination)} />)}</div><aside className="side-stack"><div className="insight-card"><div className="flex items-start justify-between"><div className="insight-icon"><Sparkles size={16} /></div><span className="insight-tag">AI INSIGHT</span></div><h3>Good time to book</h3><p>Fares on this route are <strong>{fareMetrics.bestDrop}% below</strong> the current market average for {passengers} {passengers === 1 ? "traveler" : "travelers"}. This is in the lowest 15% of prices we’ve seen.</p><div className="insight-meter"><span style={{ width: `${Math.min(96, Math.max(18, 50 + fareMetrics.bestDrop))}%` }} /></div><div className="flex justify-between text-[10px] text-white/35"><span>Higher</span><span>Current fare</span><span>Lower</span></div></div><PriceChart origin={selectedHistory.origin} destination={selectedHistory.destination} /><button onClick={() => requestPremium()} className="trend-lock-card"><div className="trend-lock-icon"><History size={16} /></div><div><p className="text-xs font-semibold text-white">See the full price history</p><p className="mt-1 text-[11px] text-white/40">Unlock 12 months of route trends</p></div><LockKeyhole size={15} className="ml-auto text-white/30" /></button></aside></div></section></>}{view === "tracker" && <section className="page-section"><div className="page-header"><div><p className="eyebrow accent-text">Always on your side</p><h1 className="page-title">Deal <em>tracker</em></h1><p className="page-description">Set a budget, then let faredrop watch the route while you get on with your day.</p></div><button onClick={() => addTracked()} className="primary-cta small"><Plus size={16} /> Add a route</button></div><div className="tracker-summary"><MetricCard icon={<Bell size={17} />} label="Active alerts" value={String(trackerRoutes.filter(route => route.status === "alert").length).padStart(2, "0")} detail="ready to send" tone="mint" /><MetricCard icon={<TrendingDown size={17} />} label="Routes watched" value={String(trackerRoutes.length).padStart(2, "0")} detail="updated 12 min ago" tone="violet" /><MetricCard icon={<Wallet size={17} />} label="Potential savings" value={`$${trackerSavings.toLocaleString()}`} detail="on your routes" tone="amber" /></div><div className="tracker-chart-shell">{selectedTrackerRoute ? <><div className="tracker-chart-controls"><div><p className="eyebrow">Price history</p><h2 className="text-xl font-semibold text-white">How the fare is moving</h2></div><label className="route-select-wrap"><span>Viewing</span><select value={selectedTrackerRoute.id} onChange={event => setSelectedTrackerRouteId(event.target.value)}>{trackerRoutes.map(route => <option key={route.id} value={route.id}>{route.origin} → {route.destination}</option>)}</select></label></div><Suspense fallback={<div className="chart-card">Loading route chart…</div>}><InteractivePriceChart origin={selectedTrackerRoute.origin} destination={selectedTrackerRoute.destination} targetPrice={selectedTrackerRoute.targetPrice} currentPrice={selectedTrackerRoute.currentPrice} /></Suspense></> : <div className="empty-chart-state"><TrendingDown size={18} /><div><p className="text-sm font-semibold text-white">Add a route to unlock price history</p><p className="mt-1 text-xs text-white/40">We’ll build a trend line as your fare data accumulates.</p></div></div>}</div><div className="tracker-toolbar"><div><p className="eyebrow">Your routes</p><h2 className="text-xl font-semibold text-white">Watching for a better price</h2></div><button onClick={() => scanRoutes.mutate()} disabled={scanRoutes.isPending} className="scan-button">{scanRoutes.isPending ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Scan now</button></div><div className="tracker-list">{trackerRoutes.map(route => <article className="tracker-row" key={route.id}><div className="tracker-route-mark"><Plane size={17} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-white">{route.origin} <span className="text-white/30">→</span> {route.destination}</h3><span className={route.status === "alert" ? "alert-pill" : "watching-pill"}>{route.status === "alert" ? <><TrendingDown size={11} /> Price drop</> : <><Clock3 size={11} /> Watching</>}</span></div><p className="mt-1 text-[11px] text-white/40">{formatDate(route.departDate)} — {formatDate(route.returnDate)} · Target ${route.targetPrice} · {route.alertChannel}</p></div><div className="tracker-price"><p className="text-lg font-semibold text-white">${route.currentPrice}</p><p className={route.status === "alert" ? "text-[11px] font-semibold text-[#a8f08a]" : "text-[11px] text-white/35"}>{route.status === "alert" ? `${Math.round((1 - route.currentPrice / route.historicalAverage) * 100)}% below avg.` : `avg. $${route.historicalAverage}`}</p></div><button onClick={() => removeRoute.mutate({ id: route.id })} className="delete-action" aria-label="Remove route"><Trash2 size={15} /></button></article>)}</div><div className="tracker-footer-note"><ShieldCheck size={16} /><p>Last scan completed 12 minutes ago. Your routes are checked every 12 hours in the background.</p></div></section>}{view === "history" && <section className="page-section"><div className="page-header"><div><p className="eyebrow accent-text">Know before you go</p><h1 className="page-title">Price <em>history</em></h1><p className="page-description">Context turns a cheap fare into a confident decision.</p></div><div className="premium-pill"><Sparkles size={13} /> Premium</div></div><div className="history-grid"><div className="history-main"><PriceChart origin={selectedHistory.origin} destination={selectedHistory.destination} /><div className="history-insights"><div className="history-insight"><TrendingDown size={17} className="text-[#a8f08a]" /><div><p className="eyebrow">Current position</p><p className="mt-1 text-sm font-semibold text-white">Lower than 84% of fares</p></div></div><div className="history-insight"><CalendarDays size={17} className="text-[#bda8ff]" /><div><p className="eyebrow">Best time to book</p><p className="mt-1 text-sm font-semibold text-white">Tuesday · 5–7 weeks out</p></div></div></div></div><div className="trend-explain"><div className="insight-icon"><Gauge size={16} /></div><p className="eyebrow">Fare intelligence</p><h3>Make the move when the line turns green.</h3><p>Our history model compares today’s fare with rolling route averages so you can see whether “cheap” is actually cheap.</p><button onClick={() => setView("tracker")} className="upgrade-link">Track this route <ArrowRight size={13} /></button></div></div></section>}{view === "paywall" && <section className="page-section"><div className="page-header"><div><p className="eyebrow accent-text">One small upgrade</p><h1 className="page-title">Fly <em>smarter.</em></h1><p className="page-description">Everything you need to know when a fare deserves a yes.</p></div></div><div className="pricing-card"><div><div className="premium-pill"><Sparkles size={13} /> Premium member</div><h2 className="mt-5 text-3xl font-semibold tracking-[-.04em] text-white">The best fare is the one you don’t miss.</h2><p className="mt-3 max-w-md text-sm leading-6 text-white/45">Upgrade once. Get price-drop alerts, historical context, and unlimited tracking for every trip on your calendar.</p></div><div className="pricing-side"><div><span className="text-4xl font-semibold text-white">$9.99</span><span className="text-sm text-white/40"> / month</span></div><button onClick={openCheckout} className="primary-cta mt-5 w-full justify-center">Activate Premium <ArrowRight size={16} /></button></div></div></section>}</div><SeoContent /><nav className="mobile-bottom-nav"><button onClick={() => setView("search")} className={view === "search" ? "selected" : ""}><Search size={18} /><span>Search</span></button><button onClick={() => setView("tracker")} className={view === "tracker" ? "selected" : ""}><Bell size={18} /><span>Tracker</span></button><button onClick={() => isPremiumDemo ? setView("history") : setPaywallOpen(true)} className={view === "history" ? "selected" : ""}><History size={18} /><span>History</span></button><button onClick={() => setPaywallOpen(true)} className={view === "paywall" ? "selected" : ""}><Crown size={18} /><span>Premium</span></button></nav></main>{notificationsOpen && <div className="notification-layer"><button className="notification-backdrop" aria-label="Close notifications" onClick={() => setNotificationsOpen(false)} /><aside className="notification-drawer" role="dialog" aria-label="Notifications"><div className="notification-drawer-head"><div><p className="eyebrow accent-text">Your inbox</p><h2>Notifications</h2></div><button onClick={() => setNotificationsOpen(false)} className="notification-close" aria-label="Close notifications"><X size={17} /></button></div><div className="notification-list">{notifications.map(item => <button key={item.id} className={`notification-item ${item.unread ? "unread" : ""}`} onClick={() => { setNotifications(items => items.map(current => current.id === item.id ? { ...current, unread: false } : current)); if (item.kind === "drop" || item.kind === "tracker") setView("tracker"); toast(item.title, { description: item.body }); setNotificationsOpen(false); }}><span className={`notification-kind ${item.kind}`}><Bell size={15} /></span><span className="notification-copy"><strong>{item.title}</strong><span>{item.body}</span><small>{item.time}</small></span>{item.unread && <i className="notification-unread" />}</button>)}</div><div className="notification-footer"><button onClick={() => { setNotifications([]); toast.success("Notifications cleared"); }} className="notification-clear">Clear all</button><button onClick={() => { setNotificationsOpen(false); setSettingsOpen(true); }} className="notification-settings"><Settings2 size={13} /> Preferences</button></div></aside></div>}{paywallOpen && <Paywall onClose={closePaywall} onUnlock={() => { setIsPremiumDemo(true); closePaywall(); toast.success("Premium demo unlocked", { description: "Price history and alerts are now available." }); }} checkout={openCheckout} />}{helpOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-5"><div className="support-modal relative w-full max-w-md rounded-t-[26px] p-7 sm:rounded-[26px]"><button onClick={() => setHelpOpen(false)} className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white/70" aria-label="Close help"><X size={17} /></button><div className="support-icon"><CircleHelp size={20} /></div><p className="eyebrow accent-text mt-5">Help & customer care</p><h2 className="mt-2 text-2xl font-semibold tracking-[-.04em] text-white">We’re here to help.</h2><p className="mt-3 text-sm leading-6 text-white/50">Questions about a fare, alerts, billing, or your account? Send us a note and our customer care team will get back to you.</p><div className="support-contact"><div><p className="eyebrow">Customer care email</p><a href="mailto:mikeyyramola@gmail.com" className="support-email">mikeyyramola@gmail.com</a></div><a href="mailto:mikeyyramola@gmail.com" className="support-send">Email us <ArrowRight size={14} /></a></div><button onClick={() => setHelpOpen(false)} className="support-close">Close</button></div></div>}{settingsOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-5" onClick={() => setSettingsOpen(false)}><div className="support-modal relative w-full max-w-md rounded-t-[26px] p-7 sm:rounded-[26px]" onClick={event => event.stopPropagation()}><button onClick={() => setSettingsOpen(false)} className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white/70" aria-label="Close settings"><X size={17} /></button><div className="support-icon"><Settings2 size={20} /></div><p className="eyebrow accent-text mt-5">Settings</p><h3 className="mt-1 text-lg font-semibold text-white">Search &amp; alert defaults</h3><div className="mt-5 flex flex-col gap-4"><label className="compact-field"><span className="field-label"><Gauge size={13} /> Default sort</span><select value={sortMode} onChange={event => { const value = event.target.value as "cheapest" | "fastest"; setSortMode(value); toast.success(`Default sort: ${value === "cheapest" ? "Cheapest total" : "Fastest"}`); }}><option value="cheapest">Cheapest total</option><option value="fastest">Fastest</option></select></label><label className="compact-field"><span className="field-label"><Bell size={13} /> Alert channel for new routes</span><select value={alertChannel} onChange={event => { const value = event.target.value as "Telegram" | "WhatsApp"; setAlertChannel(value); try { localStorage.setItem("fareloop.alertChannel", value); } catch { /* ignore */ } toast.success(`Alert channel: ${value}`); }}><option value="Telegram">Telegram</option><option value="WhatsApp">WhatsApp</option></select></label></div><p className="mt-4 text-[11px] leading-4 text-white/40">Saved on this device. New searches sort by your default and new tracked routes alert on your channel.</p><button onClick={() => setSettingsOpen(false)} className="support-close mt-5">Done</button></div></div>}</div>;
}
