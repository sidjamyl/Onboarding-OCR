import type { DocumentKind } from "./types";

const order = [
  "passport_number", "license_number", "document_number", "serial_number", "nin", "personal_number",
  "surname_latin", "given_name_latin", "surname_ar", "given_name_ar",
  "date_of_birth", "date_of_birth_printed", "place_of_birth_latin", "place_of_birth_ar",
  "sex", "nationality", "blood_group", "categories",
  "date_of_issue", "date_of_issue_printed", "date_of_expiry", "date_of_expiry_printed",
  "issuing_authority_latin", "issuing_authority_ar", "issuing_country", "document_type",
  "category_entries", "restrictions",
];
const rank = new Map(order.map((key, index) => [key, index]));
const hidden = new Set(["mrz_line_1", "mrz_line_2", "mrz_line_3"]);
const hiddenLicence = new Set([
  "date_of_birth_printed", "date_of_issue_printed", "date_of_expiry_printed",
  "front_date_of_expiry_printed", "back_date_of_expiry_printed", "category_entries",
]);

/** Show semantic values in a stable order; ID/licence MRZ remains available through the API. */
export function visibleDocumentFields(kind: DocumentKind, fields: Record<string, string | null>) {
  return Object.entries(fields)
    .filter(([key, value]) => value != null && value !== ""
      && (kind === "dz-passport" || !hidden.has(key.replace(/^(front|back)_/, "")))
      && (kind !== "dz-driving-licence" || !hiddenLicence.has(key)))
    .sort(([left], [right]) => {
      const leftRank = rank.get(left.replace(/^(front|back)_/, "")) ?? order.length;
      const rightRank = rank.get(right.replace(/^(front|back)_/, "")) ?? order.length;
      return leftRank - rightRank || left.localeCompare(right);
    });
}
