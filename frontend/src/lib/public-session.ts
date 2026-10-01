"use client";

import { useCallback, useEffect, useState } from "react";
import { normalizeApiUrl } from "./api-url";
import type { PublicSession } from "./types";

const apiUrl = normalizeApiUrl(process.env.NEXT_PUBLIC_ONBOARDING_API_URL ?? "/api/onboarding");

export class SessionRequestError extends Error {
  constructor(public readonly payload: Record<string, unknown>) {
    super(String(payload.detail ?? payload.error ?? "request_failed"));
  }
}

/** One versioned session snapshot drives the computer and the phone; the stream reconnects by itself. */
export function usePublicSession(token: string) {
  const [session, setSession] = useState<PublicSession>();
  const [error, setError] = useState<string>();
  const [live, setLive] = useState<boolean | null>(null);
  const accept = useCallback((next: PublicSession) => {
    setSession((current) => (!current || next.version >= current.version ? next : current));
    setError(undefined);
  }, []);
  const refresh = useCallback(async () => {
    const response = await fetch(`${apiUrl}/public/sessions/${token}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new SessionRequestError(payload);
    accept(payload);
    return payload as PublicSession;
  }, [accept, token]);

  useEffect(() => {
    let active = true;
    let missing = false;
    let fallback: number | undefined;
    const events = new EventSource(`${apiUrl}/public/sessions/${token}/events`);
    const handleError = (cause: unknown) => {
      if (!active) return;
      if (cause instanceof SessionRequestError && cause.payload.error === "session_not_found") {
        missing = true;
        events.close();
        if (fallback) window.clearInterval(fallback);
        fallback = undefined;
      }
      setError(cause instanceof Error ? cause.message : "request_failed");
    };
    void refresh().catch(handleError);
    events.addEventListener("session", (event) => {
      if (active) accept(JSON.parse((event as MessageEvent).data));
    });
    events.onopen = () => {
      setLive(true);
      if (fallback) window.clearInterval(fallback);
      fallback = undefined;
    };
    events.onerror = () => {
      if (missing) return;
      setLive(false);
      if (!fallback) fallback = window.setInterval(() => void refresh().catch(handleError), 1_000);
    };
    return () => {
      active = false;
      events.close();
      if (fallback) window.clearInterval(fallback);
    };
  }, [accept, refresh, token]);

  const post = useCallback(
    async (path: string, body?: object | FormData, key = crypto.randomUUID()) => {
      const response = await fetch(`${apiUrl}/public/sessions/${token}${path}`, {
        method: "POST",
        headers: {
          "idempotency-key": key,
          ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
        },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      const payload = await response.json();
      if (!response.ok) throw new SessionRequestError(payload);
      const next = payload.session ?? (payload.sessionId && payload.version ? payload : null);
      if (next) accept(next);
      return payload;
    },
    [accept, token],
  );

  return { session, error, live, refresh, post };
}
