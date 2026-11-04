// Deterministic interaction finder: no AI, no network.
//
// 1. A lexicon (hash map) is built from every drug name, alias and class name in the
//    database. Keys are normalised word sequences ("st john wort", "nsaid").
// 2. Each label section is split into sentences and words. Every run of 1..N words is
//    looked up in the map (case-insensitive, longest match wins).
// 3. A sentence that mentions another drug/class is graded with keyword rules
//    ("contraindicated", "avoid", "monitor", …) to give a severity.

import { existsSync, readFileSync } from "node:fs";
import type { Queryable } from "./db";
import { classNorm } from "./normalize";

export const MATCHER_VERSION = "text-match-v1";

export type Severity = "minor" | "moderate" | "major" | "contraindicated";
const RANK: Record<Severity, number> = { minor: 1, moderate: 2, major: 3, contraindicated: 4 };

export type Target = { type: "drug" | "class"; id: number; name: string };

// ─── Lexicon ───────────────────────────────────────────────────────────────────

// Ingredient names that mostly appear in labels as ordinary words or as diluents
// ("dilute in sodium chloride", "monitor blood glucose").
const IGNORED_TERMS = new Set(
  [
    "water", "sterile water", "oxygen", "glucose", "dextrose", "sodium chloride", "sodium", "potassium",
    "calcium", "magnesium", "urea", "lactate", "talc", "ammonia", "sulfur", "copper", "xenon", "radium",
    "indium", "gallium", "glycine", "choline", "betaine", "air", "nitrogen", "helium", "carbon dioxide",
    "sodium bicarbonate", "lactated ringer", "petrolatum", "glycerin", "mineral oil", "menthol",
    "thyroid", "histamine",
  ].map(classNorm),
);

/** Common English words, used to reject brand names like "Focus" or "Soma". Optional. */
function loadDictionary(): Set<string> {
  for (const path of ["/usr/share/dict/words", "/usr/share/cracklib/cracklib-small"]) {
    if (existsSync(path)) return new Set(readFileSync(path, "utf8").toLowerCase().split("\n"));
  }
  return new Set();
}

export type Lexicon = { map: Map<string, Target>; maxWords: number };

export async function buildLexicon(db: Queryable): Promise<Lexicon> {
  const dictionary = loadDictionary();
  const map = new Map<string, Target>();
  const ambiguous = new Set<string>();

  const add = (term: string, target: Target, opts: { trusted: boolean }) => {
    const key = classNorm(term);
    if (!key || IGNORED_TERMS.has(key)) return;
    const single = !key.includes(" ");
    if (!opts.trusted && single && (key.length < 4 || dictionary.has(key))) return;
    if (single && key.length < 3) return;
    if (ambiguous.has(key)) return;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, target);
    } else if (existing.type !== target.type || existing.id !== target.id) {
      // Drugs beat classes; two different drugs sharing a name are dropped.
      if (existing.type === "class" && target.type === "drug") map.set(key, target);
      else if (existing.type === target.type) {
        map.delete(key);
        ambiguous.add(key);
      }
    }
  };

  const drugs = await db.query<{ id: number; name: string }>(`SELECT id, name FROM drugs`);
  for (const d of drugs.rows) add(d.name, { type: "drug", id: d.id, name: d.name }, { trusted: true });

  const aliases = await db.query<{ drug_id: number; name: string; alias: string; kind: string; origin: string }>(
    `SELECT a.drug_id, d.name, a.alias, a.kind, a.origin FROM drug_aliases a JOIN drugs d ON d.id = a.drug_id`,
  );
  for (const a of aliases.rows) {
    // Curated aliases and salt-form synonyms are trusted; imported brand names are filtered.
    const trusted = a.origin === "curated" || a.kind === "synonym";
    add(a.alias, { type: "drug", id: a.drug_id, name: a.name }, { trusted });
  }

  const classes = await db.query<{ class_id: number; name: string; alias: string }>(
    `SELECT a.class_id, c.name, a.alias FROM drug_class_aliases a JOIN drug_classes c ON c.id = a.class_id`,
  );
  for (const c of classes.rows) add(c.alias, { type: "class", id: c.class_id, name: c.name }, { trusted: true });

  let maxWords = 1;
  for (const key of map.keys()) maxWords = Math.max(maxWords, key.split(" ").length);
  return { map, maxWords };
}

// ─── Scanning ──────────────────────────────────────────────────────────────────

/** Split label text into sentences. Labels use numbered headings and bullets, so be generous. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    // Don't split after abbreviations: "St. John's Wort", "e.g. ketoconazole".
    .split(/(?<!\b(?:St|Dr|vs|e\.g|i\.e|approx|etc|Fig|No|Inc|Co)\.)(?<=[.;!?])\s+(?=[A-Z(•\-\d])|\s+•\s+|\s+(?=\d+(?:\.\d+)+\s+[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type Mention = { target: Target; precededByOther: boolean };

/** All lexicon entries mentioned in a sentence, longest match first at each position. */
export function findMentions(sentence: string, lex: Lexicon): Mention[] {
  const words = classNorm(sentence).split(" ").filter(Boolean);
  const found: Mention[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = 0;
    for (let n = Math.min(lex.maxWords, words.length - i); n >= 1; n--) {
      const target = lex.map.get(words.slice(i, i + n).join(" "));
      if (target) {
        found.push({ target, precededByOther: i > 0 && words[i - 1] === "other" });
        matched = n;
        break;
      }
    }
    i += matched || 1;
  }
  return found;
}

// ─── Grading ───────────────────────────────────────────────────────────────────

