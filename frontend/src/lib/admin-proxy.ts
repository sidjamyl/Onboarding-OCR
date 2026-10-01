import { NextResponse } from "next/server";

/** Same-origin transport; administrator credentials are HttpOnly cookies. */
export async function adminProxy(request: Request, path: string) {
  const backend = (process.env.ONBOARDING_API_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
  const headers = new Headers();
  for (const name of ["content-type", "cookie", "origin", "referer"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await fetch(`${backend}${path}${new URL(request.url).search}`, {
      method: request.method,
      headers,
      cache: "no-store",
      redirect: "manual",
      ...(!["GET", "HEAD"].includes(request.method) ? { body: await request.arrayBuffer() } : {}),
    });
    const output = new Headers({
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    for (const cookie of response.headers.getSetCookie()) output.append("set-cookie", cookie);
    return new Response(response.body, { status: response.status, headers: output });
  } catch {
    return NextResponse.json(
      {
        error: "backend_unavailable",
        detail: "The administration service is unavailable. Check the backend connection.",
      },
      { status: 502 },
    );
  }
}
