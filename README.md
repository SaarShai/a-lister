# A-Lister (ChatGPT Apps SDK)

Minimal social list app built as a ChatGPT Apps SDK app (MCP server + widget UI).

## Structure
- `src/server.ts` — MCP server and tool handlers
- `src/db.ts` — Postgres queries
- `src/auth.ts` — Dev/OAuth auth helpers
- `public/alister-widget.html` — UI widget
- `db/schema.sql` — database schema

## Local dev
1. Install deps
   ```bash
   npm install
   ```

2. Create a Postgres database and apply the schema
   ```bash
   psql "$DATABASE_URL" -f db/schema.sql
   ```

3. Create `.env` from `.env.example`
   ```bash
   cp .env.example .env
   ```

4. Run the MCP server
   ```bash
   npm run dev
   ```

The server runs at `http://localhost:3000/mcp` by default.

## ChatGPT dev testing
- Expose the server with an HTTPS tunnel (ngrok, Cloudflare Tunnel, etc).
- Set `BASE_URL` to the HTTPS public URL.
- Use the ChatGPT Apps SDK developer mode to connect the MCP URL.

## Production services
Recommended services for launch:
- App host: Render or Fly.io
- Database: Supabase or Neon (Postgres)
- Auth: Auth0 or Clerk (OAuth 2.1)
- Observability: Sentry or similar

## Env vars
See `.env.example` for the full list. Key ones:
- `DATABASE_URL`
- `AUTH_MODE` (`dev` or `oauth`)
- `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` (OAuth)
- `BASE_URL`

## Notes
- All lists are public in v1.
- Only list owners can add/edit/move items; others can bookmark.