const NEGATIVE =
  /\b(no|not) (clinically |statistically )?(significant|relevant|meaningful|important)|\bno (dose|dosage|dosing) adjustment|\bdid not (significantly )?(affect|alter|change|increase|decrease|result|show|have)|\bno (clinically [a-z]+ )?(effect|interaction)s?\b|\bwas not (affected|altered|changed)|\bunlikely to\b|\bnot expected to\b|\bno (pharmacokinetic|pk) interaction/i;
const ALLERGY = /hypersensitiv|aspirin triad|allerg|anaphyla|asthma|urticaria|cross[- ]?reactiv|cross[- ]?sensitiv/i;
const CONTRA =
  /\bcontraindicated\b|\bdo not (use|take|administer|co-?administer|give|start)\b|\bmust not\b|\bshould not be (used|given|administered|co-?administered|taken|started)\b/i;
const AVOID = /\bavoid(ed|ing|ance)?\b|\bnot recommended\b|\bnot be (used|co-?administered) (together|concomitantly)/i;
const SERIOUS =
  /\bfatal|life[- ]threatening|\bserious\b|\bsevere\b|serotonin syndrome|\bbleed|hemorrhag|torsade|\bqtc?\b|respiratory depression|\bdeath\b|\btoxicity\b|rhabdomyolysis|myopathy|hyperkalemia|hypotension|neuroleptic malignant|seizure|coma\b|sedation/i;
const MONITOR =
  /\bmonitor|\badjust|\breduc|\bdecreas|\bincreas|\bcaution|\bconsider|\bseparate|\bspac(e|ing)|\bhours? (before|after)|\bdos(e|age|ing)|\bconcentration|\bexposure|\bplasma level|\beffect/i;

export type Grade = { severity: Severity; reason: "contraindicated" | "avoid" | "serious" | "monitor" | "section" };

/** Severity of one sentence, or null if it shouldn't count as an interaction. */
export function grade(sentence: string, section: string): Grade | null {
  if (ALLERGY.test(sentence)) return null; // "patients with aspirin allergy" is not an interaction
  const contra = CONTRA.test(sentence);
  const avoid = AVOID.test(sentence);
  const serious = SERIOUS.test(sentence);
  if (NEGATIVE.test(sentence) && !contra && !avoid) return null;

  if (contra) return { severity: "contraindicated", reason: "contraindicated" };
  if (section === "do_not_use") return { severity: "contraindicated", reason: "section" };
  if (avoid) return { severity: "major", reason: "avoid" };
  if (serious || section === "boxed_warning") return { severity: "major", reason: "serious" };
  if (MONITOR.test(sentence)) return { severity: "moderate", reason: "monitor" };
  // A bare mention only counts in sections that are about interactions.
  if (section === "drug_interactions" || section === "ask_doctor_or_pharmacist") return { severity: "moderate", reason: "section" };
  return null;
}

const SECTION_TITLES: Record<string, string> = {
  boxed_warning: "boxed warning",
  contraindications: "contraindications",
  drug_interactions: "drug interactions",
  warnings_and_cautions: "warnings and precautions",
  warnings: "warnings",
  do_not_use: "\"do not use\"",
  ask_doctor_or_pharmacist: "\"ask a doctor or pharmacist\"",
};

export function describe(drug: string, other: string, g: Grade, section: string) {
  const where = SECTION_TITLES[section] ?? section;
  const summary = {
    contraindicated: `The ${drug} label says it must not be used with ${other}.`,
    avoid: `The ${drug} label advises avoiding use with ${other}.`,
    serious: `The ${drug} label warns of a serious risk when used with ${other}.`,
    monitor: `The ${drug} label says use with ${other} may need monitoring or a dose change.`,
    section: `The ${drug} label lists ${other} in its ${where} section.`,
  }[g.reason];
  const recommendation = {
    contraindicated: "Do not combine. Talk to a doctor or pharmacist.",
    avoid: "Avoid the combination unless a doctor advises otherwise.",
    serious: "Ask a doctor or pharmacist before combining.",
    monitor: "A doctor may need to monitor you or adjust doses.",
    section: "Ask a doctor or pharmacist before combining.",
  }[g.reason];
  return { summary, recommendation };
}

export function trimAround(sentence: string, max = 450) {
  return sentence.length <= max ? sentence : sentence.slice(0, max - 1).trimEnd() + "…";
}

// ─── One document ──────────────────────────────────────────────────────────────

export type DocMatch = {
  target: Target;
  severity: Severity;
  grade: Grade;
  section: string;
  sentence: string;
};

/**
 * Every other drug/class the document's interaction sections mention, with the most severe
 * grading seen for each. `ownClassIds` are classes the labeled drug belongs to: its label
 * talks about them constantly ("NSAIDs can cause…"), so they only count as "other NSAIDs".
 */
export function scanDocument(
  sections: Record<string, string>,
  lex: Lexicon,
  self: { drugId: number; ownClassIds: Set<number> },
): DocMatch[] {
  const best = new Map<string, DocMatch>();
  for (const [section, text] of Object.entries(sections)) {
    for (const sentence of sentences(text)) {
      const mentions = findMentions(sentence, lex);
      if (mentions.length === 0) continue;
      const g = grade(sentence, section);
      if (!g) continue;
      for (const { target, precededByOther } of mentions) {
        if (target.type === "drug" && target.id === self.drugId) continue;
        if (target.type === "class" && self.ownClassIds.has(target.id) && !precededByOther) continue;
        const key = `${target.type}:${target.id}`;
        const prev = best.get(key);
        if (!prev || RANK[g.severity] > RANK[prev.severity]) {
          best.set(key, { target, severity: g.severity, grade: g, section, sentence });
        }
      }
    }
  }
  return [...best.values()];
}
