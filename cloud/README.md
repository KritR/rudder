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
```

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

The intended AWS shape is:

- container image in ECR
- App Runner service for the control plane
- encrypted persistent storage or managed database for production state
- secrets stored in AWS Secrets Manager or App Runner environment secrets

Build and push the image, then create or update the App Runner service with the
environment above. The sample App Runner shape lives in
`infra/apprunner-service.json`; use it as a starting point after replacing the
image identifier with your ECR image.
