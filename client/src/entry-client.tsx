import { hydrateRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import superjson from "superjson";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "@/lib/trpc";
import { COOKIE_NAME, UNAUTHED_ERR_MSG } from "@shared/const";
import App from "./App";
import { startLogin } from "./const";
import "./index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof Error) || typeof window === "undefined") return;
  if (error.message === UNAUTHED_ERR_MSG) startLogin();
};
queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") redirectToLoginIfUnauthorized(event.query.state.error);
});
queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") redirectToLoginIfUnauthorized(event.mutation.state.error);
});

const trpcClient = trpc.createClient({
  links: [httpBatchLink({
    url: "/api/trpc",
    transformer: superjson,
    headers() {
      try {
        const raw = sessionStorage.getItem("manus-cookie");
        const prefix = `${COOKIE_NAME}=`;
        const pair = raw?.split(";").find(item => item.trim().startsWith(prefix));
        const token = pair?.trim().slice(prefix.length);
        return token ? { Authorization: `Bearer ${token}` } : {};
      } catch {
        return {};
      }
    },
    fetch(input, init) { return globalThis.fetch(input, { ...(init ?? {}), credentials: "include" }); },
  })],
});

hydrateRoot(document.getElementById("root")!,
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <Router><App /></Router>
    </QueryClientProvider>
  </trpc.Provider>
);
