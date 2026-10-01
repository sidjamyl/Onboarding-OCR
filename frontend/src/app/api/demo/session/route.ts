import { NextResponse } from "next/server";
import { publicUrl, requestOrigin } from "@/lib/public-url";

export async function POST(request: Request) {
  if (process.env.DEMO_MODE_ENABLED !== "true") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin(request) && origin !== new URL(publicUrl("/", request)).origin) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }
  let input: { locale?: string; policyId?: string };
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!input || typeof input !== "object") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const { locale = "fr", policyId = "id-and-licence" } = input;
  if (!["fr", "ar", "en"].includes(locale) || policyId !== "id-and-licence") {
    return NextResponse.json({ error: "invalid_test_configuration" }, { status: 400 });
  }
  const key = process.env.ONBOARDING_API_KEY;
  if (!key)
    return NextResponse.json(
      { error: "demo_not_configured", detail: "Configure the local test credential on the server." },
      { status: 503 },
    );
  const backend = process.env.ONBOARDING_API_URL ?? "http://127.0.0.1:8090";
  try {
    const response = await fetch(`${backend}/v1/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ clientReference: `demo-${Date.now()}`, policyId, locale }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    if (response.ok && typeof payload.accessUrl === "string") {
      payload.accessUrl = publicUrl(new URL(payload.accessUrl).pathname, request);
    }
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: "backend_unavailable", detail: "The onboarding service is unavailable. Try again." },
      { status: 502 },
    );
  }
}
