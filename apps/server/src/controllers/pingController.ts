import type { Request, Response } from "express";

export async function pingCheck(_req: Request, res: Response): Promise<void> {
  res.status(200).json({ message: "pong" });
}
