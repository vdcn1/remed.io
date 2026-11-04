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
| `interactions`       | subject A ↔ subject B (each a drug *or* a class), severity, summary, mechanism, recommendation, `source_id`, `source_ref` |

Severity is a Postgres enum ordered `minor < moderate < major < contraindicated`.

### Adding scraped data later

The schema is ready for imported data: create a `sources` row (kind `scraped` or `api`), upsert drugs
keyed by `rxcui`, and insert interactions with that `source_id` and a `source_ref` URL/ID per row.
Curated rows live under the `curated` source and are the only ones `db:setup` rewrites.

## Disclaimer

The bundled dataset is a small, hand-picked starter set of well-established interactions so the
app is usable; it is **not** a complete clinical reference. remed.io is informational and does
not replace a doctor or pharmacist.
