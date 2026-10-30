import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { addendum } from "../src/lib/models";
import {
  generatedToConfig,
  loadDebaterConfigs,
  renderDebaterModule,
  sanitizeDebaterId,
  writeDebaterModule,
  type GeneratedDebater,
} from "../src/lib/debaterFiles";
import { debaterSelectionSchema } from "../src/lib/schemas";
import { LIB_DIR, tempDir } from "./helpers/fixtures";

// Model-written text with everything that broke or could break the old string-concatenated template
const hostile: GeneratedDebater = {
  id: "esperto_quote",
  name: 'L\'esperto "virgolette"',
  description: "Backtick ` e ${process.exit(1)}",
  skills: ["a\nb", "c\\d"],
  whenToUse: "</script> */ //",
  instructions: 'Rispondi "sempre" con `codice` e ${interpolazioni}\nsu più righe; poi \\ e \' fine',
  tools: ["webSearch", "calculator"],
};

describe("generated debater modules", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir("debaters");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Regression for the smart-mode bug: the addendum was concatenated into the source as raw code
  it("renders a module that loads back to exactly the generated config", async () => {
    fs.writeFileSync(path.join(dir, `${hostile.id}.ts`), renderDebaterModule(hostile, LIB_DIR));
    const [loaded] = await loadDebaterConfigs(dir);
    assert.ok(loaded, "the generated module must load");
    assert.equal(loaded.instructions, hostile.instructions + " " + addendum);
    assert.deepEqual(loaded, generatedToConfig(hostile));
  });

  it("never overwrites an existing debater and sanitizes the id", () => {
    const first = writeDebaterModule({ ...hostile, id: "../evil id" }, dir);
    assert.equal(first, path.join(dir, "evilid.ts"));
    assert.equal(writeDebaterModule({ ...hostile, id: "evilid", name: "Altro" }, dir), null);
    assert.equal(writeDebaterModule({ ...hostile, id: "!!!" }, dir), null);
    assert.equal(sanitizeDebaterId("a-b_c.1"), "ab_c1");
    // A debater named like the moderator or the user would hijack their messages and their floor
    assert.deepEqual(["moderator", "us-er", "user"].map(sanitizeDebaterId), ["", "", ""]);
    assert.equal(writeDebaterModule({ ...hostile, id: "user" }, dir), null);
  });

  // Regression: the moderator wrote "web_search", the key was dropped and the new role lost web research
  it("accepts only known tool keys for generated debaters", () => {
    const generated = (tools: string[]) =>
      debaterSelectionSchema.safeParse({ debaters: [], newDebaters: [{ ...hostile, reason: "serve", tools }] }).success;
    assert.equal(generated(["webSearch", "webFetch", "calculator"]), true);
    assert.equal(generated(["web_search"]), false);
  });

  it("refuses to load a debater file that uses a reserved id", async () => {
    fs.writeFileSync(path.join(dir, "user.ts"), renderDebaterModule({ ...hostile, id: "user" }, LIB_DIR));
    assert.deepEqual(await loadDebaterConfigs(dir), []);
  });

  it("drops unknown tools and disabled debaters when loading", async () => {
    fs.writeFileSync(path.join(dir, "uno.ts"), renderDebaterModule({ ...hostile, id: "uno", tools: ["webSearch", "teleport" as any] }, LIB_DIR));
    fs.writeFileSync(path.join(dir, "due.ts"), renderDebaterModule({ ...hostile, id: "due" }, LIB_DIR).replace("enabled: true", "enabled: false"));
    const loaded = await loadDebaterConfigs(dir);
    assert.deepEqual(
      loaded.map((config) => [config.id, config.tools]),
      [["uno", ["webSearch"]]],
    );
  });
});
