import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { type ReactNode, useEffect, useLayoutEffect } from "react";
import { useLocation } from "wouter";

// SPA navigations own the scroll position: disable the browser's
// back/forward scroll restoration so it can't fight our scroll-to-top.
if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

/** Snappy premium easing: fast out, long soft settle (easeOutExpo-style). */
const EASE_ENTER = [0.16, 1, 0.3, 1] as const;
const EASE_EXIT = [0.4, 0, 1, 1] as const;

/**
 * Lands the viewport at the top for every route change, before paint, so the
 * incoming page never flashes mid-scroll. Skips the very first page load to
 * preserve normal deep-link/reload scroll behavior. The first-load guard is
 * module-level because this component remounts (fresh refs) on every route.
 * Runs in `useEffect` on the server (no-op) to avoid SSR warnings.
 */
let hasLoadedInitialPage = false;

function ScrollToTop({ location }: { location: string }) {
  const useIsoEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
  useIsoEffect(() => {
    if (!hasLoadedInitialPage) {
      hasLoadedInitialPage = true;
      return;
    }
    window.scrollTo(0, 0);
  }, [location]);
  return null;
}

/**
 * Route-level page transitions: the outgoing page lifts away while fading,
 * then the incoming page rises in — one page at a time (`mode="wait"`) so
 * nothing ever stacks. `initial={false}` keeps the server-rendered first paint
 * instant (no flash of hidden content), and reduced-motion users get instant
 * swaps with no animation.
 */
export default function PageTransition({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return (
      <div>
        <ScrollToTop location={location} />
        {children}
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location}
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.34, ease: EASE_ENTER } }}
        exit={{ opacity: 0, y: -12, transition: { duration: 0.15, ease: EASE_EXIT } }}
      >
        <ScrollToTop location={location} />
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
