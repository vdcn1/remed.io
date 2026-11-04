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
export async function searchDrugs(db: Queryable, q: string, limit = 8): Promise<DrugSuggestion[]> {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const { rows } = await db.query<DrugSuggestion & { rank: number }>(
    `WITH hits AS (
       SELECT d.slug, d.name, d.kind, NULL::text AS matched,
              CASE WHEN lower(d.name) = $1 THEN 0 WHEN lower(d.name) LIKE $1 || '%' THEN 1 ELSE 3 END AS rank
       FROM drugs d WHERE lower(d.name) LIKE '%' || $1 || '%'
       UNION ALL
       SELECT d.slug, d.name, d.kind, a.alias,
              CASE WHEN lower(a.alias) = $1 THEN 0 WHEN lower(a.alias) LIKE $1 || '%' THEN 2 ELSE 4 END
       FROM drug_aliases a JOIN drugs d ON d.id = a.drug_id
       WHERE lower(a.alias) LIKE '%' || $1 || '%'
     )
     SELECT DISTINCT ON (slug) slug, name, kind, matched, rank
     FROM hits ORDER BY slug, rank`,
    [term],
  );
  return rows
    .sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name))
    .slice(0, limit)
    .map(({ rank: _rank, ...s }) => s);
}

/** Resolve free text (slug, generic name, or brand name) to a drug. */
export async function resolveDrug(db: Queryable, input: string): Promise<Drug | null> {
  const term = input.trim().toLowerCase();
  if (!term) return null;
  const { rows } = await db.query<Drug>(
    `${DRUG_SELECT}
     WHERE d.slug = $1 OR lower(d.name) = $1
        OR d.id IN (SELECT drug_id FROM drug_aliases WHERE lower(alias) = $1)
        -- fall back to ignoring punctuation and spaces: "st johns wort" = "St. John's Wort"
        OR regexp_replace(lower(d.name), '[^a-z0-9]', '', 'g') = $2
        OR d.id IN (SELECT drug_id FROM drug_aliases WHERE regexp_replace(lower(alias), '[^a-z0-9]', '', 'g') = $2)
     ORDER BY (d.slug = $1 OR lower(d.name) = $1) DESC
     LIMIT 1`,
    [term, term.replace(/[^a-z0-9]/g, "")],
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
export async function findInteractions(db: Queryable, a: Drug, b: Drug): Promise<Interaction[]> {
  const aClassIds = a.classes.map((c) => c.id);
  const bClassIds = b.classes.map((c) => c.id);
  const { rows } = await db.query<InteractionRow>(
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
    [a.id, aClassIds, b.id, bClassIds],
  );

  const via = (drug: Drug, classId: number | null) => {
    if (classId == null) return null;
    const cls = drug.classes.find((c) => c.id === classId);
    return cls ? `${drug.name} is one of the ${cls.name}` : null;
  };

  const seenLabels = new Set<string>();
  return rows.flatMap((r) => {
    // One row per source label: the most severe (rows are ordered by severity).
    if (r.label_of) {
      if (seenLabels.has(r.label_of)) return [];
      seenLabels.add(r.label_of);
    }
    // Work out which side of the rule each input drug landed on.
    const aOnLeft = r.a_drug_id === a.id || (r.a_class_id != null && aClassIds.includes(r.a_class_id));
    const bOnRight = r.b_drug_id === b.id || (r.b_class_id != null && bClassIds.includes(r.b_class_id));
    const straight = aOnLeft && bOnRight;
    const matchedVia = [
      via(a, straight ? r.a_class_id : r.b_class_id),
      via(b, straight ? r.b_class_id : r.a_class_id),
    ].filter((x): x is string => x !== null);
    return [{
      id: r.id,
      severity: r.severity,
      summary: r.summary,
      mechanism: r.mechanism,
      recommendation: r.recommendation,
      source: { name: r.source_name, kind: r.source_kind, ref: r.source_ref },
      reviewStatus: r.review_status,
      evidence: r.evidence_excerpt,
      extractedBy: r.extracted_by,
      labelOf: r.label_of,
      matchedVia,
    }];
  });
}

/** Flags when both drugs share a therapeutic class (e.g. two NSAIDs). */
export function findDuplications(a: Drug, b: Drug): Duplication[] {
  const bSlugs = new Set(b.classes.map((c) => c.slug));
  return a.classes
    .filter((c) => bSlugs.has(c.slug))
    .map((c) => ({
      className: c.name,
      note: `Both are ${c.name}. Taking two drugs from the same class can duplicate the effect and add up side effects.`,
    }));
}

export function highestSeverity(list: Interaction[]): Severity | null {
  return list.reduce<Severity | null>(
    (max, i) => (max === null || SEVERITY_RANK[i.severity] > SEVERITY_RANK[max] ? i.severity : max),
    null,
  );
}
