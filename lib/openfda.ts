// Cross-checks the official FDA drug label (openFDA) of one drug for mentions of the other.
// This is a text search, not a curated judgement — results are shown as supporting evidence.

const LABEL_SECTIONS = ["boxed_warning", "contraindications", "drug_interactions", "warnings_and_cautions", "warnings"] as const;
type Section = (typeof LABEL_SECTIONS)[number];

export type LabelFinding = {
  labelOf: string;    // drug whose label was searched
  mentions: string;   // term that was found
  section: string;
  excerpt: string;
  url: string | null; // DailyMed link
};

export type FdaResult = { enabled: boolean; findings: LabelFinding[]; checked: string[]; error?: string };

type Label = Partial<Record<Section, string[]>> & { set_id?: string; openfda?: { generic_name?: string[] } };

const SECTION_NAMES: Record<Section, string> = {
  boxed_warning: "Boxed warning",
  contraindications: "Contraindications",
  drug_interactions: "Drug interactions",
  warnings_and_cautions: "Warnings and precautions",
  warnings: "Warnings",
};

async function fetchLabel(name: string): Promise<Label | null> {
  const q = encodeURIComponent(`openfda.generic_name:"${name.replace(/"/g, "")}"`);
  const res = await fetch(`https://api.fda.gov/drug/label.json?search=${q}&limit=10`, {
    signal: AbortSignal.timeout(6000),
    next: { revalidate: 60 * 60 * 24 },
  });
  if (res.status === 404) return null; // openFDA returns 404 for "no matches"
  if (!res.ok) throw new Error(`openFDA responded ${res.status}`);
  const data = (await res.json()) as { results?: Label[] };
  const results = data.results ?? [];
  return results.find((l) => l.drug_interactions?.length) ?? results[0] ?? null;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerptAround(text: string, index: number, length: number, radius = 220) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function searchLabel(label: Label, labelOf: string, terms: string[]): LabelFinding[] {
  const findings: LabelFinding[] = [];
  for (const section of LABEL_SECTIONS) {
    const text = label[section]?.join("\n");
    if (!text) continue;
    for (const term of terms) {
      const m = new RegExp(`\\b${escapeRegExp(term)}`, "i").exec(text);
      if (!m) continue;
      findings.push({
        labelOf,
        mentions: term,
        section: SECTION_NAMES[section],
        excerpt: excerptAround(text, m.index, m[0].length),
        url: label.set_id ? `https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=${label.set_id}` : null,
      });
      break; // one finding per section is enough
    }
  }
  return findings;
}

export type FdaSubject = { name: string; terms: string[] };

export async function checkFdaLabels(a: FdaSubject, b: FdaSubject): Promise<FdaResult> {
  if (process.env.OPENFDA_ENABLED === "false") return { enabled: false, findings: [], checked: [] };
  try {
    const [labelA, labelB] = await Promise.all([fetchLabel(a.name), fetchLabel(b.name)]);
    const findings = [
      ...(labelA ? searchLabel(labelA, a.name, b.terms) : []),
      ...(labelB ? searchLabel(labelB, b.name, a.terms) : []),
    ];
    const checked = [labelA && a.name, labelB && b.name].filter((x): x is string => !!x);
    return { enabled: true, findings, checked };
  } catch (err) {
    return { enabled: true, findings: [], checked: [], error: err instanceof Error ? err.message : String(err) };
  }
}
