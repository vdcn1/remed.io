# remed.io

A web app that checks whether two remedies (prescription drugs, OTC pills, supplements, foods)
interact. Personal / portfolio project, **non-commercial**.

@AGENTS.md

## Stack

- **Next.js 16 (App Router)**: route handlers in `app/api/` are the backend. React 19 client
  components in `components/` are the frontend. Next 16 differs from older versions; read
  `node_modules/next/dist/docs/` before using unfamiliar Next APIs (see AGENTS.md).
- **PostgreSQL 17** in Docker (`docker-compose.yml`), accessed with plain `pg` (no ORM).
  `lib/db.ts` holds the shared pool.
- TypeScript scripts run with `tsx`. Plain CSS in `app/globals.css` with light and dark themes.

## Commands

```bash
npm run db:up          # Postgres in Docker (on this machine: sudo docker compose up -d db)
npm run db:setup       # apply db/schema.sql + seed curated data (idempotent)
npm run dev            # http://localhost:3000
npm run typecheck && npm run build

# Data pipeline (see README → Importing data). Order matters:
npm run ingest:labels  # bulk FDA label zips -> data/raw/labels.ndjson (offline, ~3 min)
npm run ingest:drugs   # RxNorm/RxClass normalisation -> drugs, aliases, classes, raw_documents (~2 min)
npm run match          # text-match interactions from label text (offline, ~15 s)
npm run match -- --only=warfarin    # debug one drug: prints every match + sentence
npm run match -- --stats            # most frequently matched names (to spot false positives)
```

`db:setup` re-seeds curated rows; re-run `ingest:drugs` and then `match` after it.

## Hard rules (user decisions)

1. **No AI/LLM calls anywhere in the app or the data pipeline.** Interactions are found by
   deterministic text matching. An earlier Claude-based extraction design was built and removed
   at the user's request; don't reintroduce model calls.
2. **Postgres** is the database.
3. **Everything is labelled "not reviewed".** There is no clinician to check entries, so every
   interaction (curated and matched) has `review_status = 'unreviewed'`. The UI shows a badge, the
   source sentence, and the source label link. Never present data as clinically verified.
4. **Only public-domain / openly licensed sources.** Don't scrape Drugs.com, Medscape or WebMD
   (copyrighted, terms forbid scraping). DrugBank and DDInter are allowed for non-commercial
   use but aren't used yet. NIH's RxNav interaction API was shut down in January 2024.

## Architecture

```
openFDA bulk labels ─ingest:labels─► labels.ndjson ─ingest:drugs─► drugs / drug_aliases / drug_classes
                                                       (RxNorm, RxClass)   drug_class_members / raw_documents
                                                                                    │
                                                                       match (lib/textmatch.ts)
                                                                                    ▼
seed (db/seed-data.ts) ───────────────────────────────────────────────────► interactions
                                                                                    │
                        POST /api/interactions (lib/interactions.ts) ◄──────────────┘
                        GET  /api/drugs?q=   (autocomplete)
```

### Data model (`db/schema.sql`, idempotent: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

- `sources`: provenance (`curated`, `openfda-label`).
- `drugs`: one row per ingredient. `kind` is drug / supplement / food. `rxcui` is the RxNorm ingredient id.
- `drug_aliases`: brands and salt-form synonyms. `origin` is `curated` or `import`; imported rows are
  rebuilt on every `ingest:drugs` run.
- `drug_classes` (`origin`: curated / epc / label-mention), `drug_class_members` (`origin`),
  `drug_class_aliases` (`norm` = `classNorm()` key, used for matching).
- `interactions`: A ↔ B, where each side is a drug **or** a class. Columns: severity enum
  (`minor < moderate < major < contraindicated`), summary, recommendation, `evidence_excerpt`,
  `extracted_by` (matcher version, NULL = curated), `raw_document_id`, `review_status`.
  Rows with `review_status = 'rejected'` are hidden.
- `raw_documents`: one FDA label per ingredient (interaction-relevant sections only) plus a content hash.

### Lookup (`lib/interactions.ts`)

A pair matches a rule if each drug matches its side by id **or by any of its classes**, in either
order. So one curated rule (warfarin ↔ NSAIDs) covers every NSAID. Text-matched rows are
de-duplicated to one per source label (the most severe). Two drugs sharing a class are flagged as
therapeutic duplication. The live openFDA label search (`lib/openfda.ts`) runs only as a fallback
when the database has no rows for the pair.

## Key decisions & rationale

