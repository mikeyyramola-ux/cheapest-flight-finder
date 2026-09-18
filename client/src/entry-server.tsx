import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { Router } from "wouter";
import superjson from "superjson";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "@/lib/trpc";
import App from "./App";

export type ServerRenderResult = {
  html: string;
  dehydratedState: unknown;
};

export async function render(url: string): Promise<ServerRenderResult> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const query = url.indexOf("?");
  const ssrPath = query === -1 ? url : url.slice(0, query);
  const ssrSearch = query === -1 ? "" : url.slice(query + 1);
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: "http://127.0.0.1/api/trpc", transformer: superjson })],
  });
  const html = renderToString(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Router ssrPath={ssrPath || "/"} ssrSearch={ssrSearch}>
          <App />
        </Router>
      </QueryClientProvider>
    </trpc.Provider>
  );
  return { html, dehydratedState: superjson.serialize(queryClient.getQueryData([])) };
}
