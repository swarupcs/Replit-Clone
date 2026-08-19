import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

/** Prisma 7 reads the connection URL from here rather than from the schema. */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
