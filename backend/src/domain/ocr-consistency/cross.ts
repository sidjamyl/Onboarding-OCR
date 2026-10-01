import { CheckCollector, buildReport, type ValidationReport } from "./result.js";
import { similarity } from "./text.js";

const NAME_SIMILARITY_FLOOR = 0.75;

type Fields = Record<string, unknown>;

const str = (fields: Fields, key: string): string | null => {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value : null;
};

/**
 * Front and back of the same ID card, submitted in one session.
 *
 * The purpose is to catch two sides of *different* cards being combined, which
 * no single-side check can detect.
 */
export function crossCheckIdSides(front: Fields, back: Fields): ValidationReport {
  const c = new CheckCollector();

  exact(
    c,
    "cross.id.birth_date",
    "date of birth",
    str(front, "date_of_birth"),
    str(back, "date_of_birth"),
    "date_of_birth",
  );
  exact(c, "cross.id.sex", "sex", str(front, "sex"), str(back, "sex"), "sex");
  exact(
    c,
    "cross.id.expiry",
    "date of expiry",
    str(front, "date_of_expiry"),
    str(back, "date_of_expiry"),
    "date_of_expiry",
  );

  exact(
    c,
    "cross.id.national_number",
    "national number",
    str(front, "nin") ?? str(front, "personal_number"),
    str(back, "nin") ?? str(back, "personal_number"),
    "nin",
  );

  // The front normally carries Arabic names, the back Latin. Without a transliteration
  // table this cannot be compared, and guessing would produce false mismatches
  // on genuine cards.
  const sharedNames = ["surname_ar", "given_name_ar", "surname_latin", "given_name_latin"].filter(
    (field) => str(front, field) !== null && str(back, field) !== null,
  );
  if (sharedNames.length === 0) {
    c.skip(
      "cross.id.names",
      "front is Arabic script and back is Latin; no transliteration table is configured",
      "surname_ar",
    );
  } else {
    for (const field of sharedNames)
      fuzzy(c, `cross.id.${field}`, field.replaceAll("_", " "), str(front, field), str(back, field), field);
  }

  // Per the front-side validator: the 10-digit printed number and the
  // 9-character MRZ number have no verified relationship.
  c.skip(
    "cross.id.document_number",
    "Algeria's front/back document-number relationship is not documented here",
    "document_number",
  );

  return buildReport(c.list());
}

/** Front and back of the same Algerian biometric driving licence. */
export function crossCheckDrivingLicenceSides(front: Fields, back: Fields): ValidationReport {
  const c = new CheckCollector();

  exact(
    c,
    "cross.driving_licence.license_number",
    "licence number",
    str(front, "license_number"),
    str(back, "license_number"),
    "license_number",
  );
  exact(
    c,
    "cross.driving_licence.birth_date",
    "date of birth",
    str(front, "date_of_birth"),
    str(back, "date_of_birth"),
    "date_of_birth",
  );
  exact(c, "cross.driving_licence.sex", "sex", str(front, "sex"), str(back, "sex"), "sex");
  exact(
    c,
    "cross.driving_licence.expiry",
    "date of expiry",
    str(front, "date_of_expiry"),
    str(back, "date_of_expiry"),
    "date_of_expiry",
  );

  fuzzy(
    c,
    "cross.driving_licence.surname",
    "surname",
    str(front, "surname_latin"),
    str(back, "surname_latin"),
    "surname_latin",
  );
  fuzzy(
    c,
    "cross.driving_licence.given_name",
    "given name",
    str(front, "given_name_latin"),
    str(back, "given_name_latin"),
    "given_name_latin",
  );

  exact(
    c,
    "cross.driving_licence.national_number",
    "national number",
    str(front, "nin") ?? str(front, "personal_number"),
    str(back, "nin") ?? str(back, "personal_number"),
    "nin",
  );
  compareDrivingCategories(c, front["categories"], back["category_entries"]);
  return buildReport(c.list());
}

/**
 * An ID card and a passport claimed to belong to the same person.
 *
 * Issue dates, expiry dates and document numbers legitimately differ between
 * the two documents and are deliberately not compared.
 */
export function crossCheckIdAndPassport(id: Fields, passport: Fields): ValidationReport {
  const c = new CheckCollector();

  exact(c, "cross.person.national_number", "national number", str(id, "nin"), str(passport, "personal_number"), "nin");
  exact(
    c,
    "cross.person.birth_date",
    "date of birth",
    str(id, "date_of_birth"),
    str(passport, "date_of_birth"),
    "date_of_birth",
  );
  exact(c, "cross.person.sex", "sex", str(id, "sex"), str(passport, "sex"), "sex");

  fuzzy(
    c,
    "cross.person.surname_ar",
    "Arabic surname",
    str(id, "surname_ar"),
    str(passport, "surname_ar"),
    "surname_ar",
  );
  fuzzy(
    c,
    "cross.person.given_name_ar",
    "Arabic given name",
    str(id, "given_name_ar"),
    str(passport, "given_name_ar"),
    "given_name_ar",
  );
  fuzzy(
    c,
    "cross.person.place_of_birth_ar",
    "Arabic place of birth",
    str(id, "place_of_birth_ar"),
    str(passport, "place_of_birth_ar"),
    "place_of_birth_ar",
  );

  c.skip(
    "cross.person.document_numbers",
    "document numbers and issue/expiry dates differ legitimately between documents and are not compared",
    "document_number",
  );

  return buildReport(c.list());
}

