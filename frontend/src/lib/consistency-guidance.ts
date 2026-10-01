import type { ConsistencyCheck, ConsistencyReading, DocumentKind, DocumentSide, PublicSession } from "./types";

export const comparisonDocumentKinds: Record<ConsistencyReading["document"], DocumentKind> = {
  id: "dz-id",
  driving_licence: "dz-driving-licence",
  passport: "dz-passport",
};

const fieldAliases = [
  ["lastNameLatin", "surname_latin", "last_name_latin"],
  ["firstNameLatin", "given_name_latin", "first_name_latin"],
  ["lastNameArabic", "surname_ar", "last_name_arabic"],
  ["firstNameArabic", "given_name_ar", "first_name_arabic"],
  ["nin", "personal_number"],
  ["dateOfBirth", "date_of_birth", "date_of_birth_printed"],
  ["expiryDate", "date_of_expiry", "date_of_expiry_printed"],
  ["documentNumber", "document_number", "license_number", "passport_number"],
];

/** A user selects one photo; a recommendation never resets other readings. */
export function comparisonRetryTargets(check: ConsistencyCheck, documents: PublicSession["documents"]) {
  const targets = new Map<string, { kind: DocumentKind; side: DocumentSide }>();
  const names = fieldAliases.find((aliases) => aliases.includes(check.field)) ?? [check.field];
  for (const reading of check.readings) {
    const kind = comparisonDocumentKinds[reading.document];
    const document = documents[kind];
    if (!document) continue;
    const found = document.requiredSides.filter((side) =>
      names.some((name) => Object.hasOwn(document.sideFields?.[side] ?? {}, name)),
    );
    const sides = reading.side ? [reading.side] : found.length ? found : document.requiredSides;
    for (const side of sides) {
      if (document.requiredSides.includes(side)) targets.set(`${kind}/${side}`, { kind, side });
    }
  }
  return [...targets.values()];
}

export function comparisonValue(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (Array.isArray(value)) return value.map(comparisonValue).filter(Boolean).join(", ") || undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "category" in value && typeof value.category === "string") return value.category;
  return undefined;
}
