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

const cliArgs = process.argv.slice(2);
const onlyDrugSlugs = cliArgs
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",")
  .map((slug) => slug.trim().toLowerCase());
const showStats = cliArgs.includes("--stats");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const runStartedAt = Date.now();
  const lexicon = await buildLexicon(db);
  console.log(`Lexicon: ${lexicon.phraseToTarget.size} terms, up to ${lexicon.maxWordsPerPhrase} words long`);

  const { rows: labelDocuments } = await db.query<{
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
    [onlyDrugSlugs ?? null],
  );

  const interactionCountBySeverity = { contraindicated: 0, major: 0, moderate: 0, minor: 0 };
  const mentionCountByTargetName = new Map<string, number>();
  let totalInteractionCount = 0;

  await db.query("BEGIN");
  try {
    for (const labelDocument of labelDocuments) {
      const documentMatches = scanDocument(labelDocument.sections, lexicon, {
        drugId: labelDocument.drug_id,
        ownClassIds: new Set(labelDocument.own_class_ids),
      });
      await db.query(`DELETE FROM interactions WHERE raw_document_id = $1`, [labelDocument.id]);
      for (const documentMatch of documentMatches) {
        const { summary, recommendation } = describe(
          labelDocument.drug_name,
          documentMatch.target.name,
          documentMatch.grade,
          documentMatch.section,
        );
        await db.query(
          `INSERT INTO interactions
             (a_drug_id, b_drug_id, b_class_id, severity, summary, recommendation,
              source_id, source_ref, evidence_excerpt, extracted_by, raw_document_id, review_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unreviewed')`,
          [
            labelDocument.drug_id,
            documentMatch.target.type === "drug" ? documentMatch.target.id : null,
            documentMatch.target.type === "class" ? documentMatch.target.id : null,
            documentMatch.severity,
            summary,
            recommendation,
            labelDocument.source_id,
            labelDocument.url,
            trimAround(documentMatch.sentence),
            MATCHER_VERSION,
            labelDocument.id,
          ],
        );
        interactionCountBySeverity[documentMatch.severity]++;
        totalInteractionCount++;
        mentionCountByTargetName.set(
          documentMatch.target.name,
          (mentionCountByTargetName.get(documentMatch.target.name) ?? 0) + 1,
        );
        if (onlyDrugSlugs) {
          console.log(
            `  ${labelDocument.drug_name} → ${documentMatch.target.name} [${documentMatch.severity}] ${trimAround(documentMatch.sentence, 140)}`,
          );
        }
      }
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    await db.end();
  }

  const elapsedSeconds = ((Date.now() - runStartedAt) / 1000).toFixed(1);
  console.log(
    `${labelDocuments.length} labels → ${totalInteractionCount} interactions in ${elapsedSeconds}s`,
    interactionCountBySeverity,
  );
  if (showStats) {
    const topTargets = [...mentionCountByTargetName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
    console.log("Most matched:", topTargets.map(([name, count]) => `${name} (${count})`).join(", "));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