function exact(c: CheckCollector, id: string, label: string, a: string | null, b: string | null, field: string): void {
  if (a === null || b === null) {
    c.skip(id, `${label} unavailable on one of the two documents`, field);
    return;
  }
  const kind =
    field === "nin"
      ? "identifier"
      : field === "sex"
        ? "sex"
        : field === "date_of_birth" || field === "date_of_expiry"
          ? "date"
          : null;
  const x = kind ? normalizeSharedIdentity(a, kind) : a.trim().toUpperCase();
  const y = kind ? normalizeSharedIdentity(b, kind) : b.trim().toUpperCase();
  if (x === null || y === null) {
    c.skip(id, `${label} unavailable or not comparable`, field);
    return;
  }
  c.assert(x === y, id, `${label} is identical across both documents`, field);
}

function fuzzy(c: CheckCollector, id: string, label: string, a: string | null, b: string | null, field: string): void {
  if (a === null || b === null) {
    c.skip(id, `${label} unavailable on one of the two documents`, field);
    return;
  }
  const kind = field.endsWith("_ar") ? "arabic" : "latin";
  const x = normalizeSharedIdentity(a, kind);
  const y = normalizeSharedIdentity(b, kind);
  if (x === null || y === null) {
    c.skip(id, `${label} is not available in comparable scripts`, field);
    return;
  }
  if (x === y) {
    c.pass(id, `${label} matches across both documents`, field);
    return;
  }
  const score = similarity(x, y);
  // Spelling variation between documents is common; a mismatch here is for a
  // human to look at, not grounds for discarding the extraction.
  if (score >= NAME_SIMILARITY_FLOOR) {
    c.warn(id, `${label} differs slightly across documents (similarity ${score.toFixed(2)})`, field);
  } else {
    c.warn(id, `${label} differs materially across documents (similarity ${score.toFixed(2)})`, field);
  }
}

function compareDrivingCategories(c: CheckCollector, frontValue: unknown, backValue: unknown): void {
  if (!Array.isArray(frontValue) || !Array.isArray(backValue)) {
    c.skip(
      "cross.driving_licence.categories",
      "categories are unavailable on one of the two document sides",
      "categories",
    );
    return;
  }

  const front = frontValue.filter((value): value is string => typeof value === "string");
  const back = backValue
    .map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
      const category = (entry as Record<string, unknown>)["category"];
      return typeof category === "string" ? category : null;
    })
    .filter((value): value is string => value !== null);

  const normalized = (values: string[]) => [...new Set(values.map((value) => value.trim().toUpperCase()))].sort();
  c.assert(
    JSON.stringify(normalized(front)) === JSON.stringify(normalized(back)),
    "cross.driving_licence.categories",
    "category codes are identical across both document sides",
    "categories",
  );
}

function normalizeDigits(value: string): string {
  return value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (char) =>
    String(char.charCodeAt(0) - (char.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660)),
  );
}
export function normalizeSharedIdentity(value: string, kind: string): string | null {
  const digits = normalizeDigits(value).normalize("NFKC").trim();
  if (kind === "identifier") return digits.replace(/[\s-]/g, "").toUpperCase() || null;
  if (kind === "date") {
    const ymd = digits.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    const dmy = digits.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (!ymd && !dmy) return null;
    const year = Number(ymd?.[1] ?? dmy?.[3]);
    const month = Number(ymd?.[2] ?? dmy?.[2]);
    const day = Number(ymd?.[3] ?? dmy?.[1]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (kind === "sex") {
    const sex = digits.toUpperCase();
    if (["M", "MALE", "MASCULIN", "ذكر"].includes(sex)) return "M";
    if (["F", "FEMALE", "FEMININ", "FÉMININ", "أنثى", "انثى"].includes(sex)) return "F";
    return null;
  }
  const letters = [...digits].filter((char) => /\p{L}/u.test(char));
  const script = kind === "arabic" ? /\p{Script=Arabic}/u : /\p{Script=Latin}/u;
  if (!letters.length || !letters.every((char) => script.test(char))) return null;
  return (
    digits
      .normalize("NFD")
      .replace(/\p{M}|\u0640/gu, "")
      .toUpperCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}
