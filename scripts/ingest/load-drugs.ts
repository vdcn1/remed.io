// Stage 2: normalise each label substance to its RxNorm ingredient, then load
// drugs, brand-name aliases, FDA classes and the label text into Postgres.
//
// Reads data/raw/labels.ndjson (from `npm run ingest:labels`). RxNorm/RxClass
// responses are cached in data/raw/rxnorm-cache.json.
//
//   npm run ingest:drugs

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { classNorm, displayName, slugify } from "../../lib/normalize";
import type { SubstanceRecord } from "./fda-labels";

try {
  process.loadEnvFile(".env.local");
} catch {}

const LABELS = "data/raw/labels.ndjson";
const CACHE = "data/raw/rxnorm-cache.json";
const RXNAV = "https://rxnav.nlm.nih.gov/REST";

type Ingredient = { rxcui: string; name: string; epc: string[] } | null;

// ─── RxNorm ────────────────────────────────────────────────────────────────────

const cache: Record<string, Ingredient> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

async function rxnav<T>(path: string, attempt = 0): Promise<T> {
  const res = await fetch(`${RXNAV}${path}`, { signal: AbortSignal.timeout(15000) });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return rxnav(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`RxNav ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

async function lookupIngredient(substance: string): Promise<Ingredient> {
  const found = await rxnav<{ idGroup: { rxnormId?: string[] } }>(
    `/rxcui.json?name=${encodeURIComponent(substance)}&search=2`,
  );
  const id = found.idGroup.rxnormId?.[0];
  if (!id) return null;

  const props = await rxnav<{ properties?: { tty: string; name: string } }>(`/rxcui/${id}/properties.json`);
  let ing: { rxcui: string; name: string } | null = null;
  if (props.properties?.tty === "IN") {
    ing = { rxcui: id, name: props.properties.name };
  } else if (props.properties?.tty === "PIN") {
    // Precise ingredient (a salt form) -> its base ingredient
    const rel = await rxnav<{
      relatedGroup: { conceptGroup?: { tty: string; conceptProperties?: { rxcui: string; name: string }[] }[] };
    }>(`/rxcui/${id}/related.json?tty=IN`);
    const c = rel.relatedGroup.conceptGroup?.find((g) => g.tty === "IN")?.conceptProperties?.[0];
    if (c) ing = { rxcui: c.rxcui, name: c.name };
  }
  if (!ing) return null;

  const cls = await rxnav<{
    rxclassDrugInfoList?: { rxclassDrugInfo: { rxclassMinConceptItem: { className: string } }[] };
  }>(`/rxclass/class/byRxcui.json?rxcui=${ing.rxcui}&relaSource=FDASPL&relas=has_EPC`);
  const epc = [
    ...new Set((cls.rxclassDrugInfoList?.rxclassDrugInfo ?? []).map((x) => x.rxclassMinConceptItem.className)),
  ];
  return { ...ing, epc };
}

async function normaliseAll(substances: string[]) {
  const todo = substances.filter((s) => !(s in cache));
  console.log(`RxNorm: ${substances.length - todo.length} cached, ${todo.length} to look up`);
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const s = todo.shift()!;
      try {
        cache[s] = await lookupIngredient(s);
      } catch (err) {
        console.warn(`  ${s}: ${(err as Error).message}`);
        continue; // not cached -> retried next run
      }
      if (++done % 200 === 0) {
        console.log(`  ${done} looked up`);
        writeFileSync(CACHE, JSON.stringify(cache));
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  writeFileSync(CACHE, JSON.stringify(cache));
}

// ─── Grouping ──────────────────────────────────────────────────────────────────

type Group = {
  key: string;
  rxcui: string | null;
  name: string;
  substances: string[];
  epc: string[];
  brands: string[];
  label: SubstanceRecord["label"];
};

function labelRank(l: SubstanceRecord["label"]) {
  return [l.sections.drug_interactions ? 1 : 0, l.product_type === "HUMAN PRESCRIPTION DRUG" ? 1 : 0, Number(l.effective_time ?? 0)];
}
const rankBetter = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

// Only brand names from prescription labels are used: OTC "brand" names are mostly store
// brands and product descriptions ("HEB", "Pain Relief"). Well-known OTC brands are curated.
function brandOk(brand: string, g: Group, owners: Map<string, Set<string>>) {
  const b = brand.trim();
  const lower = b.toLowerCase();
  if (b.length < 3 || b.length > 40) return false;
  if (owners.get(lower)!.size > 1) return false; // used for several ingredients
  const base = g.name.toLowerCase();
  if (lower.includes(base) || g.substances.some((s) => lower.includes(s.toLowerCase().split(" ")[0]))) return false;
  return true;
}

// FDA classes that are technically right but clinically misleading for our class-wide rules.
// Loperamide is an "Opioid Agonist" but acts only in the gut.
const CLASS_EXCLUSIONS: Record<string, string[]> = {
  "Opioid Agonist": ["loperamide"],
};

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const records: SubstanceRecord[] = readFileSync(LABELS, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  // Prescription labels are always kept; OTC labels only when they talk about other drugs.
  const relevant = records.filter(
    (r) =>
      r.label.product_type === "HUMAN PRESCRIPTION DRUG" ||
      r.label.sections.drug_interactions ||
      r.label.sections.ask_doctor_or_pharmacist,
  );
  console.log(`${records.length} substances, ${relevant.length} relevant`);

  await normaliseAll(relevant.map((r) => r.substance));

  const groups = new Map<string, Group>();
  for (const r of relevant) {
    const ing = cache[r.substance];
    const name = ing?.name ?? r.substance.toLowerCase();
    const key = ing?.rxcui ?? `substance:${slugify(r.substance)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, rxcui: ing?.rxcui ?? null, name, substances: [], epc: [], brands: [], label: r.label };
      groups.set(key, g);
    } else if (rankBetter(labelRank(r.label), labelRank(g.label))) {
      g.label = r.label;
    }
    g.substances.push(r.substance);
    for (const e of [...(ing?.epc ?? []), ...r.epc.map((x) => x.replace(/\s*\[EPC\]$/, ""))])
      if (!g.epc.includes(e)) g.epc.push(e);
    for (const b of r.rxBrands) if (!g.brands.includes(b)) g.brands.push(b);
  }

  const owners = new Map<string, Set<string>>();
  for (const g of groups.values())
    for (const b of g.brands) {
      const k = b.trim().toLowerCase();
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k)!.add(g.key);
    }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const stats = { drugsCreated: 0, drugsMatched: 0, aliases: 0, classesCreated: 0, memberships: 0, documents: 0 };
  try {
    await db.query("BEGIN");
    const {
      rows: [source],
    } = await db.query<{ id: number }>(
      `INSERT INTO sources (slug, name, kind, url, license)
       VALUES ('openfda-label', 'FDA drug labels (openFDA)', 'api', 'https://open.fda.gov/apis/drug/label/', 'Public domain (US Government work)')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );

    // Imported aliases and class memberships are rebuilt from scratch on every run.
    await db.query(`DELETE FROM drug_aliases WHERE origin = 'import'`);
    await db.query(`DELETE FROM drug_class_members WHERE origin = 'import'`);

    const classIdByNorm = new Map<string, number>(
      (await db.query<{ norm: string; class_id: number }>(`SELECT norm, class_id FROM drug_class_aliases`)).rows.map(
        (r) => [r.norm, r.class_id],
      ),
    );

    for (const g of groups.values()) {
      // 1. Find or create the drug
      const candidates = [g.name, ...g.substances].map((s) => s.toLowerCase());
      const existing = await db.query<{ id: number; rxcui: string | null }>(
        `SELECT d.id, d.rxcui FROM drugs d
         WHERE ($1::text IS NOT NULL AND d.rxcui = $1) OR d.slug = $2 OR lower(d.name) = ANY($3)
            OR d.id IN (SELECT drug_id FROM drug_aliases WHERE lower(alias) = ANY($3))
         ORDER BY (d.rxcui = $1) DESC NULLS LAST, (d.slug = $2) DESC LIMIT 1`,
        [g.rxcui, slugify(g.name), candidates],
      );
      let drugId: number;
      if (existing.rows[0]) {
        drugId = existing.rows[0].id;
        stats.drugsMatched++;
        if (g.rxcui && !existing.rows[0].rxcui) {
          await db.query(
            `UPDATE drugs SET rxcui = $2, updated_at = now()
             WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM drugs WHERE rxcui = $2)`,
            [drugId, g.rxcui],
          );
        }
      } else {
        const { rows } = await db.query<{ id: number }>(
          `INSERT INTO drugs (slug, name, rxcui) VALUES ($1, $2, $3)
           ON CONFLICT (slug) DO UPDATE SET updated_at = now() RETURNING id`,
          [slugify(g.name), displayName(g.name), g.rxcui],
        );
        drugId = rows[0].id;
        stats.drugsCreated++;
      }

      // 2. Aliases: salt forms as synonyms, brand names as brands
      const aliasRows: [string, "brand" | "synonym"][] = [
        ...g.substances.filter((s) => s.toLowerCase() !== g.name.toLowerCase()).map((s) => [displayName(s), "synonym"] as [string, "synonym"]),
        ...g.brands.filter((b) => brandOk(b, g, owners)).map((b) => [b.trim(), "brand"] as [string, "brand"]),
      ];
      for (const [alias, kind] of aliasRows) {
        const r = await db.query(
          `INSERT INTO drug_aliases (drug_id, alias, kind, origin) VALUES ($1, $2, $3, 'import')
           ON CONFLICT (lower(alias)) DO NOTHING`,
          [drugId, alias, kind],
        );
        stats.aliases += r.rowCount ?? 0;
      }

      // 3. Classes (FDA EPC). Names matching a curated class alias join that class.
      for (const epc of g.epc) {
        if (CLASS_EXCLUSIONS[epc]?.includes(g.name.toLowerCase())) continue;
        const norm = classNorm(epc);
        let classId = classIdByNorm.get(norm);
        if (!classId) {
          const { rows } = await db.query<{ id: number }>(
            `INSERT INTO drug_classes (slug, name, origin) VALUES ($1, $2, 'epc')
             ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [`epc-${slugify(epc)}`, epc],
          );
          classId = rows[0].id;
          await db.query(
            `INSERT INTO drug_class_aliases (class_id, alias, norm) VALUES ($1, $2, $3) ON CONFLICT (norm) DO NOTHING`,
            [classId, epc, norm],
          );
          classIdByNorm.set(norm, classId);
          stats.classesCreated++;
        }
        const r = await db.query(
          `INSERT INTO drug_class_members (drug_id, class_id, origin) VALUES ($1, $2, 'import') ON CONFLICT DO NOTHING`,
          [drugId, classId],
        );
        stats.memberships += r.rowCount ?? 0;
      }

      // 4. The label text, for extraction
      const content = {
        substances: g.substances,
        product_type: g.label.product_type,
        effective_time: g.label.effective_time,
        sections: g.label.sections,
      };
      const hash = createHash("sha256").update(JSON.stringify(g.label.sections)).digest("hex");
      await db.query(
        `INSERT INTO raw_documents (source_id, external_id, version, drug_id, url, content, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           version = EXCLUDED.version, drug_id = EXCLUDED.drug_id, content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash, fetched_at = now()`,
        [
          source.id,
          g.label.set_id,
          g.label.version,
          drugId,
          `https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=${g.label.set_id}`,
          content,
          hash,
        ],
      );
      stats.documents++;
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    await db.end();
  }
  const unresolved = relevant.filter((r) => !cache[r.substance]).length;
  console.log({ ingredients: groups.size, unresolvedInRxNorm: unresolved, ...stats });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
