import assert from "node:assert/strict";
import { applyBoardOps, emptyBoard, renderBoard } from "../src/lib/session/whiteboard";

const debater = { author: "alpha", isModerator: false, turn: 1 };
const moderator = { author: "moderator", isModerator: true, turn: 2 };

describe("whiteboard", () => {
  it("lets debaters propose and only the moderator ratify", () => {
    const proposed = applyBoardOps(
      emptyBoard(),
      [
        { op: "propose", kind: "decision", text: "Lanciare in Italia" },
        { op: "add", kind: "decision", text: "Bypass del moderatore" },
        { op: "accept", id: "W1" },
      ],
      debater,
    );
    assert.equal(proposed.board.items.length, 1);
    assert.equal(proposed.board.items[0].status, "proposed");
    assert.equal(proposed.rejected.length, 2);

    const ratified = applyBoardOps(proposed.board, [{ op: "accept", id: "W1" }], moderator);
    assert.equal(ratified.board.items[0].status, "accepted");
    assert.equal(ratified.board.items[0].updatedTurn, 2);
  });

  it("is pure: the input board is never mutated", () => {
    const board = applyBoardOps(emptyBoard(), [{ op: "propose", kind: "note", text: "x" }], debater).board;
    applyBoardOps(board, [{ op: "reject", id: "W1", text: "fuori tema" }], moderator);
    assert.equal(board.items[0].status, "proposed");
  });

  it("validates sources, questions and links", () => {
    const { board, rejected } = applyBoardOps(
      emptyBoard(),
      [
        { op: "add", kind: "source", text: "Senza url" },
        { op: "add", kind: "source", text: "Url non web", url: "javascript:alert(1)" },
        { op: "add", kind: "source", text: "Istat", url: "https://www.istat.it/dati" },
        { op: "add", kind: "question", text: "Quale prezzo?" },
        { op: "resolve", id: "W1", text: "non è una domanda" },
        { op: "resolve", id: "W2", text: "49 euro" },
        { op: "link", id: "W2", to: "W2" },
        { op: "link", id: "W2", to: "W1" },
      ],
      moderator,
    );
    assert.deepEqual(
      board.items.map((item) => [item.id, item.kind, item.status]),
      [
        ["W1", "source", "accepted"],
        ["W2", "question", "resolved"],
      ],
    );
    assert.equal(board.items[0].url, "https://www.istat.it/dati");
    assert.equal(board.items[1].note, "49 euro");
    assert.deepEqual(board.items[1].links, ["W1"]);
    assert.equal(rejected.length, 4);
  });

  it("renders live items by kind and discarded ones apart", () => {
    const { board } = applyBoardOps(
      emptyBoard(),
      [
        { op: "add", kind: "decision", text: "Prezzo 49 euro" },
        { op: "add", kind: "hypothesis", text: "Mercato B2C" },
        { op: "reject", id: "W2", text: "nessun dato" },
      ],
      moderator,
    );
    const text = renderBoard(board, (id) => (id === "moderator" ? "Moderatore" : id));
    assert.match(text, /## Decisioni\n- \[W1\] Prezzo 49 euro · accettata · Moderatore t2/);
    assert.match(text, /## Scartate \(non riproporre\)\n- \[W2\] Mercato B2C · scartata .* nota: nessun dato/);
    assert.doesNotMatch(text, /## Ipotesi/);
    assert.equal(renderBoard(emptyBoard()), "Lavagna vuota.");
  });
});
