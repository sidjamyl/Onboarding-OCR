import type { DocumentKind, OcrFields } from "./types.js";

export type RequiredFieldsConfig = Record<DocumentKind, string[]>;

const identityFields = ["lastNameLatin", "firstNameLatin", "nin", "dateOfBirth"];
export const defaultRequiredFields: RequiredFieldsConfig = {
  "dz-id": [...identityFields],
  "dz-driving-licence": [...identityFields],
  "dz-passport": [...identityFields],
};

/** A name must be readable in at least one script; cross-script equivalence is never inferred. */
export function missingRequiredFields(kind: DocumentKind, fields: OcrFields, config: RequiredFieldsConfig): string[] {
  const nameAlternatives: Record<string, string[]> = {
    lastNameLatin: ["lastNameLatin", "lastNameArabic"],
    lastNameArabic: ["lastNameLatin", "lastNameArabic"],
    firstNameLatin: ["firstNameLatin", "firstNameArabic"],
    firstNameArabic: ["firstNameLatin", "firstNameArabic"],
  };
  const requested = [...new Set([...identityFields, ...config[kind].filter((field) => field in nameAlternatives)])];
  return requested.filter((field) => !(nameAlternatives[field] ?? [field]).some((key) => fields[key]?.trim()))
    .filter((field, index, missing) => !missing.slice(0, index).some((earlier) =>
      nameAlternatives[field]?.includes(earlier)));
}
