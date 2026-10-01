# Calibrated capture settings

`quality-profile.json` is the checked-in baseline calibrated on the identity-card
front. Sharpness is 40 for both live analysis and final capture. No 90 threshold
is used. Phone and backend consume the same profile and quality core.

Startup uses this baseline, or `QUALITY_PROFILE_JSON` when set, then restores the
saved profile at `QUALITY_PROFILE_PATH` (default `.local/quality-profile.json`).
The lab's Apply action saves that file atomically. To deploy a new baseline,
copy the validated saved JSON into this directory; a previously saved runtime
profile still takes precedence. Do not commit customer captures.

The customer capture route runs generic quality checks with no onboarding ORB
or OCR-copy preparation, then asks Gateway `/v1/verify/<expected-face>`.
Only accepted guide crops are stored and sent, unchanged, for extraction.
The Gateway re-verifies at extraction and owns alignment. Laboratory diagnostics
and its ORB preview remain available separately from customer capture.

Gateway verification uses the template lab's ORB match/RANSAC gate, without prior
contour rectification or extra framed-image rejection thresholds. Its policy lives
in `OCR/src/config/document-verification.ts`; descriptor matching parameters are
preserved in each supplied export. No OCR attempt is consumed by verification.

## Local or remote OCR Gateway

Set `OCR_BASE_URL` in `onboarding/.env` to the Gateway base URL (no `/v1` suffix).
Both verification and extraction use this setting; there is no frontend API URL
or credential to change. Keep `OCR_BASIC_USERNAME` and `OCR_BASIC_PASSWORD` valid
for the selected Gateway.

- Host-run backend: `OCR_BASE_URL=http://127.0.0.1:8080` for a local Gateway.
- Docker backend: `OCR_BASE_URL=http://host.docker.internal:8080` for a host Gateway.
- Remote Gateway: `OCR_BASE_URL=http://100.126.225.103:8080` on the private network.

Restart the backend and extraction worker after changing the environment. Docker
Compose reads `onboarding/.env`; `npm run dev`, `npm start` and `npm run worker`
also load that file automatically when launched from `onboarding/backend`.
For a direct host-run command, explicitly load it, for example:

```sh
node --env-file=../.env --import tsx src/server.ts
```

Use `src/worker.ts` instead for the separate worker. Runtime environment variables
take precedence over an env-file, so remove a stale shell override if needed.

For temporary local tests, `SERVER_QUALITY_CHECKS_ENABLED=false` skips quality
analysis on the customer upload route only. Reports explicitly use mode `off`.
Phone checks, lab diagnostics, authentication, upload limits and Gateway ORB
verification remain active. Restart the backend to apply the setting, then
restore `true` and restart after testing. Production rejects this bypass.
