-- remed.io schema
-- Designed so that curated data and (later) scraped data live side by side:
-- every interaction row points at the `sources` row it came from.

CREATE TABLE IF NOT EXISTS sources (
  id           SERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,            -- e.g. 'curated', 'openfda-label'
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('curated', 'api', 'scraped')),
  url          TEXT,
  license      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drug_classes (
  id           SERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,            -- e.g. 'nsaid'
  name         TEXT NOT NULL                    -- e.g. 'NSAIDs'
);

CREATE TABLE IF NOT EXISTS drugs (
  id           SERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,            -- e.g. 'ibuprofen'
  name         TEXT NOT NULL,                   -- display / generic name
  kind         TEXT NOT NULL DEFAULT 'drug' CHECK (kind IN ('drug', 'supplement', 'food')),
  rxcui        TEXT UNIQUE,                     -- RxNorm id, useful as a join key when scraping
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drugs_name_lower_idx ON drugs (lower(name));

-- Brand names and synonyms ("Advil", "Motrin" -> ibuprofen)
CREATE TABLE IF NOT EXISTS drug_aliases (
  id           SERIAL PRIMARY KEY,
  drug_id      INT NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'brand' CHECK (kind IN ('brand', 'synonym'))
);
CREATE UNIQUE INDEX IF NOT EXISTS drug_aliases_alias_uniq ON drug_aliases (lower(alias));

CREATE TABLE IF NOT EXISTS drug_class_members (
  drug_id      INT NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  class_id     INT NOT NULL REFERENCES drug_classes(id) ON DELETE CASCADE,
  PRIMARY KEY (drug_id, class_id)
);

DO $$ BEGIN
  CREATE TYPE interaction_severity AS ENUM ('minor', 'moderate', 'major', 'contraindicated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An interaction is between two "subjects"; each subject is either a specific
-- drug or a whole drug class (e.g. NSAIDs + warfarin).
CREATE TABLE IF NOT EXISTS interactions (
  id              SERIAL PRIMARY KEY,
  a_drug_id       INT REFERENCES drugs(id) ON DELETE CASCADE,
  a_class_id      INT REFERENCES drug_classes(id) ON DELETE CASCADE,
  b_drug_id       INT REFERENCES drugs(id) ON DELETE CASCADE,
  b_class_id      INT REFERENCES drug_classes(id) ON DELETE CASCADE,
  severity        interaction_severity NOT NULL,
  summary         TEXT NOT NULL,
  mechanism       TEXT,
  recommendation  TEXT,
  source_id       INT NOT NULL REFERENCES sources(id),
  source_ref      TEXT,                          -- URL / external id of the record this came from
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((a_drug_id IS NULL) <> (a_class_id IS NULL)),
  CHECK ((b_drug_id IS NULL) <> (b_class_id IS NULL))
);
CREATE INDEX IF NOT EXISTS interactions_a_drug_idx  ON interactions (a_drug_id);
CREATE INDEX IF NOT EXISTS interactions_a_class_idx ON interactions (a_class_id);
CREATE INDEX IF NOT EXISTS interactions_b_drug_idx  ON interactions (b_drug_id);
CREATE INDEX IF NOT EXISTS interactions_b_class_idx ON interactions (b_class_id);

-- ─── Imported / extracted data ────────────────────────────────────────────────

ALTER TABLE drug_classes ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'curated';
  -- 'curated' | 'epc' (FDA Established Pharmacologic Class) | 'label-mention' (a group named in a label, e.g. "strong CYP3A4 inhibitors")

-- Alternative names for a class. `norm` is the normalised form used for matching
-- (lowercase, punctuation → spaces, trailing plural "s" dropped), so "NSAIDs" and "nsaid" collide.
CREATE TABLE IF NOT EXISTS drug_class_aliases (
  id        SERIAL PRIMARY KEY,
  class_id  INT NOT NULL REFERENCES drug_classes(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL,
  norm      TEXT NOT NULL UNIQUE
);

-- Source documents exactly as fetched (e.g. one FDA label per ingredient), so extraction
-- can be re-run without downloading again.
CREATE TABLE IF NOT EXISTS raw_documents (
  id            SERIAL PRIMARY KEY,
  source_id     INT NOT NULL REFERENCES sources(id),
  external_id   TEXT NOT NULL,               -- e.g. label set_id
  version       TEXT,
  drug_id       INT REFERENCES drugs(id) ON DELETE CASCADE,
  url           TEXT,
  content       JSONB NOT NULL,
  content_hash  TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS raw_documents_drug_idx ON raw_documents (drug_id);

DROP TABLE IF EXISTS extractions;  -- from an earlier LLM-based design


ALTER TABLE interactions ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'unreviewed'
  CHECK (review_status IN ('unreviewed', 'reviewed', 'rejected'));
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS evidence_excerpt TEXT;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS extracted_by TEXT;   -- matcher version (e.g. 'text-match-v1'), NULL for hand-curated rows
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS raw_document_id INT REFERENCES raw_documents(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS interactions_raw_doc_idx ON interactions (raw_document_id);

ALTER TABLE drug_aliases ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'curated';  -- 'curated' | 'import'
ALTER TABLE drug_class_members ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'curated';
