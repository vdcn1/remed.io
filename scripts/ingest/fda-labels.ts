// Stage 1: stream every openFDA drug label from the bulk zip files and keep the
// single best label per active substance, plus every brand name and FDA
// pharmacologic class (EPC) seen for that substance.
//
// No database or network needed. Output: data/raw/labels.ndjson (one substance per line).
//
//   npm run ingest:labels

import { spawn } from "node:child_process";
import { createWriteStream, readdirSync } from "node:fs";
import { join } from "node:path";
import chain from "stream-chain";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

const LABEL_DIR = "data/raw/labels";
const OUT = "data/raw/labels.ndjson";

// Label sections that describe interactions. The last two are OTC "Drug Facts" sections
// ("Ask a doctor or pharmacist before use if you are taking a blood thinner").
export const SECTIONS = [
  "boxed_warning",
  "contraindications",
  "drug_interactions",
  "warnings_and_cautions",
  "warnings",
  "do_not_use",
  "ask_doctor_or_pharmacist",
] as const;
type Section = (typeof SECTIONS)[number];

type RawLabel = Partial<Record<Section, string[]>> & {
  set_id?: string;
  version?: string;
  effective_time?: string;
  openfda?: {
    substance_name?: string[];
    generic_name?: string[];
    brand_name?: string[];
    product_type?: string[];
    pharm_class_epc?: string[];
    rxcui?: string[];
  };
};

export type SubstanceRecord = {
  substance: string;          // e.g. "SERTRALINE HYDROCHLORIDE"
  brands: string[];           // brand names seen on single-ingredient labels
  rxBrands: string[];         // subset seen on prescription labels
  epc: string[];              // FDA Established Pharmacologic Classes
  productRxcuis: string[];    // RxNorm product ids (used to find the ingredient)
  label: {
    set_id: string;
    version: string | null;
    effective_time: string | null;
    product_type: string;
    sections: Partial<Record<Section, string>>;
  };
};

type Candidate = SubstanceRecord & { score: number[] };

const records = new Map<string, Candidate>();
let seen = 0;
let kept = 0;

function sectionsOf(label: RawLabel) {
  const out: Partial<Record<Section, string>> = {};
  for (const s of SECTIONS) {
    const text = label[s]?.join("\n").trim();
    if (text) out[s] = text;
  }
  return out;
}

// Higher is better, compared lexicographically.
function scoreOf(label: RawLabel, sections: Partial<Record<Section, string>>, isRx: boolean) {
  return [
    sections.drug_interactions ? 1 : 0,
    isRx ? 1 : 0,
    Number(label.effective_time ?? 0),
    Object.values(sections).reduce((n, t) => n + (t?.length ?? 0), 0),
  ];
}

function better(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function addUnique(list: string[], values: string[] | undefined) {
  for (const v of values ?? []) if (!list.includes(v)) list.push(v);
}

function consider(label: RawLabel) {
  seen++;
  const of = label.openfda;
  const substances = of?.substance_name ?? [];
  // Combination products are skipped for now: one label would describe several ingredients.
  if (substances.length !== 1 || !label.set_id) return;
  const productType = of?.product_type?.[0] ?? "";
  if (!productType.startsWith("HUMAN")) return;

  const sections = sectionsOf(label);
  if (Object.keys(sections).length === 0) return;

  const substance = substances[0].toUpperCase().trim();
  const isRx = productType === "HUMAN PRESCRIPTION DRUG";
  const score = scoreOf(label, sections, isRx);

  let rec = records.get(substance);
  if (!rec) {
    rec = {
      substance,
      brands: [],
      rxBrands: [],
      epc: [],
      productRxcuis: [],
      score: [-1],
      label: null as unknown as Candidate["label"],
    };
    records.set(substance, rec);
  }
  addUnique(rec.brands, of?.brand_name);
  if (isRx) addUnique(rec.rxBrands, of?.brand_name);
  addUnique(rec.epc, of?.pharm_class_epc);
  if (rec.productRxcuis.length < 20) addUnique(rec.productRxcuis, of?.rxcui?.slice(0, 5));

  if (better(score, rec.score)) {
    rec.score = score;
    rec.label = {
      set_id: label.set_id,
      version: label.version ?? null,
      effective_time: label.effective_time ?? null,
      product_type: productType,
      sections,
    };
    kept++;
  }
}

async function processZip(file: string) {
  const unzip = spawn("unzip", ["-p", file], { stdio: ["ignore", "pipe", "inherit"] });
  const pipeline = chain([unzip.stdout, parser(), pick({ filter: "results" }), streamArray()]);
  for await (const { value } of pipeline as AsyncIterable<{ value: RawLabel }>) consider(value);
}

async function main() {
  const files = readdirSync(LABEL_DIR)
    .filter((f) => f.endsWith(".json.zip"))
    .sort();
  if (files.length === 0) throw new Error(`No label zips in ${LABEL_DIR}. See README → Importing data.`);

  for (const f of files) {
    const t = Date.now();
    await processZip(join(LABEL_DIR, f));
    console.log(`${f}: ${seen} labels seen, ${records.size} substances (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }

  const out = createWriteStream(OUT);
  for (const { score: _score, ...rec } of records.values()) out.write(JSON.stringify(rec) + "\n");
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  console.log(`Wrote ${records.size} substances to ${OUT} (${kept} label upgrades)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
