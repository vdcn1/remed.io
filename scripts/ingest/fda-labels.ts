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

const LABEL_DIRECTORY = "data/raw/labels";
const OUTPUT_PATH = "data/raw/labels.ndjson";

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
type SectionKey = (typeof SECTIONS)[number];

type RawOpenFdaLabel = Partial<Record<SectionKey, string[]>> & {
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
  substance: string; // e.g. "SERTRALINE HYDROCHLORIDE"
  brands: string[]; // brand names seen on single-ingredient labels
  rxBrands: string[]; // subset seen on prescription labels
  epc: string[]; // FDA Established Pharmacologic Classes
  productRxcuis: string[]; // RxNorm product ids (used to find the ingredient)
  label: {
    set_id: string;
    version: string | null;
    effective_time: string | null;
    product_type: string;
    sections: Partial<Record<SectionKey, string>>;
  };
};

type ScoredSubstanceRecord = SubstanceRecord & { score: number[] };

const substanceRecords = new Map<string, ScoredSubstanceRecord>();
let labelsSeen = 0;
let labelUpgrades = 0;

function interactionSectionsOf(label: RawOpenFdaLabel) {
  const sectionsByKey: Partial<Record<SectionKey, string>> = {};
  for (const sectionKey of SECTIONS) {
    const sectionText = label[sectionKey]?.join("\n").trim();
    if (sectionText) sectionsByKey[sectionKey] = sectionText;
  }
  return sectionsByKey;
}

// Higher is better, compared lexicographically.
function labelScore(label: RawOpenFdaLabel, sections: Partial<Record<SectionKey, string>>, isPrescription: boolean) {
  return [
    sections.drug_interactions ? 1 : 0,
    isPrescription ? 1 : 0,
    Number(label.effective_time ?? 0),
    Object.values(sections).reduce((totalLength, sectionText) => totalLength + (sectionText?.length ?? 0), 0),
  ];
}

function scoreIsBetter(candidateScore: number[], currentScore: number[]) {
  for (let index = 0; index < candidateScore.length; index++) {
    if (candidateScore[index] !== currentScore[index]) return candidateScore[index] > currentScore[index];
  }
  return false;
}

function addUnique(list: string[], values: string[] | undefined) {
  for (const value of values ?? []) if (!list.includes(value)) list.push(value);
}

function considerLabel(label: RawOpenFdaLabel) {
  labelsSeen++;
  const openfdaFields = label.openfda;
  const substanceNames = openfdaFields?.substance_name ?? [];
  // Combination products are skipped for now: one label would describe several ingredients.
  if (substanceNames.length !== 1 || !label.set_id) return;
  const productType = openfdaFields?.product_type?.[0] ?? "";
  if (!productType.startsWith("HUMAN")) return;

  const sections = interactionSectionsOf(label);
  if (Object.keys(sections).length === 0) return;

  const substance = substanceNames[0].toUpperCase().trim();
  const isPrescription = productType === "HUMAN PRESCRIPTION DRUG";
  const score = labelScore(label, sections, isPrescription);

  let substanceRecord = substanceRecords.get(substance);
  if (!substanceRecord) {
    substanceRecord = {
      substance,
      brands: [],
      rxBrands: [],
      epc: [],
      productRxcuis: [],
      score: [-1],
      label: null as unknown as SubstanceRecord["label"],
    };
    substanceRecords.set(substance, substanceRecord);
  }
  addUnique(substanceRecord.brands, openfdaFields?.brand_name);
  if (isPrescription) addUnique(substanceRecord.rxBrands, openfdaFields?.brand_name);
  addUnique(substanceRecord.epc, openfdaFields?.pharm_class_epc);
  if (substanceRecord.productRxcuis.length < 20) {
    addUnique(substanceRecord.productRxcuis, openfdaFields?.rxcui?.slice(0, 5));
  }

  if (scoreIsBetter(score, substanceRecord.score)) {
    substanceRecord.score = score;
    substanceRecord.label = {
      set_id: label.set_id,
      version: label.version ?? null,
      effective_time: label.effective_time ?? null,
      product_type: productType,
      sections,
    };
    labelUpgrades++;
  }
}

async function processZipFile(zipPath: string) {
  const unzipProcess = spawn("unzip", ["-p", zipPath], { stdio: ["ignore", "pipe", "inherit"] });
  const pipeline = chain([unzipProcess.stdout, parser(), pick({ filter: "results" }), streamArray()]);
  for await (const { value } of pipeline as AsyncIterable<{ value: RawOpenFdaLabel }>) considerLabel(value);
}

async function main() {
  const zipFileNames = readdirSync(LABEL_DIRECTORY)
    .filter((fileName) => fileName.endsWith(".json.zip"))
    .sort();
  if (zipFileNames.length === 0) {
    throw new Error(`No label zips in ${LABEL_DIRECTORY}. See README → Importing data.`);
  }

  for (const zipFileName of zipFileNames) {
    const startedAt = Date.now();
    await processZipFile(join(LABEL_DIRECTORY, zipFileName));
    console.log(
      `${zipFileName}: ${labelsSeen} labels seen, ${substanceRecords.size} substances (${((Date.now() - startedAt) / 1000).toFixed(0)}s)`,
    );
  }

  const outputStream = createWriteStream(OUTPUT_PATH);
  for (const { score: _score, ...substanceRecord } of substanceRecords.values()) {
    outputStream.write(JSON.stringify(substanceRecord) + "\n");
  }
  await new Promise<void>((resolve, reject) =>
    outputStream.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
  console.log(`Wrote ${substanceRecords.size} substances to ${OUTPUT_PATH} (${labelUpgrades} label upgrades)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
