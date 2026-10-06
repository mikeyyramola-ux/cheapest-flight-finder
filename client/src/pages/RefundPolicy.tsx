import { ArrowRight } from "lucide-react";
import { Link } from "wouter";

/**
 * Refund policy page (ASK 101). Content mirrors
 * compliance\refund-policy.md (owner decision option 1, ASK 107) - keep in sync.
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
            <h2>Try before you buy</h2>
            <p>Open Preview mode from the paywall to browse Premium before paying anything.</p>
          </div>
          <div className="seo-copy">
            <h2>Changed your mind?</h2>
            <p>Purchases are non-refundable - we do not offer refunds when you change your mind after you buy. If your situation is special, email <a href="mailto:billing@fareloop.in">billing@fareloop.in</a> with the address you signed up with: every case is read individually, and any goodwill refund is granted at management's sole discretion based on the situation.</p>
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
            <h2>If a refund is approved</h2>
            <p>Any refund we approve - a billing error or an exception - goes back to the original payment method.</p>
          </div>
        </section>
        <footer className="faq-footer">
          <p>Questions first? <Link href="/faq">Read the FAQ</Link>, see the <Link href="/grievance">grievance procedure</Link>, or check what <Link href="/paywall">Premium</Link> unlocks.</p>
        </footer>
      </main>
    </div>
  );
}
