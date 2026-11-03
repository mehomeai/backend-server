# Mobile SDK type verification (B6, bounded, read-only)

Date: 2026-11-03 (resumed pass; root freed ~150 MiB, free ~390 MiB).
Source repos unchanged; this file is the only repo write. No app
`node_modules`, no Downloads, no global-cache changes, no installs, no
postinstall scripts. Expo SDK58 / RN0.88 / React19.3 pins preserved;
no version upgrades to quiet errors. Only public package names/versions
leave the repo (registry metadata); no source, no private user info.

Stability: F8 owner edited mid-pass (`DevicePanel`, `_layout`,
`NotificationGate`, `MeContext`, `home-client`, `notifications.ts`,
`TaskPanel`, `artifact-store`). Final `tsc` ran on a quiet window:
34 `.ts`/`.tsx` files, newest mtime `lib/notifications.ts`
1793707759 identical BEFORE and AFTER `tsc` (~4 min quiet).
Rerun after further F8 fixes with the repeat commands below.

Current app deps verified (from `phone-app/apps/mobile/package.json`):
new F8 `expo-notifications ~58.0.11` (→ 58.0.11) and
`expo-device ~58.0.1` (→ 58.0.1) included; rest per earlier pins.

## Method (types-only mirror, not a runtime install)

- Temp mirror: `/private/tmp/me-mobile-types-20261103/node_modules`
  (verification artifact only; never claims an Expo build).
- Helper: `/private/tmp/me-mobile-types-20261103/fetch-types.py`
  (stdlib `urllib`+`tarfile` streaming `r|gz`, no cached whole archives).
  Extracts ONLY `package.json`/`tsconfig*.json`/`.d.ts`/`.d.mts`/`.d.cts`
  PLUS small bounded `.ts`/`.tsx` source entries under `src/`/`build/`
  when package `exports` (`react-native`/`expo-source` conditions) point
  at TS source (e.g. `expo-modules-core` `src/*.ts`,
  `expo-image` `src/`); skips fonts/images/native binaries/JS execution.
  Every wire archive hash-checked against registry `dist.integrity`
  (sha512). `expo-image` 50 MB wire / `expo-video` 11 MB wire /
  `expo-modules-core` 34 MB wire all streamed, kept ~35–206 KiB each.
- Resolution: exact declared pins verbatim (`~`/`^` stripped to `x.y.z`);
  ranges via real global-npm semver
  (`.../npm/node_modules/semver`, `maxSatisfying`); actual dependency
  versions (e.g. `expo` → `expo-modules-core ~58.0.23`,
  `@tanstack/react-query` → `@tanstack/query-core 5.105.3`,
  `@playwright/test` → `playwright 1.64.1` → `playwright-core 1.64.1`).
  Types unmodified.
- Temp tsconfig: `/private/tmp/me-mobile-types-20261103/tsconfig.verify.json`
  extends ACTUAL `expo/tsconfig.base.json` (`jsx: react-jsx`,
  `preserve`/`bundler`, `customConditions: [react-native]`,
  `lib: [DOM, ESNext]`, `skipLibCheck: true`), `paths: @/*`,
  file-level paths per package `types`/`exports` entry
  (`react-native → types_generated/index.d.ts`,
  `expo → build/Expo.d.ts`, `expo-router → build/index.d.ts`,
  `expo-router/native-tabs → build/native-tabs/index.d.ts`,
  `react-query → build/modern/index.d.ts`, `playwright/test`,
  `playwright-core`), `ignoreDeprecations: 6.0`. No fake `any` stubs.
- Compiler: `/Users/kgensupertramp/.tscheck-tmp/ts-pkg/lib/tsc.js`
  (TS 6.0.3), Node 24.18.0.
- Repeat: `python3 /private/tmp/me-mobile-types-20261103/fetch-types.py
  --pkg "expo@58.0.16" [...]` (or `--from-package-json
  phone-app/apps/mobile/package.json`), then `node .../tsc.js -p
  /private/tmp/me-mobile-types-20261103/tsconfig.verify.json --noEmit`.
  Full log: `/private/tmp/me-mobile-types-20261103/tsc-full.log` (4 lines,
  exit 2). Manifest: `/private/tmp/me-mobile-types-20261103/manifest.json`
  (49 packages). Prior partial log kept as `tsc-partial.log` (89 lines).

## Budget

