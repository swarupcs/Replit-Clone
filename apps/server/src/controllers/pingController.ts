import type { Request, Response } from "express";

export function pingCheck(_req: Request, res: Response): Promise<void> {
  res.status(200).json({ message: "pong" });
  return Promise.resolve();
}
