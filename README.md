# Document onboarding

Administration is available at `/admin`; the integration guide at `/docs` is public and requires no session. See [Administration and client integrations](ADMINISTRATION.md) for administrator provisioning, application credentials, document rules and deployment setup.

The computer owns document selection, OCR review, the final summary, and submission. A short-lived QR grant opens `/capture/{token}` on the phone, which only acquires and uploads the requested face. Both views follow one versioned backend session through `/public/sessions/{token}/events` (SSE, with client polling fallback). Refreshing either view does not restart the workflow.

## Local development

For a direct identity-card and driving-licence test, enable `DEMO_MODE_ENABLED=true` in the frontend process, set its server-only `ONBOARDING_API_KEY` to a local integration credential allowing `id-and-licence`, and open `/test`. Both the homepage demo and `/test` create a fresh session with only the Algerian identity card and driving licence available. The document selection screen shows both requested documents and their front/back faces; the user validates the choice before the phone QR appears. The demo endpoint accepts only `id-and-licence`; passport remains available through real onboarding policies and authenticated integrations. The demo uses real OCR and does not require entering a key or signing in. Keep this unauthenticated test launcher disabled in production. The existing desktop/phone capture journey follows the launcher; phone capture requires an HTTPS frontend origin reachable from the phone.

With that local preview running, `node --env-file=.env test/e2e/local-test.mjs` checks credential-free starts, the two required documents, fresh sessions, input validation and origin checks. Set `TEST_BASE_URL` to test another preview origin.

Copy `.env.example` to `.env` and configure the OCR Gateway credentials and `OCR_BASE_URL`. Run the backend with `npm --prefix backend run dev` and the frontend with `npm --prefix frontend run dev`. When the backend does not run on the frontend proxy's default `http://127.0.0.1:8090`, set the frontend process's `ONBOARDING_API_URL` to its actual address. `DEMO_MODE_ENABLED=true` enables the local session-creation endpoint; `NEXT_PUBLIC_DEMO_MODE_ENABLED=true` shows its start button. Neither belongs in production.

When the onboarding backend runs in Docker and the OCR Gateway runs on this computer, set `OCR_BASE_URL=http://host.docker.internal:8080`. Use the remote server URL only when that server exposes the same verification and extraction routes as the local Gateway. `readyz` alone does not guarantee route compatibility.

Set `PUBLIC_BASE_URL` in the shared `.env` to the HTTPS frontend address reachable by the phone (such as an approved development tunnel). Host-run frontend and backend processes load this file; explicitly set process variables take precedence. Session links and QR transfers use this public origin even when the computer opens the frontend through `localhost`. Without a configured public address, links use the request origin, including forwarded host and protocol headers.

## Diagnostics and safety

`SERVER_QUALITY_CHECKS_ENABLED=false` is a temporary local test setting only. Production refuses it. ORB document verification at the OCR Gateway remains enabled independently. The applied photo-quality profile lives in `backend/config/quality-profile.json`, with local overrides in the configured quality profile store.

`ONBOARDING_DEMO_TRACE=true` writes captured photos plus quality, verification, extraction-stage, and timing diagnostics to `backend/.local/traces` (or `ONBOARDING_TRACE_DIRECTORY`). Docker Compose mounts this directory into both backend and worker so traces remain visible on the host. It defaults to off, is refused in production, and must be treated as sensitive personal data. Remove local trace files after debugging. Application logs and completion webhooks do not contain document values.

Run `npm test` and `npm run typecheck` from this directory to check both applications. The HTTP flow test is in `test/e2e/run.mjs` and requires its dedicated test stack.


## Face extraction and consistency

Each accepted photo immediately queues `/v1/extract/{document-face}` in the background. The unchanged guide crop is sent; ID and driving licence use independent front/back requests, and passport uses one request. Only the latest capture IDs join. Stored completed faces survive selective retakes and worker recovery; technical retries consume no user OCR attempt. A document has three completed OCR attempts and each face has three accepted readings. Quality and verification refusals remain separate from OCR mismatches.

The pair route and onboarding share OCR's portable `core/validation/consistency.ts` rules. Onboarding opts into the identity scope; other pair consumers retain the full default validations. Run `npm run sync:consistency-core` after changing those rules. A parity test protects the backend mirror; generated files are excluded from Biome because their canonical source belongs to OCR.

Cross-face and cross-document checks compare only surname, given name, birth date and NIN. Names must be readable in at least one script; comparisons use matching scripts without inferring Arabic–Latin equivalence. These four identity facts are mandatory. Expiry, categories, sex and document numbers do not block onboarding, including legacy configured prerequisites and optional OCR failures. Document admission, unclassified integrity failures and technical failures still block. Raw OCR validation remains available for audit and other consumers. Missing comparisons are not agreement and do not produce repeated diagnostic rows in the customer interface. Normalized equal names pass; close spelling differences warn and material conflicts block confirmation and submission.

The review screen groups conflicting readings by identity field, labels their document and side, and offers one side selector with one retake action. A selective retake retains other captures and confirmations. Licence MRZ names remain separate using the observed `<<` boundary; multiword names are preserved and undelimited human names are never split by guessing.

Onboarding phone capture is automatic after stable passing quality measurements. A non-interactive circle shows the existing five-second stability progress without triggering a photo when touched. Manual shutters, keyboard activation, remote capture commands and simulation controls are unavailable in this journey; the calibration laboratory retains operator controls. A failed analyser requires restarting the camera, and failed final quality checks cannot upload automatically. The guide has no attempts/automatic-capture footer.

Conflicts show the field, both readings, and their document/face. The user chooses one implicated photo to retake; other photos and confirmations remain valid. Two matching documents can suggest an outlier but do not establish truth. Completion remains blocked until meaningful conflicts are resolved, and unavailable checks remain visible. The authenticated result retains the detailed report; legacy NIN/birth-date summaries say `matched` only when comparisons actually ran and passed.
