import * as path from "path";
import { DebateSession } from "../lib/session/session";

// Rebuilds the markdown files and viewer.html of saved debates from their events.jsonl
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("Usage: npm run render -- <debate dir> [<debate dir> ...]");
  process.exit(1);
}

for (const dir of dirs) {
  const session = DebateSession.open(path.resolve(dir));
  session.writeProjections({ viewer: true });
  console.log(`Rendered ${session.dir}`);
}
