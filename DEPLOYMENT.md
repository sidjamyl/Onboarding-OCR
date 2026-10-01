# Onboarding on the OCR server

This repository deploys independently from the Gateway repository. Its
PostgreSQL, MinIO and template volumes use the fixed Compose project name
`ocr-onboarding`; checkout changes do not replace those volumes.

## One-time server setup

1. Clone `git@github.com:sidjamyl/Onboarding-OCR.git` into
   `/home/admin/ocr-onboarding`. Create `/home/admin/ocr-config/onboarding.env`
   from `.env.example` with mode `600`. Choose unique values for all passwords,
   API keys and `BETTER_AUTH_SECRET`. Set `ONBOARDING_DATA_DIR` to an absolute
   persistent host path, such as `/home/admin/ocr-onboarding-data`. Run the
   deployment as `admin` after granting that user Docker access and reconnecting;
   this lets the backend's UID 1000 write the persistent admin directory.
2. Set `OCR_BASE_URL=http://100.126.225.103:8080` while the Gateway listens
   on that Tailscale address, and set `OCR_BASIC_USERNAME` and
   `OCR_BASIC_PASSWORD` to a user from the Gateway's private
   `BASIC_AUTH_USERS`. Keep the backend port bound to `127.0.0.1`.
3. Run `ONBOARDING_ENV_FILE=/home/admin/ocr-config/onboarding.env bash
   ops/deploy.sh` from the onboarding checkout. Verify the homepage and
   `/healthz` locally, then create the first administrator using
   `ADMINISTRATION.md`.
4. Expose only the frontend through HTTPS. If the tailnet administrator has
   enabled HTTPS, Tailscale Serve can proxy its HTTPS name to
   `http://127.0.0.1:3000`. Set `PUBLIC_BASE_URL` to that exact HTTPS origin
   and restart backend, worker and frontend. Desktop and phone users must
   both have access to this tailnet. If that cannot be arranged, use the
   existing Cloudflare domain and tunnel instead; the phone camera needs a
   trusted HTTPS origin.

Do not enable the public demo or diagnostic photo traces in production.
Configure the optional off-server encrypted backup profile before accepting
real documents; the local database and object volumes are not a backup.

## GitHub Actions

Register a self-hosted runner for this private repository on the server with
the label `ocr-onboarding`, then install it as a service. In GitHub, use
**Settings → Actions → Runners → New self-hosted runner**, follow the Linux x64
commands in a separate directory such as `/home/admin/actions-runner-onboarding`,
add `--labels ocr-onboarding` to `config.sh`, then run
`sudo ./svc.sh install admin` and `sudo ./svc.sh start`. The runner needs
noninteractive Docker access and read access to the private env file. A push
to `main` runs `ops/deploy.sh` from the exact commit checked out by Actions.
The runner connects to GitHub over outbound HTTPS, so the server does not
need public SSH. Docker access gives this runner root-equivalent privileges;
restrict repository write access and protect `main`.
