import { ArrowRight } from "lucide-react";
import { Link } from "wouter";

/**
 * Grievance procedure page (ASK 101). Content mirrors
 * compliance\grievance-procedure.md - keep the two in sync.
 *
 * The three officer fields are the owner's to provide: fill them in and the
 * details appear. Until then the page says so instead of inventing a name.
 * Applicability of the IT Rules 2021 grievance obligation is NOT FOUND IN
 * MANUAL for this service, so nothing here claims statutory status - these
 * are Fareloop's own service targets.
 */
const OFFICER = {
  name: "",
  email: "",
  postal: "",
};

const officerConfirmed = Boolean(OFFICER.name && OFFICER.email && OFFICER.postal);

export default function Grievance() {
  return (
    <div className="app-shell">
      <main className="content-wrap" style={{ maxWidth: 1060 }}>
        <header className="page-header">
          <div>
            <p className="eyebrow accent-text">Complaints</p>
            <h1 className="page-title">Grievance <em>procedure</em></h1>
            <p className="hero-subtitle">How to raise a complaint with Fareloop, what we promise to do about it, and how to escalate if we miss our own deadline.</p>
          </div>
          <Link className="primary-cta small" href="/">Search flights <ArrowRight size={14} /></Link>
        </header>
        <section className="seo-content" aria-label="Grievance procedure">
          <div className="seo-copy">
            <h2>What we promise</h2>
            <p>We aim to acknowledge every complaint within 24 hours of receipt and to resolve it within 15 days of receipt. If we need longer, we will tell you why and give you a new date.</p>
          </div>
          <div className="seo-copy">
            <h2>How to complain</h2>
            <p>Email <a href="mailto:grievance@fareloop.in">grievance@fareloop.in</a> and include the email address you signed up with, what happened, and what you want us to do.</p>
          </div>
          <div className="seo-copy">
            <h2>Who handles it</h2>
            {officerConfirmed ? (
              <p>
                Grievance Officer: {OFFICER.name}
                <br />
                Email: <a href={`mailto:${OFFICER.email}`}>{OFFICER.email}</a>
                <br />
                Post: {OFFICER.postal}
              </p>
            ) : (
              <p>The Grievance Officer&apos;s contact details will be published here once confirmed.</p>
            )}
          </div>
          <div className="seo-copy">
            <h2>Escalation</h2>
            <p>If we miss our own deadline, write again to <a href="mailto:grievance@fareloop.in">grievance@fareloop.in</a> with the word <strong>escalation</strong> in the subject line. That reaches the Grievance Officer directly, not the support queue.</p>
          </div>
          <div className="seo-copy">
            <h2>These are our own targets</h2>
            <p>The 24-hour and 15-day targets above are Fareloop's own service commitments. This page makes no statutory claim.</p>
          </div>
        </section>
        <footer className="faq-footer">
          <p>Something else? <Link href="/faq">Read the FAQ</Link>, check the <Link href="/refund-policy">refund policy</Link>, or <Link href="/">search cheap flights</Link>.</p>
        </footer>
      </main>
    </div>
  );
}
