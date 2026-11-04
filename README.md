# remed.io

Check whether two remedies — prescription drugs, OTC pills, supplements, even foods — interact.

- **Frontend:** React 19 (Next.js App Router, `components/`)
- **Backend:** Next.js route handlers (`app/api/`)
- **Database:** PostgreSQL (`db/schema.sql`, accessed with `pg`)
- **Live evidence:** openFDA drug label API, cross-checked on every query

## Getting started

```bash
npm install
cp .env.example .env.local      # adjust DATABASE_URL if needed
npm run db:up                   # starts Postgres 17 in Docker
npm run db:setup                # creates tables + loads the curated starter set (safe to re-run)
npm run dev                     # http://localhost:3000
```

## How a check works

`POST /api/interactions` with `{ "a": "Advil", "b": "Coumadin" }`:

1. Each name is resolved to a drug via its generic name, slug, or brand alias (`drug_aliases`).
2. `interactions` is searched for rules that match either the **drug itself or any of its classes**,
   in either order. So one row, `warfarin ↔ class:NSAIDs`, covers ibuprofen, naproxen, aspirin, …
3. Shared classes (e.g. two SSRIs) are flagged as therapeutic duplication.
4. In parallel, each drug's FDA label is fetched from openFDA and searched for the other drug's
   name, brands, and class (boxed warning, contraindications, drug interactions, warnings).
   Results are cached for 24 h. Set `OPENFDA_ENABLED=false` to turn this off.

`GET /api/drugs?q=adv` powers autocomplete.

## Data model

| table                | purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `sources`            | where data came from (`curated`, `api`, `scraped`) + license          |
| `drugs`              | one row per substance; `kind` = drug / supplement / food; `rxcui`    |
| `drug_aliases`       | brand names & synonyms, unique case-insensitively                    |
| `drug_classes`       | NSAIDs, SSRIs, …                                                      |
| `drug_class_members` | drug ↔ class                                                          |
| `drug_class_aliases` | normalised alternative names for classes, used for matching       |
| `interactions`       | subject A ↔ subject B (each a drug *or* a class), severity, summary, mechanism, recommendation, source, evidence quote, `review_status` |
| `raw_documents`      | source documents as fetched (one FDA label per ingredient)          |
| `extractions`        | one LLM run per document: model, batch id, raw output, token usage  |

Severity is a Postgres enum ordered `minor < moderate < major < contraindicated`.

## Importing data

The starter set covers 49 remedies. The import pipeline grows that to ~1,500 ingredients and
extracts interactions from official FDA labels. All sources are public domain.

```bash
# 1. Download the openFDA drug label bulk files (~1.8 GB, 14 zips)
mkdir -p data/raw/labels && cd data/raw/labels
curl -s https://api.fda.gov/download.json \
  | node -e 'for (const p of JSON.parse(require("fs").readFileSync(0)).results.drug.label.partitions) console.log(p.file)' \
  | xargs -n1 -P4 curl -sSfO
cd -

npm run ingest:labels   # 2. best label per substance -> data/raw/labels.ndjson   (~3 min, offline)
npm run ingest:drugs    # 3. RxNorm ingredients, brands, FDA classes, label text -> Postgres (~2 min)

# 4. Extract interactions with Claude (needs ANTHROPIC_API_KEY in .env.local)
npm run extract -- estimate                       # cost estimate, no API calls
npm run extract -- direct --only=warfarin,sertraline   # small pilot, results immediately
npm run extract -- submit                         # everything else as a Message Batch (half price)
npm run extract -- collect                        # later: store the batch results
npm run extract -- resolve                        # re-match stored outputs after alias changes (free)
```

How it fits together:

1. **Labels:** about 263k labels collapse to one label per active substance. Prescription labels are
   preferred, then labels that have a *Drug interactions* section, then the newest.
2. **Drugs:** each substance is mapped to its RxNorm ingredient ("sertraline hydrochloride" →
   sertraline). Brand names come from prescription labels, and classes from FDA Established
   Pharmacologic Classes via RxClass. EPC names that match a curated class (e.g. "Nonsteroidal
   Anti-inflammatory Drug") join it, so curated class-wide rules cover the imported drugs.
3. **Extraction:** Claude reads each label's interaction sections and returns structured entries,
   each with a verbatim supporting quote. Then:
   - Entries whose quote isn't found in the label text are dropped.
   - Names are matched to drugs, aliases and classes.
   - A group the label names with examples ("strong CYP3A4 inhibitors, e.g. ketoconazole…")
     becomes a `label-mention` class with those drugs as members.
   - Raw model output is kept in `extractions`, so `resolve` can re-run matching without new API calls.

Every interaction (curated or extracted) has `review_status = 'unreviewed'`, and the UI says so.
Set it to `reviewed` or `rejected` if someone qualified ever checks entries; rejected rows are
hidden.

## Disclaimer

remed.io is a personal/portfolio project. Its data is not reviewed by a clinician: the starter set is
hand-written and the imported interactions are AI-extracted from FDA labels. It is not a clinical
reference and does not replace a doctor or pharmacist.
