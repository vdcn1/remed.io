// LLM extraction of interactions from FDA label text, and resolution of the
// extracted names onto drugs/classes in the database.

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Queryable } from "./db";
import { classNorm, displayName, slugify } from "./normalize";

export const EXTRACT_MODEL = process.env.REMEDIO_EXTRACT_MODEL ?? "claude-opus-5-5";
export const EXTRACT_EFFORT = (process.env.REMEDIO_EXTRACT_EFFORT ?? "medium") as "low" | "medium" | "high";
export const MAX_TOKENS = 32000;

// ─── Output schema ─────────────────────────────────────────────────────────────

export const ExtractedInteraction = z.object({
  interacts_with: z.string().describe("Generic name of the other drug, or the group exactly as the label names it"),
  kind: z.enum(["drug", "class", "supplement", "food"]),
  examples: z.array(z.string()).describe("For a class: example drugs the label lists, as generic names. Otherwise empty."),
  severity: z.enum(["minor", "moderate", "major", "contraindicated"]),
  summary: z.string(),
  mechanism: z.string().nullable(),
  recommendation: z.string().nullable(),
  evidence: z.string().describe("A sentence or phrase copied verbatim from the label"),
});
export const ExtractionOutput = z.object({ interactions: z.array(ExtractedInteraction) });
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export const outputFormat = zodOutputFormat(ExtractionOutput);

// ─── Prompt ────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You extract drug interactions from official FDA drug labels for a consumer-facing interaction checker. Your output is shown to patients as "AI-extracted from the FDA label, not reviewed by a clinician", next to the quote you cite, so faithfulness to the label matters more than coverage.

Report every interaction the label states between the labeled drug and another substance: a drug, a group of drugs, a supplement, or a food or drink (alcohol, grapefruit juice, …). Use only the label text; never add outside knowledge.

Leave out: interference with lab tests; interactions with procedures, devices, or vaccines given as a procedure; contraindications that are about diseases, pregnancy, or allergy to the drug itself; and any pairing the label says has no clinically significant interaction. Never list the labeled drug itself.

Fields:
- interacts_with: lowercase generic name for a single substance (never a brand name). For a group, the group as the label names it, e.g. "strong CYP3A4 inhibitors", "NSAIDs", "other serotonergic drugs".
- kind: drug, class, supplement, or food.
- examples: for a class, the specific drugs the label gives as examples (lowercase generic names); otherwise an empty list.
- severity:
  - contraindicated: the label says the combination is contraindicated or must not be used.
  - major: the label says to avoid the combination, or warns of serious harm (bleeding, serotonin syndrome, respiratory depression, QT prolongation or arrhythmia, severe hypotension, toxicity), including boxed warnings.
  - moderate: the label advises monitoring, a dose adjustment, separating doses, or warns of reduced effectiveness.
  - minor: a small change the label says needs no action.
- summary: one plain-language sentence for a patient, at most 25 words, no jargon.
- mechanism: a short explanation if the label gives one, otherwise null.
- recommendation: what the label advises, at most 30 words, otherwise null.
- evidence: one sentence or phrase copied character-for-character from the label (at most 300 characters) that supports this entry.

If one sentence covers several separately named drugs with the same advice, emit one entry per drug only when they are not presented as a group; when the label presents a group with examples, emit one class entry with the examples.

If the label states no interactions, return an empty list.`;

const SECTION_TITLES: Record<string, string> = {
  boxed_warning: "Boxed warning",
  contraindications: "Contraindications",
  drug_interactions: "Drug interactions",
  warnings_and_cautions: "Warnings and precautions",
  warnings: "Warnings",
  do_not_use: "Do not use",
  ask_doctor_or_pharmacist: "Ask a doctor or pharmacist before use if you are",
};

export type LabelDocument = {
  id: number;
  drug_name: string;
  content: { substances: string[]; sections: Record<string, string> };
  content_hash: string;
  url: string | null;
};

export function buildRequest(doc: LabelDocument): Anthropic.MessageCreateParamsNonStreaming {
  const sections = Object.entries(doc.content.sections)
    .map(([key, text]) => `<section title="${SECTION_TITLES[key] ?? key}">\n${text}\n</section>`)
    .join("\n\n");
  return {
    model: EXTRACT_MODEL,
    max_tokens: MAX_TOKENS,
    output_config: {
      effort: EXTRACT_EFFORT,
      format: { type: "json_schema", schema: outputFormat.schema },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Labeled drug: ${doc.drug_name} (active substance: ${doc.content.substances.join(", ")})\n\n${sections}`,
      },
    ],
  };
}

/** Parse the model's structured output from a finished message. */
export function parseMessage(
  message: Pick<Anthropic.Message, "content" | "stop_reason"> | Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason">,
): ExtractionOutput {
  if (message.stop_reason === "refusal") throw new Error("Model declined (refusal)");
  if (message.stop_reason === "max_tokens") throw new Error("Output truncated (max_tokens)");
  const blocks = message.content as { type: string; text?: string }[];
  const text = blocks.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No text block in response");
  return ExtractionOutput.parse(JSON.parse(text));
}

// ─── Resolution ────────────────────────────────────────────────────────────────

const SEVERITY_RANK = { minor: 1, moderate: 2, major: 3, contraindicated: 4 } as const;

const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

async function findDrug(db: Queryable, name: string): Promise<number | null> {
  const term = name.trim().toLowerCase();
  const { rows } = await db.query<{ id: number }>(
    `SELECT d.id FROM drugs d
     WHERE d.slug = $2 OR lower(d.name) = $1
        OR d.id IN (SELECT drug_id FROM drug_aliases WHERE lower(alias) = $1)
     ORDER BY (lower(d.name) = $1) DESC LIMIT 1`,
    [term, slugify(term)],
  );
  return rows[0]?.id ?? null;
}

