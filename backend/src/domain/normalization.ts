const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const easternDigits = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = [...value]
    .map((character) => {
      const arabicIndex = arabicDigits.indexOf(character);
      if (arabicIndex >= 0) return String(arabicIndex);
      const easternIndex = easternDigits.indexOf(character);
      return easternIndex >= 0 ? String(easternIndex) : character;
    })
    .join("")
    .normalize("NFKC")
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase();
  return normalized || null;
}

export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = normalizeIdentifier(value)?.replace(/[^0-9]/g, "");
  if (!digits || digits.length !== 8) return null;
  const candidates = [
    `${digits.slice(4, 8)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`,
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`,
  ];
  return (
    candidates.find((candidate) => {
      const parsed = new Date(`${candidate}T00:00:00Z`);
      return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(candidate);
    }) ?? null
  );
}

export function normalizeOcrFields(fields: Record<string, unknown>): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (value === null || value === undefined) return [key, null];
      if (typeof value === "object" && value && "value" in value) {
        const inner = (value as { value?: unknown }).value;
        return [key, inner == null ? null : String(inner).trim() || null];
      }
      return [key, String(value).trim() || null];
    }),
  );
}
