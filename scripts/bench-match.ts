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

const args = process.argv.slice(2);
const label = args.find((a) => a.startsWith("--label="))?.slice(8) ?? "run";
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 7);

type DocRow = {
  id: number;
  drug_id: number;
  sections: Record<string, string>;
  own_class_ids: number[];
};

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const tBuild0 = performance.now();
  const lex = await buildLexicon(db);
  const buildMs = performance.now() - tBuild0;

  const { rows: docs } = await db.query<DocRow>(
    `SELECT r.id, r.drug_id, r.content->'sections' AS sections,
            COALESCE(array_agg(m.class_id) FILTER (WHERE m.class_id IS NOT NULL), '{}') AS own_class_ids
     FROM raw_documents r
     JOIN drugs d ON d.id = r.drug_id
     LEFT JOIN drug_class_members m ON m.drug_id = d.id
     GROUP BY r.id, d.id
     ORDER BY r.id`,
  );
  await db.end();

  const scanAll = () =>
    docs.map((doc) => ({
      id: doc.id,
      matches: scanDocument(doc.sections, lex, { drugId: doc.drug_id, ownClassIds: new Set(doc.own_class_ids) }),
    }));

  // Warm-up, then timed runs. Output is kept from the first timed run for the fingerprint.
  scanAll();
  const times: number[] = [];
  let output: ReturnType<typeof scanAll> | null = null;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    const out = scanAll();
    times.push(performance.now() - t0);
    if (!output) output = out;
  }

  const hash = createHash("sha256");
  let matchCount = 0;
  for (const d of output!) {
    for (const m of d.matches) {
      matchCount++;
      hash.update(`${d.id}|${m.target.type}:${m.target.id}|${m.severity}|${m.section}|${m.sentence}\n`);
    }
  }

  const report = {
    label,
    timestamp: new Date().toISOString(),
    node: process.version,
    lexiconTerms: lex.map.size,
    lexiconMaxWords: lex.maxWords,
    documents: docs.length,
    matches: matchCount,
    fingerprint: hash.digest("hex"),
    buildLexiconMs: Math.round(buildMs),
    scanMsRuns: times.map((t) => Math.round(t)),
    scanMsMedian: Math.round(median(times)),
    scanMsMin: Math.round(Math.min(...times)),
    msPerDocMedian: Number((median(times) / docs.length).toFixed(3)),
  };

  mkdirSync("data/bench", { recursive: true });
  const path = `data/bench/${label}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
