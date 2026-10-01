export function normalizeApiUrl(value: string) {
  return value.replace(/\/+$/, "");
}
