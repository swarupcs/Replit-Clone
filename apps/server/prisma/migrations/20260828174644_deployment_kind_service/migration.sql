-- CreateEnum
CREATE TYPE "DeploymentKind" AS ENUM ('STATIC', 'SERVICE');

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "kind" "DeploymentKind" NOT NULL DEFAULT 'STATIC',
ADD COLUMN     "port" INTEGER;
