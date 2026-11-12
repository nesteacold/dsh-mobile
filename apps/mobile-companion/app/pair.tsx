// A021 — pair screen (US1). The UI and its rules live in `src/ui/pair-panel.tsx`, because the web
// bootstrap of the root layout renders the same panel before any route mounts; this file only wires
// it to the router on a successful pairing.

import { useRouter } from 'expo-router';

import { PairPanel } from '../src/ui/pair-panel';
import { useApp } from './_layout';

export default function PairScreen() {
  const { controller, snapshot, tr } = useApp();
  const router = useRouter();
  return (
    <PairPanel
      controller={controller}
      snapshot={snapshot}
      tr={tr}
      onPaired={() => router.replace('/')}
    />
  );
}
