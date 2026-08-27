import { readFile } from "node:fs/promises";
import pg from "pg";

// DATABASE_URL is injected into this container's environment by the platform.
// It is deliberately not in a file: a file would be committed, exported, and
// listed in the file panel.
const url = process.env.DATABASE_URL;

if (!url) {
  console.error(
    "No DATABASE_URL. Add a database to this project from the Database panel.",
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
await client.end();

console.log("Schema is up to date.");
