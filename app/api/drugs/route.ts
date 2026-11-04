import { NextResponse, type NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { searchDrugs } from "@/lib/interactions";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (q.length > 100) return NextResponse.json({ error: "Query too long" }, { status: 400 });
  try {
    return NextResponse.json({ results: await searchDrugs(pool, q) });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
}
