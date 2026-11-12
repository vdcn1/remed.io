// Deterministic interaction finder: no AI, no network.
//
// 1. A lexicon is built from every drug name, alias and class name in the database.
//    Phrases are normalised word sequences ("st john wort", "nsaid") mapped to their Target.
// 2. The lexicon is compiled into an Aho-Corasick automaton over words. Each label
//    section is split into sentences; one pass per sentence finds the mentions, taking the
//    longest phrase at each word.
// 3. A sentence that mentions another drug or class is graded with keyword rules
//    ("contraindicated", "avoid", "monitor", …) to give a severity.

import { existsSync, readFileSync } from "node:fs";
import type { Queryable } from "./db";
import { classNorm } from "./normalize";

export const MATCHER_VERSION = "text-match-v1";

export type Severity = "minor" | "moderate" | "major" | "contraindicated";
const SEVERITY_RANK: Record<Severity, number> = { minor: 1, moderate: 2, major: 3, contraindicated: 4 };

/** The drug or class a phrase in label text refers to. */
export type Target = { type: "drug" | "class"; id: number; name: string };

// ─── Lexicon ───────────────────────────────────────────────────────────────────

// Ingredient names that mostly appear in labels as ordinary words or as diluents
// ("dilute in sodium chloride", "monitor blood glucose").
const IGNORED_LABEL_TERMS = new Set(
  [
    "water", "sterile water", "oxygen", "glucose", "dextrose", "sodium chloride", "sodium", "potassium",
    "calcium", "magnesium", "urea", "lactate", "talc", "ammonia", "sulfur", "copper", "xenon", "radium",
    "indium", "gallium", "glycine", "choline", "betaine", "air", "nitrogen", "helium", "carbon dioxide",
    "sodium bicarbonate", "lactated ringer", "petrolatum", "glycerin", "mineral oil", "menthol",
    "thyroid", "histamine",
  ].map(classNorm),
);

/** Common English words, used to reject brand names like "Focus" or "Soma". Optional. */
function loadEnglishWords(): Set<string> {
  for (const wordListPath of ["/usr/share/dict/words", "/usr/share/cracklib/cracklib-small"]) {
    if (existsSync(wordListPath)) return new Set(readFileSync(wordListPath, "utf8").toLowerCase().split("\n"));
  }
  return new Set();
}

export type Lexicon = {
  phraseToTarget: Map<string, Target>;
  maxWordsPerPhrase: number;
  automaton?: PhraseAutomaton;
};

// ─── Aho-Corasick over words ───────────────────────────────────────────────────

/**
 * Trie over word sequences with failure links (Aho & Corasick, 1975). The alphabet is
 * whole words, so a phrase can only match on word boundaries.
 */
export type PhraseAutomaton = {
  childrenByNode: Map<string, number>[];
  failureLinkByNode: Int32Array; // longest proper suffix of the node's words that is also a trie node
  dictionaryLinkByNode: Int32Array; // nearest phrase-ending node on the failure chain (-1 if none)
  wordCountByNode: Int32Array; // phrase length in words
  targetByNode: (Target | null)[]; // target for phrases that end at this node
};

export function buildPhraseAutomaton(phraseToTarget: Map<string, Target>): PhraseAutomaton {
  const childrenByNode: Map<string, number>[] = [new Map()];
  const wordCounts: number[] = [0];
  const targetByNode: (Target | null)[] = [null];

  for (const [phrase, target] of phraseToTarget) {
    let currentNode = 0;
    for (const word of phrase.split(" ")) {
      let childNode = childrenByNode[currentNode].get(word);
      if (childNode === undefined) {
        childNode = childrenByNode.length;
        childrenByNode.push(new Map());
        wordCounts.push(wordCounts[currentNode] + 1);
        targetByNode.push(null);
        childrenByNode[currentNode].set(word, childNode);
      }
      currentNode = childNode;
    }
    targetByNode[currentNode] = target;
  }

  const nodeCount = childrenByNode.length;
  const failureLinkByNode = new Int32Array(nodeCount);
  const dictionaryLinkByNode = new Int32Array(nodeCount).fill(-1);

  // Breadth-first, so each node's failure link is computed after its ancestors'.
  const nodesToVisit: number[] = [...childrenByNode[0].values()];
  for (let visitIndex = 0; visitIndex < nodesToVisit.length; visitIndex++) {
    const parentNode = nodesToVisit[visitIndex];
    for (const [word, childNode] of childrenByNode[parentNode]) {
      let candidateFailNode = failureLinkByNode[parentNode];
      while (candidateFailNode !== 0 && !childrenByNode[candidateFailNode].has(word)) {
        candidateFailNode = failureLinkByNode[candidateFailNode];
      }
      failureLinkByNode[childNode] = childrenByNode[candidateFailNode].get(word) ?? 0;
      const failTarget = failureLinkByNode[childNode];
      dictionaryLinkByNode[childNode] = targetByNode[failTarget] ? failTarget : dictionaryLinkByNode[failTarget];
      nodesToVisit.push(childNode);
    }
  }

  return {
    childrenByNode,
    failureLinkByNode,
    dictionaryLinkByNode,
    wordCountByNode: Int32Array.from(wordCounts),
    targetByNode,
  };
}

