"use client";

import { useState } from "react";
import DrugInput from "./DrugInput";
import type { Drug, Duplication, Interaction, Severity } from "@/lib/interactions";
import type { FdaResult } from "@/lib/openfda";

type CheckResult = {
  a: { input: string; drug: Drug | null };
  b: { input: string; drug: Drug | null };
  severity: Severity | null;
  interactions: Interaction[];
  duplications: Duplication[];
  fda: FdaResult;
};

const SEVERITY_LABEL: Record<Severity, string> = {
  contraindicated: "Do not combine",
  major: "Major interaction",
  moderate: "Moderate interaction",
  minor: "Minor interaction",
};

const EXAMPLES: [string, string][] = [
  ["Warfarin", "Advil"],
  ["Zoloft", "Tramadol"],
  ["Viagra", "Nitroglycerin"],
  ["Simvastatin", "Grapefruit juice"],
  ["Tylenol", "Amoxicillin"],
];

export default function Checker() {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function check(x = a, y = b) {
    if (!x.trim() || !y.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: x, b: y }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <form
        className="checker"
        onSubmit={(e) => {
          e.preventDefault();
          check();
        }}
      >
        <DrugInput label="First remedy" value={a} onChange={setA} placeholder="e.g. Ibuprofen" />
        <button
          type="button"
          className="swap"
          aria-label="Swap remedies"
          title="Swap"
          onClick={() => {
            setA(b);
            setB(a);
          }}
        >
          ⇄
        </button>
        <DrugInput label="Second remedy" value={b} onChange={setB} placeholder="e.g. Warfarin" />
        <button className="primary" type="submit" disabled={loading || !a.trim() || !b.trim()}>
          {loading ? "Checking…" : "Check"}
        </button>
      </form>

      <div className="examples">
        <span className="muted">Try:</span>
        {EXAMPLES.map(([x, y]) => (
          <button
            key={x + y}
            type="button"
            className="chip"
            onClick={() => {
              setA(x);
              setB(y);
              check(x, y);
            }}
          >
            {x} + {y}
          </button>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}
      {result && <ResultView result={result} />}
    </section>
  );
}

function ResultView({ result }: { result: CheckResult }) {
  const nameA = result.a.drug?.name ?? result.a.input;
  const nameB = result.b.drug?.name ?? result.b.input;
  const unknown = [result.a, result.b].filter((s) => !s.drug).map((s) => s.input);
  const fdaHits = result.fda.findings.length > 0;

  let verdict: { tone: string; title: string; text: string };
  if (result.severity) {
    verdict = {
      tone: result.severity,
      title: SEVERITY_LABEL[result.severity],
      text: result.interactions[0].summary,
    };
  } else if (fdaHits) {
    verdict = {
      tone: "moderate",
      title: "Mentioned on the FDA label",
      text: "No curated interaction on record, but one drug's official label mentions the other. Review the excerpts below.",
    };
  } else if (unknown.length) {
    verdict = {
      tone: "unknown",
      title: "Not enough data",
      text: `We don't have “${unknown.join("” or “")}” in our database yet, so we can't rule out an interaction.`,
    };
  } else {
    verdict = {
      tone: "none",
      title: "No known interaction",
      text: "No interaction is on record for this pair. That's not a guarantee — check with a pharmacist if unsure.",
    };
  }

  return (
    <div className="result">
      <div className={`verdict tone-${verdict.tone}`}>
        <div className="pair">
          {nameA} <span className="plus">+</span> {nameB}
        </div>
        <h2>{verdict.title}</h2>
        <p>{verdict.text}</p>
      </div>

      {result.interactions.map((i) => (
        <article key={i.id} className="card">
          <div className="badges">
            <span className={`badge tone-${i.severity}`}>{i.severity}</span>
            {i.reviewStatus !== "reviewed" && (
              <span className="badge tone-unknown" title="No doctor or pharmacist has checked this entry">
                not reviewed
              </span>
            )}
          </div>
          <h3>{i.summary}</h3>
          {i.matchedVia.length > 0 && <p className="via">Applies because {i.matchedVia.join(" and ")}.</p>}
          {i.mechanism && (
            <p>
              <strong>Why:</strong> {i.mechanism}
            </p>
          )}
          {i.recommendation && (
            <p>
              <strong>What to do:</strong> {i.recommendation}
            </p>
          )}
          {i.evidence && (
            <blockquote className="evidence">
              “{i.evidence}”
            </blockquote>
          )}
          <p className="source">
            {i.extractedBy ? (
              <>
                Found by text matching in the {i.labelOf ?? "FDA"} label
                {i.source.ref && (
                  <>
                    {" · "}
                    <a href={i.source.ref} target="_blank" rel="noreferrer">
                      DailyMed
                    </a>
                  </>
                )}
              </>
            ) : (
              <>Source: {i.source.name}</>
            )}
          </p>
        </article>
      ))}

      {result.duplications.map((d) => (
        <article key={d.className} className="card">
          <span className="badge tone-moderate">same class</span>
          <h3>Therapeutic duplication</h3>
          <p>{d.note}</p>
        </article>
      ))}

      {result.fda.enabled && (
        <article className="card fda">
          <h3>FDA label cross-check</h3>
          {result.fda.error ? (
            <p className="muted">Couldn&apos;t reach openFDA ({result.fda.error}).</p>
          ) : fdaHits ? (
            result.fda.findings.map((f, idx) => (
              <blockquote key={idx}>
                <div className="fda-head">
                  {f.labelOf} label · {f.section} · mentions “{f.mentions}”
                  {f.url && (
                    <>
                      {" · "}
                      <a href={f.url} target="_blank" rel="noreferrer">
                        DailyMed
                      </a>
                    </>
                  )}
                </div>
                {f.excerpt}
              </blockquote>
            ))
          ) : (
            <p className="muted">
              {result.fda.checked.length
                ? `Searched the ${result.fda.checked.join(" and ")} label${result.fda.checked.length > 1 ? "s" : ""}; no mention of the other found.`
                : "No FDA label found for either entry."}
            </p>
          )}
        </article>
      )}
    </div>
  );
}
