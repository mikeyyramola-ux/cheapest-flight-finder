import { useState } from "react";
import { ArrowRight, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * GO 167 - account sign-in and registration.
 *
 * WHY THIS PAGE EXISTS: before it, a "customer" was a PayPal subscription id in
 * localStorage. Clear the browser, switch phone, or open the site in private
 * mode and Premium vanished - and the id itself could be pasted into any other
 * device to claim the same plan. An account that is theirs fixes both: identity
 * survives the device, and ownership of a tracked route has somewhere to attach.
 *
 * Design notes:
 *  - One form, two modes. Registering and signing in differ by one field (name),
 *    so a tab control beats two pages that each half-explain the other.
 *  - Errors surface inline AND by toast. Inline so the form never silently
 *    appears dead, toast because the house already toasts everywhere else.
 *  - No password in any log, URL, or returned payload. The server returns a
 *    public subset of the user and sets an httpOnly cookie; the password leaves
 *    this component exactly once, over HTTPS, and is never stored client-side.
 *  - The Telegram chat id is optional and explained plainly: alerts can only
 *    reach a customer if we know where to send them.
 */

type Mode = "signin" | "register";

export default function Login() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const registerMutation = trpc.auth.register.useMutation();
  const loginMutation = trpc.auth.login.useMutation();

  const switchMode = (next: Mode) => {
    setMode(next);
    setInlineError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setInlineError(null);

    // Trimmed here as well as on the server: a trailing space in an email is the
    // single most common reason a person "cannot log in to their own account".
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail.includes("@")) {
      setInlineError("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setInlineError("Password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "register") {
        await registerMutation.mutateAsync({
          email: trimmedEmail,
          password,
          name: name.trim() || undefined,
          telegramChatId: telegramChatId.trim() || undefined,
        });
        toast.success("Account created", { description: "You are signed in. Your routes are yours alone now." });
      } else {
        await loginMutation.mutateAsync({ email: trimmedEmail, password });
        toast.success("Signed in", { description: "Welcome back." });
      }

      // Refetch rather than optimistic-write: `me` is the server's opinion of who
      // you are, and the cookie is only authoritative once the response lands.
      await utils.auth.me.invalidate();
      navigate("/");
    } catch (error) {
      const message =
        (error as { data?: { message?: string } })?.data?.message ??
        (error as Error)?.message ??
        "Something went wrong. Please try again.";
      setInlineError(message);
      toast.error(mode === "register" ? "Could not create the account" : "Sign-in failed", { description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <main className="content-wrap" style={{ maxWidth: 560 }}>
        <header className="page-header">
          <div>
            <p className="eyebrow accent-text">Your account</p>
            <h1 className="page-title">{mode === "register" ? <>Create your <em>account</em></> : <>Sign <em>in</em></>}</h1>
            <p className="hero-subtitle">
              {mode === "register"
                ? "An account keeps your watched routes, your price history and your Premium plan attached to you - not to whichever browser you happened to be using."
                : "Welcome back. Sign in to see your watched routes and keep your alerts coming."}
            </p>
          </div>
          <Link className="primary-cta small" href="/">Search flights <ArrowRight size={14} /></Link>
        </header>

        <section className="seo-content" aria-label="Account sign-in">
          <div className="seo-copy" style={{ maxWidth: "100%" }}>
            {/* Mode switch: two buttons, one form. `aria-pressed` rather than a
                tab role, because the panel below is a plain form. */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              {(["signin", "register"] as Mode[]).map(next => (
                <button
                  key={next}
                  type="button"
                  onClick={() => switchMode(next)}
                  aria-pressed={mode === next}
                  className="primary-cta small"
                  style={mode === next ? undefined : { opacity: 0.55 }}
                >
                  {next === "signin" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>

            <form onSubmit={submit} noValidate>
              {mode === "register" && (
                <label style={{ display: "block", marginBottom: 14 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <Mail size={14} aria-hidden /> Name <span style={{ opacity: 0.5 }}>(optional)</span>
                  </span>
                  <input
                    type="text"
                    value={name}
                    onChange={event => setName(event.target.value)}
                    autoComplete="name"
                    maxLength={120}
                    placeholder="How should we greet you?"
                    style={fieldStyle}
                  />
                </label>
              )}

              <label style={{ display: "block", marginBottom: 14 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <Mail size={14} aria-hidden /> Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                  maxLength={320}
                  placeholder="you@example.com"
                  style={fieldStyle}
                />
              </label>

              <label style={{ display: "block", marginBottom: 14 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <LockKeyhole size={14} aria-hidden /> Password
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  required
                  minLength={8}
                  maxLength={200}
                  placeholder="At least 8 characters"
                  style={fieldStyle}
                />
                {mode === "register" && (
                  <span style={{ display: "block", marginTop: 6, fontSize: 12, opacity: 0.5 }}>
                    Longer is stronger. We never show it again after this.
                  </span>
                )}
              </label>

              {mode === "register" && (
                <label style={{ display: "block", marginBottom: 14 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <ShieldCheck size={14} aria-hidden /> Telegram chat id <span style={{ opacity: 0.5 }}>(optional)</span>
                  </span>
                  <input
                    type="text"
                    value={telegramChatId}
                    onChange={event => setTelegramChatId(event.target.value)}
                    maxLength={64}
                    placeholder="From @userinfobot"
                    style={fieldStyle}
                  />
                  <span style={{ display: "block", marginTop: 6, fontSize: 12, opacity: 0.5 }}>
                    Price-drop alerts are sent on Telegram, so we need a chat id to reach you. You can add it later - your account works without it.
                  </span>
                </label>
              )}

              {inlineError && (
                <p role="alert" style={{ marginBottom: 14, fontSize: 13, color: "#ff9d9d" }}>
                  {inlineError}
                </p>
              )}

              <button type="submit" className="primary-cta" disabled={busy} style={{ width: "100%", justifyContent: "center", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}
                {!busy && <ArrowRight size={16} />}
              </button>
            </form>

            <p style={{ marginTop: 18, fontSize: 13, opacity: 0.6 }}>
              {mode === "register" ? (
                <>Already have an account?{" "}
                  <button type="button" onClick={() => switchMode("signin")} style={linkButtonStyle}>Sign in</button>
                </>
              ) : (
                <>New to Fareloop?{" "}
                  <button type="button" onClick={() => switchMode("register")} style={linkButtonStyle}>Create one</button>
                </>
              )}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.05)",
  color: "#fff",
  fontSize: 14,
};

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#b9ff98",
  cursor: "pointer",
  padding: 0,
  fontSize: 13,
  textDecoration: "underline",
};