Floor 250 MiB free enforced; max extra 100 MiB kept. Final: 49 packages,
~9.6 MB kept (manifest `keptBytes` sum), 19 MB on disk incl. logs,
free 390 MiB. Earlier 6-package 1.6 MB reuse verified; `expo-router`
floor-abort then succeeded after space freed. Full SDK graph COMPLETE
for all app imports (no TS2307/TS2305 remaining).

Coverage includes: `expo@58.0.16`, `expo-modules-core@58.0.23`,
`expo-router@58.0.24` (+`native-tabs`), `expo-constants@58.0.12`,
`expo-device@58.0.1`, `expo-notifications@58.0.11`, `expo-asset@58.0.17`,
all other `expo-*` in app deps (blur/crypto/file-system/font/
glass-effect/haptics/image/image-picker/linear-gradient/linking/location/
secure-store/sharing/splash-screen/status-bar/symbols/system-ui/video/
web-browser/auth-session), `react@19.3.0` (+`@types/react@19.3.0`,
`react-dom@19.3.0`/`@types/react-dom@19.2.3`), `react-native@0.88.0`,
`safe-area-context@5.10.1`, `screens@4.30.0`, `svg@15.16.0`,
`gesture-handler@3.3.0`, `keyboard-controller@1.22.7`,
`reanimated@4.7.1`, `worklets@0.13.0`, `async-storage@2.2.0`,
`@tanstack/react-query@5.105.3`+`query-core@5.105.3`,
`@expo/vector-icons@15.0.2`, `@expo-google-fonts/geist@0.4.2`/
`geist-mono@0.4.3`, `@playwright/test@1.64.1`+`playwright@1.64.1`+
`playwright-core@1.64.1` (types-only, no browsers).
Typeless-but-unreferenced: `react-native-web` (no `types` field, no app
diagnostic). `@types` nested `react/` layout preserved verbatim with
file-level paths.

## Results: full `tsc --noEmit`, 4 errors (all real strict `noImplicitAny`)

- `app/(tabs)/chats.tsx:184` TS7031 `({ item })` — `FlatList`
  `data={conversations}` without generic; annotate or
  `FlatList<Conversation>`.
- `app/(tabs)/feed.tsx:76` TS7031 `({ item, index })` — same FlatList
  generic missing.
- `components/ChatComposer.tsx:174` TS7031 `({ item })` —
  `renderItem={({ item }) => <Bubble m={item} />}` without generic.
- Playwright spec fully resolves now (`Page` via `playwright-core`);
  no spec errors. No test exclusion needed (app `tsconfig.include`
  covers `tests/`, and types are real).

## Earlier 27 partial diagnostics: triage (do not treat as all-real)

- F8 owner FIXED during this pass (verified in current source, gone from
  full log): `artifact-store` re-exports `canPreviewInline`/
  `isPreviewableImage`/`isPreviewableText` (re-exported from portable
  `src/artifact-cache.ts`); `home-client` re-exports `randomUuidV4`
  (from portable `src/index.ts`); `TaskPanel:230` now passes
  `(task.id, qid, text)`; `stopPollersFor` moved above first use
  (decl :853, uses :978+); `MeContext:1452` optional-assign gone.
- FALSE POSITIVE from partial mapping, now resolved: `ErrorFallback`
  `reloadAppAsync from 'expo'` — real `expo@58.0.16`
  `build/Expo.d.ts:5` re-exports it from `expo-modules-core`
  (partial pass mapped `expo` to `types/index.d.ts` + lacked
  `expo-modules-core`; full graph resolves clean).
- CASCADING (missing-SDK) then, gone now: `_layout color/focused`,
  `feed videoPlayer/status/error/playing`, `me`/`browser`/`DevicePanel`/
  `ui` presseds, `MeContext next`, `TaskPanel text`, `SettingsPanel v`,
  etc. — all resolved once real RN/Expo types present. Earlier
  local-only reads (e.g. "home-client exports only X") missed
  `export { ... } from '../../../src/index.ts'` re-export blocks.
- Remaining 4 above are the only firm actionables; all in list screens
  (`chats`, `feed` prototype surfaces + `ChatComposer`).

## Pass limits

No application fixes applied (F8 active); no CI/package edits.
B5 `framework-support-review.md` untouched. Not a native-bundle/runtime
proof. To rerun after F8 fixes: confirm quiet `stat -f '%m'`
(max mtime stable), rerun the two repeat commands, expect exit 2 with
only the listed lines until annotated.
