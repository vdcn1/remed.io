// Stage 3: extract interactions from FDA label text with Claude.
//
//   npm run extract -- estimate [--only=a,b] [--limit=N]   cost estimate, no API calls
//   npm run extract -- direct   [--only=a,b] [--limit=N]   call the API now (good for pilots)
//   npm run extract -- submit   [--only=a,b] [--limit=N]   send a Message Batch (50% cheaper, async)
//   npm run extract -- collect                              fetch finished batches and store results
//   npm run extract -- resolve                              re-run name resolution on stored outputs (free)
//
// --only takes drug slugs, e.g. --only=warfarin,sertraline. Documents that already have
// a successful or pending extraction for their current text are skipped.

import Anthropic from "@anthropic-ai/sdk";
import { Pool, type PoolClient } from "pg";
import {
  buildRequest,
  EXTRACT_EFFORT,
  EXTRACT_MODEL,
  parseMessage,
  resolveExtraction,
  SYSTEM_PROMPT,
  type ExtractionOutput,
  type LabelDocument,
  type ResolveStats,
} from "../lib/extraction";

try {
  process.loadEnvFile(".env.local");
} catch {}

// $ per million tokens (input, output) at standard rates; batches are half price.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const only = flag("only")?.split(",").map((s) => s.trim().toLowerCase());
const limit = flag("limit") ? Number(flag("limit")) : null;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

type Doc = LabelDocument & { drug_id: number };

async function sourceId() {
  const { rows } = await pool.query<{ id: number }>(`SELECT id FROM sources WHERE slug = 'openfda-label'`);
  if (!rows[0]) throw new Error("No FDA label source yet. Run `npm run ingest:drugs` first.");
  return rows[0].id;
}

async function pendingDocs(): Promise<Doc[]> {
  const { rows } = await pool.query<Doc>(
    `SELECT r.id, r.drug_id, d.name AS drug_name, r.content, r.content_hash, r.url
     FROM raw_documents r
     JOIN drugs d ON d.id = r.drug_id
     JOIN sources s ON s.id = r.source_id AND s.slug = 'openfda-label'
     WHERE ($1::text[] IS NULL OR d.slug = ANY($1))
       AND NOT EXISTS (
         SELECT 1 FROM extractions e
         WHERE e.raw_document_id = r.id AND e.content_hash = r.content_hash AND e.status IN ('succeeded', 'pending'))
     ORDER BY (r.content->>'product_type' = 'HUMAN PRESCRIPTION DRUG') DESC,
              (r.content->'sections' ? 'drug_interactions') DESC, r.id
     LIMIT $2`,
    [only ?? null, limit],
  );
  return rows;
}

async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

// ─── Reporting ─────────────────────────────────────────────────────────────────

