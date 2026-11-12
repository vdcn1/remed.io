import type { Queryable } from "./db";

export type Severity = "minor" | "moderate" | "major" | "contraindicated";
export const SEVERITY_RANK: Record<Severity, number> = { minor: 1, moderate: 2, major: 3, contraindicated: 4 };

export type DrugClass = { id: number; slug: string; name: string };

export type Drug = {
  id: number;
  slug: string;
  name: string;
  kind: "drug" | "supplement" | "food";
  aliases: string[];
  classes: DrugClass[];
};

export type DrugSuggestion = { slug: string; name: string; kind: Drug["kind"]; matched: string | null };

export type Interaction = {
  id: number;
  severity: Severity;
  summary: string;
  mechanism: string | null;
  recommendation: string | null;
  source: { name: string; kind: string; ref: string | null };
  reviewStatus: "unreviewed" | "reviewed";
  /** Verbatim sentence from the source label (text-matched rows). */
  evidence: string | null;
  /** Matcher version that produced this row (e.g. "text-match-v1"); null for hand-curated rows. */
  extractedBy: string | null;
  /** Drug whose label this row was found in. */
  labelOf: string | null;
  /** Human-readable explanation of why this rule matched, e.g. "Ibuprofen is one of the NSAIDs". */
  matchedVia: string[];
};

export type Duplication = { className: string; note: string };

const DRUG_SELECT = `
  SELECT d.id, d.slug, d.name, d.kind,
    COALESCE((SELECT json_agg(a.alias ORDER BY a.alias) FROM drug_aliases a WHERE a.drug_id = d.id), '[]') AS aliases,
    COALESCE((SELECT json_agg(json_build_object('id', c.id, 'slug', c.slug, 'name', c.name) ORDER BY c.name)
              FROM drug_class_members m JOIN drug_classes c ON c.id = m.class_id
              WHERE m.drug_id = d.id), '[]') AS classes
  FROM drugs d`;

/** Autocomplete over generic names and brand aliases. Prefix matches rank first. */
export async function searchDrugs(db: Queryable, userQuery: string, maxSuggestions = 8): Promise<DrugSuggestion[]> {
  const searchTerm = userQuery.trim().toLowerCase();
  if (!searchTerm) return [];
  const { rows: rankedSuggestions } = await db.query<DrugSuggestion & { matchRank: number }>(
    `WITH drug_name_hits AS (
       SELECT d.slug, d.name, d.kind, NULL::text AS matched,
              CASE WHEN lower(d.name) = $1 THEN 0 WHEN lower(d.name) LIKE $1 || '%' THEN 1 ELSE 3 END AS match_rank
       FROM drugs d WHERE lower(d.name) LIKE '%' || $1 || '%'
       UNION ALL
       SELECT d.slug, d.name, d.kind, a.alias,
              CASE WHEN lower(a.alias) = $1 THEN 0 WHEN lower(a.alias) LIKE $1 || '%' THEN 2 ELSE 4 END
       FROM drug_aliases a JOIN drugs d ON d.id = a.drug_id
       WHERE lower(a.alias) LIKE '%' || $1 || '%'
     )
     SELECT DISTINCT ON (slug) slug, name, kind, matched, match_rank AS "matchRank"
     FROM drug_name_hits ORDER BY slug, match_rank`,
    [searchTerm],
  );
  return rankedSuggestions
    .sort((left, right) => left.matchRank - right.matchRank || left.name.localeCompare(right.name))
    .slice(0, maxSuggestions)
    .map(({ matchRank: _matchRank, ...suggestion }) => suggestion);
}

/** Resolve free text (slug, generic name, or brand name) to a drug. */
export async function resolveDrug(db: Queryable, enteredName: string): Promise<Drug | null> {
  const normalizedName = enteredName.trim().toLowerCase();
  if (!normalizedName) return null;
  const { rows } = await db.query<Drug>(
    `${DRUG_SELECT}
     WHERE d.slug = $1 OR lower(d.name) = $1
        OR d.id IN (SELECT drug_id FROM drug_aliases WHERE lower(alias) = $1)
        -- fall back to ignoring punctuation and spaces: "st johns wort" = "St. John's Wort"
        OR regexp_replace(lower(d.name), '[^a-z0-9]', '', 'g') = $2
        OR d.id IN (SELECT drug_id FROM drug_aliases WHERE regexp_replace(lower(alias), '[^a-z0-9]', '', 'g') = $2)
     ORDER BY (d.slug = $1 OR lower(d.name) = $1) DESC
     LIMIT 1`,
    [normalizedName, normalizedName.replace(/[^a-z0-9]/g, "")],
  );
  return rows[0] ?? null;
}

