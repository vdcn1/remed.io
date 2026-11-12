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

const LABELS_PATH = "data/raw/labels.ndjson";
const RXNORM_CACHE_PATH = "data/raw/rxnorm-cache.json";
const RXNAV_BASE_URL = "https://rxnav.nlm.nih.gov/REST";

type Ingredient = { rxcui: string; name: string; epc: string[] } | null;

// ─── RxNorm ────────────────────────────────────────────────────────────────────

const rxnormCache: Record<string, Ingredient> = existsSync(RXNORM_CACHE_PATH)
  ? JSON.parse(readFileSync(RXNORM_CACHE_PATH, "utf8"))
  : {};

async function rxnavGet<T>(path: string, attempt = 0): Promise<T> {
  const response = await fetch(`${RXNAV_BASE_URL}${path}`, { signal: AbortSignal.timeout(15000) });
  if ((response.status === 429 || response.status >= 500) && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    return rxnavGet(path, attempt + 1);
  }
  if (!response.ok) throw new Error(`RxNav ${response.status} for ${path}`);
  return response.json() as Promise<T>;
}

async function lookupIngredient(substanceName: string): Promise<Ingredient> {
  const searchResult = await rxnavGet<{ idGroup: { rxnormId?: string[] } }>(
    `/rxcui.json?name=${encodeURIComponent(substanceName)}&search=2`,
  );
  const rxcui = searchResult.idGroup.rxnormId?.[0];
  if (!rxcui) return null;

  const conceptProperties = await rxnavGet<{ properties?: { tty: string; name: string } }>(
    `/rxcui/${rxcui}/properties.json`,
  );
  let ingredient: { rxcui: string; name: string } | null = null;
  if (conceptProperties.properties?.tty === "IN") {
    ingredient = { rxcui, name: conceptProperties.properties.name };
  } else if (conceptProperties.properties?.tty === "PIN") {
    // Precise ingredient (a salt form) -> its base ingredient
    const related = await rxnavGet<{
      relatedGroup: { conceptGroup?: { tty: string; conceptProperties?: { rxcui: string; name: string }[] }[] };
    }>(`/rxcui/${rxcui}/related.json?tty=IN`);
    const baseIngredient = related.relatedGroup.conceptGroup?.find((group) => group.tty === "IN")?.conceptProperties?.[0];
    if (baseIngredient) ingredient = { rxcui: baseIngredient.rxcui, name: baseIngredient.name };
  }
  if (!ingredient) return null;

  const classResult = await rxnavGet<{
    rxclassDrugInfoList?: { rxclassDrugInfo: { rxclassMinConceptItem: { className: string } }[] };
  }>(`/rxclass/class/byRxcui.json?rxcui=${ingredient.rxcui}&relaSource=FDASPL&relas=has_EPC`);
  const epcClassNames = [
    ...new Set(
      (classResult.rxclassDrugInfoList?.rxclassDrugInfo ?? []).map((info) => info.rxclassMinConceptItem.className),
    ),
  ];
  return { ...ingredient, epc: epcClassNames };
}

