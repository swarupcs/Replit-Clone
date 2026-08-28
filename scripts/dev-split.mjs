import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { platform, env } from "node:process";

/** One command, two terminals.
 *
 *  `pnpm dev` runs the web app and the server interleaved into a single
 *  terminal, which is fine until you are reading the server's logs. Running
 *  `dev:server` and `dev:web` by hand keeps them apart but is two commands and
 *  two windows to arrange.
 *
 *  So: this opens a terminal for the WEB app and then runs the SERVER here.
 *  The server is the one kept in the foreground deliberately -- it is the noisy
 *  half, the one whose output you came to read, and the one you will restart.
 *
 *  The web terminal is genuinely independent: it survives Ctrl+C here, because
 *  a window that closes itself when an unrelated process stops is worse than
 *  one you close yourself.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** How to open a terminal running `command`, per platform.
 *
 *  Returns the argv to spawn, or null when nothing suitable was found -- in
 *  which case this falls back to telling the user what to type, which is a
 *  better outcome than a cryptic spawn failure.
 */
function terminalFor(command) {
  if (platform === "win32") {
    // Windows Terminal if it is installed. It ships with Windows 11 but is a
    // Store app, so it is often absent from PATH in a non-interactive shell
    // even though `wt` works when typed -- hence the explicit path.
    const wt = join(
      env["LOCALAPPDATA"] ?? "",
      "Microsoft",
      "WindowsApps",
      "wt.exe",
    );
    if (env["LOCALAPPDATA"] && existsSync(wt)) {
      return [wt, ["-d", root, "--title", "web", "cmd", "/k", command]];
    }

    // Every Windows has this. `start` needs a title argument first, or it
    // treats a quoted path as the title and opens the wrong thing.
    return ["cmd.exe", ["/c", "start", "web", "cmd", "/k", command]];
  }

  if (platform === "darwin") {
    return [
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script "cd ${root.replace(/"/g, '\\"')} && ${command}"`,
        "-e",
        'tell application "Terminal" to activate',
      ],
    ];
  }

  // Linux has no single answer, so find one that is actually installed rather
  // than spawning the first name on a list and hoping.
  for (const term of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
    const found = spawnSync("which", [term], { encoding: "utf8" });
    if (found.status === 0) {
      // `exec bash` keeps the window open after the command stops, so a crash
      // leaves its own error on screen instead of closing over it.
      return [term, ["-e", `bash -lc '${command}; exec bash'`]];
    }
  }

  return null;
}

const webCommand = "pnpm run dev:web";
const opener = terminalFor(webCommand);

if (opener) {
  const [file, args] = opener;
  const child = spawn(file, args, {
    cwd: root,
    // Detached and ignoring our streams: the new terminal must outlive this
    // process and must not write into it.
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });

  child.on("error", () => {
    console.log(`Could not open a terminal. Run this in one yourself:\n  ${webCommand}\n`);
  });
  child.unref();

  console.log("Opened a terminal for the web app (http://localhost:15273).");
} else {
  console.log(`No terminal to open here. Run this in one yourself:\n  ${webCommand}\n`);
}

console.log("Starting the server in this terminal.\n");

// Inherited stdio, so the server's logs are this terminal's output and Ctrl+C
// reaches it directly rather than through a wrapper that would swallow it.
//
// One string rather than a command plus an args array: `pnpm` on Windows is a
// .cmd shim and cannot be spawned without a shell, and passing args alongside
// `shell: true` is deprecated (DEP0190) because they are concatenated rather
// than escaped. There is nothing user-supplied here to escape, but a warning
// on every startup is noise in the logs this script exists to make readable.
const server = spawn("pnpm run dev:server", {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

server.on("exit", (code) => {
  process.exit(code ?? 0);
});