/** For each word position, the longest phrase that starts there (0 words if none). */
function longestPhraseStartingAt(words: string[], automaton: PhraseAutomaton) {
  const longestWordCountAt = new Int32Array(words.length);
  const longestTargetNodeAt = new Int32Array(words.length);
  let currentNode = 0;
  for (let endWordIndex = 0; endWordIndex < words.length; endWordIndex++) {
    const word = words[endWordIndex];
    while (currentNode !== 0 && !automaton.childrenByNode[currentNode].has(word)) {
      currentNode = automaton.failureLinkByNode[currentNode];
    }
    currentNode = automaton.childrenByNode[currentNode].get(word) ?? 0;

    // Every phrase ending at this word: the current node if it is a phrase, then its dictionary links.
    let phraseNode = automaton.targetByNode[currentNode] ? currentNode : automaton.dictionaryLinkByNode[currentNode];
    while (phraseNode !== -1) {
      const phraseWordCount = automaton.wordCountByNode[phraseNode];
      const startWordIndex = endWordIndex - phraseWordCount + 1;
      if (phraseWordCount > longestWordCountAt[startWordIndex]) {
        longestWordCountAt[startWordIndex] = phraseWordCount;
        longestTargetNodeAt[startWordIndex] = phraseNode;
      }
      phraseNode = automaton.dictionaryLinkByNode[phraseNode];
    }
  }
  return { longestWordCountAt, longestTargetNodeAt };
}

export async function buildLexicon(db: Queryable): Promise<Lexicon> {
  const englishWords = loadEnglishWords();
  const phraseToTarget = new Map<string, Target>();
  const ambiguousPhrases = new Set<string>();

  const addPhrase = (rawName: string, target: Target, options: { trusted: boolean }) => {
    const phrase = classNorm(rawName);
    if (!phrase || IGNORED_LABEL_TERMS.has(phrase)) return;
    const isSingleWord = !phrase.includes(" ");
    // Untrusted single words must be long enough and not be common English words.
    if (!options.trusted && isSingleWord && (phrase.length < 4 || englishWords.has(phrase))) return;
    if (isSingleWord && phrase.length < 3) return;
    if (ambiguousPhrases.has(phrase)) return;

    const existingTarget = phraseToTarget.get(phrase);
    if (!existingTarget) {
      phraseToTarget.set(phrase, target);
    } else if (existingTarget.type !== target.type || existingTarget.id !== target.id) {
      // Drugs beat classes; two different drugs sharing a name are dropped.
      if (existingTarget.type === "class" && target.type === "drug") phraseToTarget.set(phrase, target);
      else if (existingTarget.type === target.type) {
        phraseToTarget.delete(phrase);
        ambiguousPhrases.add(phrase);
      }
    }
  };

  const drugRows = await db.query<{ id: number; name: string }>(`SELECT id, name FROM drugs`);
  for (const drugRow of drugRows.rows) {
    addPhrase(drugRow.name, { type: "drug", id: drugRow.id, name: drugRow.name }, { trusted: true });
  }

  const drugAliasRows = await db.query<{ drug_id: number; name: string; alias: string; kind: string; origin: string }>(
    `SELECT a.drug_id, d.name, a.alias, a.kind, a.origin FROM drug_aliases a JOIN drugs d ON d.id = a.drug_id`,
  );
  for (const aliasRow of drugAliasRows.rows) {
    // Curated aliases and salt-form synonyms are trusted; imported brand names are filtered.
    const isTrusted = aliasRow.origin === "curated" || aliasRow.kind === "synonym";
    addPhrase(aliasRow.alias, { type: "drug", id: aliasRow.drug_id, name: aliasRow.name }, { trusted: isTrusted });
  }

  const classAliasRows = await db.query<{ class_id: number; name: string; alias: string }>(
    `SELECT a.class_id, c.name, a.alias FROM drug_class_aliases a JOIN drug_classes c ON c.id = a.class_id`,
  );
  for (const classAliasRow of classAliasRows.rows) {
    addPhrase(classAliasRow.alias, { type: "class", id: classAliasRow.class_id, name: classAliasRow.name }, { trusted: true });
  }

  let maxWordsPerPhrase = 1;
  for (const phrase of phraseToTarget.keys()) {
    maxWordsPerPhrase = Math.max(maxWordsPerPhrase, phrase.split(" ").length);
  }
  return { phraseToTarget, maxWordsPerPhrase, automaton: buildPhraseAutomaton(phraseToTarget) };
}

