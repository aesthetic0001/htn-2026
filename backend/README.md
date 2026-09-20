# Providence backend

Express API backed by a persistent Playwright session for Discord DMs and group chats. Discord server channels are intentionally out of scope. Credentials stay in `.env` and are never returned by the API.

## Run

```bash
npm install
npm run dev
```

Production-style build:

```bash
npm run build
npm start
```

Required environment variables:

- `DISCORD_EMAIL`
- `DISCORD_PASSWORD`
- `USER_DATA_DIR`

Optional variables:

- `CUSTOM_CHROMIUM_PATH`: custom Chromium executable
- `HOST`: defaults to `127.0.0.1`
- `PORT`: defaults to `3001`
- `HEADLESS`: defaults to `false`
- `FRONTEND_ORIGIN`: comma-separated CORS origins; defaults to `*`
- `POLL_INTERVAL_MS`: watched-conversation polling interval; defaults to `5000`

If Discord requests CAPTCHA or MFA, complete it in the opened browser. The authenticated profile is retained in `USER_DATA_DIR` for later starts.

## API

- `GET /health`
- `GET /api/providers`
- `POST /api/providers/discord/connect`
- `GET /api/conversations`
- `GET /api/conversations/:conversationId/messages?limit=50`
- `POST /api/conversations/:conversationId/messages` with `{ "content": "..." }`
- `POST /api/conversations/:conversationId/messages/:messageId/reactions` with `{ "emoji": "..." }`
- `GET /api/events` for server-sent `provider.status` and `message.created` events

Conversation and message IDs are provider-qualified (for example, `discord:123`). URL-encode IDs when placing them in route parameters.