type InteractionRow = {
  id: number;
  severity: Severity;
  summary: string;
  mechanism: string | null;
  recommendation: string | null;
  source_ref: string | null;
  source_name: string;
  source_kind: string;
  review_status: "unreviewed" | "reviewed";
  evidence_excerpt: string | null;
  extracted_by: string | null;
  label_of: string | null;
  a_drug_id: number | null;
  a_class_id: number | null;
  b_drug_id: number | null;
  b_class_id: number | null;
};

/** All recorded interactions between two drugs, matching on the drugs themselves or their classes. */
export async function findInteractions(db: Queryable, firstDrug: Drug, secondDrug: Drug): Promise<Interaction[]> {
  const firstDrugClassIds = firstDrug.classes.map((drugClass) => drugClass.id);
  const secondDrugClassIds = secondDrug.classes.map((drugClass) => drugClass.id);
  const { rows: interactionRows } = await db.query<InteractionRow>(
    `SELECT i.id, i.severity, i.summary, i.mechanism, i.recommendation, i.source_ref,
            i.a_drug_id, i.a_class_id, i.b_drug_id, i.b_class_id,
            i.review_status, i.evidence_excerpt, i.extracted_by,
            s.name AS source_name, s.kind AS source_kind, ld.name AS label_of
     FROM interactions i
     JOIN sources s ON s.id = i.source_id
     LEFT JOIN raw_documents rd ON rd.id = i.raw_document_id
     LEFT JOIN drugs ld ON ld.id = rd.drug_id
     WHERE i.review_status <> 'rejected' AND (((i.a_drug_id = $1 OR i.a_class_id = ANY($2::int[])) AND (i.b_drug_id = $3 OR i.b_class_id = ANY($4::int[])))
        OR ((i.a_drug_id = $3 OR i.a_class_id = ANY($4::int[])) AND (i.b_drug_id = $1 OR i.b_class_id = ANY($2::int[]))))
     ORDER BY i.severity DESC, (i.extracted_by IS NULL) DESC, i.id`,
    [firstDrug.id, firstDrugClassIds, secondDrug.id, secondDrugClassIds],
  );

  // Explains a rule match through a class, e.g. "Ibuprofen is one of the NSAIDs".
  const classReason = (drug: Drug, classId: number | null) => {
    if (classId == null) return null;
    const matchedClass = drug.classes.find((drugClass) => drugClass.id === classId);
    return matchedClass ? `${drug.name} is one of the ${matchedClass.name}` : null;
  };

  const labelNamesSeen = new Set<string>();
  return interactionRows.flatMap((row) => {
    // One row per source label: the most severe (rows are ordered by severity).
    if (row.label_of) {
      if (labelNamesSeen.has(row.label_of)) return [];
      labelNamesSeen.add(row.label_of);
    }
    // Work out which side of the rule each input drug landed on.
    const firstIsLeftSide =
      row.a_drug_id === firstDrug.id || (row.a_class_id != null && firstDrugClassIds.includes(row.a_class_id));
    const secondIsRightSide =
      row.b_drug_id === secondDrug.id || (row.b_class_id != null && secondDrugClassIds.includes(row.b_class_id));
    const isStraightOrientation = firstIsLeftSide && secondIsRightSide;
    const matchedVia = [
      classReason(firstDrug, isStraightOrientation ? row.a_class_id : row.b_class_id),
      classReason(secondDrug, isStraightOrientation ? row.b_class_id : row.a_class_id),
    ].filter((reason): reason is string => reason !== null);
    return [
      {
        id: row.id,
        severity: row.severity,
        summary: row.summary,
        mechanism: row.mechanism,
        recommendation: row.recommendation,
        source: { name: row.source_name, kind: row.source_kind, ref: row.source_ref },
        reviewStatus: row.review_status,
        evidence: row.evidence_excerpt,
        extractedBy: row.extracted_by,
        labelOf: row.label_of,
        matchedVia,
      },
    ];
  });
}

/** Flags when both drugs share a therapeutic class (e.g. two NSAIDs). */
export function findDuplications(firstDrug: Drug, secondDrug: Drug): Duplication[] {
  const secondDrugClassSlugs = new Set(secondDrug.classes.map((drugClass) => drugClass.slug));
  return firstDrug.classes
    .filter((drugClass) => secondDrugClassSlugs.has(drugClass.slug))
    .map((drugClass) => ({
      className: drugClass.name,
      note: `Both are ${drugClass.name}. Taking two drugs from the same class can duplicate the effect and add up side effects.`,
    }));
}

export function highestSeverity(interactions: Interaction[]): Severity | null {
  return interactions.reduce<Severity | null>(
    (highest, interaction) =>
      highest === null || SEVERITY_RANK[interaction.severity] > SEVERITY_RANK[highest] ? interaction.severity : highest,
    null,
  );
}
