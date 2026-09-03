import { useQuery } from "@tanstack/react-query";
import type { DeploymentCapabilities } from "@replit-clone/shared";
import { getAuthProvidersApi } from "../apis/auth.ts";

/** What this deployment has routes for.
 *
 *  Read from `/auth/providers`, which the sign-in form already asks and which
 *  is unauthenticated and cached forever — so any screen can ask it without a
 *  second request and without caring whether somebody is signed in yet.
 *
 *  It exists so the app does not draw controls whose endpoints are 404s. In
 *  single-user mode the sharing, moderation, operator-console and gallery
 *  routes are not mounted at all (see `config/deploymentMode.ts` on the
 *  server), and a Share button that fails on click is worse than no Share
 *  button — it reads as a broken feature rather than as one this deployment
 *  does not have.
 *
 *  Defaults to everything ON while the query is in flight and if it fails.
 *  That is the safe direction: the ordinary deployment is the common case, and
 *  briefly showing a control that works beats briefly hiding one that does.
 */
export function useDeployment(): {
  capabilities: DeploymentCapabilities;
  singleUser: boolean;
} {
  const { data } = useQuery({
    queryKey: ["authProviders"],
    queryFn: getAuthProvidersApi,
    staleTime: Infinity,
    retry: false,
  });

  return {
    capabilities: data?.capabilities ?? {
      sharing: true,
      moderation: true,
      operatorConsole: true,
      gallery: true,
      plans: true,
    },
    singleUser: data?.singleUser ?? false,
  };
}
