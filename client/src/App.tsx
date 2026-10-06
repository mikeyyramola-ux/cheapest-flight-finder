import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Analytics } from "@vercel/analytics/react";
import DestinationPage, { DestinationHub } from "@/pages/Destination";
import FAQ from "@/pages/FAQ";
import Grievance from "@/pages/Grievance";
import NotFound from "@/pages/NotFound";
import Ops from "@/pages/Ops";
import RefundPolicy from "@/pages/RefundPolicy";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import PageTransition from "./components/PageTransition";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";

function Router() {
  return (
    <PageTransition>
      <Switch><Route path="/" component={Home} /><Route path="/tracker" component={Home} /><Route path="/paywall" component={Home} /><Route path="/faq" component={FAQ} /><Route path="/grievance" component={Grievance} /><Route path="/refund-policy" component={RefundPolicy} /><Route path="/flights-to" component={DestinationHub} /><Route path="/flights-to/:slug" component={DestinationPage} /><Route path="/ops" component={Ops} /><Route path="/404" component={NotFound} /><Route component={NotFound} /></Switch>
    </PageTransition>
  );
}

export default function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><Toaster theme="dark" /><Router /><Analytics /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}
