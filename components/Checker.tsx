"use client";

import { useState } from "react";
import DrugInput from "./DrugInput";
import type { Drug, DrugLabel, Duplication, Interaction, Severity } from "@/lib/interactions";
import type { FdaResult } from "@/lib/openfda";

type CheckResult = {
  first: { input: string; drug: Drug | null; labels: DrugLabel[] };
  second: { input: string; drug: Drug | null; labels: DrugLabel[] };
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

const EXAMPLE_PAIRS: [string, string][] = [
  ["Warfarin", "Advil"],
  ["Zoloft", "Tramadol"],
  ["Viagra", "Nitroglycerin"],
  ["Simvastatin", "Grapefruit juice"],
  ["Tylenol", "Amoxicillin"],
];

export default function Checker() {
  const [firstRemedy, setFirstRemedy] = useState("");
  const [secondRemedy, setSecondRemedy] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);

  async function checkPair(firstName = firstRemedy, secondName = secondRemedy) {
    if (!firstName.trim() || !secondName.trim()) return;
    setIsChecking(true);
    setErrorMessage(null);
    try {
      const response = await fetch("/api/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first: firstName, second: secondName }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Something went wrong");
      setCheckResult(payload);
    } catch (err) {
      setCheckResult(null);
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <section>
      <form
        className="checker"
        onSubmit={(event) => {
          event.preventDefault();
          checkPair();
        }}
      >
        <DrugInput
          fieldLabel="First remedy"
          value={firstRemedy}
          onValueChange={setFirstRemedy}
          placeholder="e.g. Ibuprofen"
        />
        <button
          type="button"
          className="swap"
          aria-label="Swap remedies"
          title="Swap"
          onClick={() => {
            setFirstRemedy(secondRemedy);
            setSecondRemedy(firstRemedy);
          }}
        >
          ⇄
        </button>
        <DrugInput
          fieldLabel="Second remedy"
          value={secondRemedy}
          onValueChange={setSecondRemedy}
          placeholder="e.g. Warfarin"
        />
        <button
          className="primary"
          type="submit"
          disabled={isChecking || !firstRemedy.trim() || !secondRemedy.trim()}
        >
          {isChecking ? "Checking…" : "Check"}
        </button>
      </form>

      <div className="examples">
        <span className="muted">Try:</span>
        {EXAMPLE_PAIRS.map(([exampleFirst, exampleSecond]) => (
          <button
            key={exampleFirst + exampleSecond}
            type="button"
            className="chip"
            onClick={() => {
              setFirstRemedy(exampleFirst);
              setSecondRemedy(exampleSecond);
              checkPair(exampleFirst, exampleSecond);
            }}
          >
            {exampleFirst} + {exampleSecond}
          </button>
        ))}
      </div>

      {errorMessage && <div className="alert">{errorMessage}</div>}
      {checkResult && <ResultView result={checkResult} />}
    </section>
  );
}

/** Warning triangle shown for critical (contraindicated) interactions, which can be fatal. */
function CriticalWarningIcon() {
  return (
    <svg
      className="critical-icon"
      role="img"
      aria-label="Critical interaction: can be fatal"
      viewBox="0 0 24 24"
      width="28"
      height="28"
    >
      <path
        fill="currentColor"
        d="M12 2.5 1.5 21h21L12 2.5Zm0 6.2 6.9 12.3H5.1L12 8.7Zm-1 3.8h2v4.6h-2v-4.6Zm0 5.6h2v2h-2v-2Z"
      />
    </svg>
  );
}

function ResultView({ result }: { result: CheckResult }) {
  const firstName = result.first.drug?.name ?? result.first.input;
  const secondName = result.second.drug?.name ?? result.second.input;
  const unknownInputs = [result.first, result.second].filter((side) => !side.drug).map((side) => side.input);
  const hasFdaFindings = result.fda.findings.length > 0;

  let verdict: { tone: string; title: string; text: string };
  if (result.severity) {
    verdict = {
      tone: result.severity,
      title: SEVERITY_LABEL[result.severity],
      text: result.interactions[0].summary,
    };
  } else if (hasFdaFindings) {
    verdict = {
      tone: "moderate",
      title: "Mentioned on the FDA label",
      text: "No curated interaction on record, but one drug's official label mentions the other. Review the excerpts below.",
    };
  } else if (unknownInputs.length) {
    verdict = {
      tone: "unknown",
      title: "Not enough data",
      text: `We don't have “${unknownInputs.join("” or “")}” in our database yet, so we can't rule out an interaction.`,
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
          {firstName} <span className="plus">+</span> {secondName}
        </div>
        {result.severity === "contraindicated" && <CriticalWarningIcon />}
        <h2>{verdict.title}</h2>
        <p>{verdict.text}</p>
      </div>

      {[
        { drugName: firstName, labels: result.first.labels },
        { drugName: secondName, labels: result.second.labels },
      ].flatMap(({ drugName, labels }) =>
        labels.map((label) => (
          <article key={label.id} className={`card label-card label-card-${label.labelType}`}>
            <div className="badges">
              <span className={`badge label-${label.labelType}`}>
                {label.labelType === "warning" ? "Warning" : "Legal status"}
              </span>
              <span className="muted">{drugName}</span>
              {label.reviewStatus !== "reviewed" && (
                <span className="badge tone-unknown" title="No doctor or pharmacist has checked this entry">
                  not reviewed
                </span>
              )}
            </div>
            <h3>{label.title}</h3>
            <p>{label.body}</p>
            <p className="source">
              Source: {label.source.name}
              {label.source.checkedOn && <> · checked {label.source.checkedOn}</>}
              {label.source.ref && (
                <>
                  {" · "}
                  <a href={label.source.ref} target="_blank" rel="noreferrer">
                    page
                  </a>
                </>
              )}
            </p>
          </article>
        )),
      )}

      {result.interactions.map((interaction) => (
        <article key={interaction.id} className="card">
          <div className="badges">
            <span className={`badge tone-${interaction.severity}`}>{interaction.severity}</span>
            {interaction.reviewStatus !== "reviewed" && (
              <span className="badge tone-unknown" title="No doctor or pharmacist has checked this entry">
                not reviewed
              </span>
            )}
          </div>
          <h3>{interaction.summary}</h3>
          {interaction.matchedVia.length > 0 && (
            <p className="via">Applies because {interaction.matchedVia.join(" and ")}.</p>
          )}
          {interaction.mechanism && (
            <p>
              <strong>Why:</strong> {interaction.mechanism}
            </p>
          )}
          {interaction.recommendation && (
            <p>
              <strong>What to do:</strong> {interaction.recommendation}
            </p>
          )}
          {interaction.evidence && (
            <blockquote className="evidence">
              “{interaction.evidence}”
            </blockquote>
          )}
          <p className="source">
            {interaction.extractedBy ? (
              <>
                Found by text matching in the {interaction.labelOf ?? "FDA"} label
                {interaction.source.ref && (
                  <>
                    {" · "}
                    <a href={interaction.source.ref} target="_blank" rel="noreferrer">
                      DailyMed
                    </a>
                  </>
                )}
              </>
            ) : (
              <>Source: {interaction.source.name}</>
            )}
          </p>
        </article>
      ))}

      {result.duplications.map((duplication) => (
        <article key={duplication.className} className="card">
          <span className="badge label-same-class">same class</span>
          <h3>Therapeutic duplication</h3>
          <p>{duplication.note}</p>
        </article>
      ))}

      {result.fda.enabled && (
        <article className="card fda">
          <h3>FDA label cross-check</h3>
          {result.fda.error ? (
            <p className="muted">Couldn&apos;t reach openFDA ({result.fda.error}).</p>
          ) : hasFdaFindings ? (
            result.fda.findings.map((finding, findingIndex) => (
              <blockquote key={findingIndex}>
                <div className="fda-head">
                  {finding.labelOf} label · {finding.section} · mentions “{finding.mentions}”
                  {finding.url && (
                    <>
                      {" · "}
                      <a href={finding.url} target="_blank" rel="noreferrer">
                        DailyMed
                      </a>
                    </>
                  )}
                </div>
                {finding.excerpt}
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
