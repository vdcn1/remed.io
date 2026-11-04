// Stage 3: find interactions in the stored FDA label text by exact word matching.
// No AI and no network: deterministic and free to re-run.
//
//   npm run match                      all labels
//   npm run match -- --only=warfarin   just these drug slugs (prints what it found)
//   npm run match -- --stats           also print the most frequently matched names

import { Client } from "pg";
import { buildLexicon, describe, MATCHER_VERSION, scanDocument, trimAround } from "../lib/textmatch";

try {
  process.loadEnvFile(".env.local");
} catch {}

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",").map((s) => s.trim().toLowerCase());
const showStats = args.includes("--stats");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const t0 = Date.now();
  const lex = await buildLexicon(db);
  console.log(`Lexicon: ${lex.map.size} terms, up to ${lex.maxWords} words long`);

  const { rows: docs } = await db.query<{
    id: number;
    drug_id: number;
    drug_name: string;
    url: string | null;
    source_id: number;
    sections: Record<string, string>;
    own_class_ids: number[];
  }>(
    `SELECT r.id, r.drug_id, d.name AS drug_name, r.url, r.source_id, r.content->'sections' AS sections,
            COALESCE(array_agg(m.class_id) FILTER (WHERE m.class_id IS NOT NULL), '{}') AS own_class_ids
     FROM raw_documents r
     JOIN drugs d ON d.id = r.drug_id
     LEFT JOIN drug_class_members m ON m.drug_id = d.id
     WHERE ($1::text[] IS NULL OR d.slug = ANY($1))
     GROUP BY r.id, d.id`,
    [only ?? null],
  );

  const counts = { contraindicated: 0, major: 0, moderate: 0, minor: 0 };
  const targetFreq = new Map<string, number>();
  let total = 0;

  await db.query("BEGIN");
  try {
    for (const doc of docs) {
      const matches = scanDocument(doc.sections, lex, { drugId: doc.drug_id, ownClassIds: new Set(doc.own_class_ids) });
      await db.query(`DELETE FROM interactions WHERE raw_document_id = $1`, [doc.id]);
      for (const m of matches) {
        const { summary, recommendation } = describe(doc.drug_name, m.target.name, m.grade, m.section);
        await db.query(
          `INSERT INTO interactions
             (a_drug_id, b_drug_id, b_class_id, severity, summary, recommendation,
              source_id, source_ref, evidence_excerpt, extracted_by, raw_document_id, review_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unreviewed')`,
          [
            doc.drug_id,
            m.target.type === "drug" ? m.target.id : null,
            m.target.type === "class" ? m.target.id : null,
            m.severity,
            summary,
            recommendation,
            doc.source_id,
            doc.url,
            trimAround(m.sentence),
            MATCHER_VERSION,
            doc.id,
          ],
        );
        counts[m.severity]++;
        total++;
        targetFreq.set(m.target.name, (targetFreq.get(m.target.name) ?? 0) + 1);
        if (only) console.log(`  ${doc.drug_name} → ${m.target.name} [${m.severity}] ${trimAround(m.sentence, 140)}`);
      }
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    await db.end();
  }

  console.log(`${docs.length} labels → ${total} interactions in ${((Date.now() - t0) / 1000).toFixed(1)}s`, counts);
  if (showStats) {
    const top = [...targetFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
    console.log("Most matched:", top.map(([n, c]) => `${n} (${c})`).join(", "));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