async function normaliseAllSubstances(substanceNames: string[]) {
  const pendingSubstances = substanceNames.filter((name) => !(name in rxnormCache));
  console.log(`RxNorm: ${substanceNames.length - pendingSubstances.length} cached, ${pendingSubstances.length} to look up`);
  let lookedUpCount = 0;
  const lookupWorker = async () => {
    while (pendingSubstances.length) {
      const substanceName = pendingSubstances.shift()!;
      try {
        rxnormCache[substanceName] = await lookupIngredient(substanceName);
      } catch (err) {
        console.warn(`  ${substanceName}: ${(err as Error).message}`);
        continue; // not cached -> retried next run
      }
      if (++lookedUpCount % 200 === 0) {
        console.log(`  ${lookedUpCount} looked up`);
        writeFileSync(RXNORM_CACHE_PATH, JSON.stringify(rxnormCache));
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, lookupWorker));
  writeFileSync(RXNORM_CACHE_PATH, JSON.stringify(rxnormCache));
}

// ─── Grouping ──────────────────────────────────────────────────────────────────

type IngredientGroup = {
  key: string;
  rxcui: string | null;
  name: string;
  substances: string[];
  epc: string[];
  brands: string[];
  label: SubstanceRecord["label"];
};

// Ranks a label for choosing the group's representative: interactions section, then prescription, then newest.
function labelRank(label: SubstanceRecord["label"]) {
  return [
    label.sections.drug_interactions ? 1 : 0,
    label.product_type === "HUMAN PRESCRIPTION DRUG" ? 1 : 0,
    Number(label.effective_time ?? 0),
  ];
}

function rankIsBetter(candidateRank: number[], currentRank: number[]) {
  for (let index = 0; index < candidateRank.length; index++) {
    if (candidateRank[index] !== currentRank[index]) return candidateRank[index] > currentRank[index];
  }
  return false;
}

// Only brand names from prescription labels are used: OTC "brand" names are mostly store
// brands and product descriptions ("HEB", "Pain Relief"). Well-known OTC brands are curated.
function isUsableBrand(brandName: string, group: IngredientGroup, ownerKeysByBrand: Map<string, Set<string>>) {
  const trimmedBrand = brandName.trim();
  const lowerBrand = trimmedBrand.toLowerCase();
  if (trimmedBrand.length < 3 || trimmedBrand.length > 40) return false;
  if (ownerKeysByBrand.get(lowerBrand)!.size > 1) return false; // used for several ingredients
  const groupName = group.name.toLowerCase();
  if (lowerBrand.includes(groupName) || group.substances.some((substance) => lowerBrand.includes(substance.toLowerCase().split(" ")[0]))) {
    return false;
  }
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
  const substanceRecords: SubstanceRecord[] = readFileSync(LABELS_PATH, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  // Prescription labels are always kept; OTC labels only when they talk about other drugs.
  const relevantRecords = substanceRecords.filter(
    (record) =>
      record.label.product_type === "HUMAN PRESCRIPTION DRUG" ||
      record.label.sections.drug_interactions ||
      record.label.sections.ask_doctor_or_pharmacist,
  );
  console.log(`${substanceRecords.length} substances, ${relevantRecords.length} relevant`);

  await normaliseAllSubstances(relevantRecords.map((record) => record.substance));

  const groupByKey = new Map<string, IngredientGroup>();
  for (const record of relevantRecords) {
    const ingredient = rxnormCache[record.substance];
    const name = ingredient?.name ?? record.substance.toLowerCase();
    const key = ingredient?.rxcui ?? `substance:${slugify(record.substance)}`;
    let group = groupByKey.get(key);
    if (!group) {
      group = { key, rxcui: ingredient?.rxcui ?? null, name, substances: [], epc: [], brands: [], label: record.label };
      groupByKey.set(key, group);
    } else if (rankIsBetter(labelRank(record.label), labelRank(group.label))) {
      group.label = record.label;
    }
    group.substances.push(record.substance);
    for (const epcName of [
      ...(ingredient?.epc ?? []),
      ...record.epc.map((epc) => epc.replace(/\s*\[EPC\]$/, "")),
    ]) {
      if (!group.epc.includes(epcName)) group.epc.push(epcName);
    }
    for (const brand of record.rxBrands) if (!group.brands.includes(brand)) group.brands.push(brand);
  }

  const ownerKeysByBrand = new Map<string, Set<string>>();
  for (const group of groupByKey.values()) {
    for (const brand of group.brands) {
      const brandKey = brand.trim().toLowerCase();
      if (!ownerKeysByBrand.has(brandKey)) ownerKeysByBrand.set(brandKey, new Set());
      ownerKeysByBrand.get(brandKey)!.add(group.key);
    }
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const stats = { drugsCreated: 0, drugsMatched: 0, aliases: 0, classesCreated: 0, memberships: 0, documents: 0 };
  try {
    await db.query("BEGIN");
    const {
      rows: [openfdaSource],
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
        (row) => [row.norm, row.class_id],
      ),
    );

    for (const group of groupByKey.values()) {
      // 1. Find or create the drug
      const candidateNames = [group.name, ...group.substances].map((name) => name.toLowerCase());
      const existingDrugs = await db.query<{ id: number; rxcui: string | null }>(
        `SELECT d.id, d.rxcui FROM drugs d
         WHERE ($1::text IS NOT NULL AND d.rxcui = $1) OR d.slug = $2 OR lower(d.name) = ANY($3)
            OR d.id IN (SELECT drug_id FROM drug_aliases WHERE lower(alias) = ANY($3))
         ORDER BY (d.rxcui = $1) DESC NULLS LAST, (d.slug = $2) DESC LIMIT 1`,
        [group.rxcui, slugify(group.name), candidateNames],
      );
      let drugId: number;
      if (existingDrugs.rows[0]) {
        drugId = existingDrugs.rows[0].id;
        stats.drugsMatched++;
        if (group.rxcui && !existingDrugs.rows[0].rxcui) {
          await db.query(
            `UPDATE drugs SET rxcui = $2, updated_at = now()
             WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM drugs WHERE rxcui = $2)`,
            [drugId, group.rxcui],
          );
        }
      } else {
        const { rows: insertedDrugRows } = await db.query<{ id: number }>(
          `INSERT INTO drugs (slug, name, rxcui) VALUES ($1, $2, $3)
           ON CONFLICT (slug) DO UPDATE SET updated_at = now() RETURNING id`,
          [slugify(group.name), displayName(group.name), group.rxcui],
        );
        drugId = insertedDrugRows[0].id;
        stats.drugsCreated++;
      }

      // 2. Aliases: salt forms as synonyms, brand names as brands
      const aliasRows: [string, "brand" | "synonym"][] = [
        ...group.substances
          .filter((substance) => substance.toLowerCase() !== group.name.toLowerCase())
          .map((substance) => [displayName(substance), "synonym"] as [string, "synonym"]),
        ...group.brands
          .filter((brand) => isUsableBrand(brand, group, ownerKeysByBrand))
          .map((brand) => [brand.trim(), "brand"] as [string, "brand"]),
      ];
      for (const [alias, aliasKind] of aliasRows) {
        const insertResult = await db.query(
          `INSERT INTO drug_aliases (drug_id, alias, kind, origin) VALUES ($1, $2, $3, 'import')
           ON CONFLICT (lower(alias)) DO NOTHING`,
          [drugId, alias, aliasKind],
        );
        stats.aliases += insertResult.rowCount ?? 0;
      }

      // 3. Classes (FDA EPC). Names matching a curated class alias join that class.
      for (const epcName of group.epc) {
        if (CLASS_EXCLUSIONS[epcName]?.includes(group.name.toLowerCase())) continue;
        const norm = classNorm(epcName);
        let classId = classIdByNorm.get(norm);
        if (!classId) {
          const { rows: insertedClassRows } = await db.query<{ id: number }>(
            `INSERT INTO drug_classes (slug, name, origin) VALUES ($1, $2, 'epc')
             ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [`epc-${slugify(epcName)}`, epcName],
          );
          classId = insertedClassRows[0].id;
          await db.query(
            `INSERT INTO drug_class_aliases (class_id, alias, norm) VALUES ($1, $2, $3) ON CONFLICT (norm) DO NOTHING`,
            [classId, epcName, norm],
          );
          classIdByNorm.set(norm, classId);
          stats.classesCreated++;
        }
        const membershipResult = await db.query(
          `INSERT INTO drug_class_members (drug_id, class_id, origin) VALUES ($1, $2, 'import') ON CONFLICT DO NOTHING`,
          [drugId, classId],
        );
        stats.memberships += membershipResult.rowCount ?? 0;
      }

      // 4. The label text, for extraction
      const documentContent = {
        substances: group.substances,
        product_type: group.label.product_type,
        effective_time: group.label.effective_time,
        sections: group.label.sections,
      };
      const contentHash = createHash("sha256").update(JSON.stringify(group.label.sections)).digest("hex");
      await db.query(
        `INSERT INTO raw_documents (source_id, external_id, version, drug_id, url, content, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           version = EXCLUDED.version, drug_id = EXCLUDED.drug_id, content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash, fetched_at = now()`,
        [
          openfdaSource.id,
          group.label.set_id,
          group.label.version,
          drugId,
          `https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=${group.label.set_id}`,
          documentContent,
          contentHash,
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
  const unresolvedSubstanceCount = relevantRecords.filter((record) => !rxnormCache[record.substance]).length;
  console.log({ ingredients: groupByKey.size, unresolvedInRxNorm: unresolvedSubstanceCount, ...stats });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