**Ingestion**
- **Bulk downloads, not scraping or per-drug API calls.** openFDA publishes all ~263k labels as 14
  zips (~1.8 GB). They are streamed with `stream-json` + `unzip -p`, never loaded whole.
- **One label per active substance.** Ranking: has a Drug Interactions section > prescription >
  newest effective date. Only labels with exactly one active substance are used, because a
  combination product's label describes several ingredients (known gap below).
- **OTC labels are kept only if** they have a Drug Interactions or "Ask a doctor or pharmacist"
  section. Otherwise cosmetics and topicals flood the drug list.

**Drugs, brands and classes**
- **RxNorm normalisation:** substance → ingredient (IN), via the precise ingredient (PIN) for
  salts. So "SERTRALINE HYDROCHLORIDE" becomes sertraline, and salt forms become synonym aliases.
  Responses are cached in `data/raw/rxnorm-cache.json`.
- **Classes from RxClass (FDA EPC), not the label's `openfda.pharm_class_epc`,** which is missing
  on most labels. An EPC name that matches a curated class alias joins that curated class, so
  curated class-wide rules cover imported drugs.
- **Brand names only from prescription labels.** OTC "brand" fields are mostly store brands and
  descriptions ("HEB", "Pain Relief"). A brand used by more than one ingredient, or one containing
  the ingredient name, is dropped.

**Clinical adjustments**
- **Loperamide is excluded from Opioids** (`CLASS_EXCLUSIONS` in `scripts/ingest/load-drugs.ts`).
  It's an FDA "Opioid Agonist" but acts peripherally, so the opioid + benzodiazepine boxed
  warning would mislead.
- **The curated SSRI class is named "Serotonin reuptake inhibitors (incl. SSRIs)"**, because the
  FDA EPC it absorbs also contains trazodone and nefazodone.
- **"Alcohol"** is a curated `food` entry (slug `ethanol`) so label warnings about alcohol match.

**Text matcher (`lib/textmatch.ts`)**
- **Lexicon:** a hash map from normalised word sequence → drug/class. `classNorm()` lowercases,
  turns punctuation into spaces, and drops a trailing plural "s". The same normalisation is
  applied to label text, so "NSAIDs" matches "nsaid" and "St. John's Wort" matches `st john wort`.
- **Scanning:** each sentence is scanned word by word; at each position the longest phrase (up to
  N words) found in the map wins.
- **False-positive controls:**
  - `IGNORED_TERMS` (water, glucose, sodium chloride, thyroid, histamine…).
  - Imported single-word brands are dropped if they're common English words (system word list,
    optional) or shorter than 4 characters.
  - A name shared by two different drugs is dropped.
  - The drug's own classes count only when preceded by "other".
- **Grading:** keyword rules per sentence (see `grade()`). Allergy wording and negative statements
  are skipped. A bare mention counts only in Drug Interactions / "Ask a doctor" sections.
  Summaries and recommendations are templates (`describe()`), and the original sentence is
  always stored and shown.
- **Sentence splitter** avoids abbreviations (St., e.g., i.e.). Labels contain flattened tables,
  so some "sentences" are long table rows.

**Running environment**
- `DATABASE_POOL_MAX` env var: set it to 1 when testing against single-connection Postgres
  emulators (PGlite socket server).

## Quality baseline (last measured)

- 1,565 labels → ~12.4k interactions (≈1.2k contraindicated, 3.9k major, 7.3k moderate).
- **Recall vs the 33 curated pairs: 30/33.** Misses: ciprofloxacin + calcium ("calcium" is
  ignored as too ambiguous), methotrexate + Bactrim, and the combined pill + St. John's Wort
  (combination products).
- **Precision (random sample of 20): ~17 genuine.** Typical errors: flattened tables putting
  "Contraindicated" near an unrelated drug, monitoring advice that isn't an interaction.
- After changing matcher rules, re-run `npm run match` and spot-check with `--stats` and `--only`.

## Known gaps / next steps

- **Combination products** (e.g. Bactrim, combined oral contraceptives): import their labels and
  link combos to their ingredients.
- **Severity is keyword-based** and tends to over-grade. Table-aware parsing of the
  "Clinical Impact / Intervention" table format would help.
- **Supplement and food coverage** comes only from what drug labels mention, plus a few curated rows.
- **No review tooling yet.** `review_status` exists so a reviewer UI can be added later.
- **No automated tests yet.** The checks above were run as ad-hoc scripts.

## Conventions

- Keep the pipeline idempotent: every script can be re-run. Curated data lives in
  `db/seed-data.ts`; never hand-edit imported rows, fix the importer instead.
- `data/raw/` is gitignored (bulk downloads and caches).
