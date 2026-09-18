/**
 * The niches the new-series wizard offers as one-click starting points.
 *
 * A preset is a *prefill*, never a setting. Nothing here is stored: choosing
 * one writes a name, a script style, a couple of prompt-variable answers and a
 * starter topic list into the wizard's draft, and the operator edits all of it
 * on the next screen before anything is saved. That is also why the topics are
 * allowed to exist at all in a codebase that otherwise refuses to invent a
 * subject — they are a first draft the operator reads, keeps, deletes or
 * rewrites, and the series only ever runs what is in the box when Create is
 * pressed.
 *
 * The script style is named, not id'd. Styles are the operator's own
 * `PromptTemplate` rows, and the only link a copied catalogue style keeps back
 * to `SCRIPT_STYLES` is its name — the same match `starterSubjectsForStyleName`
 * relies on. So each preset lists the catalogue names it would prefer, in
 * order, and `resolvePresetStyle` falls back to the operator's default when
 * their library holds none of them. The wizard says which one it picked.
 *
 * Only `audience` and `tone` are prefilled, and only when the resolved style
 * declares them: those are the two variables most catalogue styles share, and
 * an answer to a variable the style does not declare is one the service would
 * discard anyway.
 */

import type { AutomationScriptStyle } from "@/services/automation.service";

export type NichePresetId =
  | "history-stories"
  | "historical-figures"
  | "mythology"
  | "mysteries"
  | "personal-finance";

export interface NichePreset {
  id: NichePresetId;
  title: string;
  /** One line on the card: what the show is about. */
  description: string;
  /** What the series is called unless the operator types something else. */
  seriesName: string;
  /** Catalogue style names, most suitable first. */
  scriptStyleNames: readonly string[];
  variables: { audience?: string; tone?: string };
  topics: readonly string[];
}

export const NICHE_PRESETS: readonly NichePreset[] = [
  {
    id: "history-stories",
    title: "History stories",
    description: "One turning point or forgotten episode per video, told as a story.",
    seriesName: "History stories",
    // "One real story told in order, from the decision to the consequence" is
    // exactly the shape of a history episode.
    scriptStyleNames: ["Case study", "Default script"],
    variables: {
      audience: "curious adults who enjoy a good story",
      tone: "vivid and narrative, but accurate",
    },
    topics: [
      "The Great Molasses Flood of 1919",
      "The Christmas truce of 1914",
      "How the Year Without a Summer changed the world",
      "The dancing plague of 1518",
      "How a press conference mistake opened the Berlin Wall",
      "The pigeon that saved hundreds of soldiers in the First World War",
    ],
  },
  {
    id: "historical-figures",
    title: "Historical figures",
    description: "One life per video — who they were, and why it still matters.",
    seriesName: "Historical figures",
    scriptStyleNames: ["Case study", "Default script"],
    variables: {
      audience: "curious adults who enjoy biography",
      tone: "warm, specific and even-handed",
    },
    topics: [
      "Ada Lovelace and the first computer program",
      "Hatshepsut, the pharaoh history tried to erase",
      "Mansa Musa and the pilgrimage that crashed the price of gold",
      "Marie Curie's two Nobel Prizes",
      "Ibn Battuta's thirty-year journey",
      "Nikola Tesla's rise and fall",
    ],
  },
  {
    id: "mythology",
    title: "Mythology",
    description: "Myths and legends retold, and what they meant to the people who told them.",
    seriesName: "Mythology",
    scriptStyleNames: ["Default script"],
    variables: {
      audience: "adults and teenagers who love old stories",
      tone: "dramatic and atmospheric",
    },
    topics: [
      "Prometheus and the theft of fire",
      "Orpheus and Eurydice",
      "The twelve labours of Heracles",
      "Anubis and the weighing of the heart",
      "Izanagi, Izanami and the making of Japan",
      "How Thor got his hammer",
    ],
  },
  {
    id: "mysteries",
    title: "Mysteries",
    description: "Unsolved cases and strange events, with the evidence laid out fairly.",
    seriesName: "Unsolved mysteries",
    scriptStyleNames: ["Case study", "Default script"],
    variables: {
      audience: "adults who like a puzzle",
      tone: "suspenseful but careful with the facts",
    },
    topics: [
      "The Dyatlov Pass incident",
      "What happened to the lost colony of Roanoke",
      "The crew of the Mary Celeste",
      "The Voynich manuscript",
      "The Somerton Man",
      "The Wow! signal",
    ],
  },
  {
    id: "personal-finance",
    title: "Personal finance",
    description: "How money actually works — interest, investing, debt and inflation.",
    seriesName: "Money explained",
    scriptStyleNames: ["Default script"],
    variables: {
      audience: "adults managing their own money for the first time",
      tone: "plain, practical and never preachy",
    },
    topics: [
      "How compound interest actually works",
      "Why index funds beat most professional investors",
      "What inflation does to money in a savings account",
      "How a credit score is calculated",
      "The real cost of a car loan",
      "Why an emergency fund comes before investing",
    ],
  },
];

export function findNichePreset(id: string | null | undefined): NichePreset | null {
  return NICHE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * The operator's script style a preset should use: the first of its preferred
 * catalogue names present in their library, else their category default, else
 * whatever they have first. Null only for a library with no SCRIPT styles at
 * all, which the readiness blockers stop before the wizard renders.
 */
export function resolvePresetStyle(
  preset: NichePreset,
  scriptStyles: readonly AutomationScriptStyle[],
): AutomationScriptStyle | null {
  for (const name of preset.scriptStyleNames) {
    const match = scriptStyles.find((style) => style.name === name);

    if (match) {
      return match;
    }
  }

  return scriptStyles.find((style) => style.isDefault) ?? scriptStyles[0] ?? null;
}
