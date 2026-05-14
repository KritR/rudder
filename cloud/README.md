# Rudder Cloud

Rudder Cloud is the control plane for `/login`, `/cloud`, and `/sail`.

The CLI package stays light. This service is a separate deployable app that uses
Better Auth for Google and GitHub login, then issues a Rudder CLI token for the
local dashboard.

## Environment

```bash
BETTER_AUTH_URL=https://cloud.example.com
BETTER_AUTH_SECRET=<random secret>
GOOGLE_CLIENT_ID=<google oauth client id>
GOOGLE_CLIENT_SECRET=<google oauth client secret>
GITHUB_CLIENT_ID=<github oauth client id>
GITHUB_CLIENT_SECRET=<github oauth client secret>
RUDDER_CLOUD_DATA_DIR=/data
RUDDER_S3_BUCKET=<snapshot bucket>
RUDDER_CLOUD_STATE_KEY=control-plane/rudder-cloud.sqlite
RUDDER_CLOUD_PERSIST_STATE=1
AWS_REGION=us-east-1
FLY_API_TOKEN=<fly token>
FLY_APP_NAME=<existing fly machines app>
FLY_REGION=iad
RUDDER_WORKER_IMAGE=<registry image for cloud/worker/Dockerfile>
```

Current hosted control plane:

```text
https://mpd2pmnpep.us-east-1.awsapprunner.com
```

Current Exla defaults:

```bash
RUDDER_S3_BUCKET=rudder-cloud-snapshots-597088032164-us-east-1
AWS_REGION=us-east-1
FLY_APP_NAME=rudder-workers-exla
FLY_REGION=iad
RUDDER_WORKER_IMAGE=public.ecr.aws/exla/rudder-worker:latest
```

The current control-plane image is:

```text
public.ecr.aws/exla/rudder-cloud-control:latest
```

Generated AWS secrets:

- `rudder/better-auth-secret`
- `rudder/fly-api-token`

Google/GitHub OAuth client IDs and client secrets still need to be created in
the provider consoles and added as App Runner secrets before the hosted login
flow can go live.

Until provider OAuth clients are installed, login still works through an
already-authenticated GitHub CLI or GitHub's device flow. `rudder login` sends
the resulting GitHub token to `/api/cli/login/github-token`; the server verifies
it with GitHub and stores only a hashed Rudder Cloud token. The hosted
`/cli/login` page also exposes a GitHub device-login path so browser login does
not dead-end while Google/GitHub Better Auth provider secrets are missing.

GitHub browser OAuth can be configured from the hosted setup page without
copying secrets by hand:

```text
https://mpd2pmnpep.us-east-1.awsapprunner.com/setup/github
https://mpd2pmnpep.us-east-1.awsapprunner.com/setup/github?org=exla
```

That page uses GitHub's App Manifest flow to create a GitHub App, receives the
generated OAuth client ID and secret at `/setup/github/callback`, stores them in
Rudder Cloud's persisted state, and rebuilds Better Auth dynamically. The normal
GitHub browser login button appears on `/cli/login` immediately after setup.

If the GitHub App already exists, generate a fresh client secret from the app
settings page and install the existing app credentials from a logged-in admin
CLI:

```bash
rudder cloud login
rudder cloud setup-github <client-id>
```

The CLI prompts for the client secret without echoing it. For scripts, set
`RUDDER_GITHUB_CLIENT_ID` and `RUDDER_GITHUB_CLIENT_SECRET`.

Google browser OAuth can be installed the same way after creating an OAuth web
client with this redirect URI:

```text
https://mpd2pmnpep.us-east-1.awsapprunner.com/api/auth/callback/google
```

```bash
rudder cloud login
rudder cloud setup-google <client-id>
```

The CLI prompts for the Google client secret without echoing it. For scripts,
set `RUDDER_GOOGLE_CLIENT_ID` and `RUDDER_GOOGLE_CLIENT_SECRET`.

The setup endpoint is restricted to `RUDDER_ADMIN_EMAILS` (defaults to
`viraat.laldas@gmail.com,viraat@exla.ai`) and persists the credentials to S3
before returning.

OAuth callback URLs:

```text
https://cloud.example.com/api/auth/callback/google
https://cloud.example.com/api/auth/callback/github
```

## Local

```bash
npm install
npm run build
npm start
```

Then point the CLI at it:

```bash
export RUDDER_CLOUD_URL=http://localhost:3000
rudder login
rudder cloud list
```

## AWS

The AWS role of the control plane is S3 snapshot storage. The service stores
uploaded launch/onload snapshots in `RUDDER_S3_BUCKET` using server-side
encryption and gives each Fly Machine a one-hour presigned URL. Fly workers do
not receive AWS credentials.

The control plane also persists its SQLite state to S3 at
`RUDDER_CLOUD_STATE_KEY` by default. That keeps CLI tokens, sail records, worker
heartbeats, and Better Auth tables available across App Runner restarts without
requiring a database server for the early deployment. Set
`RUDDER_CLOUD_PERSIST_STATE=0` to disable that behavior for local development.

The intended AWS shape is:

- container image in ECR
- App Runner service for the control plane
- S3 bucket for encrypted snapshot objects and persisted control-plane state
- secrets stored in AWS Secrets Manager or App Runner environment secrets

Build and push the image, then create or update the App Runner service with the
environment above. The sample App Runner shape lives in
`infra/apprunner-service.json`.

## Fly Machines

Rudder Cloud creates one Fly Machine per sail through the Fly Machines API.
`FLY_APP_NAME` must point at an existing Fly app, and `RUDDER_WORKER_IMAGE`
should be an image built from `worker/Dockerfile`.

```bash
docker buildx build --platform linux/amd64 \
  -f cloud/worker/Dockerfile \
  -t public.ecr.aws/exla/rudder-worker:latest \
  --push .
```

The worker image installs Rudder, acpx, and Hunk at startup, downloads the
snapshot from S3, restores selected HOME config, and starts `rudder run
--worktree "$RUDDER_TASK"` inside the unpacked repo.
