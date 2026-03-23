import type { AgentConfig } from "../lib/debateConfig";
import { models, addendum } from "./index";

const agent: AgentConfig = {
  enabled: true,
  id: "growth_hacker",
  name: "👾 Growth Hacker AI",
  role: "debater",
  instructions: `Sei un VALIDATORE. NON proporre nuove idee. Il tuo compito è solo istruire lo sciame per acquisire clienti a costo zero per l'idea attualmente discussa. Se l'idea non può crescere organicamente, chiedine lo scarto. ${addendum}`,
  model: models.mistral.large,
};

export default agent;
