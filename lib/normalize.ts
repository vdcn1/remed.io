// Name normalisation shared by the importers and the extraction resolver.

/** "St. John's Wort" -> "st-johns-wort" */
export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Matching key for class names: "Non-steroidal Anti-inflammatory Drugs (NSAIDs)" -> "non steroidal anti inflammatory drug nsaid" */
export function classNorm(s: string) {
  const words = s
    .toLowerCase()
    .replace(/\[epc\]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return words.join(" ");
}

/** "SERTRALINE HYDROCHLORIDE" -> "Sertraline hydrochloride" */
export function displayName(s: string) {
  const lower = s.trim().toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
