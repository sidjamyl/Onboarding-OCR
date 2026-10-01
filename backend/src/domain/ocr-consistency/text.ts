import type { CheckCollector } from "./result.js";

/** Values a model reaches for instead of null. None of these are real data. */
const PLACEHOLDERS = new Set([
  "",
  "N/A",
  "NA",
  "UNKNOWN",
  "NONE",
  "NULL",
  "-",
  "--",
  "?",
  "???",
  "غير معروف",
  "لا يوجد",
]);

const ARABIC_LABELS = [
  "اللقب",
  "الاسم",
  "الإسم",
  "تاريخ الميلاد",
  "مكان الميلاد",
  "الجنس",
  "فصيلة الدم",
  "زمرة الدم",
  "تاريخ الإصدار",
  "تاريخ الانتهاء",
  "رقم التعريف",
  "سلطة الإصدار",
  "سلطة",
];

const LATIN_LABELS = [
  "SURNAME",
  "GIVEN NAME",
  "GIVEN NAMES",
  "NOM",
  "PRENOM",
  "PRÉNOM",
  "DATE OF BIRTH",
  "PLACE OF BIRTH",
  "NATIONALITY",
  "AUTHORITY",
  "SEX",
];

const DOCUMENT_TITLES = [
  "رخصة السياقة",
  "بطاقة التعريف الوطنية",
  "بطاقة التعريف الوطنية البيومترية",
  "الجمهورية الجزائرية الديمقراطية الشعبية",
  "جواز السفر",
  "بطاقة إقامة",
  "شهادة الميلاد",
  "PERMIS DE CONDUIRE",
  "CARTE NATIONALE D'IDENTITÉ",
  "CARTE D'IDENTITÉ NATIONALE",
  "RÉPUBLIQUE ALGÉRIENNE DÉMOCRATIQUE ET POPULAIRE",
  "PASSEPORT",
  "RESIDENCE CERTIFICATE",
  "BIRTH CERTIFICATE",
];

const normalizedLabels = [...ARABIC_LABELS, ...LATIN_LABELS].map(normalizePrintedText);
const normalizedTitles = DOCUMENT_TITLES.map(normalizePrintedText);
const standaloneBoilerplate = new Set([...normalizedLabels, ...normalizedTitles]);

function normalizePrintedText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Exclude whole printed labels/titles from mapped values; retain the raw OCR observation. */
export function isPrintedBoilerplate(value: string): boolean {
  return standaloneBoilerplate.has(normalizePrintedText(value));
}

/** Confusion pairs the catalogue calls out, in both directions. */
export const CONFUSABLE_LETTERS_IN_DIGIT_FIELD = /[OIZSGB]/g;
export const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;

export interface TextFieldOptions {
  id: string;
  field: string;
  maxLength: number;
  script?: "arabic" | "latin";
  /** Fraction of letters that must belong to the expected script. */
  scriptThreshold?: number;
}

/**
 * Envelope-level hygiene applied to every string the model returns, before any
 * field-specific rule. Returns the value to use downstream, or null when the
 * value is a placeholder masquerading as data.
 */
