import * as fs from "fs";
import * as path from "path";
import type { DebateEvent, DebateEventBody, SessionSettings } from "./events";
import { applyEvent, createInitialState, replay, type DebateState } from "./state";
import { writeProjections } from "./projections";

export const EVENTS_FILE = "events.jsonl";

export function readEvents(file: string): DebateEvent[] {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const events: DebateEvent[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line) as DebateEvent);
    } catch (err) {
      // A crash mid-append can only truncate the last line; anything earlier is real corruption
      if (index === lines.length - 1) break;
      throw new Error(`Corrupted event log ${file} at line ${index + 1}: ${err}`);
    }
  }
  return events;
}

function folderName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-debate`;
}

export type EventListener = (event: DebateEvent, state: DebateState) => void;

/**
 * Append-only event log plus the state folded from it. events.jsonl is the source of truth:
 * the md files and viewer.html are projections and can be rebuilt with `npm run render`.
 */
export class DebateSession {
  readonly state: DebateState;
  private seq: number;
  private listeners: EventListener[] = [];

  private constructor(
    readonly dir: string,
    state: DebateState,
    seq: number,
  ) {
    this.state = state;
    this.seq = seq;
  }

  get eventsFile(): string {
    return path.join(this.dir, EVENTS_FILE);
  }

  static create(root: string, topic: string, settings: SessionSettings, now = new Date()): DebateSession {
    let debateId = folderName(now);
    // Two debates started in the same second must not share a log
    for (let suffix = 2; fs.existsSync(path.join(root, debateId)); suffix++) debateId = `${folderName(now)}-${suffix}`;
    const dir = path.join(root, debateId);
    fs.mkdirSync(dir, { recursive: true });
    const session = new DebateSession(dir, createInitialState(), 0);
    session.emit({ type: "debate_started", debateId, topic, settings });
    return session;
  }

  static open(dir: string): DebateSession {
    const events = readEvents(path.join(dir, EVENTS_FILE));
    return new DebateSession(dir, replay(events), events.at(-1)?.seq ?? 0);
  }

  // Most recent session that got past selection and has no debate_finished event:
  // a debate abandoned during selection has nothing to resume
  static findUnfinished(root: string): string | null {
    if (!fs.existsSync(root)) return null;
    const candidates = fs
      .readdirSync(root)
      .map((name) => path.join(root, name))
      .filter((dir) => fs.existsSync(path.join(dir, EVENTS_FILE)))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const dir of candidates) {
      const events = readEvents(path.join(dir, EVENTS_FILE));
      const started = events.some((event) => event.type === "debaters_selected");
      if (started && !events.some((event) => event.type === "debate_finished")) return dir;
    }
    return null;
  }

  onEvent(listener: EventListener) {
    this.listeners.push(listener);
  }

  emit(body: DebateEventBody): DebateEvent {
    if (this.state.phase === "finished") throw new Error(`Session ${this.state.debateId} is finished`);
    const event = { ...body, seq: ++this.seq, ts: new Date().toISOString(), turn: this.state.turn } as DebateEvent;
    // Sync append keeps the log ordered and durable before the state moves on
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + "\n", "utf8");
    applyEvent(this.state, event);
    for (const listener of this.listeners) listener(event, this.state);
    return event;
  }

  events(): DebateEvent[] {
    return readEvents(this.eventsFile);
  }

  writeProjections(options: { viewer: boolean }) {
    writeProjections(this.dir, this.state, options.viewer ? this.events() : undefined);
  }
}
