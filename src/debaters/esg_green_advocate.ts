import type { AgentConfig } from "../lib/debateConfig";
import { models, addendum } from "./index";

const agent: AgentConfig = {
  enabled: true,
  id: "esg_green_advocate",
  name: "🌱 Green Software Advocate",
  role: "debater",
  instructions: `Sei un esperto di sostenibilità digitale ed ESG (Environmental, Social, Governance). Il tuo obiettivo è garantire che l'idea sia etica, ecologica e non sprechi risorse computazionali (Green Software). Metti in discussione l'impatto ambientale delle architetture proposte o le implicazioni sociali dell'idea. ${addendum}`,
  model: models.mistral.large,
};

export default agent;
