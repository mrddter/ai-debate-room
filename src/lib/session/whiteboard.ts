export const BOARD_ITEM_KINDS = ["decision", "question", "hypothesis", "source", "note"] as const;
export type BoardItemKind = (typeof BOARD_ITEM_KINDS)[number];

export const BOARD_OPS = ["propose", "add", "accept", "reject", "resolve", "edit", "link"] as const;
export type BoardOpName = (typeof BOARD_OPS)[number];

export type BoardItemStatus = "proposed" | "accepted" | "rejected" | "open" | "resolved";

export interface BoardItem {
  id: string;
  kind: BoardItemKind;
  text: string;
  status: BoardItemStatus;
  author: string;
  turn: number;
  updatedTurn: number;
  links: string[];
  url?: string;
  note?: string;
}

export interface Board {
  items: BoardItem[];
  nextId: number;
}

// Flat shape on purpose: structured outputs handle a flat object more reliably than a discriminated union
export interface BoardOp {
  op: BoardOpName;
  id?: string;
  kind?: BoardItemKind;
  text?: string;
  url?: string;
  to?: string;
}

export interface BoardOpContext {
  author: string;
  isModerator: boolean;
  turn: number;
}

export interface BoardOpsResult {
  board: Board;
  applied: number;
  rejected: string[];
}

export function emptyBoard(): Board {
  return { items: [], nextId: 1 };
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// Pure: returns a new board; invalid ops are skipped and reported, never thrown, so a bad LLM op cannot stop a debate
export function applyBoardOps(board: Board, ops: BoardOp[], ctx: BoardOpContext): BoardOpsResult {
  const items = board.items.map((item) => ({ ...item, links: [...item.links] }));
  let nextId = board.nextId;
  let applied = 0;
  const rejected: string[] = [];
  const find = (id?: string) => items.find((item) => item.id === id);

  for (const op of ops) {
    const fail = (why: string) => rejected.push(`${op.op}${op.id ? ` ${op.id}` : ""}: ${why}`);

    // Debaters only propose and link; ratification is the moderator's job
    if (!ctx.isModerator && op.op !== "propose" && op.op !== "link") {
      fail("only the moderator can do this");
      continue;
    }

    switch (op.op) {
      case "propose":
      case "add": {
        const text = op.text?.trim();
        if (!op.kind || !BOARD_ITEM_KINDS.includes(op.kind)) {
          fail("missing or unknown kind");
          continue;
        }
        if (!text) {
          fail("missing text");
          continue;
        }
        if (op.kind === "source" && !isHttpUrl(op.url)) {
          fail("source without a valid url");
          continue;
        }
        const status: BoardItemStatus =
          op.op === "propose" ? "proposed" : op.kind === "question" ? "open" : "accepted";
        items.push({
          id: `W${nextId++}`,
          kind: op.kind,
          text,
          status,
          author: ctx.author,
          turn: ctx.turn,
          updatedTurn: ctx.turn,
          links: [],
          ...(op.kind === "source" ? { url: op.url } : {}),
        });
        applied++;
        break;
      }
      case "accept": {
        const item = find(op.id);
        if (!item) {
          fail("unknown id");
          continue;
        }
        item.status = item.kind === "question" ? "open" : "accepted";
        item.updatedTurn = ctx.turn;
        applied++;
        break;
      }
      case "reject": {
        const item = find(op.id);
        if (!item) {
          fail("unknown id");
          continue;
        }
        item.status = "rejected";
        if (op.text?.trim()) item.note = op.text.trim();
        item.updatedTurn = ctx.turn;
        applied++;
        break;
      }
      case "resolve": {
        const item = find(op.id);
        if (!item || item.kind !== "question") {
          fail("resolve applies to existing questions only");
          continue;
        }
        item.status = "resolved";
        if (op.text?.trim()) item.note = op.text.trim();
        item.updatedTurn = ctx.turn;
        applied++;
        break;
      }
      case "edit": {
        const item = find(op.id);
        const text = op.text?.trim();
        if (!item || !text) {
          fail("unknown id or missing text");
          continue;
        }
        item.text = text;
        item.updatedTurn = ctx.turn;
        applied++;
        break;
      }
      case "link": {
        const item = find(op.id);
        const target = find(op.to);
        if (!item || !target || item.id === target.id) {
          fail("link needs two distinct existing ids");
          continue;
        }
        if (!item.links.includes(target.id)) item.links.push(target.id);
        item.updatedTurn = ctx.turn;
        applied++;
        break;
      }
      default: {
        const unknownOp: never = op.op;
        fail(`unknown op ${unknownOp}`);
      }
    }
  }

  return { board: { items, nextId }, applied, rejected };
}

const KIND_LABELS: Record<BoardItemKind, string> = {
  decision: "Decisioni",
  question: "Domande",
  hypothesis: "Ipotesi",
  source: "Fonti",
  note: "Note",
};

const STATUS_LABELS: Record<BoardItemStatus, string> = {
  proposed: "proposta",
  accepted: "accettata",
  rejected: "scartata",
  open: "aperta",
  resolved: "risolta",
};

function renderItem(item: BoardItem, nameOf: (id: string) => string): string {
  const parts = [`[${item.id}] ${item.text}`];
  if (item.url) parts.push(`(${item.url})`);
  parts.push(`· ${STATUS_LABELS[item.status]} · ${nameOf(item.author)} t${item.turn}`);
  if (item.links.length > 0) parts.push(`· collegata a ${item.links.join(", ")}`);
  if (item.note) parts.push(`· nota: ${item.note}`);
  return `- ${parts.join(" ")}`;
}

// Plain text used both in prompts and in whiteboard.md
export function renderBoard(board: Board, nameOf: (id: string) => string = (id) => id): string {
  if (board.items.length === 0) return "Lavagna vuota.";
  const live = board.items.filter((item) => item.status !== "rejected");
  const sections = BOARD_ITEM_KINDS.map((kind) => {
    const rows = live.filter((item) => item.kind === kind);
    if (rows.length === 0) return "";
    return `## ${KIND_LABELS[kind]}\n${rows.map((item) => renderItem(item, nameOf)).join("\n")}`;
  }).filter(Boolean);
  const discarded = board.items.filter((item) => item.status === "rejected");
  if (discarded.length > 0) {
    sections.push(`## Scartate (non riproporre)\n${discarded.map((item) => renderItem(item, nameOf)).join("\n")}`);
  }
  return sections.join("\n\n");
}
