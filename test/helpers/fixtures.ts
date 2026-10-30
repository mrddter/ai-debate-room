import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentConfig } from "../../src/lib/debateConfig";
import { models } from "../../src/lib/models";

export const LIB_DIR = path.resolve(__dirname, "../../src/lib");

export function debaterConfig(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { id, name: id.toUpperCase(), enabled: true, role: "debater", instructions: "Parla.", model: models.debater, ...overrides };
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}
