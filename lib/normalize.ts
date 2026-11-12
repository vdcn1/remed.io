// Name normalisation shared by the importers and the text matcher.

/** "St. John's Wort" -> "st-johns-wort" */
export function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Matching key for class names: "Non-steroidal Anti-inflammatory Drugs (NSAIDs)" -> "non steroidal anti inflammatory drug nsaid" */
export function classNorm(name: string) {
  const normalizedWords = name
    .toLowerCase()
    .replace(/\[epc\]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return normalizedWords.join(" ");
}

/** "SERTRALINE HYDROCHLORIDE" -> "Sertraline hydrochloride" */
export function displayName(rawName: string) {
  const lowerCased = rawName.trim().toLowerCase();
  return lowerCased.charAt(0).toUpperCase() + lowerCased.slice(1);
}
