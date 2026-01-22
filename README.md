# Notification Hub PWA

A production-ready Notification Hub that provides multi-tenant Web Push notifications for multiple services. It includes a lightweight PWA, a Node.js + Express API, and Postgres storage.

## Features

- Deep-link onboarding via one-time tokens (`/link?token=...`).
- Dev login for direct visits.
- Service entitlement gating with automatic flow for 0, 1, or many services.
- Push enable flow with iOS install guidance.
- Topic preferences (trade_alerts, fills, risk_events, system).
- Test notification and unsubscribe controls.
- Web Push delivery with VAPID + invalid endpoint handling.

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create environment file**
   ```bash
   cp .env.example .env
   ```
   Update the values for your database and VAPID keys.

3. **Initialize the database**
   ```bash
   npm run db:setup
   ```

4. **Run the app**
   ```bash
   npm run dev
   ```

The app will be available at [http://localhost:5173](http://localhost:5173).

## Environment Variables

See `.env.example` for the full list. Required values:

- `DATABASE_URL` - Postgres connection string.
- `SESSION_SECRET` - Secret for session JWT cookies.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` - Web Push credentials.
- `INTERNAL_API_KEY` - API key for internal push sending.

## Dev Workflows

### Create a dev user

```bash
curl -X POST http://localhost:5173/api/dev/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

### Grant access to a service

```bash
curl -X POST http://localhost:5173/api/dev/grant-access \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","service_id":"algopilotx"}'
```

### Create a one-time link token (for `/link`)

```bash
curl -X POST http://localhost:5173/api/dev/create-link-token \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","expires_in_minutes":30}'
```

Then open `http://localhost:5173/link?token=TOKEN_HERE`.

### Send a push notification (internal API)

```bash
curl -X POST http://localhost:5173/api/internal/push/send \
  -H "Content-Type: application/json" \
  -H "x-api-key: $INTERNAL_API_KEY" \
  -d '{"service_id":"algopilotx","user_id":"USER_UUID","title":"Hello","body":"Trade alert","url":"/done"}'
```

## Notes on Push Testing

- Web Push requires HTTPS in production. Locally, `http://localhost` works in modern browsers.
- iOS Safari requires the app to be installed to the Home Screen to enable push.
- If you see `No active subscriptions`, ensure notifications are enabled in browser settings.

## Database Schema

The schema lives in `db/schema.sql` and includes:

- `users`
- `services`
- `user_service_access`
- `push_devices`
- `push_device_services`
- `push_link_tokens`

## Deploying to Railway

- Set the same environment variables as `.env.example`.
- Use the Railway Postgres plugin and copy its connection string into `DATABASE_URL`.
- Run `npm run db:setup` once after provisioning the database.
- Railway will run `npm start` by default if configured with a Node.js service.

## API Reference

- `POST /api/dev/login`
- `POST /api/link/exchange`
- `GET /api/me`
- `GET /api/me/services`
- `POST /api/push/subscribe`
- `POST /api/push/unsubscribe`
- `POST /api/push/test`
- `POST /api/internal/push/send`
- `POST /api/dev/grant-access`
- `POST /api/dev/create-link-token`
