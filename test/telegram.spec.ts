import assert from "node:assert/strict";
import { splitMessage } from "../src/lib/telegram";

// Regression: a 45K character board sent as one message got a 400 from Telegram and the error stopped the bot
describe("telegram message splitting", () => {
  it("keeps short texts whole", () => {
    assert.deepEqual(splitMessage("Lavagna\n\n- W1"), ["Lavagna\n\n- W1"]);
    assert.deepEqual(splitMessage(""), []);
  });

  it("cuts long texts at line breaks, every part under the limit, nothing lost", () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `- [W${index}] ${"testo ".repeat(index % 7)}`);
    const text = lines.join("\n");
    const parts = splitMessage(text);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.length <= 4000));
    assert.equal(parts.join("\n"), text);
  });

  it("cuts a line without breaks at the limit, never inside an emoji", () => {
    const text = "a".repeat(9) + "😀" + "b".repeat(5);
    const parts = splitMessage(text, 10);
    assert.deepEqual(parts, ["a".repeat(9), "😀bbbbb"]);
  });
});
