import { QueryClient } from "@tanstack/react-query";

/** The single app-wide query client.
 *
 *  It lives here rather than in main.tsx so non-component code (the tree store)
 *  can reach the SAME cache. It previously constructed a second QueryClient of
 *  its own, giving the store a cache the React tree never saw.
 */
export const queryClient = new QueryClient();
