-- plan.md Part A: "Starter" copies a committed directory; "Latest" runs the
-- real upstream scaffolder inside the project's container.

CREATE TYPE "ScaffoldStatus" AS ENUM ('READY', 'SCAFFOLDING', 'FAILED');

-- READY as the default is what makes this migration a no-op for every existing
-- row: a project copied from a starter is finished the moment it is created,
-- which is what every project before this one was.
ALTER TABLE "Project" ADD COLUMN "scaffoldStatus" "ScaffoldStatus" NOT NULL DEFAULT 'READY';
ALTER TABLE "Project" ADD COLUMN "scaffoldLog" TEXT;

-- Only ever queried for the handful that are not READY -- the dashboard poll
-- and the boot reconcile both ask "which of these is unfinished".
CREATE INDEX "Project_scaffoldStatus_idx" ON "Project"("scaffoldStatus");

CREATE TABLE "ScaffoldRecipe" (
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "argv" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScaffoldRecipe_pkey" PRIMARY KEY ("templateId")
);

-- The recipes themselves, seeded here rather than by a script so a fresh
-- database has them without a manual step somebody can forget.
--
-- Every argv is an array of arrays and is handed to `docker exec` as an array.
-- Nothing here is ever parsed by a shell, which is what keeps a table of
-- commands a table of data.
--
-- The `.` and the `--` matter in the Vite ones: `.` scaffolds into the existing
-- workspace directory rather than creating a subdirectory (the nested-directory
-- mismatch the old host-side `npm create` produced, which projectService.ts:82
-- still records), and `--` stops npm from eating the flags meant for the
-- scaffolder.
INSERT INTO "ScaffoldRecipe" ("templateId", "label", "argv", "enabled", "updatedAt") VALUES
  ('react-vite', 'Vite · React',
   '[["npm","create","vite@latest",".","--","--template","react"],["npm","install"]]', true, NOW()),
  ('react-vite-ts', 'Vite · React + TypeScript',
   '[["npm","create","vite@latest",".","--","--template","react-ts"],["npm","install"]]', true, NOW()),
  ('vue-vite', 'Vite · Vue',
   '[["npm","create","vite@latest",".","--","--template","vue"],["npm","install"]]', true, NOW()),
  ('svelte-vite', 'Vite · Svelte',
   '[["npm","create","vite@latest",".","--","--template","svelte"],["npm","install"]]', true, NOW()),
  -- create-next-app installs on its own, so there is no second step. The flags
  -- are all explicit because without them it asks questions, and there is
  -- nobody at the other end of a container exec to answer them.
  ('nextjs', 'Next.js',
   '[["npx","--yes","create-next-app@latest",".","--js","--eslint","--app","--no-tailwind","--no-src-dir","--no-turbopack","--import-alias","@/*","--use-npm","--yes"]]', true, NOW()),
  ('nextjs-ts', 'Next.js + TypeScript',
   '[["npx","--yes","create-next-app@latest",".","--ts","--eslint","--app","--no-tailwind","--no-src-dir","--no-turbopack","--import-alias","@/*","--use-npm","--yes"]]', true, NOW());
