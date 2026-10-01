import { crossCheckDrivingLicenceSides, crossCheckIdSides, normalizeSharedIdentity } from "./cross.js";
import { buildReport, type CheckOutcome, type ValidationReport } from "./result.js";
import { similarity } from "./text.js";

export type DocumentPairType = "dz-id" | "dz-driving-licence";
export type IdentityDocument = "id" | "driving_licence" | "passport";
export type DocumentSide = "front" | "back" | "single";
export type MergedFieldSource = "front" | "back" | "both" | "conflict" | "none";
export interface MergeConflict {
  field: string;
  frontValue: unknown;
  backValue: unknown;
}
export interface SideExtraction {
  fields: Record<string, unknown>;
  validation?: { checks?: ValidationReport["checks"]; failedFields?: string[] };
  unreadableFields?: string[];
}
export interface ConsistencyReading {
  document: IdentityDocument;
  side?: DocumentSide;
  value: unknown;
}
export interface ConsistencyCheck {
  id: string;
  field: string;
  label: string;
  status: CheckOutcome;
  message: string;
  readings: ConsistencyReading[];
  /** A two-to-one agreement suggests where to look; it never establishes truth. */
  suggestedRetry?: { document: IdentityDocument; side?: DocumentSide };
}
export interface ConsistencyReport {
  checks: ConsistencyCheck[];
  blocking: boolean;
  warnings: number;
  notChecked: number;
}
export interface IdentityReading {
  document: IdentityDocument;
  fields: Record<string, unknown>;
  fieldSides?: Record<string, DocumentSide>;
}
export interface ConsistencyOptions {
  /** Restrict onboarding to surname, given name, birth date and national identity number. */
  scope?: "onboarding";
}
const ONBOARDING_FIELDS = new Set([
  "nin", "date_of_birth", "surname_latin", "given_name_latin", "surname_ar", "given_name_ar",
  "dateOfBirth", "lastNameLatin", "firstNameLatin", "lastNameArabic", "firstNameArabic",
]);

/** Only these identical keys mean the same fact on both sides. */
const COMPARABLE_FIELDS: Record<DocumentPairType, ReadonlySet<string>> = {
  "dz-id": new Set([
    "date_of_birth",
    "sex",
    "date_of_expiry",
    "nin",
    "surname_latin",
    "given_name_latin",
    "surname_ar",
    "given_name_ar",
  ]),
  "dz-driving-licence": new Set([
    "license_number",
    "surname_latin",
    "given_name_latin",
    "date_of_birth",
    "sex",
    "date_of_expiry",
    "nin",
  ]),
};
const COVERAGE_EXCLUDED_CHECKS = new Set([
  "cross.id.names",
  "cross.id.document_number",
  "cross.id.national_number",
  "cross.driving_licence.national_number",
]);
const LABELS: Record<string, string> = {
  date_of_birth: "Date of birth",
  date_of_expiry: "Expiry date",
  sex: "Sex",
  license_number: "Licence number",
  surname_latin: "Surname (Latin)",
  given_name_latin: "Given name (Latin)",
  surname_ar: "Surname (Arabic)",
  given_name_ar: "Given name (Arabic)",
  categories: "Licence categories",
  nin: "NIN",
  document_number: "Document number",
};

/** Portable post-extraction join. Uses the same cross-face rules as the pair route.
 * It accepts observations, never reconstructed checksum evidence or a repairer.
 */
