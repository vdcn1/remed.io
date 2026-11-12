// Cross-checks the official FDA drug label (openFDA) of one drug for mentions of the other.
// This is a text search, not a curated judgement — results are shown as supporting evidence.

const SEARCHED_LABEL_SECTIONS = ["boxed_warning", "contraindications", "drug_interactions", "warnings_and_cautions", "warnings"] as const;
type LabelSectionKey = (typeof SEARCHED_LABEL_SECTIONS)[number];

export type LabelFinding = {
  labelOf: string; // drug whose label was searched
  mentions: string; // term that was found
  section: string;
  excerpt: string;
  url: string | null; // DailyMed link
};

export type FdaResult = { enabled: boolean; findings: LabelFinding[]; checked: string[]; error?: string };

type OpenFdaLabel = Partial<Record<LabelSectionKey, string[]>> & {
  set_id?: string;
  openfda?: { generic_name?: string[] };
};

const SECTION_DISPLAY_NAMES: Record<LabelSectionKey, string> = {
  boxed_warning: "Boxed warning",
  contraindications: "Contraindications",
  drug_interactions: "Drug interactions",
  warnings_and_cautions: "Warnings and precautions",
  warnings: "Warnings",
};

async function fetchLabelByGenericName(genericName: string): Promise<OpenFdaLabel | null> {
  const encodedSearch = encodeURIComponent(`openfda.generic_name:"${genericName.replace(/"/g, "")}"`);
  const response = await fetch(`https://api.fda.gov/drug/label.json?search=${encodedSearch}&limit=10`, {
    signal: AbortSignal.timeout(6000),
    next: { revalidate: 60 * 60 * 24 },
  });
  if (response.status === 404) return null; // openFDA returns 404 for "no matches"
  if (!response.ok) throw new Error(`openFDA responded ${response.status}`);
  const payload = (await response.json()) as { results?: OpenFdaLabel[] };
  const candidateLabels = payload.results ?? [];
  return candidateLabels.find((label) => label.drug_interactions?.length) ?? candidateLabels[0] ?? null;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerptAround(text: string, matchIndex: number, matchLength: number, radius = 220) {
  const excerptStart = Math.max(0, matchIndex - radius);
  const excerptEnd = Math.min(text.length, matchIndex + matchLength + radius);
  const body = text.slice(excerptStart, excerptEnd).replace(/\s+/g, " ").trim();
  return `${excerptStart > 0 ? "…" : ""}${body}${excerptEnd < text.length ? "…" : ""}`;
}

function searchLabelForTerms(label: OpenFdaLabel, labelOf: string, searchTerms: string[]): LabelFinding[] {
  const findings: LabelFinding[] = [];
  for (const sectionKey of SEARCHED_LABEL_SECTIONS) {
    const sectionText = label[sectionKey]?.join("\n");
    if (!sectionText) continue;
    for (const term of searchTerms) {
      const match = new RegExp(`\\b${escapeRegExp(term)}`, "i").exec(sectionText);
      if (!match) continue;
      findings.push({
        labelOf,
        mentions: term,
        section: SECTION_DISPLAY_NAMES[sectionKey],
        excerpt: excerptAround(sectionText, match.index, match[0].length),
        url: label.set_id ? `https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=${label.set_id}` : null,
      });
      break; // one finding per section is enough
    }
  }
  return findings;
}

export type FdaSubject = { name: string; terms: string[] };

export async function checkFdaLabels(firstSubject: FdaSubject, secondSubject: FdaSubject): Promise<FdaResult> {
  if (process.env.OPENFDA_ENABLED === "false") return { enabled: false, findings: [], checked: [] };
  try {
    const [firstLabel, secondLabel] = await Promise.all([
      fetchLabelByGenericName(firstSubject.name),
      fetchLabelByGenericName(secondSubject.name),
    ]);
    const findings = [
      ...(firstLabel ? searchLabelForTerms(firstLabel, firstSubject.name, secondSubject.terms) : []),
      ...(secondLabel ? searchLabelForTerms(secondLabel, secondSubject.name, firstSubject.terms) : []),
    ];
    const checked = [firstLabel && firstSubject.name, secondLabel && secondSubject.name].filter(
      (name): name is string => !!name,
    );
    return { enabled: true, findings, checked };
  } catch (err) {
    return {
      enabled: true,
      findings: [],
      checked: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
