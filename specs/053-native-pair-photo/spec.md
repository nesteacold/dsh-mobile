# Spec 053 — Pair screen back label and QR from image

Owner requests: replace native navigation '< (tabs)' with localized '< Back'; add QR scanning from photo library alongside camera.

## Requirements
- Set explicit localized headerBackTitle on the pair route, using existing Back/Quay lại translation or a new en/vi key. Do not expose Expo Router group '(tabs)'. Preserve title and navigation behavior.
- Add visible native action 'Choose QR image' / 'Chọn ảnh QR', accessible >=44pt target, available even if camera permission denied. Use a system image-library picker; if existing document picker only exposes Files, do not label it photo library. A new expo-image-picker dependency needs lead approval before install.
- Decode locally with installed expo-camera scanFromURLAsync(uri,['qr']) (verified build/index.d.ts:47-56 supports iOS QR and Android). Never send images or decoded pairing payload to remote services or logs.
- Feed decoded data through existing submit/classification/pin validation path unchanged. No native OTP acceptance, TLS bypass or automatic scope changes. Preserve Host approval behavior.
- Handle cancel silently, denied permission with localized feedback, no QR with localized feedback, decoder errors, multiple distinct QR candidates with a deterministic refusal/choice (never pair arbitrarily). Single-flight guard prevents overlapping camera/photo submissions. Discard stale completion on unmount or newer attempt.
- En/vi complete; stable testID pair-image-picker and localized accessibilityLabel. Add Node source/pure tests for back label, local decode, error/cancel/multiple handling and unchanged validation route. Existing camera/paste tests remain.

## Scope/process
Apps/mobile-companion only, preserve dirty hunks, no commit/push/store upload without explicit request. Lead owns spec; coder implements; reviewer reviews. No DSH core or gateway changes. No camera permission requirement merely to read a selected image. No broad photo-library access when platform picker suffices.

## Verification
App gates: typecheck, check:core, check-flows and full unit suite; repo verify-publish and scan-pii. Native validation: generated non-secret QR image selected from simulator library decodes; no-QR feedback; existing back button says Back/Quay lại. Screenshots must not expose live pairing secrets. Distinguish tested source from native behavior.

## Dependency decision
Lead approved `expo-image-picker@58.0.10` (MIT, SDK58 line; npm metadata checked 2026-11-19) for a genuine Photos-library picker. Existing expo-document-picker opens Files and is not a substitute for the owner's library request. Use launchImageLibraryAsync with images only and no editing; request only platform-required permissions, never broad access unnecessarily.

Status: specified, implementation authorized; no commit/push/upload authorized in this slice.