// ─── Scanning ──────────────────────────────────────────────────────────────────

/** Split label text into sentences. Labels use numbered headings and bullets, so be generous. */
export function sentences(labelText: string): string[] {
  return labelText
    .replace(/\s+/g, " ")
    // Don't split after abbreviations: "St. John's Wort", "e.g. ketoconazole".
    .split(/(?<!\b(?:St|Dr|vs|e\.g|i\.e|approx|etc|Fig|No|Inc|Co)\.)(?<=[.;!?])\s+(?=[A-Z(•\-\d])|\s+•\s+|\s+(?=\d+(?:\.\d+)+\s+[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** One drug or class mentioned in a sentence. */
export type Mention = { target: Target; precededByOther: boolean };

/**
 * All lexicon targets mentioned in a sentence. Scans left to right; at each word the longest
 * phrase starting there is taken and scanning resumes after it.
 */
export function findMentions(sentence: string, lexicon: Lexicon): Mention[] {
  const words = classNorm(sentence).split(" ").filter(Boolean);
  const automaton = lexicon.automaton ?? (lexicon.automaton = buildPhraseAutomaton(lexicon.phraseToTarget));
  const { longestWordCountAt, longestTargetNodeAt } = longestPhraseStartingAt(words, automaton);

  const mentions: Mention[] = [];
  let wordIndex = 0;
  while (wordIndex < words.length) {
    const matchedWordCount = longestWordCountAt[wordIndex];
    if (matchedWordCount > 0) {
      mentions.push({
        target: automaton.targetByNode[longestTargetNodeAt[wordIndex]]!,
        precededByOther: wordIndex > 0 && words[wordIndex - 1] === "other",
      });
      wordIndex += matchedWordCount;
    } else {
      wordIndex++;
    }
  }
  return mentions;
}

// ─── Grading ───────────────────────────────────────────────────────────────────

// Keyword rules, applied to one sentence at a time.
const NEGATED_OR_NON_SIGNIFICANT =
  /\b(no|not) (clinically |statistically )?(significant|relevant|meaningful|important)|\bno (dose|dosage|dosing) adjustment|\bdid not (significantly )?(affect|alter|change|increase|decrease|result|show|have)|\bno (clinically [a-z]+ )?(effect|interaction)s?\b|\bwas not (affected|altered|changed)|\bunlikely to\b|\bnot expected to\b|\bno (pharmacokinetic|pk) interaction/i;
const ALLERGY_CONTEXT = /hypersensitiv|aspirin triad|allerg|anaphyla|asthma|urticaria|cross[- ]?reactiv|cross[- ]?sensitiv/i;
const CONTRAINDICATION_WORDING =
  /\bcontraindicated\b|\bdo not (use|take|administer|co-?administer|give|start)\b|\bmust not\b|\bshould not be (used|given|administered|co-?administered|taken|started)\b/i;
const AVOIDANCE_WORDING = /\bavoid(ed|ing|ance)?\b|\bnot recommended\b|\bnot be (used|co-?administered) (together|concomitantly)/i;
const SERIOUS_HARM_WORDING =
  /\bfatal|life[- ]threatening|\bserious\b|\bsevere\b|serotonin syndrome|\bbleed|hemorrhag|torsade|\bqtc?\b|respiratory depression|\bdeath\b|\btoxicity\b|rhabdomyolysis|myopathy|hyperkalemia|hypotension|neuroleptic malignant|seizure|coma\b|sedation/i;
const MONITORING_WORDING =
  /\bmonitor|\badjust|\breduc|\bdecreas|\bincreas|\bcaution|\bconsider|\bseparate|\bspac(e|ing)|\bhours? (before|after)|\bdos(e|age|ing)|\bconcentration|\bexposure|\bplasma level|\beffect/i;

export type Grade = {
  severity: Severity;
  reason: "contraindicated" | "avoid" | "serious" | "monitor" | "section";
};

/** Severity of one sentence, or null if it shouldn't count as an interaction. */
export function grade(sentence: string, labelSection: string): Grade | null {
  if (ALLERGY_CONTEXT.test(sentence)) return null; // "patients with aspirin allergy" is not an interaction
  const hasContraindication = CONTRAINDICATION_WORDING.test(sentence);
  const advisesAvoidance = AVOIDANCE_WORDING.test(sentence);
  const mentionsSeriousHarm = SERIOUS_HARM_WORDING.test(sentence);
  if (NEGATED_OR_NON_SIGNIFICANT.test(sentence) && !hasContraindication && !advisesAvoidance) return null;

  if (hasContraindication) return { severity: "contraindicated", reason: "contraindicated" };
  if (labelSection === "do_not_use") return { severity: "contraindicated", reason: "section" };
  if (advisesAvoidance) return { severity: "major", reason: "avoid" };
  if (mentionsSeriousHarm || labelSection === "boxed_warning") return { severity: "major", reason: "serious" };
  if (MONITORING_WORDING.test(sentence)) return { severity: "moderate", reason: "monitor" };
  // A bare mention only counts in sections that are about interactions.
  if (labelSection === "drug_interactions" || labelSection === "ask_doctor_or_pharmacist") {
    return { severity: "moderate", reason: "section" };
  }
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

/** Plain-language summary and recommendation for one grade. */
export function describe(drugName: string, otherName: string, sentenceGrade: Grade, labelSection: string) {
  const sectionTitle = SECTION_TITLES[labelSection] ?? labelSection;
  const summary = {
    contraindicated: `The ${drugName} label says it must not be used with ${otherName}.`,
    avoid: `The ${drugName} label advises avoiding use with ${otherName}.`,
    serious: `The ${drugName} label warns of a serious risk when used with ${otherName}.`,
    monitor: `The ${drugName} label says use with ${otherName} may need monitoring or a dose change.`,
    section: `The ${drugName} label lists ${otherName} in its ${sectionTitle} section.`,
  }[sentenceGrade.reason];
  const recommendation = {
    contraindicated: "Do not combine. Talk to a doctor or pharmacist.",
    avoid: "Avoid the combination unless a doctor advises otherwise.",
    serious: "Ask a doctor or pharmacist before combining.",
    monitor: "A doctor may need to monitor you or adjust doses.",
    section: "Ask a doctor or pharmacist before combining.",
  }[sentenceGrade.reason];
  return { summary, recommendation };
}

export function trimAround(sentence: string, maxLength = 450) {
  return sentence.length <= maxLength ? sentence : sentence.slice(0, maxLength - 1).trimEnd() + "…";
}

// ─── One document ──────────────────────────────────────────────────────────────

/** The strongest interaction found in one label for one other drug or class. */
export type DocumentMatch = {
  target: Target;
  severity: Severity;
  grade: Grade;
  section: string;
  sentence: string;
};

/**
 * Every other drug or class the label's interaction sections mention, with the most severe
 * grading seen for each. `ownClassIds` are classes the labeled drug belongs to: its label
 * talks about them constantly ("NSAIDs can cause…"), so they only count as "other NSAIDs".
 */
export function scanDocument(
  labelSections: Record<string, string>,
  lexicon: Lexicon,
  labeledDrug: { drugId: number; ownClassIds: Set<number> },
): DocumentMatch[] {
  const strongestMatchByTarget = new Map<string, DocumentMatch>();
  for (const [section, sectionText] of Object.entries(labelSections)) {
    for (const sentence of sentences(sectionText)) {
      const mentions = findMentions(sentence, lexicon);
      if (mentions.length === 0) continue;
      const sentenceGrade = grade(sentence, section);
      if (!sentenceGrade) continue;
      for (const { target, precededByOther } of mentions) {
        if (target.type === "drug" && target.id === labeledDrug.drugId) continue;
        if (target.type === "class" && labeledDrug.ownClassIds.has(target.id) && !precededByOther) continue;
        const targetKey = `${target.type}:${target.id}`;
        const previousMatch = strongestMatchByTarget.get(targetKey);
        if (!previousMatch || SEVERITY_RANK[sentenceGrade.severity] > SEVERITY_RANK[previousMatch.severity]) {
          strongestMatchByTarget.set(targetKey, { target, severity: sentenceGrade.severity, grade: sentenceGrade, section, sentence });
        }
      }
    }
  }
  return [...strongestMatchByTarget.values()];
}
