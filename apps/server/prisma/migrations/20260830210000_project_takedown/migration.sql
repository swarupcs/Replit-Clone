-- A moderator's takedown, as a fact distinct from the owner's visibility switch.
--
-- ACTIONED used to mean `visibility = PRIVATE` and nothing else, which the
-- owner could reverse in one request and which left the deployment and the
-- embed serving to anonymous visitors.

ALTER TABLE "projects" ADD COLUMN "takenDownAt" TIMESTAMP(3);

-- Read on every public site request and every embed resolution, and almost
-- always null.
CREATE INDEX "projects_takenDownAt_idx" ON "projects"("takenDownAt");
