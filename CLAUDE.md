@AGENTS.md

## Codebase exploration

Prefer the codebase-memory (CBM) graph over manual `grep`/`find`/multi-file `Read` sweeps when exploring, to save tokens:

- For structural questions (where is X defined, who calls X, what does X call, impact of changing X, dead code, architecture), use the `codebase-memory` skill, or spawn the `codebase-memory` / `codebase-memory-scout` agent.
- Fall back to `Read`/`grep` when the target file is already known, the lookup is a single literal string, or the graph reports the file as partially indexed or stale. The source is ground truth.
- Before changing a shared function, type or util, check its callers via the graph.
- Do not `Read` large files (e.g. `src/services/api.ts`, ~4k lines) to find a function: `search_graph` for it, then `get_code_snippet`.
- The CBM project name is `Users-zaidbhimala-Desktop-grocey-app`. The CBM tools are deferred, so load them with `ToolSearch` first. If results look stale, run `index_status` / `index_repository`.

## Project

BasketBuddy: Expo (SDK 57) / React Native / TypeScript app that compares grocery prices across Blinkit, Swiggy Instamart etc., builds a basket, and exports it to a store cart. Uses expo-router and in-app WebView "bridges" to reach store sites.

## Layout

- `src/app/` expo-router screens (`(tabs)/index` search, `cart`, `profile`, `webview`)
- `src/components/` modals, sheets and the Blinkit/Swiggy bridge WebViews
- `src/services/` API, bridges, pricing, export, storage, lists, address sync
- `src/utils/` pure logic: matcher, productKey, basketVerdict, stockNotes, location
- Tests live in `__tests__/` folders beside the code (`src/**/__tests__/**/*.test.ts(x)`)

## Commands

- Run: `npx expo start` (`npm run ios|android|web`)
- Test: `npm test` (Jest + jest-expo, ~7 s, 568 tests, all mocked; no secrets). Stop hook runs this automatically.
- Typecheck: `npx tsc --noEmit`; lint: `npm run lint`; coverage: `npm run test:coverage` (thresholds enforced, writes `coverage/`)
- Build: EAS (`eas.json`, profiles `preview`/`production`). CI: `.github/workflows/test.yml` (tsc + tests).

## Non-obvious

- `README.md` is the unmodified create-expo-app template; don't trust it.
- Store integrations scrape via WebView bridges and are fragile; keep their tests mocked.
- Large files, hand to the `reader` agent (or use the CBM graph): `src/services/api.ts` (~3.5k lines), `src/app/(tabs)/cart.tsx` (~1.8k), `src/app/(tabs)/index.tsx` (~1.8k), `src/app/webview.tsx` (~900), and test output logs.
