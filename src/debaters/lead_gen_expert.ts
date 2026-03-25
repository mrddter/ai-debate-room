import type { AgentConfig } from "../lib/debateConfig";
import { models, addendum } from "./index";

const agent: AgentConfig = {
  enabled: true,
  id: "lead_gen_expert",
  name: "🎯 Esperto Lead Generation",

  description: "Maestro nell'attirare e catturare potenziali clienti.",
  skills: ["B2B Outreach", "Funnel di Vendita", "Cold Emailing"],
  whenToUse:
    "Per trasformare un prodotto valido in un flusso costante di contatti commerciali qualificati.",
  role: "debater",
  instructions: `Sei lo specialista dell'acquisizione di lead (prospect) e delle strategie di mercato (SEO, GEO, campagne ADV). Pensi a come portare le persone a conoscere e acquistare il prodotto. Se l'idea non ha un canale di acquisizione chiaro o se il costo di acquisizione (CAC) supererebbe di gran lunga i margini di profitto, fai notare che il prodotto, per quanto bello, non venderà mai. ${addendum}`,
  model: models.debater,
};

export default agent;
