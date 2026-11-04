import { NextResponse, type NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { checkFdaLabels, type FdaSubject } from "@/lib/openfda";
import {
  findDuplications,
  findInteractions,
  highestSeverity,
  resolveDrug,
  type Drug,
} from "@/lib/interactions";

// Words used to find a drug in another drug's FDA label: its name, brand names, and class names.
function labelTerms(input: string, drug: Drug | null): string[] {
  if (!drug) return [input.trim()];
  const classTerms = drug.classes.map((c) => c.name.replace(/s$/, "")); // "NSAIDs" -> "NSAID"
  return [drug.name, ...drug.aliases, ...classTerms];
}

function fdaSubject(input: string, drug: Drug | null): FdaSubject {
  return { name: drug?.name ?? input.trim(), terms: labelTerms(input, drug) };
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { a?: unknown; b?: unknown } | null;
  const a = typeof body?.a === "string" ? body.a.trim() : "";
  const b = typeof body?.b === "string" ? body.b.trim() : "";
  if (!a || !b) return NextResponse.json({ error: "Provide two remedies: { a, b }" }, { status: 400 });
  if (a.length > 100 || b.length > 100) return NextResponse.json({ error: "Names are too long" }, { status: 400 });

  let drugA: Drug | null, drugB: Drug | null;
  try {
    [drugA, drugB] = await Promise.all([resolveDrug(pool, a), resolveDrug(pool, b)]);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  if (drugA && drugB && drugA.id === drugB.id) {
    return NextResponse.json({ error: `Both entries are ${drugA.name}. Pick two different remedies.` }, { status: 400 });
  }

  const [interactions, fda] = await Promise.all([
    drugA && drugB ? findInteractions(pool, drugA, drugB) : Promise.resolve([]),
    checkFdaLabels(fdaSubject(a, drugA), fdaSubject(b, drugB)),
  ]);
  const duplications = drugA && drugB ? findDuplications(drugA, drugB) : [];

  return NextResponse.json({
    a: { input: a, drug: drugA },
    b: { input: b, drug: drugB },
    severity: highestSeverity(interactions),
    interactions,
    duplications,
    fda,
  });
}
