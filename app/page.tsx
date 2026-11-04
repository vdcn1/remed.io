import Checker from "@/components/Checker";

export default function Home() {
  return (
    <main className="page">
      <header className="hero">
        <div className="brand">
          remed<span>.io</span>
        </div>
        <h1>Do these two go together?</h1>
        <p className="lede">
          Enter two medicines, supplements, or remedies — generic or brand names — to check for known interactions.
        </p>
      </header>

      <Checker />

      <footer className="disclaimer">
        remed.io is an informational tool and does not replace advice from a doctor or pharmacist. Absence of a
        result does not mean a combination is safe. Label excerpts come from the{" "}
        <a href="https://open.fda.gov/apis/drug/label/" target="_blank" rel="noreferrer">
          openFDA drug label API
        </a>
        .
      </footer>
    </main>
  );
}
