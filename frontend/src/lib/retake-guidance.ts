import type { DocumentKind, DocumentSide, PublicSession } from "./types";

type SessionDocument = NonNullable<PublicSession["documents"][DocumentKind]>;

const rawNames: Record<string, string[]> = {
  lastNameLatin: ["surname_latin", "last_name_latin"],
  firstNameLatin: ["given_name_latin", "first_name_latin"],
  lastNameArabic: ["surname_ar", "last_name_arabic"],
  firstNameArabic: ["given_name_ar", "first_name_arabic"],
  documentNumber: ["document_number", "license_number", "passport_number", "serial_number"],
  dateOfBirth: ["date_of_birth"],
  expiryDate: ["date_of_expiry", "date_of_expiry_printed"],
};

/** Recommend only a side whose photo can actually be retaken. */
export function sideForMissingFields(document: SessionDocument): DocumentSide | undefined {
  if (!document.unreadableFields.length) return undefined;
  if (document.requiredSides.length === 1) return document.requiredSides[0];
  const counts = new Map<DocumentSide, number>();
  for (const field of document.unreadableFields) {
    const names = [field, ...(rawNames[field] ?? [])];
    const sides = document.requiredSides.filter((side) =>
      names.some((name) => Object.hasOwn(document.sideFields?.[side] ?? {}, name)),
    );
    const side =
      sides.find((candidate) => names.some((name) => !document.sideFields?.[candidate]?.[name]?.trim())) ??
      sides[0] ??
      defaultSide(document.kind, field);
    counts.set(side, (counts.get(side) ?? 0) + 1);
  }
  return document.requiredSides.reduce<DocumentSide | undefined>(
    (best, side) => (!best || (counts.get(side) ?? 0) > (counts.get(best) ?? 0) ? side : best),
    undefined,
  );
}

function defaultSide(kind: DocumentKind, field: string): DocumentSide {
  if (kind === "dz-id" && ["lastNameLatin", "firstNameLatin"].includes(field)) return "back";
  return "front";
}
