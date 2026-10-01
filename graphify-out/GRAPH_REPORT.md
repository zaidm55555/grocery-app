# Graph Report - grocey app  (2026-10-01)

## Corpus Check
- 40 files · ~80,736 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: (none) 3, .css 1)

## Summary
- 352 nodes · 708 edges · 16 communities (12 shown, 4 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e6b839e0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.tsx
- cart.tsx
- expo
- SwiggyBridgeWebView.tsx
- dependencies
- package.json
- blinkitBridge.ts
- matcher.ts
- reset-project.js
- tsconfig.json
- scripts
- Expo HAS CHANGED
- rules/graphify.md
- api.ts
- workflows/graphify.md
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
- `SearchScreen()` --calls--> `getProductOverallMax()`  [EXTRACTED]
  src/app/(tabs)/index.tsx → src/services/api.ts
- `SearchScreen()` --calls--> `resolvePlatformProduct()`  [EXTRACTED]
  src/app/(tabs)/index.tsx → src/services/api.ts

## Import Cycles
- None detected.

## Communities (16 total, 4 thin omitted)

### Community 0 - "index.tsx"
Cohesion: 0.08
Nodes (54): expo-linear-gradient, expo-location, lucide-react-native, react, VariantRowItem, LogoTile(), ProductCard, ProductCardProps (+46 more)

### Community 1 - "cart.tsx"
Cohesion: 0.14
Nodes (28): @react-native-async-storage/async-storage, btoaUnicode(), CartScreen(), LogoTile(), s_row, styles, CartCalculation, getProductOverallMax() (+20 more)

### Community 2 - "expo"
Cohesion: 0.05
Nodes (36): backgroundColor, backgroundImage, foregroundImage, adaptiveIcon, icon, package, predictiveBackGestureEnabled, projectId (+28 more)

### Community 3 - "SwiggyBridgeWebView.tsx"
Cohesion: 0.14
Nodes (23): COPY, styles, SwiggyBridgeWebView(), BridgeResponse, dispatch(), handleSwiggyBridgeMessage(), handleSwiggyBridgeResponse(), Injector (+15 more)

### Community 4 - "dependencies"
Cohesion: 0.06
Nodes (32): dependencies, expo, expo-clipboard, expo-constants, expo-device, expo-font, @expo-google-fonts/inter, @expo-google-fonts/outfit (+24 more)

### Community 5 - "package.json"
Cohesion: 0.05
Nodes (42): { defineConfig }, expoConfig, devDependencies, eslint, eslint-config-expo, @expo/ngrok, @types/react, typescript (+34 more)

### Community 6 - "blinkitBridge.ts"
Cohesion: 0.12
Nodes (27): react-native, react-native-webview, buildSwiggyOpenCartScript(), styles, WebViewScreen(), BlinkitBridgeHandle, BlinkitBridgeWebView, styles (+19 more)

### Community 7 - "matcher.ts"
Cohesion: 0.24
Nodes (16): BestMatch, MatchableItem, matchScore(), nameSimilarity(), pickBestMatch(), priceSanity(), sizeScore(), tokenSet() (+8 more)

### Community 8 - "reset-project.js"
Cohesion: 0.14
Nodes (7): exampleDirPath, fs, oldDirs, path, readline, rl, root

### Community 9 - "tsconfig.json"
Cohesion: 0.25
Nodes (7): expo/tsconfig.base, compilerOptions, paths, strict, extends, include, @/assets/*

### Community 10 - "scripts"
Cohesion: 0.29
Nodes (7): scripts, android, ios, lint, reset-project, start, web

### Community 13 - "api.ts"
Cohesion: 0.12
Nodes (26): AddressCacheEntry, asNum(), BillFees, debugScanSwiggyStock(), walk(), deepSwiggyImage(), extractStockCount(), extractSwiggySearchProducts() (+18 more)

## Knowledge Gaps
- **153 isolated node(s):** `graphify`, `Workflow: graphify`, `graphify`, `StoreFilter`, `PlatformTheme` (+148 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 166 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `@react-native-async-storage/async-storage` connect `cart.tsx` to `index.tsx`, `api.ts`, `package.json`, `blinkitBridge.ts`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **Why does `react` connect `index.tsx` to `cart.tsx`, `SwiggyBridgeWebView.tsx`, `package.json`, `blinkitBridge.ts`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **What connects `graphify`, `Workflow: graphify`, `graphify` to the rest of the system?**
  _153 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.07837301587301587 - nodes in this community are weakly interconnected._
- **Should `cart.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13978494623655913 - nodes in this community are weakly interconnected._
- **Should `expo` be split into smaller, more focused modules?**
  _Cohesion score 0.05405405405405406 - nodes in this community are weakly interconnected._