async function findClass(db: Queryable, name: string): Promise<{ id: number; origin: string } | null> {
  const { rows } = await db.query<{ id: number; origin: string }>(
    `SELECT c.id, c.origin FROM drug_class_aliases a JOIN drug_classes c ON c.id = a.class_id WHERE a.norm = $1`,
    [classNorm(name)],
  );
  return rows[0] ?? null;
}

export type ResolveStats = {
  extracted: number;
  inserted: number;
  unresolved: string[];
  unverified: number;
  self: number;
  classesCreated: number;
};

/**
 * Turn one extraction's output into interaction rows (replacing any earlier rows
 * from the same document). Every row is stored as review_status = 'unreviewed'.
 */
export async function resolveExtraction(
  db: Queryable,
  opts: { doc: LabelDocument & { drug_id: number }; output: ExtractionOutput; model: string; sourceId: number },
): Promise<ResolveStats> {
  const { doc, output, model, sourceId } = opts;
  const stats: ResolveStats = { extracted: output.interactions.length, inserted: 0, unresolved: [], unverified: 0, self: 0, classesCreated: 0 };
  const labelText = squash(Object.values(doc.content.sections).join("\n"));

  // Keep the most severe entry per counterpart
  const rows = new Map<string, { bDrug: number | null; bClass: number | null; item: (typeof output.interactions)[number] }>();

  for (const item of output.interactions) {
    // The quote must really be in the label; otherwise the entry is dropped.
    const evidence = squash(item.evidence).replace(/^["'…\s]+|["'…\s]+$/g, "");
    if (evidence.length < 8 || !labelText.includes(evidence)) {
      stats.unverified++;
      continue;
    }

    let bDrug: number | null = null;
    let bClass: number | null = null;

    if (item.kind === "class") {
      const cls = await findClass(db, item.interacts_with);
      const exampleIds: number[] = [];
      for (const e of item.examples) {
        const id = await findDrug(db, e); // sequential: `db` may be a single client
        if (id !== null && id !== doc.drug_id) exampleIds.push(id);
      }
      if (cls) {
        bClass = cls.id;
        if (cls.origin === "label-mention") await addMembers(db, cls.id, exampleIds);
      } else if (exampleIds.length > 0) {
        bClass = await createMentionClass(db, item.interacts_with, exampleIds);
        stats.classesCreated++;
      } else {
        // A group with no recognisable name or examples, e.g. "drugs that lower seizure threshold"
        stats.unresolved.push(item.interacts_with);
        continue;
      }
    } else {
      bDrug = await findDrug(db, item.interacts_with);
      if (bDrug === null) {
        const cls = await findClass(db, item.interacts_with);
        if (cls) bClass = cls.id;
      }
      if (bDrug === null && bClass === null && (item.kind === "food" || item.kind === "supplement")) {
        bDrug = await createSubstance(db, item.interacts_with, item.kind);
      }
      if (bDrug === null && bClass === null) {
        stats.unresolved.push(item.interacts_with);
        continue;
      }
    }

    if (bDrug === doc.drug_id) {
      stats.self++;
      continue;
    }
    const key = bDrug !== null ? `d${bDrug}` : `c${bClass}`;
    const prev = rows.get(key);
    if (!prev || SEVERITY_RANK[item.severity] > SEVERITY_RANK[prev.item.severity]) rows.set(key, { bDrug, bClass, item });
  }

  await db.query(`DELETE FROM interactions WHERE raw_document_id = $1`, [doc.id]);
  for (const { bDrug, bClass, item } of rows.values()) {
    await db.query(
      `INSERT INTO interactions
         (a_drug_id, b_drug_id, b_class_id, severity, summary, mechanism, recommendation,
          source_id, source_ref, evidence_excerpt, extracted_by, raw_document_id, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'unreviewed')`,
      [
        doc.drug_id, bDrug, bClass, item.severity, item.summary, item.mechanism, item.recommendation,
        sourceId, doc.url, item.evidence.trim(), model, doc.id,
      ],
    );
    stats.inserted++;
  }
  return stats;
}

async function addMembers(db: Queryable, classId: number, drugIds: number[]) {
  for (const id of drugIds) {
    await db.query(
      `INSERT INTO drug_class_members (drug_id, class_id, origin) VALUES ($1, $2, 'extraction') ON CONFLICT DO NOTHING`,
      [id, classId],
    );
  }
}

/** A group named in a label ("strong CYP3A4 inhibitors"), whose members are the examples labels give. */
async function createMentionClass(db: Queryable, name: string, memberIds: number[]) {
  const norm = classNorm(name);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO drug_classes (slug, name, origin) VALUES ($1, $2, 'label-mention')
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
    [`mention-${slugify(norm)}`, name.charAt(0).toUpperCase() + name.slice(1)],
  );
  const id = rows[0].id;
  await db.query(
    `INSERT INTO drug_class_aliases (class_id, alias, norm) VALUES ($1, $2, $3) ON CONFLICT (norm) DO NOTHING`,
    [id, name, norm],
  );
  await addMembers(db, id, memberIds);
  return id;
}

async function createSubstance(db: Queryable, name: string, kind: "food" | "supplement") {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO drugs (slug, name, kind) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET updated_at = now() RETURNING id`,
    [slugify(name), displayName(name), kind],
  );
  return rows[0].id;
}
