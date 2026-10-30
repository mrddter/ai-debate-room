import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { DebateSession } from "../src/lib/session/session";
import { renderChat, renderViewer } from "../src/lib/session/projections";
import { debaterConfig, tempDir } from "./helpers/fixtures";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const hostileTopic = `Prezzi </script><script>alert(1)</script> e separatori ${LINE_SEPARATOR} ${PARAGRAPH_SEPARATOR}`;

describe("projections", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir("debate-projections");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function sampleSession() {
    const session = DebateSession.create(root, hostileTopic, { maxTurns: 5, contextWindow: 4, judgeEvery: 0 });
    session.emit({ type: "debaters_selected", debaters: [debaterConfig("alpha"), debaterConfig("beta")] });
    session.emit({ type: "moderator_message", kind: "intro", text: "Benvenuti" });
    session.emit({ type: "speech", speakerId: "alpha", text: "Primo punto", replyTo: [] });
    session.emit({ type: "speech", speakerId: "beta", text: "Replica", replyTo: ["alpha"] });
    session.emit({ type: "moderator_message", kind: "summary", text: "Sintesi", inShort: "Esito netto" });
    session.emit({ type: "debate_finished", reason: "judges" });
    return session;
  }

  it("writes every projection from the log alone", () => {
    const session = sampleSession();
    session.writeProjections({ viewer: true });
    for (const file of ["topic.md", "chat.md", "whiteboard.md", "sunto-finale.md", "viewer.html"]) {
      assert.ok(fs.existsSync(path.join(session.dir, file)), `${file} missing`);
    }
    const summary = fs.readFileSync(path.join(session.dir, "sunto-finale.md"), "utf8");
    assert.match(summary, /## In breve\nEsito netto/);
    assert.match(summary, /voto dei giudici/);
  });

  it("renders the chat with turns and addressees", () => {
    const chat = renderChat(sampleSession().state);
    assert.match(chat, /\*\*\[t2\] \[BETA\] → ALPHA\*\*: Replica/);
  });

  it("embeds data the page cannot break out of", () => {
    const session = sampleSession();
    const html = renderViewer(session.state, session.events());
    assert.equal(html.match(/<\/script>/g)?.length, 2, "only the two page scripts may close a script tag");
    assert.ok(!html.includes(LINE_SEPARATOR) && !html.includes(PARAGRAPH_SEPARATOR), "raw separators break the inline script");
    const json = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(json);
    assert.equal(JSON.parse(json).topic, hostileTopic);
  });
});
