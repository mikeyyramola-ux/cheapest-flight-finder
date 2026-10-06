import { ArrowRight } from "lucide-react";
import { Link } from "wouter";

/**
 * Refund policy page (ASK 101). Content mirrors
 * compliance\refund-policy.md (wording option A as approved) - keep in sync.
 */
export default function RefundPolicy() {
  return (
    <div className="app-shell">
      <main className="content-wrap" style={{ maxWidth: 1060 }}>
        <header className="page-header">
          <div>
            <p className="eyebrow accent-text">Billing</p>
            <h1 className="page-title">Refund <em>policy</em></h1>
            <p className="hero-subtitle">Cancel any time - and what happens to your money if you change your mind or we bill you wrongly.</p>
          </div>
          <Link className="primary-cta small" href="/paywall">See Premium <ArrowRight size={14} /></Link>
        </header>
        <section className="seo-content" aria-label="Refund policy">
          <div className="seo-copy">
            <h2>Cancel any time</h2>
            <p>Cancel from your account page (Billing, cancel button). Your plan stops at the end of the period you already paid for.</p>
          </div>
          <div className="seo-copy">
            <h2>Changed your mind?</h2>
            <p>Get a full refund within 14 days of purchase, for any reason: email <a href="mailto:billing@fareloop.in">billing@fareloop.in</a> with the address you signed up with.</p>
          </div>
          <div className="seo-copy">
            <h2>Billing errors</h2>
            <p>Overcharges, double charges, and charges for a plan you did not buy are refunded in full, at any time.</p>
          </div>
          <div className="seo-copy">
            <h2>Chargebacks</h2>
            <p>If a payment is successfully charged back, premium access on that account is removed.</p>
          </div>
          <div className="seo-copy">
            <h2>How the money returns</h2>
            <p>Refunds go back to the original payment method within 10 business days of approval.</p>
          </div>
        </section>
        <footer className="faq-footer">
          <p>Questions first? <Link href="/faq">Read the FAQ</Link>, see the <Link href="/grievance">grievance procedure</Link>, or check what <Link href="/paywall">Premium</Link> unlocks.</p>
        </footer>
      </main>
    </div>
  );
}