export function combineDocumentSides(
  pairType: DocumentPairType,
  front: SideExtraction,
  back: SideExtraction,
  priorCrossValidation?: ValidationReport,
  options: ConsistencyOptions = {},
) {
  let crossValidation =
    priorCrossValidation ??
    (pairType === "dz-id"
      ? crossCheckIdSides(usableFields(front), usableFields(back))
      : crossCheckDrivingLicenceSides(usableFields(front), usableFields(back)));
  if (options.scope === "onboarding")
    crossValidation = buildReport(crossValidation.checks.filter((check) => check.field && ONBOARDING_FIELDS.has(check.field)));
  const comparable = crossValidation.checks.filter(
    (check) =>
      !check.id.startsWith("cross.repair.") && !COVERAGE_EXCLUDED_CHECKS.has(check.id) && check.id !== "cross.coverage",
  );
  const notChecked = comparable.filter((check) => check.outcome === "not_checked").length;
  const crossCoverage = {
    checked: comparable.length - notChecked,
    total: comparable.length,
    notChecked,
    complete: notChecked === 0,
  };
  if (options.scope !== "onboarding" && notChecked > 0 && !crossValidation.checks.some((check) => check.id === "cross.coverage")) {
    crossValidation = buildReport([
      ...crossValidation.checks,
      {
        id: "cross.coverage",
        outcome: "warning",
        detail: `${notChecked} cross-side comparisons could not be performed; agreement is not established`,
      },
    ]);
  }
  const mergedFields: Record<string, unknown> = {};
  const mergedFieldSources: Record<string, MergedFieldSource> = {};
  const mergeConflicts: MergeConflict[] = [];
  const frontKeys = new Set(Object.keys(front.fields));
  const backKeys = new Set(Object.keys(back.fields));
  for (const field of new Set([...frontKeys, ...backKeys])) {
    const frontValue = usableValue(front, field);
    const backValue = usableValue(back, field);
    if (frontKeys.has(field) && backKeys.has(field) && !COMPARABLE_FIELDS[pairType].has(field)) {
      mergedFields[`front_${field}`] = frontValue;
      mergedFields[`back_${field}`] = backValue;
      mergedFieldSources[`front_${field}`] = frontValue === null ? "none" : "front";
      mergedFieldSources[`back_${field}`] = backValue === null ? "none" : "back";
    } else if (frontValue !== null && backValue !== null) {
      if (sameReading(field, frontValue, backValue)) {
        mergedFields[field] = frontValue;
        mergedFieldSources[field] = "both";
      } else {
        mergedFields[field] = null;
        mergedFieldSources[field] = "conflict";
        mergeConflicts.push({ field, frontValue, backValue });
      }
    } else {
      mergedFields[field] = frontValue ?? backValue;
      mergedFieldSources[field] = frontValue !== null ? "front" : backValue !== null ? "back" : "none";
    }
  }
  const document: IdentityDocument = pairType === "dz-id" ? "id" : "driving_licence";
  const consistencyChecks: ConsistencyCheck[] = crossValidation.checks.map((check) => {
    const field = check.field ?? "coverage";
    const frontValue = front.fields[field] ?? (field === "nin" ? front.fields.personal_number : undefined) ?? null;
    const backValue =
      back.fields[field === "categories" ? "category_entries" : field] ??
      (field === "nin" ? back.fields.personal_number : undefined) ??
      null;
    return {
      id: check.id,
      field,
      label: LABELS[field] ?? field,
      status: check.outcome,
      message: check.detail,
      readings: [
        { document, side: "front", value: frontValue },
        { document, side: "back", value: backValue },
      ],
    };
  });
  // A fuzzy warning may still leave two competing readings with no safely merged value.
  // Expose that ambiguity separately rather than calling the readable observations unreadable.
  for (const conflict of mergeConflicts) {
    if (options.scope === "onboarding" && !ONBOARDING_FIELDS.has(conflict.field)) continue;
    if (consistencyChecks.some((check) => check.field === conflict.field && check.status === "failed")) continue;
    consistencyChecks.push({
      id: `cross.merge.${conflict.field}`,
      field: conflict.field,
      label: LABELS[conflict.field] ?? conflict.field,
      status: "failed",
      message: "Both faces are readable but disagree; a shared value cannot be selected safely",
      readings: [
        { document, side: "front", value: conflict.frontValue },
        { document, side: "back", value: conflict.backValue },
      ],
    });
  }
  return {
    crossValidation,
    crossCoverage,
    mergedFields,
    mergedFieldSources,
    mergeConflicts,
    consistencyChecks,
    validation: buildReport([
      ...(front.validation?.checks ?? []),
      ...(back.validation?.checks ?? []),
      ...crossValidation.checks,
    ]),
  };
}

function usableValue(result: SideExtraction, field: string): unknown {
  const failed = result.validation?.failedFields ?? [];
  return failed.includes(field) ||
    result.unreadableFields?.includes(field) ||
    (field.startsWith("mrz_line_") && failed.includes("mrz"))
    ? null
    : (result.fields[field] ?? null);
}
function usableFields(result: SideExtraction): Record<string, unknown> {
  return Object.fromEntries(Object.keys(result.fields).map((field) => [field, usableValue(result, field)]));
}
function sameReading(field: string, front: unknown, back: unknown): boolean {
  if (typeof front !== "string" || typeof back !== "string") return JSON.stringify(front) === JSON.stringify(back);
  const kind =
    field === "nin"
      ? "identifier"
      : field === "sex"
        ? "sex"
        : field === "date_of_birth" || field === "date_of_expiry"
          ? "date"
          : field.endsWith("_latin")
            ? "latin"
            : field.endsWith("_ar")
              ? "arabic"
              : null;
  const x = kind ? normalizeSharedIdentity(front, kind) : front.trim().toUpperCase();
  const y = kind ? normalizeSharedIdentity(back, kind) : back.trim().toUpperCase();
  return x !== null && y !== null && x === y;
}

