import type { Queryable } from "../lib/db";
import { classNorm } from "../lib/normalize";
import { classes, drugs, interactions } from "./seed-data";

export async function seed(db: Queryable) {
  const {
    rows: [source],
  } = await db.query<{ id: number }>(
    `INSERT INTO sources (slug, name, kind, license)
     VALUES ('curated', 'remed.io curated starter set', 'curated', 'internal')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );

  const classIds = new Map<string, number>();
  for (const c of classes) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO drug_classes (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [c.slug, c.name],
    );
    classIds.set(c.slug, rows[0].id);
    for (const alias of [c.name, c.slug, ...(c.aliases ?? [])]) {
      await db.query(
        `INSERT INTO drug_class_aliases (class_id, alias, norm) VALUES ($1, $2, $3)
         ON CONFLICT (norm) DO UPDATE SET class_id = EXCLUDED.class_id, alias = EXCLUDED.alias`,
        [rows[0].id, alias, classNorm(alias)],
      );
    }
  }

  const drugIds = new Map<string, number>();
  for (const d of drugs) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO drugs (slug, name, kind) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, updated_at = now()
       RETURNING id`,
      [d.slug, d.name, d.kind ?? "drug"],
    );
    const id = rows[0].id;
    drugIds.set(d.slug, id);

    for (const alias of d.aliases ?? []) {
      await db.query(
        `INSERT INTO drug_aliases (drug_id, alias) VALUES ($1, $2)
         ON CONFLICT (lower(alias)) DO NOTHING`,
        [id, alias],
      );
    }
    for (const cls of d.classes ?? []) {
      const classId = classIds.get(cls);
      if (!classId) throw new Error(`Unknown class "${cls}" on drug "${d.slug}"`);
      await db.query(
        `INSERT INTO drug_class_members (drug_id, class_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, classId],
      );
    }
  }

  const resolve = (subject: string): [number | null, number | null] => {
    if (subject.startsWith("class:")) {
      const id = classIds.get(subject.slice(6));
      if (!id) throw new Error(`Unknown class subject "${subject}"`);
      return [null, id];
    }
    const id = drugIds.get(subject);
    if (!id) throw new Error(`Unknown drug subject "${subject}"`);
    return [id, null];
  };

  // Curated interactions are fully replaced on each seed so edits to seed-data.ts apply.
  await db.query(`DELETE FROM interactions WHERE source_id = $1`, [source.id]);
  for (const i of interactions) {
    const [aDrug, aClass] = resolve(i.a);
    const [bDrug, bClass] = resolve(i.b);
    await db.query(
      `INSERT INTO interactions
         (a_drug_id, a_class_id, b_drug_id, b_class_id, severity, summary, mechanism, recommendation, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [aDrug, aClass, bDrug, bClass, i.severity, i.summary, i.mechanism ?? null, i.recommendation ?? null, source.id],
    );
  }

  return { drugs: drugs.length, classes: classes.length, interactions: interactions.length };
}
