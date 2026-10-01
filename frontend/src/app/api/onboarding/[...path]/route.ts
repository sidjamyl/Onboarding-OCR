import { NextResponse } from "next/server";
import { publicUrl } from "@/lib/public-url";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: Request, context: RouteContext) {
  const backend = (process.env.ONBOARDING_API_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
  const { path } = await context.params;
  const sourceUrl = new URL(request.url);
  const targetUrl = `${backend}/${path.map(encodeURIComponent).join("/")}${sourceUrl.search}`;
  const headers = new Headers();
  for (const name of ["content-type", "idempotency-key", "x-api-key"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const carriesBody = request.method !== "GET" && request.method !== "HEAD";
  const body = carriesBody ? await request.arrayBuffer() : undefined;
  // Fastify requires a JSON content type for bodyless mutation actions.
  if (carriesBody && !headers.has("content-type")) headers.set("content-type", "application/json");

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: carriesBody && body?.byteLength ? body : carriesBody ? "{}" : undefined,
      cache: "no-store",
      signal: request.signal,
    });
    const forwardedHeaders = new Headers({
      "content-type": response.headers.get("content-type") ?? "application/json",
    });
    for (const name of ["cache-control", "connection", "x-accel-buffering"]) {
      const value = response.headers.get(name);
      if (value) forwardedHeaders.set(name, value);
    }
    if (
      response.ok && request.method === "POST" && path.length === 4 &&
      path[0] === "public" && path[1] === "sessions" && path[3] === "transfer"
    ) {
      const payload = await response.json();
      if (typeof payload.transferUrl === "string")
        payload.transferUrl = publicUrl(new URL(payload.transferUrl).pathname, request);
      return NextResponse.json(payload, { status: response.status, headers: forwardedHeaders });
    }
    return new Response(response.body, {
      status: response.status,
      headers: forwardedHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: "backend_unavailable", detail: "The onboarding service is temporarily unavailable" },
      { status: 502 },
    );
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;