export function checkStringHygiene(
  c: CheckCollector,
  raw: string,
  opts: { id: string; field: string; maxLength: number },
): string | null {
  const { id, field, maxLength } = opts;

  if (CONTROL_CHARS.test(raw)) {
    c.fail(`${id}.control_chars`, "value contains control characters", field);
    return null;
  }
  c.pass(`${id}.control_chars`, "no control characters", field);

  if (raw !== raw.trim()) {
    c.warn(`${id}.trimmed`, "value had leading or trailing whitespace", field);
  }
  const trimmed = raw.trim();

  // NFC so that visually identical Arabic and accented Latin strings compare
  // equal downstream. Recording the change matters: it is a normalisation the
  // model didn't make.
  const normalized = trimmed.normalize("NFC");
  if (normalized !== trimmed) {
    c.warn(`${id}.unicode_nfc`, "value was not in NFC and has been normalised", field);
  }

  if (PLACEHOLDERS.has(normalized.toUpperCase()) || PLACEHOLDERS.has(normalized)) {
    c.fail(
      `${id}.placeholder`,
      "unreadable value returned as a placeholder string instead of null",
      field,
    );
    return null;
  }
  c.pass(`${id}.placeholder`, "value is not a placeholder string", field);

  if (normalized.length > maxLength) {
    c.fail(`${id}.max_length`, `value exceeds ${maxLength} characters`, field);
    return null;
  }
  c.pass(`${id}.max_length`, `value is within ${maxLength} characters`, field);

  // Markdown or prose leaking out of a constrained field.
  if (/^```|\*\*|^Here (is|are)\b|^The \w+ is\b/i.test(normalized)) {
    c.fail(`${id}.model_prose`, "value looks like model commentary rather than a field", field);
    return null;
  }

  return normalized;
}

export function checkScript(
  c: CheckCollector,
  value: string,
  opts: TextFieldOptions,
): void {
  const { id, field, script, scriptThreshold = 0.6 } = opts;
  if (!script) return;

  const letters = [...value].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) {
    c.fail(`${id}.script`, "value contains no letters", field);
    return;
  }

  const wanted = script === "arabic" ? ARABIC_SCRIPT : LATIN_SCRIPT;
  const matching = letters.filter((ch) => wanted.test(ch)).length;
  const ratio = matching / letters.length;

  if (ratio >= scriptThreshold) {
    c.pass(`${id}.script`, `value is predominantly ${script} script`, field);
  } else {
    c.fail(
      `${id}.script`,
      `only ${Math.round(ratio * 100)}% of letters are ${script} script`,
      field,
    );
  }
}

export function checkNoFieldLabel(
  c: CheckCollector,
  value: string,
  opts: { id: string; field: string },
): void {
  const normalized = ` ${normalizePrintedText(value)} `;
  const found = [...normalizedLabels, ...normalizedTitles]
    .find((phrase) => normalized.includes(` ${phrase} `));

  if (found) {
    c.fail(`${opts.id}.field_label`, "value appears to include a printed field label", opts.field);
  } else {
    c.pass(`${opts.id}.field_label`, "no printed field label captured in the value", opts.field);
  }
}

export function checkNoDigitsOrFillers(
  c: CheckCollector,
  value: string,
  opts: { id: string; field: string },
): void {
  if (/[0-9]/.test(value) || ARABIC_INDIC_DIGITS.test(value)) {
    c.fail(`${opts.id}.digits`, "name or place value contains digits", opts.field);
  } else {
    c.pass(`${opts.id}.digits`, "no digits in the value", opts.field);
  }
  if (value.includes("<")) {
    c.fail(`${opts.id}.mrz_filler`, "visible-zone value contains an MRZ filler character", opts.field);
  } else {
    c.pass(`${opts.id}.mrz_filler`, "no MRZ filler characters", opts.field);
  }
}

/**
 * Detect likely OCR substitutions in a field that should be digits only.
 *
 * Never corrects. The catalogue is explicit: a failed checksum can justify a
 * targeted retry, but a proposed correction is recorded, not applied.
 */
export function checkDigitFieldConfusables(
  c: CheckCollector,
  value: string,
  opts: { id: string; field: string },
): void {
  const { id, field } = opts;

  if (ARABIC_INDIC_DIGITS.test(value)) {
    c.fail(`${id}.arabic_indic_digits`, "Arabic-Indic digits used where ASCII digits are required", field);
  } else {
    c.pass(`${id}.arabic_indic_digits`, "digits are ASCII", field);
  }

  const letters = value.match(CONFUSABLE_LETTERS_IN_DIGIT_FIELD);
  if (letters && letters.length > 0) {
    const unique = [...new Set(letters)].join(", ");
    c.warn(
      `${id}.character_confusion`,
      `letters likely misread from digits present (${unique}); not corrected automatically`,
      field,
    );
  } else {
    c.pass(`${id}.character_confusion`, "no likely digit/letter confusions", field);
  }

  if (value.includes("<")) {
    c.warn(`${id}.filler_confusion`, "MRZ filler character present in a visible-zone number", field);
  }
}

/** Loose comparison for transliterated names: uppercase, strip marks and punctuation. */
export function normalizeForNameComparison(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .toUpperCase()
    .replace(/</g, " ")
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0..1 similarity, used for fuzzy name agreement rather than strict equality. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] as number;
  }
  return prev[b.length] as number;
}
