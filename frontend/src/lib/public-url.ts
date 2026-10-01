/** The configured browser address is authoritative; internal proxy ports never become public links. */
export function publicUrl(path: string, request: Request, configured = process.env.PUBLIC_BASE_URL): string {
  return new URL(path, configured ? new URL(configured).origin : requestOrigin(request)).toString();
}

export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host;
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const scheme = protocol === "https" || protocol === "http" ? `${protocol}:` : url.protocol;
  return new URL(`${scheme}//${host}`).origin;
}
