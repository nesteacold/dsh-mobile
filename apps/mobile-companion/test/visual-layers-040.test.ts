// Spec 040 — source guards for the three visual layers. There is no component renderer in this
// repo (see test/ui-test-hooks.test.ts), so these assertions read the sources directly: the mesh is
// mounted behind the shell and cannot take touches, both colour schemes have a readable palette,
// screen roots are transparent so the mesh is actually visible, the glass seam still uses real blur,
// and every newly introduced SVG icon is sized and labelled.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readApp = (relative: string): string => readFileSync(path.join(APP, relative), 'utf8');

/** WCAG contrast from source hex literals; keeps the guard source-based (no renderer/module import). */
function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const LAYOUT = readApp('app/_layout.tsx');
const TAB_LAYOUT = readApp('app/(tabs)/_layout.tsx');
const MESH = readApp('src/ui/components/ocean-mesh.tsx');
const THEME = readApp('src/ui/theme.ts');
const UI = readApp('src/ui/components/ui.tsx');
const HOME = readApp('app/(tabs)/index.tsx');
const SESSION = readApp('app/session/[id].tsx');
const SETTINGS = readApp('app/settings.tsx');

describe('spec 040 — ocean mesh', () => {
  it('is mounted behind the app shell through a non-interactive absolute view', () => {
    assert.match(LAYOUT, /import OceanMesh from '\.\.\/src\/ui\/components\/ocean-mesh'/);
    assert.match(
      LAYOUT,
      /<View style=\{StyleSheet\.absoluteFill\} pointerEvents="none">\s*<OceanMesh \/>\s*<\/View>/,
    );
    // Inside ThemeProvider (so useTheme() sees the real device scheme), but before the gate/Stack.
    assert.ok(LAYOUT.indexOf('<ThemeProvider') < LAYOUT.indexOf('<OceanMesh />'));
    assert.ok(LAYOUT.indexOf('<OceanMesh />') < LAYOUT.indexOf('<Stack'));
  });

  it('has a reduced-motion branch and no reanimated dependency', () => {
    assert.match(MESH, /AccessibilityInfo\.isReduceMotionEnabled\(\)/);
    assert.match(MESH, /reduceMotionChanged/);
    assert.match(MESH, /if \(reduceMotion\)/);
    assert.match(MESH, /Animated\.loop\(/);
    assert.equal(/from\s+['"]react-native-reanimated['"]/.test(MESH), false);
  });

  it('uses a navy palette in dark and a clearly visible paper/mist palette in light', () => {
    assert.match(MESH, /import \{ brand, useTheme \} from '\.\.\/theme'/);
    assert.match(MESH, /const \{ scheme \} = useTheme\(\)/);
    assert.match(MESH, /const dark = scheme === 'dark'/);
    // Dark is unchanged.
    assert.match(MESH, /stopColor=\{dark \? '#07182B' : brand\.paper\}/);
    assert.match(MESH, /stopColor=\{dark \? '#0B2545' : LIGHT_MIST\}/);
    assert.match(MESH, /const DARK_GRID_LINE = 'rgba\(255, 255, 255, 0\.043\)'/);
    assert.match(MESH, /const DARK_DOT_FILL = 'rgba\(255, 255, 255, 0\.085\)'/);
    // Light is strong enough to survive a light screen.
    assert.match(MESH, /const LIGHT_MIST = '#8FB6F5'/);
    assert.match(MESH, /const LIGHT_GRID_LINE = 'rgba\(6, 23, 43, 0\.14\)'/);
    assert.match(MESH, /const LIGHT_DOT_FILL = 'rgba\(46, 107, 230, 0\.28\)'/);
    assert.match(MESH, /const DOT_DARK = 2\.2/);
    assert.match(MESH, /const DOT_LIGHT = 3/);
    assert.match(MESH, /const dot = dark \? DOT_DARK : DOT_LIGHT/);
    assert.match(MESH, /width=\{dot\}/);
    assert.match(MESH, /height=\{dot\}/);
    assert.match(MESH, /id="ocean-mesh-wash"/);
    assert.match(MESH, /stopColor=\{brand\.navy\} stopOpacity=\{0\.1\}/);
    assert.match(MESH, /dark \? null : <Rect[^>]*fill="url\(#ocean-mesh-wash\)"/);
    // Geometry and drift still survive.
    assert.match(MESH, /const GRID = 42/);
    assert.match(MESH, /\(row \* 11 \+ column \* 7\) % 13/);
    assert.match(MESH, /Animated\.loop\(/);

    // Ink text stays far above WCAG AA on both light gradient stops.
    const ink = /ink: '(#[0-9A-Fa-f]{6})'/.exec(THEME)?.[1] ?? '';
    const paper = /paper: '(#[0-9A-Fa-f]{6})'/.exec(THEME)?.[1] ?? '';
    const mist = /const LIGHT_MIST = '(#[0-9A-Fa-f]{6})'/.exec(MESH)?.[1] ?? '';
    assert.ok(contrast(ink, paper) >= 4.5, `Ink on paper: ${contrast(ink, paper).toFixed(2)}:1`);
    assert.ok(contrast(ink, mist) >= 4.5, `Ink on ocean mist: ${contrast(ink, mist).toFixed(2)}:1`);
  });

  it('keeps the port free of any whale mark or mascot identifier', () => {
    assert.equal(/whale/i.test(MESH), false, 'the mesh source contains no whale identifier');
  });
});

describe('spec 040 revision — visible through screen roots', () => {
  it('defines one transparent screen-root token and keeps the opaque bg token', () => {
    assert.match(THEME, /readonly bg: string/);
    assert.match(THEME, /readonly screenBackground: string/);
    assert.equal([...THEME.matchAll(/screenBackground: 'transparent'/g)].length, 2, 'both palettes');
    assert.equal([...THEME.matchAll(/bg: brand\.paper|bg: '#090D13'/g)].length, 2, 'both opaque bg tokens remain');
  });

  it('uses the transparent token on every app screen root', () => {
    assert.match(LAYOUT, /headerStyle: \{ backgroundColor: palette\.screenBackground \}/);
    assert.match(LAYOUT, /contentStyle: \{ backgroundColor: palette\.screenBackground \}/);
    assert.match(TAB_LAYOUT, /contentStyle: \{ backgroundColor: colors\.screenBackground \}/);
    assert.match(HOME, /testID="workspace-home" style=\{\[styles\.root, \{\s*position: 'relative', backgroundColor: colors\.screenBackground/);
    assert.match(HOME, /paddingBottom: composerHeight,\s*backgroundColor: colors\.screenBackground/);
    assert.match(SESSION, /style=\{\[styles\.container, \{ position: 'relative', backgroundColor: colors\.screenBackground \}\]\}/);
    assert.match(SETTINGS, /<Screen scroll testID="settings-screen">/, 'settings uses the shared transparent Screen');
    assert.equal([...UI.matchAll(/backgroundColor: colors\.screenBackground/g)].length, 2, 'Screen scroll + plain roots');
  });

  it('renders MeshBackdrop as the first child of every screen root', () => {
    assert.match(MESH, /export function MeshBackdrop\(\)/);
    assert.match(
      MESH,
      /<View style=\{StyleSheet\.absoluteFill\} pointerEvents="none">\s*<OceanMesh \/>\s*<\/View>/,
    );
    assert.match(HOME, /import \{ MeshBackdrop \} from '\.\.\/\.\.\/src\/ui\/components\/ocean-mesh'/);
    assert.match(HOME, /testID="workspace-home"[^>]*>\s*<MeshBackdrop \/>/);
    assert.match(SESSION, /import \{ MeshBackdrop \} from '\.\.\/\.\.\/src\/ui\/components\/ocean-mesh'/);
    assert.match(SESSION, /behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}\s*>\s*<MeshBackdrop \/>/);
    assert.match(UI, /import \{ MeshBackdrop \} from '\.\/ocean-mesh'/);
    assert.match(UI, /<ScrollView[\s\S]*?>\s*<MeshBackdrop \/>/);
    assert.match(UI, /<View testID=\{props\.testID\}[\s\S]*?>\s*<MeshBackdrop \/>/);
    assert.match(UI, /screen: \{ flex: 1, position: 'relative' \}/);
  });

  it('keeps the gate, sheets and modals opaque', () => {
    assert.match(LAYOUT, /styles\.gate, \{ backgroundColor: palette\.bg \}/);
    assert.match(LAYOUT, /styles\.overlay, \{ backgroundColor: palette\.bg \}/);
    assert.match(SESSION, /styles\.teamScreen, \{ backgroundColor: colors\.bg \}/);
  });
});

describe('spec 040 — liquid glass', () => {
  it('activates GlassSurface with expo-blur and keeps its props', () => {
    assert.match(UI, /import \{ BlurView \} from 'expo-blur'/);
    const body = UI.slice(UI.indexOf('export function GlassSurface'));
    assert.match(body, /<BlurView[\s\S]*?intensity=\{10\}[\s\S]*?tint=\{scheme === 'dark' \? 'dark' : 'light'\}/);
    assert.match(body, /colors\.glass/);
    assert.match(body, /colors\.glassHighlight/);
    assert.match(body, /elevation\(colors, 'bar'\)/);
    assert.match(body, /<BlurView[\s\S]*?\{props\.children\}[\s\S]*?<\/BlurView>/, 'children are still rendered');
  });

  it('uses the glass seam for cards and both composers', () => {
    assert.match(UI, /<GlassSurface style=\{surface\}>/, 'cards use the seam');
    assert.match(HOME, /<GlassSurface style=\{\[styles\.composer, \{ borderRadius: radius\.pill \}\]\}>/);
    assert.match(SESSION, /<GlassSurface\s+style=\{\[\s*styles\.composer,/);
  });
});

describe('spec 040 — vector icons', () => {
  // Aliases are included because settings.tsx imports `Settings as SettingsIcon`.
  const ICONS = [
    'ArrowUp', 'Check', 'ChevronDown', 'ChevronLeft', 'ChevronRight', 'ChevronUp',
    'Ellipsis', 'Folder', 'LayoutGrid', 'Monitor', 'Plus', 'RotateCcw', 'Search',
    'Settings', 'SettingsIcon', 'ShieldCheck', 'X',
  ];
  const SOURCES: Record<string, string> = {
    'app/(tabs)/index.tsx': HOME,
    'app/session/[id].tsx': SESSION,
    'app/settings.tsx': SETTINGS,
  };

  it('gives every new icon an explicit accessibilityLabel and a >= 20pt size', () => {
    const tag = new RegExp(`<(${ICONS.join('|')})\\b([\\s\\S]*?)/>`, 'g');
    let found = 0;
    for (const [file, source] of Object.entries(SOURCES)) {
      for (const match of source.matchAll(tag)) {
        found += 1;
        const whole = match[0];
        const name = match[1] ?? 'icon';
        const attrs = match[2] ?? '';
        assert.match(attrs, /accessibilityLabel=/, `${file}: <${name}> needs an accessibilityLabel`);
        const size = /size=\{(\d+)\}/.exec(attrs);
        const pointSize = size?.[1];
        assert.ok(pointSize !== undefined, `${file}: <${name}> needs an explicit size`);
        assert.ok(Number(pointSize) >= 20, `${file}: <${name}> is smaller than 20pt`);
        assert.ok(whole.includes(`<${name}`));
      }
    }
    assert.ok(found >= 20, `expected the icon rollout to be present, found ${found} icon tags`);
  });
});
