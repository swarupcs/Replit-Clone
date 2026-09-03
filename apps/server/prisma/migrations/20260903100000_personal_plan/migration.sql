-- A plan for a deployment with one person on it.
--
-- Every per-account limit in this product rations a shared VM between tenants:
-- twenty projects, 2 GB across them, 512 MB each, sixty assistant requests an
-- hour, two containers at once. At n=1 there is nobody to ration against, and
-- a 512 MB project quota on somebody's own machine is an editor refusing to
-- save into their own free space.
--
-- Zero means unlimited -- see UNLIMITED in packages/shared/src/billing.ts for
-- why a sentinel rather than a very large number or a nullable column. The
-- rule already existed unwritten: isNearQuota has always guarded on `limit >
-- 0`, because a meter over a limit of zero means nothing.
--
-- What this deliberately does NOT raise is anything about the machine.
-- CONTAINER_MEMORY_MB, MAX_CONCURRENT_CONTAINERS and DEPLOY_MEMORY_MB stay in
-- env and no plan can touch them, because a plan that promises more memory per
-- container than the host has is a promise kept by an OOM kill rather than by
-- an honest refusal. That is plan.md section 6, decision 15, and it does not
-- weaken at one user: it is the same kill in the same terminal.
--
-- Seeded and not selected. Nothing moves onto it by migrating; single-user
-- mode puts its one account here at boot, and an ordinary deployment now has a
-- plan in its catalogue that nobody is on. rank 100 so it sorts after whatever
-- a real catalogue grows, since it is not a tier anybody buys.

INSERT INTO "plans" ("id", "label", "priceCents", "currency", "rank", "maxProjects", "userDiskQuotaMb", "projectDiskQuotaMb", "aiRequestsPerHour", "maxContainersPerUser", "managedDatabases", "customDomains", "scheduledJobs")
VALUES ('personal', 'Personal', 0, 'usd', 100, 0, 0, 0, 0, 0, true, true, true)
ON CONFLICT ("id") DO NOTHING;
