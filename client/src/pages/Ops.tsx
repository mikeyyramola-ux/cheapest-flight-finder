import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, Check, KeyRound, Lock, Radar, RefreshCw, ShieldCheck } from "lucide-react";

/**
 * Operator view of every cloud service Fareloop depends on, and how much of each
 * allowance is already spent.
 *
 * It exists because each ceiling used to live in a different place: supplier credits
 * in the credit ledger, database storage in TiDB's console, hosting limits in Vercel's
 * dashboard. Nothing failed gradually - each one simply ran out somewhere we were not
 * looking. One frame, one vocabulary for provenance, and a row for every gap we cannot
 * yet measure is the difference between a warning and a surprise.
 *
 * Labels are all served from the API. This file deliberately contains no vendor name
 * of its own: the supplier shown is whatever the ledger reports, so the page can never
 * drift from the record that backs it.
 */

const ENDPOINT = "/api/ops/quotas";
const STORAGE_KEY = "fareloop.ops.key";

/** State colours, matched to the site's palette: green is fine, amber is the 75% line. */
const TONE = {
  ok: "#b9ff98",
  warn: "#f5b74e",
  exhausted: "#ff6b6b",
  nofeed: "#6f7488",
  noquota: "#8b8fa3",
} as const;

type RowState = keyof typeof TONE;

type CloudRow = {
  key: string;
  service: string;
  category: "supplier" | "hosting" | "database" | "payments";
  metric: string;
  unit: string;
  limit: number | null;
  period: "month" | "lifetime" | "day" | "standing" | null;
  used: number | null;
  percent: number | null;
  warn: boolean;
  exhausted: boolean;
  wired: boolean;
  feed: "ledger" | "sql" | "none";
  source: "database" | "instance-memory" | "none";
  limitSource: string;
  note: string | null;
};

type Board = {
  ok: boolean;
  generatedAt: string;
  warnPercent: number;
  summary: { total: number; monitored: number; blindSpots: number; warn: number; exhausted: number; unwired: number };
  services: CloudRow[];
};

const FEED_LABEL: Record<CloudRow["feed"], string> = { ledger: "Credit ledger", sql: "SQL read", none: "No feed" };

/** Exhausted beats warn beats measured; a ceiling with no counter is its own state. */
function rowState(row: CloudRow): RowState {
  if (row.exhausted) return "exhausted";
  if (row.warn) return "warn";
  if (row.percent !== null) return "ok";
  return row.limit === null ? "noquota" : "nofeed";
}

