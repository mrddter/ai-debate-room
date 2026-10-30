import * as fs from "fs";
import * as path from "path";
import { MODE_LABELS, MODERATOR_ID, STAGE_LABELS, USER_ID, type DebateEvent, type FinishReason } from "./events";
import { latestVerdicts, nameOf, type DebateState, type UsageTotals } from "./state";
import { renderBoard } from "./whiteboard";

const FINISH_LABELS: Record<FinishReason, string> = {
  judges: "voto dei giudici",
  max_turns: "limite massimo di turni",
  budget: "budget di spesa raggiunto",
  user_stop: "interruzione dell'utente",
  error: "errore",
};

export const usd = (value: number) => `$${value.toFixed(2)}`;

// Estimated from src/lib/pricing.ts, not read from the invoice
export function spendLine(state: DebateState): string {
  const cap = state.settings.maxCostUsd;
  return `${usd(state.usage.total.costUsd)}${cap > 0 ? ` su ${usd(cap)} di budget` : " (nessun budget)"}`;
}

function formatDuration(state: DebateState): string {
  if (!state.startedAt) return "N/A";
  const end = state.endedAt ? Date.parse(state.endedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(state.startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function usageRow(label: string, usage: UsageTotals): string {
  return `| ${label} | ${usage.calls} | ${usage.inputTokens} | ${usage.cachedInputTokens} | ${usage.cacheWriteTokens} | ${usage.outputTokens} | ${usage.webSearches} | ${usage.costUsd.toFixed(3)} | ${Math.round(usage.ms / 1000)} |`;
}

export function renderMetrics(state: DebateState): string {
  const header =
    "| Voce | Chiamate | Input tok | letti da cache | scritti in cache | Output tok | Ricerche web | Costo $ | Secondi |\n|---|---|---|---|---|---|---|---|---|";
  const byPurpose = Object.entries(state.usage.byPurpose).map(([purpose, usage]) => usageRow(purpose, usage));
  const byAgent = Object.entries(state.usage.byAgent).map(([agentId, usage]) => usageRow(nameOf(state, agentId), usage));
  return [
    `- **Durata**: ${formatDuration(state)}`,
    `- **Modalità**: ${MODE_LABELS[state.mode]}`,
    `- **Fase raggiunta**: ${STAGE_LABELS[state.stage]}`,
    `- **Spesa stimata**: ${spendLine(state)}`,
    `- **Debaters**: ${state.debaters.length}`,
    `- **Interventi**: ${state.turn}`,
    `- **Messaggi totali**: ${state.messages.length}`,
    `- **Elementi in lavagna**: ${state.board.items.length}`,
    `- **Chiamate a tool**: ${state.toolCalls}`,
    `- **Errori registrati**: ${state.errors}`,
    `- **Fine**: ${state.finishReason ? FINISH_LABELS[state.finishReason] : "in corso"}`,
    "",
    "### Uso LLM per scopo",
    header,
    usageRow("totale", state.usage.total),
    ...byPurpose,
    "",
    "### Uso LLM per agente",
    header,
    ...byAgent,
  ].join("\n");
}

export function renderTopic(state: DebateState): string {
  const participants = state.debaters.map((debater) => `- ${debater.name} (\`${debater.id}\`)`).join("\n");
  const intro = state.messages.find((message) => message.kind === "moderator")?.text ?? "";
  return `# Tema\n\n${state.topic}\n\n## Partecipanti\n${participants || "Nessuno"}\n\n## Introduzione del moderatore\n${intro}\n`;
}

export function renderChat(state: DebateState): string {
  return state.messages
    .map((message) => {
      const replyTo = message.replyTo.length > 0 ? ` → ${message.replyTo.map((id) => nameOf(state, id)).join(", ")}` : "";
      return `**[t${message.turn}] [${nameOf(state, message.speakerId)}]${replyTo}**: ${message.text}`;
    })
    .join("\n\n---\n\n");
}

export function renderWhiteboard(state: DebateState): string {
  return `# Lavagna\n\n${renderBoard(state.board, (id) => nameOf(state, id))}\n`;
}

export function renderSummary(state: DebateState): string {
  const verdicts = latestVerdicts(state)
    .map((verdict) => `- **${verdict.judgeName}**: ${verdict.isReady ? "pronto" : "non pronto"}, maturità ${verdict.maturityDegree}/5. ${verdict.reason}`)
    .join("\n");
  const points = (state.summary?.focalPoints ?? []).map((point, index) => `${index + 1}. ${point}`).join("\n");
  const summary = state.summary
    ? `## In breve\n${state.summary.inShort}\n\n## Punti focali\n${points || "Nessuno."}\n\n## Sintesi del dibattito\n${state.summary.text}`
    : "## Sintesi del dibattito\nNessun sunto generato.";
  return `# Sunto finale\n\n## Tema\n${state.topic}\n\n${summary}\n\n## Ultimo voto dei giudici\n${verdicts || "Nessun voto."}\n\n## Metriche\n${renderMetrics(state)}\n`;
}

// From char codes: these characters are line terminators and cannot appear literally inside a regex literal
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// JSON inside <script> must not be able to close the tag or break the parser
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

export function renderViewer(state: DebateState, events: DebateEvent[]): string {
  const names = Object.fromEntries([...state.debaters.map((d) => d.id), MODERATOR_ID, USER_ID].map((id) => [id, nameOf(state, id)]));
  const data = {
    topic: state.topic,
    debateId: state.debateId,
    finishReason: state.finishReason ?? null,
    board: renderBoard(state.board, (id) => nameOf(state, id)),
    summary: state.summary ?? null,
    metrics: renderMetrics(state),
    names,
    events,
  };
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>Dibattito ${state.debateId}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1d1d1f;background:#f6f6f4}
header{padding:16px 24px;background:#fff;border-bottom:1px solid #ddd;position:sticky;top:0}
h1{font-size:18px;margin:0 0 8px}
main{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:16px;padding:16px 24px}
section{background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px 16px;min-width:0}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font:12px/1.45 ui-monospace,monospace}
.ev{border-left:3px solid #ccc;padding:4px 10px;margin:6px 0}
.ev .meta{color:#666;font-size:12px}
.speech{border-color:#2b6cb0}.moderator_message{border-color:#805ad5}.hand_raised,.hand_lowered{border-color:#d69e2e}
.floor_given{border-color:#38a169}.whiteboard_ops{border-color:#dd6b20}.judge_verdict{border-color:#e53e3e}
.error{border-color:#c53030;background:#fff5f5}.research_done,.tool_call{border-color:#319795}
label{margin-right:10px;font-size:12px;white-space:nowrap}
</style>
</head>
<body>
<header><h1 id="title"></h1><div id="filters"></div></header>
<main>
<section><h2>Cronologia</h2><div id="timeline"></div></section>
<section><h2>Lavagna</h2><pre id="board"></pre><h2>Sunto</h2><pre id="summary"></pre><h2>Metriche</h2><pre id="metrics"></pre></section>
</main>
<script type="application/json" id="data">${embedJson(data)}</script>
<script>
const data = JSON.parse(document.getElementById("data").textContent);
const name = (id) => data.names[id] || id;
const numbered = (points) => (points || []).map((p, i) => (i + 1) + ". " + p).join("\\n");
document.getElementById("title").textContent = data.topic + (data.finishReason ? " (fine: " + data.finishReason + ")" : " (in corso)");
document.getElementById("board").textContent = data.board;
document.getElementById("summary").textContent = data.summary
  ? [data.summary.inShort, numbered(data.summary.focalPoints), data.summary.text].filter(Boolean).join("\\n\\n")
  : "Nessun sunto.";
document.getElementById("metrics").textContent = data.metrics;
const describe = {
  debate_started: (e) => "Tema: " + e.topic + " (" + e.mode + ")",
  debaters_selected: (e) => "Partecipanti: " + e.debaters.map((d) => d.name).join(", "),
  moderator_message: (e) => "[" + e.kind + "] " + e.text + (e.inShort ? "\\n\\nIn breve: " + e.inShort : "") + (e.focalPoints ? "\\n\\nPunti focali:\\n" + numbered(e.focalPoints) : ""),
  stage_changed: (e) => "Fase: " + e.stage + "\\n" + e.text,
  floor_given: (e) => "Parola a " + name(e.speakerId) + " (" + e.source + "): " + e.reason,
  speech: (e) => name(e.speakerId) + (e.replyTo.length ? " → " + e.replyTo.map(name).join(", ") : "") + "\\n" + e.text,
  notebook_updated: (e) => "Taccuino di " + name(e.debaterId) + ":\\n" + e.notebook,
  whiteboard_ops: (e) => name(e.author) + ": " + e.ops.map((o) => [o.op, o.id, o.kind, o.text, o.url, o.to].filter(Boolean).join(" ")).join("\\n"),
  hand_raised: (e) => "✋ " + name(e.debaterId) + " [" + e.kind + "] " + e.pitch + (e.target ? " → " + name(e.target) : ""),
  hand_lowered: (e) => "Mano abbassata: " + name(e.debaterId),
  research_done: (e) => "Ricerca di " + name(e.debaterId) + ":\\n" + e.notes + "\\n" + e.sources.map((s) => s.title + " " + s.url).join("\\n"),
  tool_call: (e) => name(e.agentId) + " → " + e.tool + " " + JSON.stringify(e.input),
  judge_verdict: (e) => e.judgeName + ": " + (e.isReady ? "pronto" : "non pronto") + ", maturità " + e.maturityDegree + "/5. " + e.reason,
  llm_usage: (e) => name(e.agentId) + " " + e.purpose + " " + e.model + ": in " + e.inputTokens + " (cache " + e.cachedInputTokens + "/" + e.cacheWriteTokens + "), out " + e.outputTokens + ", $" + e.costUsd.toFixed(4) + ", " + e.ms + "ms",
  error: (e) => e.scope + ": " + e.message,
  debate_finished: (e) => "Fine: " + e.reason,
};
const hiddenByDefault = new Set(["llm_usage", "notebook_updated", "tool_call"]);
const types = [...new Set(data.events.map((e) => e.type))];
const visible = new Set(types.filter((t) => !hiddenByDefault.has(t)));
const filters = document.getElementById("filters");
for (const type of types) {
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = visible.has(type);
  box.onchange = () => { box.checked ? visible.add(type) : visible.delete(type); render(); };
  label.append(box, " " + type);
  filters.append(label);
}
function render() {
  const timeline = document.getElementById("timeline");
  timeline.replaceChildren();
  for (const e of data.events) {
    if (!visible.has(e.type)) continue;
    const row = document.createElement("div");
    row.className = "ev " + e.type;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "#" + e.seq + " t" + e.turn + " " + e.ts.slice(11, 19) + " " + e.type;
    const body = document.createElement("pre");
    body.textContent = (describe[e.type] || ((x) => JSON.stringify(x)))(e);
    row.append(meta, body);
    timeline.append(row);
  }
}
render();
</script>
</body>
</html>
`;
}

export function writeProjections(dir: string, state: DebateState, events?: DebateEvent[]) {
  fs.writeFileSync(path.join(dir, "topic.md"), renderTopic(state), "utf8");
  fs.writeFileSync(path.join(dir, "chat.md"), renderChat(state), "utf8");
  fs.writeFileSync(path.join(dir, "whiteboard.md"), renderWhiteboard(state), "utf8");
  fs.writeFileSync(path.join(dir, "sunto-finale.md"), renderSummary(state), "utf8");
  if (events) fs.writeFileSync(path.join(dir, "viewer.html"), renderViewer(state, events), "utf8");
}
