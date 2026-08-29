-- CreateEnum
CREATE TYPE "ProjectVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "visibility" "ProjectVisibility" NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "forkedFromId" TEXT;

-- CreateIndex
CREATE INDEX "projects_visibility_idx" ON "projects"("visibility");

-- CreateIndex
CREATE INDEX "projects_forkedFromId_idx" ON "projects"("forkedFromId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_forkedFromId_fkey" FOREIGN KEY ("forkedFromId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
