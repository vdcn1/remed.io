import type { Queryable } from "../lib/db";
import { classNorm } from "../lib/normalize";
import { classes, drugs, interactions } from "./seed-data";

export async function seed(db: Queryable) {
  const {
    rows: [curatedSource],
  } = await db.query<{ id: number }>(
    `INSERT INTO sources (slug, name, kind, license)
     VALUES ('curated', 'remed.io curated starter set', 'curated', 'internal')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );

  const classIdBySlug = new Map<string, number>();
  for (const drugClass of classes) {
    const { rows: classRows } = await db.query<{ id: number }>(
      `INSERT INTO drug_classes (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [drugClass.slug, drugClass.name],
    );
    classIdBySlug.set(drugClass.slug, classRows[0].id);
    for (const alias of [drugClass.name, drugClass.slug, ...(drugClass.aliases ?? [])]) {
      await db.query(
        `INSERT INTO drug_class_aliases (class_id, alias, norm) VALUES ($1, $2, $3)
         ON CONFLICT (norm) DO UPDATE SET class_id = EXCLUDED.class_id, alias = EXCLUDED.alias`,
        [classRows[0].id, alias, classNorm(alias)],
      );
    }
  }

  const drugIdBySlug = new Map<string, number>();
  for (const drug of drugs) {
    const { rows: drugRows } = await db.query<{ id: number }>(
      `INSERT INTO drugs (slug, name, kind) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, updated_at = now()
       RETURNING id`,
      [drug.slug, drug.name, drug.kind ?? "drug"],
    );
    const drugId = drugRows[0].id;
    drugIdBySlug.set(drug.slug, drugId);

    for (const alias of drug.aliases ?? []) {
      await db.query(
        `INSERT INTO drug_aliases (drug_id, alias) VALUES ($1, $2)
         ON CONFLICT (lower(alias)) DO NOTHING`,
        [drugId, alias],
      );
    }
    for (const classSlug of drug.classes ?? []) {
      const classId = classIdBySlug.get(classSlug);
      if (!classId) throw new Error(`Unknown class "${classSlug}" on drug "${drug.slug}"`);
      await db.query(
        `INSERT INTO drug_class_members (drug_id, class_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [drugId, classId],
      );
    }
  }

  // "class:<slug>" names a class; anything else names a drug. Returns [drugId, classId].
  const resolveSubject = (subject: string): [number | null, number | null] => {
    if (subject.startsWith("class:")) {
      const classId = classIdBySlug.get(subject.slice(6));
      if (!classId) throw new Error(`Unknown class subject "${subject}"`);
      return [null, classId];
    }
    const drugId = drugIdBySlug.get(subject);
    if (!drugId) throw new Error(`Unknown drug subject "${subject}"`);
    return [drugId, null];
  };

  // Curated interactions are fully replaced on each seed so edits to seed-data.ts apply.
  await db.query(`DELETE FROM interactions WHERE source_id = $1`, [curatedSource.id]);
  for (const interaction of interactions) {
    const [aDrugId, aClassId] = resolveSubject(interaction.a);
    const [bDrugId, bClassId] = resolveSubject(interaction.b);
    await db.query(
      `INSERT INTO interactions
         (a_drug_id, a_class_id, b_drug_id, b_class_id, severity, summary, mechanism, recommendation, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        aDrugId,
        aClassId,
        bDrugId,
        bClassId,
        interaction.severity,
        interaction.summary,
        interaction.mechanism ?? null,
        interaction.recommendation ?? null,
        curatedSource.id,
      ],
    );
  }

  return { drugs: drugs.length, classes: classes.length, interactions: interactions.length };
}
