// Benchmark the text matcher (lib/textmatch.ts) against the stored label text.
// Read-only: it does not write interactions. It writes a JSON report to data/bench/.
//
//   npm run bench:match -- --label=before
//   npm run bench:match -- --label=after
//
// The report includes a fingerprint of every match found. Two runs with the same
// fingerprint produced identical output, so timing differences are not from changed results.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { buildLexicon, scanDocument } from "../lib/textmatch";

try {
  process.loadEnvFile(".env.local");
} catch {}

const cliArgs = process.argv.slice(2);
const reportLabel = cliArgs.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "run";
const timedRunCount = Number(cliArgs.find((arg) => arg.startsWith("--runs="))?.slice(7) ?? 7);

type LabelDocumentRow = {
  id: number;
  drug_id: number;
  sections: Record<string, string>;
  own_class_ids: number[];
};

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const lexiconBuildStartedAt = performance.now();
  const lexicon = await buildLexicon(db);
  const lexiconBuildMs = performance.now() - lexiconBuildStartedAt;

  const { rows: labelDocuments } = await db.query<LabelDocumentRow>(
    `SELECT r.id, r.drug_id, r.content->'sections' AS sections,
            COALESCE(array_agg(m.class_id) FILTER (WHERE m.class_id IS NOT NULL), '{}') AS own_class_ids
     FROM raw_documents r
     JOIN drugs d ON d.id = r.drug_id
     LEFT JOIN drug_class_members m ON m.drug_id = d.id
     GROUP BY r.id, d.id
     ORDER BY r.id`,
  );
  await db.end();

  const scanAllLabels = () =>
    labelDocuments.map((labelDocument) => ({
      id: labelDocument.id,
      documentMatches: scanDocument(labelDocument.sections, lexicon, {
        drugId: labelDocument.drug_id,
        ownClassIds: new Set(labelDocument.own_class_ids),
      }),
    }));

  // Warm-up, then timed runs. Output is kept from the first timed run for the fingerprint.
  scanAllLabels();
  const scanMsPerRun: number[] = [];
  let firstRunOutput: ReturnType<typeof scanAllLabels> | null = null;
  for (let runIndex = 0; runIndex < timedRunCount; runIndex++) {
    const startedAt = performance.now();
    const runOutput = scanAllLabels();
    scanMsPerRun.push(performance.now() - startedAt);
    if (!firstRunOutput) firstRunOutput = runOutput;
  }

  const fingerprintHash = createHash("sha256");
  let totalMatchCount = 0;
  for (const labelResult of firstRunOutput!) {
    for (const documentMatch of labelResult.documentMatches) {
      totalMatchCount++;
      fingerprintHash.update(
        `${labelResult.id}|${documentMatch.target.type}:${documentMatch.target.id}|${documentMatch.severity}|${documentMatch.section}|${documentMatch.sentence}\n`,
      );
    }
  }

  const report = {
    label: reportLabel,
    timestamp: new Date().toISOString(),
    node: process.version,
    lexiconTerms: lexicon.phraseToTarget.size,
    lexiconMaxWordsPerPhrase: lexicon.maxWordsPerPhrase,
    documents: labelDocuments.length,
    matches: totalMatchCount,
    fingerprint: fingerprintHash.digest("hex"),
    buildLexiconMs: Math.round(lexiconBuildMs),
    scanMsRuns: scanMsPerRun.map((ms) => Math.round(ms)),
    scanMsMedian: Math.round(median(scanMsPerRun)),
    scanMsMin: Math.round(Math.min(...scanMsPerRun)),
    msPerDocMedian: Number((median(scanMsPerRun) / labelDocuments.length).toFixed(3)),
  };

  mkdirSync("data/bench", { recursive: true });
  const reportPath = `data/bench/${reportLabel}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