const totals: ResolveStats = { extracted: 0, inserted: 0, unresolved: [], unverified: 0, self: 0, classesCreated: 0 };
function addStats(s: ResolveStats) {
  totals.extracted += s.extracted;
  totals.inserted += s.inserted;
  totals.unverified += s.unverified;
  totals.self += s.self;
  totals.classesCreated += s.classesCreated;
  totals.unresolved.push(...s.unresolved);
}
function report() {
  const counts = new Map<string, number>();
  for (const n of totals.unresolved) counts.set(n.toLowerCase(), (counts.get(n.toLowerCase()) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log({
    extracted: totals.extracted,
    inserted: totals.inserted,
    droppedQuoteNotInLabel: totals.unverified,
    unresolvedNames: totals.unresolved.length,
    newLabelClasses: totals.classesCreated,
  });
  if (top.length) console.log("Most common unresolved names:", top.map(([n, c]) => `${n} (${c})`).join(", "));
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function estimate() {
  const docs = await pendingDocs();
  const [inPrice, outPrice] = PRICES[EXTRACT_MODEL] ?? [NaN, NaN];
  const inputTokens = docs.reduce(
    (n, d) => n + Math.ceil((SYSTEM_PROMPT.length + JSON.stringify(d.content.sections).length) / 4),
    0,
  );

  // Calibrate output size from earlier runs with the same model, if any.
  const { rows } = await pool.query<{ n: string; out: string; inp: string }>(
    `SELECT count(*) AS n, avg((usage->>'output_tokens')::int) AS out, avg((usage->>'input_tokens')::int) AS inp
     FROM extractions WHERE status = 'succeeded' AND model = $1`,
    [EXTRACT_MODEL],
  );
  const observed = Number(rows[0].n) > 0;
  const outPerDoc = observed ? Number(rows[0].out) : 3000;
  const outputTokens = docs.length * outPerDoc;
  const cost = (inputTokens * inPrice + outputTokens * outPrice) / 1e6;

  console.log(`Model: ${EXTRACT_MODEL} (effort ${EXTRACT_EFFORT})`);
  console.log(`Documents to extract: ${docs.length}`);
  console.log(`Input  ≈ ${(inputTokens / 1e6).toFixed(2)}M tokens (rough: characters ÷ 4)`);
  console.log(
    `Output ≈ ${(outputTokens / 1e6).toFixed(2)}M tokens (${Math.round(outPerDoc)}/doc, ${observed ? `measured over ${rows[0].n} earlier extractions` : "a guess until a pilot has run"})`,
  );
  console.log(`Cost   ≈ $${cost.toFixed(2)} direct, $${(cost / 2).toFixed(2)} as a batch`);
}

async function direct() {
  const docs = await pendingDocs();
  const src = await sourceId();
  const client = new Anthropic();
  console.log(`Extracting ${docs.length} documents with ${EXTRACT_MODEL} (effort ${EXTRACT_EFFORT})…`);
  let done = 0;
  const usage = { input: 0, output: 0 };

  const work = async (doc: Doc) => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO extractions (raw_document_id, content_hash, model, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [doc.id, doc.content_hash, EXTRACT_MODEL],
    );
    const extractionId = rows[0].id;
    try {
      const message = await client.beta.messages
        .stream({
          ...buildRequest(doc),
          // If the model declines, the API re-runs the request on a fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
        .finalMessage();
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      const output = parseMessage(message);
      const stats = await inTransaction(async (c) => {
        await c.query(
          `UPDATE extractions SET status = 'succeeded', output = $2, usage = $3, model = $4, finished_at = now() WHERE id = $1`,
          [extractionId, output, message.usage, message.model],
        );
        return resolveExtraction(c, { doc, output, model: message.model, sourceId: src });
      });
      addStats(stats);
      console.log(
        `[${++done}/${docs.length}] ${doc.drug_name}: ${stats.inserted} interactions` +
          (stats.unresolved.length ? `, unresolved: ${stats.unresolved.join("; ")}` : "") +
          (stats.unverified ? `, ${stats.unverified} dropped (quote not found)` : ""),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await pool.query(`UPDATE extractions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
        extractionId,
        msg,
      ]);
      console.error(`[${++done}/${docs.length}] ${doc.drug_name}: FAILED – ${msg}`);
    }
  };

  const queue = [...docs];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) await work(queue.shift()!);
    }),
  );
  report();
  const [inPrice, outPrice] = PRICES[EXTRACT_MODEL] ?? [NaN, NaN];
  console.log(
    `Usage: ${usage.input} input + ${usage.output} output tokens ≈ $${((usage.input * inPrice + usage.output * outPrice) / 1e6).toFixed(2)}`,
  );
}

async function submit() {
  const docs = await pendingDocs();
  if (docs.length === 0) return console.log("Nothing to extract.");
  const client = new Anthropic();
  const batch = await client.messages.batches.create({
    requests: docs.map((doc) => ({ custom_id: `doc-${doc.id}`, params: buildRequest(doc) })),
  });
  for (const doc of docs) {
    await pool.query(
      `INSERT INTO extractions (raw_document_id, content_hash, model, batch_id, status) VALUES ($1, $2, $3, $4, 'pending')`,
      [doc.id, doc.content_hash, EXTRACT_MODEL, batch.id],
    );
  }
  console.log(`Submitted batch ${batch.id} with ${docs.length} documents. Run \`npm run extract -- collect\` later.`);
}

async function collect() {
  const src = await sourceId();
  const client = new Anthropic();
  const { rows: batches } = await pool.query<{ batch_id: string }>(
    `SELECT DISTINCT batch_id FROM extractions WHERE status = 'pending' AND batch_id IS NOT NULL`,
  );
  if (batches.length === 0) return console.log("No pending batches.");

  for (const { batch_id } of batches) {
    const batch = await client.messages.batches.retrieve(batch_id);
    if (batch.processing_status !== "ended") {
      const c = batch.request_counts;
      console.log(`${batch_id}: ${batch.processing_status} (${c.succeeded} done, ${c.processing} processing)`);
      continue;
    }
    console.log(`${batch_id}: ended, collecting…`);
    for await (const result of await client.messages.batches.results(batch_id)) {
      const docId = Number(result.custom_id.replace("doc-", ""));
      const { rows } = await pool.query<Doc & { extraction_id: number }>(
        `SELECT e.id AS extraction_id, r.id, r.drug_id, d.name AS drug_name, r.content, r.content_hash, r.url
         FROM extractions e JOIN raw_documents r ON r.id = e.raw_document_id JOIN drugs d ON d.id = r.drug_id
         WHERE e.batch_id = $1 AND e.raw_document_id = $2`,
        [batch_id, docId],
      );
      const doc = rows[0];
      if (!doc) continue;
      if (result.result.type !== "succeeded") {
        const error = result.result.type === "errored" ? JSON.stringify(result.result.error) : result.result.type;
        await pool.query(`UPDATE extractions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
          doc.extraction_id,
          error,
        ]);
        continue;
      }
      const message = result.result.message;
      try {
        const output = parseMessage(message);
        const stats = await inTransaction(async (c) => {
          await c.query(
            `UPDATE extractions SET status = 'succeeded', output = $2, usage = $3, finished_at = now() WHERE id = $1`,
            [doc.extraction_id, output, message.usage],
          );
          return resolveExtraction(c, { doc, output, model: message.model, sourceId: src });
        });
        addStats(stats);
      } catch (err) {
        await pool.query(
          `UPDATE extractions SET status = 'failed', error = $2, usage = $3, finished_at = now() WHERE id = $1`,
          [doc.extraction_id, (err as Error).message, message.usage],
        );
      }
    }
  }
  report();
}

async function resolve() {
  const src = await sourceId();
  const { rows } = await pool.query<Doc & { output: ExtractionOutput; model: string }>(
    `SELECT DISTINCT ON (r.id) r.id, r.drug_id, d.name AS drug_name, r.content, r.content_hash, r.url, e.output, e.model
     FROM extractions e JOIN raw_documents r ON r.id = e.raw_document_id JOIN drugs d ON d.id = r.drug_id
     WHERE e.status = 'succeeded'
     ORDER BY r.id, e.finished_at DESC`,
  );
  for (const row of rows) {
    addStats(
      await inTransaction((c) => resolveExtraction(c, { doc: row, output: row.output, model: row.model, sourceId: src })),
    );
  }
  console.log(`Re-resolved ${rows.length} documents.`);
  report();
}

const commands: Record<string, () => Promise<unknown>> = { estimate, direct, submit, collect, resolve };

(commands[command] ?? (async () => console.log("Usage: npm run extract -- <estimate|direct|submit|collect|resolve> [--only=slugs] [--limit=N]")))()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