const STATE_LABEL: Record<RowState, string> = {
  ok: "Healthy",
  warn: "At 75%",
  exhausted: "Exhausted",
  nofeed: "Not monitored",
  noquota: "No allowance",
};

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = bytes / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`;
}

/** Renders a count in its own unit; bytes get scaled because raw bytes are unreadable. */
function formatValue(row: CloudRow, value: number | null): string {
  if (value === null) return "—";
  if (row.unit === "bytes") return formatBytes(value);
  const number = formatNumber(value);
  return row.unit ? `${number} ${row.unit}` : number;
}

const CATEGORY_LABEL: Record<CloudRow["category"], string> = {
  supplier: "Supplier",
  hosting: "Hosting",
  database: "Database",
  payments: "Payments",
};

/** One pie per service: the share of its own ceiling already spent. */
function Donut({ row }: { row: CloudRow }) {
  const state = rowState(row);
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const share = row.percent === null ? 0 : Math.min(Math.max(row.percent, 0), 100);
  const centre = row.percent !== null ? `${row.percent}%` : row.limit === null ? "n/a" : "—";

  return (
    <div className="quota-donut-card">
      <div className="quota-donut">
        <svg viewBox="0 0 100 100" width="104" height="104" role="img" aria-label={`${row.service} ${row.metric}: ${STATE_LABEL[state]}`}>
          <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="11" />
          {row.percent !== null ? (
            <circle
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke={TONE[state]}
              strokeWidth="11"
              strokeLinecap="round"
              strokeDasharray={`${(share / 100) * circumference} ${circumference}`}
              transform="rotate(-90 50 50)"
            />
          ) : (
            // No counter to draw from: a dashed ring reads as "unknown", never as empty.
            <circle
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke={TONE[state]}
              strokeWidth="11"
              strokeDasharray="3 7"
              transform="rotate(-90 50 50)"
            />
          )}
          <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fill="#f7f7f3" fontSize="17" fontWeight="700">
            {centre}
          </text>
        </svg>
      </div>
      <div className="quota-donut-meta">
        <strong>{row.service}</strong>
        <span>{row.metric}</span>
        <em style={{ color: TONE[state] }}>{STATE_LABEL[state]}</em>
      </div>
    </div>
  );
}

/** All ceilings on one axis, so the closest one to its limit is visible at a glance. */
function PositionBars({ rows, warnPercent }: { rows: CloudRow[]; warnPercent: number }) {
  // Sorted closest-to-limit first: the board's job is to put the row that needs a
  // decision at the top of the axis rather than in whatever order it was registered.
  const measurable = rows.filter(row => row.percent !== null).slice().sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
  const blind = rows.filter(row => row.percent === null && row.limit !== null);

  return (
    <div className="quota-bars">
      <div className="quota-bar-scale">
        <span style={{ left: 0 }}>0%</span>
        <span style={{ left: `${warnPercent}%` }}>{warnPercent}%</span>
        <span style={{ right: 0 }}>100%</span>
      </div>
      {measurable.map(row => {
        const state = rowState(row);
        const share = Math.min(Math.max(row.percent ?? 0, 0), 100);
        return (
          <div className="quota-bar-row" key={row.key}>
            <span className="quota-bar-label">
              {row.service}
              <em>{row.metric}</em>
            </span>
            <div className="quota-bar-track">
              <div className="quota-bar-fill" style={{ width: `${share}%`, background: TONE[state] }} />
              <div className="quota-bar-marker" style={{ left: `${warnPercent}%` }} aria-hidden="true" />
            </div>
            <span className="quota-bar-value" style={{ color: TONE[state] }}>
              {row.percent}%
            </span>
          </div>
        );
      })}
      {blind.length > 0 && (
        <p className="quota-blind-note">
          {blind.length} {blind.length === 1 ? "ceiling has" : "ceilings have"} no counter behind {blind.length === 1 ? "it" : "them"}:
          {" "}
          {blind.map(row => `${row.service} ${row.metric}`).join(", ")}. They cannot appear above because nothing here measures them.
        </p>
      )}
    </div>
  );
}

function SummaryCard({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: string }) {
  return (
    <div className="quota-summary-card">
      <span className="quota-summary-label">{label}</span>
      <strong style={{ color: tone }}>{value}</strong>
      <span className="quota-summary-hint">{hint}</span>
    </div>
  );
}

function TokenGate({ onSubmit, error, busy }: { onSubmit: (value: string) => void; error: string | null; busy: boolean }) {
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    onSubmit(value);
  };

  return (
    <div className="quota-gate">
      <div className="quota-gate-card">
        <div className="quota-gate-icon">
          <Lock size={22} />
        </div>
        <h1>Operations key required</h1>
        <p>
          This page reports the allowances Fareloop depends on. It is not public: enter the operations key (the same
          <code> CRON_SECRET </code> the scheduled scans carry) to load it. Nothing is shown until the key is accepted.
        </p>
        <form onSubmit={submit} className="quota-gate-form">
          <label className="sr-only" htmlFor="ops-key">
            Operations key
          </label>
          <input
            id="ops-key"
            type="password"
            autoComplete="off"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="Paste the operations key"
          />
          <button type="submit" disabled={busy || !draft.trim()}>
            <KeyRound size={15} />
            {busy ? "Checking…" : "Open board"}
          </button>
        </form>
        {error && <p className="quota-gate-error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Takes an operations key supplied in the query string, or null when none was given.
 *
 * Remembering the key and honouring it are separate decisions, and neither optional
 * part may veto the other or the result. Storage is denied outright inside a
 * cross-origin iframe - the SecurityError is thrown by the `sessionStorage` property
 * read itself - and the original version called setItem *before* setToken, so a blocked
 * store threw out of the whole branch and `?token=` quietly landed on the key gate even
 * though the key was present and valid. Production proved that with this page embedded
 * in the PRIME dashboard; `Ops.key.test.ts` pins the ordering.
 */
export function takeUrlKey(
  search: string,
  remember: (key: string) => void,
  stripFromAddress: () => void,
): string | null {
  const key = new URLSearchParams(search).get("token");
  if (!key) return null;
  try {
    remember(key);
  } catch {
    // Not remembered - it still governs this load.
  }
  try {
    stripFromAddress();
  } catch {
    // The address bar keeps showing it instead of losing it.
  }
  return key;
}

export default function Ops() {
  const [token, setToken] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Runs only in the browser: a saved key is picked up, and a key passed in the query
  // string is moved into sessionStorage and stripped from the URL so it does not sit
  // in history or in a screenshot.
  useEffect(() => {
    const fromUrl = takeUrlKey(
      window.location.search,
      key => sessionStorage.setItem(STORAGE_KEY, key),
      () => window.history.replaceState(null, "", window.location.pathname),
    );
    if (fromUrl) {
      setToken(fromUrl);
      return;
    }
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) setToken(saved);
    } catch {
      // Storage can be blocked outright; the paste field below still works.
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        if (response.status === 403) {
          // A rejected key is discarded rather than retried forever on reload.
          try {
            sessionStorage.removeItem(STORAGE_KEY);
          } catch {
            // Nothing to clean up if storage is unavailable.
          }
          if (!cancelled) {
            setBoard(null);
            setToken("");
            setError("That key was rejected. Enter the operations key again.");
          }
          return null;
        }
        if (!response.ok) throw new Error(`The quota board could not be loaded (HTTP ${response.status}).`);
        return (await response.json()) as Board;
      })
      .then(payload => {
        if (!cancelled && payload) setBoard(payload);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  const acceptKey = (value: string) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Held in state instead when storage is unavailable.
    }
    setBoard(null);
    setToken(value);
    setAttempt(current => current + 1);
  };

  const summary = board?.summary;
  const rows = board?.services ?? [];

  const byCategory = useMemo(() => {
    const order: CloudRow["category"][] = ["supplier", "database", "hosting", "payments"];
    return order.map(category => ({ category, rows: rows.filter(row => row.category === category) })).filter(group => group.rows.length > 0);
  }, [rows]);

  if (!token) {
    return (
      <div className="app-shell">
        <main className="content-wrap" style={{ maxWidth: 760 }}>
          <TokenGate onSubmit={acceptKey} error={error} busy={loading} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main className="content-wrap" style={{ maxWidth: 1080 }}>
        <header className="page-header">
          <div>
            <p className="eyebrow accent-text">Operations</p>
            <h1 className="page-title">
              Cloud <em>quota analytics</em>
            </h1>
            <p className="hero-subtitle">
              Every outside service this product sits under, how much of each allowance is spent, and where there is no
              counter to read yet.
            </p>
          </div>
          <div className="quota-header-actions">
            <span className="quota-timestamp">
              {board ? `Read ${new Date(board.generatedAt).toLocaleString()}` : "Reading the board…"}
            </span>
            <button type="button" className="quota-refresh" onClick={() => setAttempt(current => current + 1)} disabled={loading}>
              <RefreshCw size={14} />
              {loading ? "Reading…" : "Refresh"}
            </button>
            <button type="button" className="quota-lock" onClick={() => { setToken(""); setBoard(null); }}>
              <Lock size={14} />
              Lock
            </button>
          </div>
        </header>

        {error && <div className="quota-banner quota-banner-error">{error}</div>}
        {!error && board && board.summary.exhausted > 0 && (
          <div className="quota-banner quota-banner-danger">
            <AlertTriangle size={16} /> {board.summary.exhausted} allowance is exhausted. Treat this as an active incident.
          </div>
        )}
        {!error && board && board.summary.warn > 0 && board.summary.exhausted === 0 && (
          <div className="quota-banner quota-banner-warn">
            <AlertTriangle size={16} /> {board.summary.warn} {board.summary.warn === 1 ? "allowance is" : "allowances are"} at or past {board.warnPercent}%.
            There is still a quarter left to act on.
          </div>
        )}

        {summary && (
          <div className="quota-summary-grid">
            <SummaryCard label="Watched" value={`${summary.monitored}/${summary.total}`} hint="ceilings with a live counter" tone={TONE.ok} />
            <SummaryCard label="Blind spots" value={String(summary.blindSpots)} hint="a ceiling nothing here measures" tone={summary.blindSpots > 0 ? TONE.warn : TONE.ok} />
            <SummaryCard label={`At or past ${board?.warnPercent ?? 75}%`} value={String(summary.warn)} hint="act while a quarter remains" tone={summary.warn > 0 ? TONE.warn : TONE.ok} />
            <SummaryCard label="Reserve held" value={String(summary.unwired)} hint="supplier kept out of the live chain" tone={TONE.noquota} />
          </div>
        )}

        {!board && !error && <p className="quota-loading">Loading the quota board…</p>}

        {board && (
          <>
            <section aria-label="Consumption by service">
              <div className="quota-section-head">
                <h2>
                  <Radar size={16} /> Share of each ceiling spent
                </h2>
                <p>Each ring is one allowance. A dashed ring has a ceiling but no counter behind it.</p>
              </div>
              {byCategory.map(group => (
                <div className="quota-donut-group" key={group.category}>
                  <h3 className="quota-group-label">{CATEGORY_LABEL[group.category]}</h3>
                  <div className="quota-donut-grid">
                    {group.rows.map(row => (
                      <Donut row={row} key={row.key} />
                    ))}
                  </div>
                </div>
              ))}
            </section>

            <section aria-label="Position across services">
              <div className="quota-section-head">
                <h2>
                  <ShieldCheck size={16} /> Position on one axis
                </h2>
                <p>
                  Only services with a measured counter can be plotted. The vertical line marks the {board.warnPercent}%
                  point - the moment a quarter of the pool is left.
                </p>
              </div>
              <PositionBars rows={rows} warnPercent={board.warnPercent} />
            </section>

            <section aria-label="Full quota board">
              <div className="quota-section-head">
                <h2>
                  <Check size={16} /> The full board
                </h2>
                <p>Every ceiling, where it came from, and how it is - or is not - measured.</p>
              </div>
              <div className="table-scroll">
                <table className="quota-table">
                  <thead>
                    <tr>
                      <th scope="col">Service</th>
                      <th scope="col">Used</th>
                      <th scope="col">Ceiling</th>
                      <th scope="col">Spent</th>
                      <th scope="col">Resets</th>
                      <th scope="col">Feed</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const state = rowState(row);
                      const remaining = row.used !== null && row.limit !== null ? row.limit - row.used : null;
                      return (
                        <tr key={row.key}>
                          <th scope="row">
                            <span className="quota-cell-service">
                              {row.service}
                              <em>{row.metric}</em>
                            </span>
                            <span className="quota-cell-note">{row.note ?? row.limitSource}</span>
                          </th>
                          <td>{formatValue(row, row.used)}</td>
                          <td>
                            {row.limit === null ? "No allowance" : formatValue(row, row.limit)}
                            <span className="quota-cell-sub">{row.limit === null ? "per transaction" : remaining === null ? "remaining unknown" : `${formatValue(row, remaining)} left`}</span>
                          </td>
                          <td className="quota-cell-percent" style={{ color: TONE[state] }}>
                            {row.percent === null ? "—" : `${row.percent}%`}
                          </td>
                          <td>{row.period === null ? "—" : row.period === "standing" ? "never" : row.period}</td>
                          <td>
                            {FEED_LABEL[row.feed]}
                            <span className="quota-cell-sub">{row.source === "none" ? "no source" : row.source}</span>
                          </td>
                          <td>
                            <span className="quota-pill" style={{ color: TONE[state], background: `${TONE[state]}1f` }}>
                              {STATE_LABEL[state]}
                            </span>
                            {!row.wired && <span className="quota-pill quota-pill-muted">in reserve</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="quota-provenance">
                <h3>Where each ceiling comes from</h3>
                <ul>
                  {rows.map(row => (
                    <li key={row.key}>
                      <strong>
                        {row.service} — {row.metric}:
                      </strong>{" "}
                      {row.limitSource}
                    </li>
                  ))}
                </ul>
                <p>
                  Usage figures are read at the moment this page loads: supplier credits from the ledger written when a
                  supplier bills us, database storage from the schema catalogue. Nothing here is estimated, and a metric
                  with no feed is reported as unmeasured rather than as zero.
                </p>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
