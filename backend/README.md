# Providence backend

Express API backed by persistent Playwright sessions for Discord and Instagram DMs/group chats. Discord server channels and Instagram post/feed features are intentionally out of scope. Credentials stay in `.env` and are never returned by the API.

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

Configure at least one complete credential pair to load messages:

- `DISCORD_EMAIL` and `DISCORD_PASSWORD`
- `INSTAGRAM_EMAIL` and `INSTAGRAM_PASSWORD`

Optional variables:

- `CUSTOM_CHROMIUM_PATH`: custom Chromium executable
- `DISCORD_USER_DATA_DIR`: persistent Discord browser profile; falls back to `USER_DATA_DIR`, then `user-data`
- `INSTAGRAM_USER_DATA_DIR`: persistent Instagram browser profile; defaults to `instagram-user-data`
- `USER_DATA_DIR`: legacy name for the Discord browser profile
- `HOST`: defaults to `127.0.0.1`
- `PORT`: defaults to `3001`
- `HEADLESS`: defaults to `false`
- `FRONTEND_ORIGIN`: comma-separated CORS origins; defaults to `*`
- `POLL_INTERVAL_MS`: watched-conversation polling interval; defaults to `5000`

The API can start without credentials so the frontend can display its setup state, but no providers or conversations will be available until credentials are configured and the backend is restarted.

If a provider requests CAPTCHA, MFA, or a login challenge, complete it in the opened browser and reconnect. Each authenticated profile is retained in its own user-data directory for later starts. Do not point both providers at the same directory.

## Shared model

The public conversation/message model is the common subset supported by both providers. It includes direct and group conversations, unread state, text and media attachments, edit metadata, and emoji reactions. Discord-only metadata such as presence, mute state, and member counts is deliberately not exposed.

## API

- `GET /health`
- `GET /api/providers`
- `POST /api/providers/:provider/connect` where `provider` is `discord` or `instagram`
- `GET /api/conversations`
- `GET /api/conversations/:conversationId/messages?limit=50`
- `POST /api/conversations/:conversationId/messages` with `{ "content": "..." }`
- `POST /api/conversations/:conversationId/messages/:messageId/reactions` with `{ "emoji": "..." }`
- `GET /api/events` for server-sent `provider.status` and `message.created` events

Conversation and message IDs are provider-qualified (for example, `discord:123` or `instagram:abc`). URL-encode IDs when placing them in route parameters. Conversation routes dispatch to the provider named by the ID prefix; unavailable providers do not prevent connected providers from being listed.
