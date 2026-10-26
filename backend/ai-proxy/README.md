# BasketBuddy AI proxy

A Cloudflare Worker that sits between the app's AI mode and Groq. The Groq API key
lives only here, as a Workers secret. The app never holds it: it calls this
Worker's `POST /chat` with a shared app token.

```
app (AI mode) --X-App-Token--> Worker /chat --Bearer GROQ_API_KEY--> api.groq.com
```

## What protects it (and what doesn't)

- **The app token only stops casual abuse.** `APP_TOKEN` is a single shared
  value compiled into every app build (`EXPO_PUBLIC_AI_PROXY_TOKEN`), so anyone
  with the APK/IPA or a debugger can extract it. It keeps out scanners and
  people who stumble on the URL. It does not authenticate users. Before a broad
  public release, add real per-user auth: sign-in with short-lived tokens, or
  device attestation (App Attest / Play Integrity).
- **Per-IP rate limit:** 12 requests per 60 s per IP (IPv6 is grouped by /64),
  using the [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
  The limit is approximate and counted per Cloudflare location, and users
  behind the same NAT share it. One AI-mode run makes 2 calls.
- **The request is rebuilt from an allow-list**, so even with the token this
  makes a poor general-purpose LLM endpoint:
  - The only model accepted is `openai/gpt-oss-120b`. Keep it in sync with
    `GROQ_MODEL` in `src/services/groq.ts`.
  - Messages can have only the `system` or `user` role, with 1 to 4 text
    messages.
  - `response_format` must be a `json_schema`.
  - Output is capped at 4096 tokens. Larger requests are clamped.
  - `stream` is forced to `false`. `tools`, `tool_choice`, `functions` and
    `function_call` are rejected. Unknown fields are dropped.
  - Bodies must be `application/json` and at most 64 KB. The largest
    legitimate AI-mode request is about 43 KB.
- **No secret logging:** the Worker never logs the Groq key, the app token or
  request/response bodies. Workers *invocation* logs are turned off in
  `wrangler.toml` because they record request details, including headers.
- **CORS:** only the origins in `ALLOWED_ORIGINS` (`wrangler.toml`) may call it
  from a browser. Native apps send no `Origin` and are unaffected. Add your
  deployed web origin there if you ship the web build. Avoid `*`: it would let
  any website spend your quota from its visitors' IPs.

## Deploy

You need a Cloudflare account (the free plan is enough) and a Groq API key.
Run these commands from this directory:

```sh
cd backend/ai-proxy
npm install

npx wrangler login                      # opens the browser to authorise Wrangler

npx wrangler secret put GROQ_API_KEY    # paste the Groq key at the prompt
#   On the first run Wrangler says the Worker doesn't exist yet and asks to
#   create it: answer yes.

openssl rand -hex 32                    # generate an app token and copy it
npx wrangler secret put APP_TOKEN       # paste that token (16+ characters)

npx wrangler deploy                     # prints https://basketbuddy-ai-proxy.<your-subdomain>.workers.dev
```

`wrangler.toml` declares both secrets in `[secrets] required`, so `wrangler deploy`
refuses to run until both are set. If this is your first Worker, `deploy` may
also ask you to pick a `workers.dev` subdomain.

Then point the app at it. In the repo root's `.env.local` (gitignored; see
`.env.example`):

```sh
EXPO_PUBLIC_AI_PROXY_URL=https://basketbuddy-ai-proxy.<your-subdomain>.workers.dev
EXPO_PUBLIC_AI_PROXY_TOKEN=<the same value you gave APP_TOKEN>
```

Delete any old `EXPO_PUBLIC_GROQ_API_KEY` line, because the app no longer reads
it. Restart the bundler with `npx expo start --clear`. For EAS builds, set the
same two variables in the EAS environment for the build profile.

If a build ever shipped with `EXPO_PUBLIC_GROQ_API_KEY` in it, treat that key
as leaked. Revoke it in the Groq console and give the Worker a fresh one.

### Rotating secrets

- **Groq key:** run `npx wrangler secret put GROQ_API_KEY` again. This takes
  effect immediately, and no app change is needed.
- **App token:** run `npx wrangler secret put APP_TOKEN`, then rebuild the app
  with the new `EXPO_PUBLIC_AI_PROXY_TOKEN`. Builds that carry the old token
  start getting 401.

## Local development

```sh
cp .dev.vars.example .dev.vars          # gitignored; fill in GROQ_API_KEY and APP_TOKEN
npm run dev                             # wrangler dev on http://localhost:8787
```

To reach it from a phone on the same Wi-Fi, run
`npx wrangler dev --ip 0.0.0.0`. Then set
`EXPO_PUBLIC_AI_PROXY_URL=http://<your-computer's-LAN-IP>:8787`. Plain
`http://` is fine for development but not for release builds.

## Tests and type checks

These run only inside this package. The app's root `npm test`, `tsc` and lint
all ignore `backend/`.

```sh
npm test            # vitest; fetch and the rate limiter are mocked, no network
npm run typecheck   # regenerates worker-configuration.d.ts (wrangler types), then tsc
```

`worker-configuration.d.ts` is generated and gitignored. Run `npm run cf-typegen`
after editing `wrangler.toml`, or let `npm run typecheck` regenerate it.

## API

`POST /chat` with `Content-Type: application/json` and `X-App-Token: <token>`.
The body is an OpenAI-style chat completion request, limited as described
above. On success, Groq's status and JSON body are returned unchanged. Proxy
errors look like `{ "error": { "code": "...", "message": "..." } }`:

| Status | code | Meaning |
| --- | --- | --- |
| 400 | `invalid_json` / `invalid_request` | The body is unparseable or outside the allow-list. |
| 401 | `unauthorized` | The `X-App-Token` header is missing or wrong. |
| 403 | `origin_not_allowed` | The browser origin is not in `ALLOWED_ORIGINS`. |
| 404 / 405 | `not_found` / `method_not_allowed` | The path is not `/chat`, or the method is not POST. |
| 413 | `too_large` | The body is over 64 KB. |
| 415 | `unsupported_media_type` | The request is not JSON. |
| 429 | `rate_limited` | The per-IP limit was hit. The response sets `Retry-After: 60`. Groq's own 429s pass through as they are. |
| 500 | `not_configured` | A secret is missing, or `APP_TOKEN` is shorter than 16 characters. |
| 502 | `upstream_auth` | Groq rejected the Worker's key. This is never reported as 401. |
| 502 / 504 | `upstream_unreachable` / `upstream_timeout` | Groq could not be reached, or did not answer within 40 s. |
| 503 | `unavailable` | The rate limiter failed. The proxy fails closed. |

## Files

- `src/index.ts`: the Worker entry. Keep it to the default export only, because
  workerd treats every named export of the main module as an entrypoint.
- `src/proxy.ts`: routing, auth, rate limiting, validation and forwarding.
- `test/proxy.test.ts`: unit tests.
- `wrangler.toml`: the Worker name, vars, required secrets, the rate-limit
  binding and logging settings.
