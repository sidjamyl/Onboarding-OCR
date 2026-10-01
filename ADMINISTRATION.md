# Administration and client integrations

`/admin` manages consumer applications, API keys, document requirements and completion destinations. `/docs` is the public developer guide. It includes copyable curl and Node.js examples for session creation, status, results, webhook verification, retries and return navigation. `/api/onboarding/openapi.json` exposes the public API specification through the frontend proxy.

## Enable administration

Configure the backend's `BETTER_AUTH_SECRET` with at least 32 characters and keep it in the deployment secret store or ignored `onboarding/.env`. The supplied local secret is already saved in that ignored file; no secret belongs in source control. Set `PUBLIC_BASE_URL` to the frontend's exact origin. HTTPS is required for administration in production. Set the frontend's `ONBOARDING_API_URL` to the private backend address.

Production uses PostgreSQL, MinIO and pg-boss. Management and Better Auth tables are initialized at startup. A PostgreSQL advisory lock serializes initialization across the backend, worker and administrator provisioning; environment credential imports are transactional. Keep the database private and include it in your backup policy. Memory storage remains available for development and tests.

There is no public sign-up or bootstrap HTTP endpoint. Provision an administrator from the backend:

```sh
npm run build
npm run admin:create -- admin@your-company.example
```

With the Compose stack configured and built, run from `onboarding`:

```sh
docker compose run --rm backend npm run admin:create -- admin@your-company.example
```

Provisioning generates a password and writes it to `.local/admin-access.txt`, without printing it. The Compose mount makes that file available on the host at `onboarding/.local/admin/admin-access.txt`. Move the password to your password manager and remove the file. `ADMIN_PASSWORD` can supply a password of at least 12 characters through the process environment. Attempting to provision an existing email fails without changing its credentials.

Better Auth owns password hashing, signed HttpOnly session cookies, sign-in and sign-out. Only provisioned users with the server-controlled `isAdmin` flag can use administration endpoints. Sessions last eight hours. Administration mutations require the configured origin. Login rate limiting uses a server-derived socket address; deployments using the Next.js proxy share its backend address and therefore its per-path rate-limit bucket.

## Register an application

1. Open `/admin` and sign in.
2. Create an application and select its compatible documents.
3. Choose its collection rule and, where applicable, its mandatory documents and total count.
4. Optionally configure a webhook URL and a return URL. Copy the webhook signing secret when it is displayed.
5. Generate an API key with a descriptive name and optional expiration. Copy the full value immediately to the consumer backend's secret storage.

API keys are scoped to one application. Only SHA-256 digests and display prefixes are stored; full keys are returned once on issuance. Generate a replacement, deploy it in the consumer backend, then revoke the old key. Revocation is immediate. Disabling an application blocks all of its application API access. Existing public session links retain their captured configuration and can complete; re-enable access or handle cancellation separately when withdrawing an integration.

Changing application settings uses a version check to prevent overwriting a concurrent edit. New sessions receive a snapshot of the rules, return URL and webhook URL/signing secret. Existing sessions keep their original configuration. When replacing a webhook signing secret, retain the previous secret in the consumer verifier until its existing sessions and pending webhook deliveries are finished.

## Document rules

| Rule | Behavior |
| --- | --- |
| All required | Every selected document must be collected. |
| Required + optional | Mandatory documents must be collected; the person may also choose optional documents. At least one document is required overall. |
| Exact count | The person chooses exactly the configured number from the selected list. |
| Exact count + required | The configured total includes every mandatory document; the person chooses the remaining documents from the optional list. |

Counts refer to complete documents, not images: the front and back of an identity card or driving licence count as one document. Duplicate selections, missing mandatory documents and invalid totals are rejected by the backend as well as prevented in the interface. Selection is locked once a capture or OCR attempt has started.

The catalog comes from the live gateway's `/v1/documents` discovery endpoint. Onboarding currently has capture, extraction and result adapters for `dz-id`, `dz-driving-licence` and `dz-passport`. Both gateway faces must be available for a paired document. Other gateway types, such as birth and residence certificates, are listed separately and cannot be selected until their onboarding adapters are implemented. A gateway outage prevents creating or changing document rules, while existing rules and other application settings remain usable.

OCR engine selection and extracted fields remain shared across applications. Per-application engine/field configuration is deferred to V2.

## Connect a consumer backend

The frontend proxy base is `https://your-onboarding-origin/api/onboarding`. A directly exposed backend uses the same routes without `/api/onboarding`. Authenticate application calls with `X-API-Key`.

1. Optionally call `GET /v1/config` to read the application's assigned document requirements.
2. Call `POST /v1/sessions` with `clientReference`, optional `locale` (`fr`, `ar`, `en`) and an `Idempotency-Key` of at least eight characters. Save the returned `sessionId` with your customer record.
3. Send the returned `accessUrl` to your frontend for navigation to the hosted onboarding journey. Keep API keys in backend code.
4. Receive a signed `onboarding.completed` webhook, or poll `GET /v1/sessions/{sessionId}/status` when webhooks are not configured.
5. Fetch `GET /v1/sessions/{sessionId}/result` with the same application's key and apply your own business decision.

Managed applications do not choose a policy or arbitrary completion URL when creating a session. The configured rules and destinations are selected automatically. Existing environment-based applications are imported once and preserve their legacy policy/destination identifiers until saved in the panel. A revoked imported key is never restored by a restart. Stop adding credentials through environment configuration after migrating an integration to managed keys.

Verify the webhook's `X-Onboarding-Signature` against the raw request bytes using HMAC-SHA256 and the application's signing secret. Deduplicate `eventId`, persist receipt durably, and return a successful response promptly. Webhooks contain session metadata and terminal status, without OCR fields. Completion can represent success, failure or expiration. Fetch detailed results over the authenticated API. The return URL is navigation only and does not prove success; it is opened as configured, without automatically adding session identifiers.

## Validation

Run `npm test`, `npm run typecheck` and `npm run build` from `onboarding`. Administration tests cover all four collection rules, human authentication, origin checks, application ownership, immutable session configuration, version conflicts, secret exposure and immediate key revocation. Manual browser verification covers PostgreSQL login, application creation, one-time secrets, rule updates, the frontend API proxy, revocation and anonymous documentation at desktop and mobile widths.

The isolated local preview uses `http://localhost:3000/admin` and `/docs`, a backend on port 8091 and a dedicated PostgreSQL QA database on port 55432. Its generated access file is `onboarding/backend/.local/admin-preview-access.txt`. When running this preview, stop the existing Compose frontend to free port 3000. This preview does not constitute a production deployment.
