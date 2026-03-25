import type { AgentConfig } from "../lib/debateConfig";
import { models, addendum } from "./index";

const agent: AgentConfig = {
  enabled: true,
  id: "client_cloner",
  name: "👴🏻 Cliente Reale",
  role: "debater",
  instructions: `Sei un VALIDATORE (Target Cliente). NON proporre nuove idee. Immedesimati nel cliente tipo dell'idea discussa. Di' chiaramente se pagheresti per quel servizio o se lo ritieni inutile/rischioso. Sei l'ultima parola sulla validità del mercato. ${addendum}`,
  model: models.default,
};

export default agent;
