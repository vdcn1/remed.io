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

npm run match           # 4. find interactions in the label text by word matching (~15 s, offline)
```

How it fits together:

1. **Labels:** about 263k labels collapse to one label per active substance. Prescription labels are
   preferred, then labels that have a *Drug interactions* section, then the newest.
2. **Drugs:** each substance is mapped to its RxNorm ingredient ("sertraline hydrochloride" →
   sertraline). Brand names come from prescription labels, and classes from FDA Established
   Pharmacologic Classes via RxClass. EPC names that match a curated class (e.g. "Nonsteroidal
   Anti-inflammatory Drug") join it, so curated class-wide rules cover the imported drugs.
3. **Matching (no AI):** every drug name, salt form, brand name and class name goes into a hash
   map keyed by its normalised words ("St. John's Wort" → `st john wort`). Each label sentence is
   scanned word by word (case-insensitive, longest phrase first) and looked up in the map.
   - A sentence that mentions another drug or class is graded by keywords: "contraindicated" / "do
     not use" → contraindicated; "avoid", or serious harms (bleeding, serotonin syndrome, QT…) →
     major; "monitor", "adjust", "dose" → moderate.
   - Negative statements ("no clinically significant interaction") and allergy wording are skipped.
   - The drug's own classes are skipped unless the label says "other NSAIDs".
   - Each row stores the sentence it came from, and the UI shows it.

   Checked against the 33 curated interactions: 30 are found independently. The misses are
   "calcium" (ignored as too ambiguous) and combination products (their labels aren't imported yet).

Every interaction (curated or extracted) has `review_status = 'unreviewed'`, and the UI says so.
Set it to `reviewed` or `rejected` if someone qualified ever checks entries; rejected rows are
hidden.

## Disclaimer

remed.io is a personal/portfolio project. Its data is not reviewed by a clinician: the starter set is
hand-written and the imported interactions come from automatic text matching on FDA labels. It is not a clinical
reference and does not replace a doctor or pharmacist.
