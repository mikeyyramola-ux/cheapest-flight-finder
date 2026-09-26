import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Clock3, Globe2, Wallet } from "lucide-react";

type ProfileKey = "budget" | "nomad" | "timing";

/**
 * Section 22.3 (Cheap Flights): one high-contrast constraint prompt that
 * reshapes into a Travel Hacker Strategy Profile. Zero-database by design —
 * the pick lives in localStorage only, and every number on screen stays one
 * the fare panel actually computed.
 */
const STORAGE_KEY = "fareloop.constraintProfile";

const PROFILES: Record<ProfileKey, {
  pick: string;
  title: string;
  sub: string;
  blurb: string;
  tactics: string[];
  primaryLabel: string;
  primaryKind: "button" | "link";
  primaryHref?: string;
}> = {
  budget: {
    pick: "My budget is tight",
    title: "Budget Saver",
    sub: "Profile · price leads every choice",
    blurb: "You want the lowest total you can actually pay, stops and layovers included.",
    tactics: [
      "Sort every result by Cheapest total so the lowest number surfaces first.",
      "Watch the route in the Deal tracker instead of re-checking fares yourself.",
      "Open the partner page before you pay to confirm the final price and baggage rules.",
    ],
    primaryLabel: "Sort results by cheapest total",
    primaryKind: "button",
  },
  nomad: {
    pick: "I care where I land",
    title: "Destination Nomad",
    sub: "Profile · place leads every choice",
    blurb: "The city matters more than the date — you are picking where, then when.",
    tactics: [
      "Read the cheapest-month guide for a hub before locking any dates.",
      "Swap airports in the search to compare hubs against each other.",
      "Compare the same trip on a partner site to see live availability.",
    ],
    primaryLabel: "Browse destination fare guides",
    primaryKind: "link",
    primaryHref: "/flights-to",
  },
  timing: {
    pick: "My dates are fixed",
    title: "Time Optimizer",
    sub: "Profile · calendar leads every choice",
    blurb: "Your window is set, so the job is reading the fare curve inside it.",
    tactics: [
      "Switch to One way if only one leg fits the calendar, and price each leg alone.",
      "Read the price trend before committing instead of guessing at \"cheap\".",
      "Track the route so a drop reaches you rather than the other way round.",
    ],
    primaryLabel: "Open the deal tracker",
    primaryKind: "link",
    primaryHref: "/tracker",
  },
};

const ORDERED: ProfileKey[] = ["budget", "nomad", "timing"];

/** Fires only on a real user pick — never on render, never on snapshot. */
const emitPick = (profile: ProfileKey) => {
  try {
    const w = window as Window & {
      dataLayer?: Array<Record<string, unknown>>;
      umami?: { track?: (event: string, data?: Record<string, unknown>) => void };
    };
    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push({ event: "constraint_profile", profile });
    w.umami?.track?.("constraint_profile", { profile });
  } catch { /* analytics optional */ }
};

export default function ConstraintCoach({
  partnerHref,
  onSortCheapest,
}: {
  /** Contextual partner link tagged with the profile that selected it. */
  partnerHref: (profile: ProfileKey) => string;
  onSortCheapest: () => void;
}) {
  const [profile, setProfile] = useState<ProfileKey | null>(null);

  // Read after mount only: SSR must render the same prompt markup as the client.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && ORDERED.includes(saved as ProfileKey)) setProfile(saved as ProfileKey);
    } catch { /* storage unavailable */ }
  }, []);

  const pick = (key: ProfileKey) => {
    setProfile(key);
    try { localStorage.setItem(STORAGE_KEY, key); } catch { /* storage unavailable */ }
    emitPick(key);
  };

  const reset = () => {
    setProfile(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  };

  if (!profile) {
    return (
      <section className="constraint-panel" aria-label="Travel hacker strategy">
        <p className="eyebrow accent-text">Travel hacker strategy</p>
        <p className="constraint-prompt">What is your single biggest travel constraint right now?</p>
        <div className="constraint-choices">
          {ORDERED.map(key => {
            const Icon = key === "budget" ? Wallet : key === "nomad" ? Globe2 : Clock3;
            return (
              <button key={key} type="button" className="constraint-choice" onClick={() => pick(key)}>
                <span className="constraint-choice-icon"><Icon size={16} /></span>
                <span>{PROFILES[key].pick}</span>
                <ArrowRight size={14} className="constraint-choice-arrow" />
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  const active = PROFILES[profile];
  const Icon = profile === "budget" ? Wallet : profile === "nomad" ? Globe2 : Clock3;

  return (
    <section className="constraint-panel constraint-panel-filled" aria-label="Your travel hacker strategy profile">
      <div className="constraint-head">
        <span className="constraint-badge"><Icon size={14} /> {active.title}</span>
        <p className="constraint-sub">{active.sub}</p>
        <p className="constraint-blurb">{active.blurb}</p>
      </div>
      <ul className="constraint-tactics">
        {active.tactics.map(tactic => <li key={tactic}>{tactic}</li>)}
      </ul>
      <div className="constraint-actions">
        {active.primaryKind === "button" ? (
          <button type="button" className="constraint-primary" onClick={onSortCheapest}>
            {active.primaryLabel} <ArrowRight size={14} />
          </button>
        ) : (
          <Link href={active.primaryHref ?? "/"} className="constraint-primary">
            {active.primaryLabel} <ArrowRight size={14} />
          </Link>
        )}
        <a href={partnerHref(profile)} target="_blank" rel="noopener noreferrer sponsored" className="constraint-partner">
          Compare live on a partner site <ArrowRight size={14} />
        </a>
        <button type="button" className="constraint-change" onClick={reset}>Change answer</button>
      </div>
      <p className="constraint-note">
        Profile stored on this device only. Partner links may earn Fareloop a commission at no extra cost to you.
      </p>
    </section>
  );
}
