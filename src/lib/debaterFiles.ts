import * as fs from "fs";
import * as path from "path";
import type { AgentConfig } from "./debateConfig";
import { addendum, models } from "./models";
import { isToolKey, type ToolKey } from "../mcp/index";

export const DEBATERS_DIR = path.join(__dirname, "..", "debaters");

export interface GeneratedDebater {
  id: string;
  name: string;
  description: string;
  skills: string[];
  whenToUse: string;
  instructions: string;
  tools: ToolKey[];
}

export function sanitizeDebaterId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "");
}

export function toToolKeys(values: readonly string[] | undefined, owner: string): ToolKey[] {
  const keys: ToolKey[] = [];
  for (const value of values ?? []) {
    if (isToolKey(value)) keys.push(value);
    else console.warn(`[debaters] ${owner}: unknown tool "${value}" ignored`);
  }
  return keys;
}

// Every model-provided string goes through JSON.stringify: it is a valid TS string literal and cannot inject code
export function renderDebaterModule(debater: GeneratedDebater, libImport = "../lib"): string {
  const literal = (value: unknown) => JSON.stringify(value);
  return `import type { AgentConfig } from ${literal(`${libImport}/debateConfig`)};
import { models, addendum } from ${literal(`${libImport}/models`)};

const agent: AgentConfig = {
  enabled: true,
  id: ${literal(debater.id)},
  name: ${literal(debater.name)},
  description: ${literal(debater.description)},
  skills: ${literal(debater.skills)},
  whenToUse: ${literal(debater.whenToUse)},
  role: "debater",
  instructions: ${literal(debater.instructions)} + " " + addendum,
  model: models.debater,
  tools: ${literal(debater.tools)},
};

export default agent;
`;
}

// Same config the rendered module evaluates to, so a debater behaves identically before and after its file exists
export function generatedToConfig(debater: GeneratedDebater): AgentConfig {
  return {
    enabled: true,
    id: debater.id,
    name: debater.name,
    description: debater.description,
    skills: debater.skills,
    whenToUse: debater.whenToUse,
    role: "debater",
    instructions: debater.instructions + " " + addendum,
    model: models.debater,
    tools: debater.tools,
  };
}

/** Writes src/debaters/<id>.ts. Returns null when the id is empty or already taken: generated files never overwrite. */
export function writeDebaterModule(debater: GeneratedDebater, dir = DEBATERS_DIR): string | null {
  const safeId = sanitizeDebaterId(debater.id);
  if (!safeId) return null;
  const filePath = path.join(dir, `${safeId}.ts`);
  if (fs.existsSync(filePath)) return null;
  fs.writeFileSync(filePath, renderDebaterModule({ ...debater, id: safeId }), "utf8");
  return filePath;
}

export async function loadDebaterConfigs(dir = DEBATERS_DIR): Promise<AgentConfig[]> {
  const files = fs.readdirSync(dir).filter((file) => /\.(ts|js)$/.test(file) && !file.startsWith("index.") && !file.endsWith(".d.ts"));
  const configs: AgentConfig[] = [];
  for (const file of files) {
    try {
      const module = await import(path.join(dir, file));
      const config = module.default as AgentConfig | undefined;
      if (!config?.id) {
        console.warn(`[debaters] ${file} has no valid default export`);
        continue;
      }
      if (config.enabled === false) continue;
      configs.push({ ...config, tools: toToolKeys(config.tools, config.id) });
    } catch (err) {
      console.error(`[debaters] failed to load ${file}:`, err);
    }
  }
  return configs;
}
