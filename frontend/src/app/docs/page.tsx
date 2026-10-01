/** biome-ignore-all lint/correctness/useUniqueElementIds: This single route owns stable public documentation anchors. */
import type { Metadata } from "next";
import { ArrowRight, FileText, Globe, KeyRound, ShieldCheck } from "lucide-react";
import { Code } from "./code";
import "../workspace.css";
export const metadata: Metadata = {
  title: "API documentation · OCR Onboarding",
  description: "Create document onboarding sessions, receive signed notifications and retrieve verified results.",
};
const sections = [
  ["overview", "Integration overview"],
  ["authentication", "Authentication"],
  ["configuration", "Document rules"],
  ["sessions", "Create a session"],
  ["status", "Status & results"],
  ["webhooks", "Completion webhooks"],
  ["return", "Return to your application"],
  ["errors", "Errors & retries"],
  ["reference", "API reference"],
];
export default function Documentation() {
  return (
    <div className="docs-shell">
      <header className="docs-header">
        <a className="console-brand" href="/docs">
          <span className="console-mark">
            <FileText size={18} />
          </span>
          OCR Onboarding
        </a>
        <div className="docs-header-links">
          <a href="/api/onboarding/openapi.json">OpenAPI JSON</a>
          <a href="/admin">
            Administration <ArrowRight size={13} />
          </a>
        </div>
      </header>
      <div className="docs-layout">
        <nav className="docs-nav" aria-label="Documentation sections">
          <strong>Developer documentation</strong>
          {sections.map(([id, title]) => (
            <a key={id} href={`#${id}`}>
              {title}
            </a>
          ))}
        </nav>
        <main className="docs-content">
          <h1>Connect your application.</h1>
          <p className="docs-intro">
            One hosted journey to collect documents, extract their fields and check consistency. Your application starts
            a session and consumes its final result.
          </p>
          <div className="docs-overview">
            <span>
              <Globe size={14} /> Public documentation
            </span>
            <span>
              <KeyRound size={14} /> Server-side API keys
            </span>
            <span>
              <ShieldCheck size={14} /> Signed completion events
            </span>
          </div>
          <section className="docs-section" id="overview">
            <h2>Integration overview</h2>
            <p>
              The onboarding service owns capture, OCR, read-only review and document checks. Your backend owns the link
              to your customer and the business actions that follow.
            </p>
            <ol>
              <li>Ask your administrator to register your application, document rules and completion destinations.</li>
              <li>Store your API key and webhook signing secret in your backend's secret storage.</li>
              <li>
                Create a session and save its <code>sessionId</code> with your customer reference.
              </li>
              <li>
                Open the returned <code>accessUrl</code> in the user's browser.
              </li>
              <li>Receive the completion webhook and retrieve the final result using your API key.</li>
            </ol>
            <p>
              All examples use the frontend's same-origin API proxy. Replace <code>https://onboarding.example.com</code>{" "}
              with your deployment's public URL. A directly exposed backend supports the same paths without the{" "}
              <code>/api/onboarding</code> prefix.
            </p>
            <Code title="Base URL">{"ONBOARDING_API_BASE=https://onboarding.example.com/api/onboarding"}</Code>
            <div className="docs-callout">
              A completion event means the session reached a final state. Check <code>status</code>: completion can
              represent success, failure or expiration.
            </div>
          </section>
          <section className="docs-section" id="authentication">
            <h2>Authenticate your backend</h2>
            <p>
              Send the API key in <code>X-API-Key</code> on every application API request. Each key belongs to one
              application. Access to another application's sessions returns <code>404</code>.
            </p>
            <Code title="HTTP header">{"X-API-Key: <your-application-api-key>"}</Code>
            <p>
              Keys are shown only when generated. Administrators can issue replacement keys, set an expiration and
              revoke old ones. Revoked or expired keys are rejected immediately. Keep API keys in server-side
              environment variables, never in browser code, a mobile bundle or a URL.
            </p>
          </section>
          <section className="docs-section" id="configuration">
            <h2>Your document rules</h2>
            <p>
              The administrator assigns a rule to your application. The server applies it automatically when you create
              a session. You cannot override it from the client.
            </p>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>What the person provides</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>All required</td>
                    <td>Every document in the configured list.</td>
                  </tr>
                  <tr>
                    <td>Required + optional</td>
                    <td>
                      All mandatory documents, plus any optional documents they choose. At least one document is
                      required overall.
                    </td>
                  </tr>
                  <tr>
                    <td>Exact count</td>
                    <td>Exactly the configured number from the list.</td>
                  </tr>
                  <tr>
                    <td>Exact count + required</td>
                    <td>
                      Exactly that number, including every mandatory document. Mandatory documents count toward the
                      total.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              The catalog includes document types supported by both the gateway and the onboarding capture adapters.
              Identity cards and driving licences require two faces but each counts as one document; passports require
              the identity page. All extracted fields remain available. New configuration versions affect new sessions;
              existing sessions retain their rules and destinations.
            </p>
            <Code title="Read your assigned configuration">{`curl "$ONBOARDING_API_BASE/v1/config" \
  -H "X-API-Key: $ONBOARDING_API_KEY"`}</Code>
            <Code title="Example configuration response">
              {JSON.stringify(
                {
                  applicationId: "example-application-id",
                  policy: {
                    id: "application:example-application-id",
                    version: 3,
                    selection: "exact",
                    allowedDocuments: ["dz-id", "dz-driving-licence", "dz-passport"],
                    requiredDocuments: ["dz-id"],
                    minimumDocuments: 2,
                    maximumDocuments: 2,
                  },
                  webhookConfigured: true,
                  returnConfigured: true,
                },
                null,
                2,
              )}
            </Code>
          </section>
          <section className="docs-section" id="sessions">
            <h2>Create a session</h2>
            <p>
              Make this request from your backend. Use a stable, unique idempotency key for each creation attempt. If
              the network fails, retry with the same key and request body to retrieve the same session.
            </p>
            <Code title="POST /v1/sessions">{`curl "$ONBOARDING_API_BASE/v1/sessions" \
  -X POST \
  -H "X-API-Key: $ONBOARDING_API_KEY" \
  -H "Idempotency-Key: $REQUEST_ID" \
  -H "Content-Type: application/json" \
  -d '{"clientReference":"customer-123","locale":"fr"}'`}</Code>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Requirement</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>clientReference</code>
                    </td>
                    <td>Required</td>
                    <td>
                      Your opaque customer or workflow reference, 1–120 characters. Prefer an internal identifier over
                      personal data.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>locale</code>
                    </td>
                    <td>Optional</td>
                    <td>
                      <code>fr</code>, <code>ar</code> or <code>en</code>. Defaults to French.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>policyId</code>
                    </td>
                    <td>Legacy only</td>
                    <td>
                      Imported integrations may choose an authorized predefined policy. Managed applications use their
                      assigned rule automatically.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Webhook and return destinations configured in administration are automatically selected for managed
              applications. Imported integrations can still pass their registered <code>webhookDestinationId</code> and{" "}
              <code>returnDestinationId</code>.
            </p>
            <Code title="201 Created · illustrative response">
              {JSON.stringify(
                {
                  sessionId: "123e4567-e89b-42d3-a456-426614174000",
                  status: "created",
                  accessUrl: "https://onboarding.example.com/s/example-public-token",
                  expiresAt: "2026-10-01T10:30:00.000Z",
                },
                null,
                2,
              )}
            </Code>
            <p>
              Persist the session ID before opening the link. The access URL contains a temporary bearer token: share it
              only with the intended person and keep it out of analytics and application logs. The initial session
              lifetime is 30 minutes; use <code>expiresAt</code> from the response.
            </p>
            <Code title="Backend example · JavaScript">{`const response = await fetch(process.env.ONBOARDING_API_BASE + "/v1/sessions", {
  method: "POST",
  headers: {
    "X-API-Key": process.env.ONBOARDING_API_KEY,
    "Idempotency-Key": requestId, // Persist and reuse this on a retry.
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ clientReference: customerId, locale: "fr" })
});
if (!response.ok) throw new Error("Session creation failed: " + response.status);
const session = await response.json();
// Save session.sessionId against customerId in your own database.
// Return session.accessUrl to your frontend for navigation.`}</Code>
          </section>
          <section className="docs-section" id="status">
            <h2>Follow status and retrieve results</h2>
            <Code title="GET /v1/sessions/{sessionId}/status">{`curl "$ONBOARDING_API_BASE/v1/sessions/$SESSION_ID/status" \
  -H "X-API-Key: $ONBOARDING_API_KEY"`}</Code>
            <p>
              Active states are <code>created</code>, <code>capturing</code>, <code>processing</code>,{" "}
              <code>awaiting_confirmation</code> and <code>awaiting_submission</code>. Final states are listed below.
            </p>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Final status</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["succeeded", "The person confirmed and submitted the checked documents."],
                    ["document_failed", "A document did not satisfy the checks or exhausted its attempts."],
                    ["consistency_failed", "Cross-document identity checks could not be satisfied."],
                    ["technical_failed", "Processing could not complete because of a technical failure."],
                    ["expired", "The session expired before completion."],
                  ].map(([status, detail]) => (
                    <tr key={status}>
                      <td>
                        <code>{status}</code>
                      </td>
                      <td>{detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Code title="GET /v1/sessions/{sessionId}/result">{`curl "$ONBOARDING_API_BASE/v1/sessions/$SESSION_ID/result" \
  -H "X-API-Key: $ONBOARDING_API_KEY"`}</Code>
            <p>
              The endpoint returns <code>409 result_not_ready</code> while the session is active. Once final, it returns{" "}
              <code>200</code> for successes and failures. Inspect <code>status</code> and <code>reasonCode</code>{" "}
              before using the fields.
            </p>
            <Code title="Illustrative result structure · fields abbreviated">
              {JSON.stringify(
                {
                  sessionId: "123e4567-e89b-42d3-a456-426614174000",
                  clientReference: "customer-123",
                  status: "succeeded",
                  policy: { id: "application:example-application-id", version: 3 },
                  reasonCode: null,
                  result: {
                    fields: { firstNameLatin: "EXAMPLE", nin: "100012345678901234" },
                    documents: { "dz-id": { firstNameLatin: "EXAMPLE" } },
                    completedAt: "2026-10-01T10:12:00.000Z",
                  },
                  documents: {
                    "dz-id": {
                      fields: {},
                      originalOcrResponse: {},
                      confirmed: true,
                      unreadableFields: [],
                      ocrAttempts: 1,
                      timingsMs: {},
                    },
                  },
                  consistency: { nin: "matched", dateOfBirth: "matched" },
                },
                null,
                2,
              )}
            </Code>
            <p>
              <code>result.fields</code> contains consolidated values. Use <code>result.documents</code> and the
              top-level <code>documents</code> for values and evidence per document. A failed session can have{" "}
              <code>result: null</code> and partial document readings. Store only the data needed by your business
              process.
            </p>
            <p>
              If you do not configure a webhook, your backend can poll the status with a bounded interval and backoff.
              Stop on a final status or expiration. A background recovery job can also reconcile sessions whose
              notifications were missed.
            </p>
          </section>
          <section className="docs-section" id="webhooks">
            <h2>Receive completion webhooks</h2>
            <p>
              Register an HTTPS endpoint in administration. The onboarding backend sends a signed <code>POST</code> when
              the session reaches a final state. The notification contains no OCR values or customer reference.
            </p>
            <Code title="Completion event">
              {JSON.stringify(
                {
                  eventId: "example-event-id",
                  event: "onboarding.completed",
                  sessionId: "123e4567-e89b-42d3-a456-426614174000",
                  status: "succeeded",
                  reasonCode: null,
                  completedAt: "2026-10-01T10:12:00.000Z",
                },
                null,
                2,
              )}
            </Code>
            <p>
              The header <code>X-Onboarding-Signature</code> is <code>sha256=&lt;hex-digest&gt;</code>. Compute
              HMAC-SHA256 over the exact raw request body using your webhook signing secret, then compare signatures
              safely.
            </p>
            <Code title="Verify a notification · Node.js">{`import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhook(rawBody, signatureHeader, secret) {
  if (!/^sha256=[a-f0-9]{64}$/.test(signatureHeader ?? "")) return false;
  const received = Buffer.from(signatureHeader.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// Use the raw bytes before any JSON parsing middleware.
// Reject an invalid signature before handling the event.
// Parse JSON only after verification.
// Persist a job with a unique eventId, then return a 2xx response.
// The job retrieves /v1/sessions/{sessionId}/result with your API key.`}</Code>
            <p>
              Deliveries may be repeated. Deduplicate by <code>eventId</code> in durable storage, and make your business
              action safe to repeat for the same session. Acknowledge with a <code>2xx</code> response only after saving
              the event or processing it reliably. Transient delivery failures are retried; your endpoint should not
              redirect.
            </p>
            <div className="docs-callout">
              The API key authorizes your backend's requests. The webhook secret verifies our notifications. They are
              separate credentials. Sessions retain the destination and signing secret active at creation; keep old
              secrets available for in-flight sessions after rotation.
            </div>
          </section>
          <section className="docs-section" id="return">
            <h2>Return to your application</h2>
            <p>
              The configured return URL is shown as the completion link after submission or failure. It is a fixed
              navigation destination; it is not a signed result and does not currently receive an appended session
              identifier.
            </p>
            <p>
              Use the session mapping saved by your backend to resume the right customer workflow. On return, your
              frontend asks your backend for the result. If it is still pending, show a waiting state while your backend
              verifies it through the API. Webhooks work independently of whether the person clicks the return link.
            </p>
          </section>
          <section className="docs-section" id="errors">
            <h2>Errors and retries</h2>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>HTTP status</th>
                    <th>How to handle it</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      "400",
                      "Validate the request body and required headers. Creation idempotency keys need at least 8 characters.",
                    ],
                    ["401", "Check that the API key is active and the application is enabled."],
                    ["403", "The requested policy is not assigned to your application."],
                    ["404", "The session does not exist or belongs to another application."],
                    ["409", "The result is not final yet. Consult status and wait."],
                    ["5xx / network error", "Retry with backoff. Reuse the original idempotency key for creation."],
                  ].map(([status, detail]) => (
                    <tr key={status}>
                      <td>
                        <code>{status}</code>
                      </td>
                      <td>{detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Code title="Error envelope">
              {JSON.stringify({ error: "result_not_ready", status: "processing", reasonCode: null }, null, 2)}
            </Code>
            <p>
              Do not retry terminal document failures indefinitely. If your business flow allows another attempt, create
              a new session with a new creation idempotency key.
            </p>
          </section>
          <section className="docs-section" id="reference">
            <h2>Application API reference</h2>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["GET", "/v1/config", "Assigned document rules and destination availability"],
                    ["POST", "/v1/sessions", "Create or recover an idempotent session"],
                    ["GET", "/v1/sessions/{id}/status", "Read the current session status"],
                    ["GET", "/v1/sessions/{id}/result", "Retrieve a final decision and document results"],
                  ].map(([method, path, purpose]) => (
                    <tr key={path}>
                      <td>
                        <span className="docs-method">{method}</span>
                        <code>{path}</code>
                      </td>
                      <td>{purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              All endpoints above require <code>X-API-Key</code>. Session creation additionally requires{" "}
              <code>Idempotency-Key</code>. <a href="/api/onboarding/openapi.json">Download the OpenAPI contract</a> for
              request and response schemas.
            </p>
            <p>
              Public-token capture routes are used by the hosted onboarding interface. Application backends should
              integrate through the endpoints above rather than implementing their own capture orchestration.
            </p>
          </section>
          <footer className="docs-footer">
            OCR Onboarding API · v1 · This documentation is accessible without a session or API key.
          </footer>
        </main>
      </div>
    </div>
  );
}
