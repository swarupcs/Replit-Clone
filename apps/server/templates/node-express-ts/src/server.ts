import express, { type Request, type Response } from "express";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.get("/", (_req: Request, res: Response) => {
  res.send("<h1>Hello from your Node playground</h1><p>Edit src/server.ts and save.</p>");
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// 0.0.0.0 so the preview proxy can reach this from outside the container.
app.listen(port, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${port}`);
});
