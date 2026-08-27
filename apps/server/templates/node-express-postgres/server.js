import express from "express";
import pg from "pg";

const app = express();
const port = process.env.PORT ?? 3000;

// One pool for the process, not one per request: a connection per request
// exhausts the database's own limit long before the app is under real load.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.get("/", async (_request, response) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, body, created_at FROM notes ORDER BY id",
    );

    // Rendered rather than returned as JSON so the preview shows something
    // on the very first run, which is the point of the template.
    response.send(`<!doctype html>
<meta charset="utf-8">
<title>Notes</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem }
  li { margin: .5rem 0 }
  time { color: #666; font-size: .85em }
</style>
<h1>Notes</h1>
<ul>
  ${rows
    .map(
      (row) =>
        `<li>${row.body} <time>${new Date(row.created_at).toISOString()}</time></li>`,
    )
    .join("\n  ")}
</ul>
<p>${rows.length} row${rows.length === 1 ? "" : "s"}, read from Postgres.</p>`);
  } catch (error) {
    response.status(500).send(`Could not read from the database: ${error.message}`);
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Listening on ${port}`);
});
