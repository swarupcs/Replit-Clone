import dotenv from "dotenv";

dotenv.config();

export const PORT: number = Number(process.env.PORT ?? 3000);

export const REACT_PROJECT_COMMAND: string | undefined =
  process.env.REACT_PROJECT_COMMAND;

/** Port the standalone terminal websocket server listens on (Phase 2 merges
 *  this into the main server). */
export const TERMINAL_PORT: number = Number(process.env.TERMINAL_PORT ?? 4000);