const IDENTITY_FIELDS = [
  { field: "nin", label: "NIN", aliases: ["nin", "personal_number"], kind: "identifier" },
  { field: "dateOfBirth", label: "Date of birth", aliases: ["dateOfBirth", "date_of_birth"], kind: "date" },
  { field: "sex", label: "Sex", aliases: ["sex"], kind: "sex" },
  { field: "lastNameLatin", label: "Surname (Latin)", aliases: ["lastNameLatin", "surname_latin"], kind: "latin" },
  {
    field: "firstNameLatin",
    label: "Given name (Latin)",
    aliases: ["firstNameLatin", "given_name_latin"],
    kind: "latin",
  },
  { field: "lastNameArabic", label: "Surname (Arabic)", aliases: ["lastNameArabic", "surname_ar"], kind: "arabic" },
  {
    field: "firstNameArabic",
    label: "Given name (Arabic)",
    aliases: ["firstNameArabic", "given_name_ar"],
    kind: "arabic",
  },
] as const;

/** Compare only selected documents' same-person facts. No document-number or date-of-issue/expiry comparison.
 * Close spelling differences are review warnings; materially different comparable names block completion.
 */
export function crossDocumentConsistency(documents: readonly IdentityReading[], options: ConsistencyOptions = {}): ConsistencyReport {
  const checks: ConsistencyCheck[] = [];
  for (const spec of IDENTITY_FIELDS) {
    if (options.scope === "onboarding" && !ONBOARDING_FIELDS.has(spec.field)) continue;
    const values = documents.map((doc) => {
      const key = spec.aliases.find((alias) => nonempty(doc.fields[alias]) !== null);
      const value = key ? nonempty(doc.fields[key]) : null;
      const side = doc.fieldSides?.[spec.field] ?? (key ? doc.fieldSides?.[key] : undefined);
      return {
        reading: { document: doc.document, ...(side ? { side } : {}), value } as ConsistencyReading,
        normalized: value === null ? null : normalizeSharedIdentity(value, spec.kind),
      };
    });
    for (let i = 0; i < values.length; i++)
      for (let j = i + 1; j < values.length; j++) {
        const a = values[i]!;
        const b = values[j]!;
        let status: CheckOutcome;
        let message: string;
        if (a.normalized === null || b.normalized === null) {
          status = "not_checked";
          message = `${spec.label} unavailable or not comparable in the expected script`;
        } else if (a.normalized === b.normalized) {
          status = "passed";
          message = `${spec.label} matches across documents`;
        } else if (
          (spec.kind === "latin" || spec.kind === "arabic") &&
          similarity(a.normalized, b.normalized) >= 0.75
        ) {
          status = "warning";
          message = `${spec.label} differs slightly; review both readings`;
        } else {
          status = "failed";
          message = `${spec.label} differs across documents`;
        }
        const check: ConsistencyCheck = {
          id: `cross.person.${spec.field}.${a.reading.document}.${b.reading.document}`,
          field: spec.field,
          label: spec.label,
          status,
          message,
          readings: [a.reading, b.reading],
        };
        if (status === "failed" && values.length === 3 && values.every((value) => value.normalized !== null)) {
          const minority = values.find(
            (value) => values.filter((other) => other.normalized === value.normalized).length === 1,
          );
          const majority = values.find(
            (value) => values.filter((other) => other.normalized === value.normalized).length === 2,
          );
          if (minority && majority) {
            check.suggestedRetry = {
              document: minority.reading.document,
              ...(minority.reading.side ? { side: minority.reading.side } : {}),
            };
            check.message +=
              "; two other documents agree, suggesting an outlier without establishing which reading is true";
          }
        }
        checks.push(check);
      }
  }
  return {
    checks,
    blocking: checks.some((check) => check.status === "failed"),
    warnings: checks.filter((check) => check.status === "warning").length,
    notChecked: checks.filter((check) => check.status === "not_checked").length,
  };
}
function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
