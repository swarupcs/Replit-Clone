import WebSocket from "ws";
const [token, pid, cmd] = process.argv.slice(2);
const ws = new WebSocket(`ws://localhost:3100/terminal?projectId=${pid}`, ["auth", token]);
let out = "";
ws.on("open", () => setTimeout(() => ws.send(cmd + "\n"), 900));
ws.on("message", (d) => { out += d.toString(); });
ws.on("error", (e) => { console.log("ERR", e.message); process.exit(1); });
setTimeout(() => { console.log(out.trim().slice(-600)); ws.close(); process.exit(0); }, 8000);
