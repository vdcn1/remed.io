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
function labelSearchTerms(enteredName: string, drug: Drug | null): string[] {
  if (!drug) return [enteredName.trim()];
  const classNames = drug.classes.map((drugClass) => drugClass.name.replace(/s$/, "")); // "NSAIDs" -> "NSAID"
  return [drug.name, ...drug.aliases, ...classNames];
}

function fdaSubject(enteredName: string, drug: Drug | null): FdaSubject {
  return { name: drug?.name ?? enteredName.trim(), terms: labelSearchTerms(enteredName, drug) };
}

export async function POST(request: NextRequest) {
  const requestBody = (await request.json().catch(() => null)) as { first?: unknown; second?: unknown } | null;
  const firstName = typeof requestBody?.first === "string" ? requestBody.first.trim() : "";
  const secondName = typeof requestBody?.second === "string" ? requestBody.second.trim() : "";
  if (!firstName || !secondName) {
    return NextResponse.json({ error: "Provide two remedies: { first, second }" }, { status: 400 });
  }
  if (firstName.length > 100 || secondName.length > 100) {
    return NextResponse.json({ error: "Names are too long" }, { status: 400 });
  }

  let firstDrug: Drug | null, secondDrug: Drug | null;
  try {
    [firstDrug, secondDrug] = await Promise.all([resolveDrug(pool, firstName), resolveDrug(pool, secondName)]);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  if (firstDrug && secondDrug && firstDrug.id === secondDrug.id) {
    return NextResponse.json(
      { error: `Both entries are ${firstDrug.name}. Pick two different remedies.` },
      { status: 400 },
    );
  }

  const interactions =
    firstDrug && secondDrug ? await findInteractions(pool, firstDrug, secondDrug) : [];
  // The live label search is a fallback for pairs the database knows nothing about.
  const fda = interactions.length
    ? { enabled: false, findings: [], checked: [] }
    : await checkFdaLabels(fdaSubject(firstName, firstDrug), fdaSubject(secondName, secondDrug));
  const duplications = firstDrug && secondDrug ? findDuplications(firstDrug, secondDrug) : [];

  return NextResponse.json({
    first: { input: firstName, drug: firstDrug },
    second: { input: secondName, drug: secondDrug },
    severity: highestSeverity(interactions),
    interactions,
    duplications,
    fda,
  });
}
