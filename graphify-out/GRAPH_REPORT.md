# Graph Report - grocey app  (2026-10-01)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 342 nodes · 700 edges · 16 communities (15 shown, 1 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `207e8b23`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.tsx
- api.ts
- expo
- SwiggyBridgeWebView.tsx
- dependencies
- package.json
- blinkitBridge.ts
- matcher.ts
- reset-project.js
- tsconfig.json
- scripts
- app/_layout.tsx
- devDependencies
- variationImage
- eslint.config.js
- declarations.d.ts

## God Nodes (most connected - your core abstractions)
1. `SearchScreen()` - 17 edges
2. `expo` - 16 edges
3. `UnifiedProduct` - 14 edges
4. `Platform` - 14 edges
5. `walk()` - 13 edges
6. `resolvePlatformProduct()` - 11 edges
7. `react` - 11 edges
8. `storage` - 11 edges
9. `getProductPlatformLimit()` - 10 edges
10. `SwiggyBridgeWebView()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `ProductCardProps` --references--> `UnifiedProduct`  [EXTRACTED]
  src/app/(tabs)/index.tsx → src/services/api.ts
- `Props` --references--> `UnifiedProduct`  [EXTRACTED]
  src/components/VariantPickerModal.tsx → src/services/api.ts
- `CartCalculation` --references--> `Platform`  [EXTRACTED]
  src/services/api.ts → src/services/storage.ts
- `SearchScreen()` --calls--> `resolvePlatformProduct()`  [EXTRACTED]
  src/app/(tabs)/index.tsx → src/services/api.ts
- `SearchScreen()` --calls--> `pickBestMatch()`  [EXTRACTED]
  src/app/(tabs)/index.tsx → src/utils/matcher.ts

## Import Cycles
- None detected.

## Communities (16 total, 1 thin omitted)

### Community 0 - "index.tsx"
Cohesion: 0.08
Nodes (53): expo-linear-gradient, expo-location, expo-router, lucide-react-native, react, react-native, VariantRowItem, LogoTile() (+45 more)

### Community 1 - "api.ts"
Cohesion: 0.08
Nodes (53): @react-native-async-storage/async-storage, btoaUnicode(), CartScreen(), LogoTile(), s_row, styles, AddressCacheEntry, api (+45 more)

### Community 2 - "expo"
Cohesion: 0.05
Nodes (36): backgroundColor, backgroundImage, foregroundImage, adaptiveIcon, icon, package, predictiveBackGestureEnabled, projectId (+28 more)

### Community 3 - "SwiggyBridgeWebView.tsx"
Cohesion: 0.11
Nodes (30): react-native-webview, RootLayout(), buildSwiggyOpenCartScript(), styles, WebViewScreen(), COPY, styles, SwiggyBridgeWebView() (+22 more)

### Community 4 - "dependencies"
Cohesion: 0.06
Nodes (32): dependencies, expo, expo-clipboard, expo-constants, expo-device, expo-font, @expo-google-fonts/inter, @expo-google-fonts/outfit (+24 more)

### Community 5 - "package.json"
Cohesion: 0.08
Nodes (24): main, name, private, version, expo, expo-clipboard, expo-constants, expo-device (+16 more)

### Community 6 - "blinkitBridge.ts"
Cohesion: 0.17
Nodes (19): BlinkitBridgeHandle, BlinkitBridgeWebView, styles, BlinkitBridgeResponse, dispatch(), getBlinkitPageStorage(), handleBlinkitBridgeMessage(), handleBlinkitLocalStorage() (+11 more)

### Community 7 - "matcher.ts"
Cohesion: 0.25
Nodes (15): BestMatch, MatchableItem, matchScore(), nameSimilarity(), priceSanity(), sizeScore(), tokenSet(), familyKey() (+7 more)

### Community 8 - "reset-project.js"
Cohesion: 0.17
Nodes (7): exampleDirPath, fs, oldDirs, path, readline, rl, root

### Community 9 - "tsconfig.json"
Cohesion: 0.25
Nodes (7): expo/tsconfig.base, compilerOptions, paths, strict, extends, include, @/assets/*

### Community 10 - "scripts"
Cohesion: 0.29
Nodes (7): scripts, android, ios, lint, reset-project, start, web

### Community 11 - "app/_layout.tsx"
Cohesion: 0.29
Nodes (6): expo-font, @expo-google-fonts/inter, @expo-google-fonts/outfit, expo-splash-screen, expo-status-bar, react-native-safe-area-context

### Community 12 - "devDependencies"
Cohesion: 0.33
Nodes (6): devDependencies, eslint, eslint-config-expo, @expo/ngrok, @types/react, typescript

### Community 13 - "variationImage"
Cohesion: 0.40
Nodes (6): deepSwiggyImage(), imageUrlFrom(), suspiciousImageUrl(), variationImage(), isVideo(), mediaRef()

### Community 14 - "eslint.config.js"
Cohesion: 0.40
Nodes (4): { defineConfig }, expoConfig, eslint, eslint-config-expo

## Knowledge Gaps
- **150 isolated node(s):** `StoreFilter`, `PlatformTheme`, `AddressSyncState`, `LocationResetListener`, `SyncListener` (+145 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 160 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **Why does `@react-native-async-storage/async-storage` connect `api.ts` to `index.tsx`, `SwiggyBridgeWebView.tsx`, `package.json`, `blinkitBridge.ts`?**
  _High betweenness centrality (0.110) - this node is a cross-community bridge._
- **Why does `react` connect `index.tsx` to `api.ts`, `SwiggyBridgeWebView.tsx`, `package.json`, `blinkitBridge.ts`, `app/_layout.tsx`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **What connects `StoreFilter`, `PlatformTheme`, `AddressSyncState` to the rest of the system?**
  _150 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.07932310946589106 - nodes in this community are weakly interconnected._
- **Should `api.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07759562841530054 - nodes in this community are weakly interconnected._
- **Should `expo` be split into smaller, more focused modules?**
  _Cohesion score 0.05405405405405406 - nodes in this community are weakly interconnected._