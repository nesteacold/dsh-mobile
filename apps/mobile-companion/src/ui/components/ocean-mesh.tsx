// Spec 040 — the ocean mesh backdrop, ported from Clarklevis1995/dsh-mobile (MIT):
// HarnessAnimatedBackground.kt and OceanMeshBackground.kt. Only the base gradient, technical grid,
// sparse squares and slow drift survive here; no mascot, mark or logo. Drawing is react-native-svg,
// motion is plain RN Animated (no reanimated native dependency).

import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Defs, LinearGradient, Path, Pattern, Rect, Svg, Stop } from 'react-native-svg';

import { brand, useTheme } from '../theme';

const GRID = 42;
const DOT_DARK = 2.2;
const DOT_LIGHT = 3;
// (row * 11 + col * 7) % 13 repeats every 13 rows, so a 13-cell drift loops seamlessly.
const DRIFT_ROWS = 13;
const DARK_GRID_LINE = 'rgba(255, 255, 255, 0.043)';
const DARK_DOT_FILL = 'rgba(255, 255, 255, 0.085)';
// Light scheme: paper -> stronger ocean mist, with navy/ocean detail that survives a light screen.
// Ink #0E131A measures >= 9:1 on both gradient stops, so text stays well above WCAG AA.
const LIGHT_MIST = '#8FB6F5';
const LIGHT_GRID_LINE = 'rgba(6, 23, 43, 0.14)';
const LIGHT_DOT_FILL = 'rgba(46, 107, 230, 0.28)';

/**
 * Screen-root host for the mesh. React Navigation's native stack card paints its own background,
 * so a root-level mesh alone stays hidden; mounting this FIRST inside each screen root keeps it
 * behind that screen's content without intercepting touches.
 */
export function MeshBackdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <OceanMesh />
    </View>
  );
}

/** Full-bleed, non-interactive mesh drawing. {@link MeshBackdrop} supplies screen positioning. */
export default function OceanMesh() {
  const { width, height } = useWindowDimensions();
  const { scheme } = useTheme();
  const dark = scheme === 'dark';
  const dot = dark ? DOT_DARK : DOT_LIGHT;
  // Start still: a device that asks for reduced motion never sees a frame of drift before the
  // asynchronous AccessibilityInfo answer arrives.
  const [reduceMotion, setReduceMotion] = useState(true);
  const drift = useMemo(() => new Animated.Value(0), []);

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (alive) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (alive) setReduceMotion(enabled);
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      drift.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(drift, {
        toValue: 1,
        duration: 24000,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [drift, reduceMotion]);

  const squares = useMemo(() => {
    const result: { key: string; x: number; y: number }[] = [];
    const columns = Math.ceil(width / GRID) + 1;
    const rows = Math.ceil(height / GRID) + DRIFT_ROWS + 2;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if ((row * 11 + column * 7) % 13 !== 0) continue;
        result.push({ key: `${row}:${column}`, x: column * GRID, y: row * GRID });
      }
    }
    return result;
  }, [width, height]);

  const translateY = drift.interpolate({ inputRange: [0, 1], outputRange: [0, -GRID * DRIFT_ROWS] });
  const opacity = drift.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.55, 1] });
  const driftHeight = height + GRID * DRIFT_ROWS;

  return (
    <>
      <Svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <LinearGradient id="ocean-mesh-base" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor={dark ? '#07182B' : brand.paper} />
            <Stop offset="100%" stopColor={dark ? '#0B2545' : LIGHT_MIST} />
          </LinearGradient>
          {/* Light only: a quiet navy wash at the top-left makes the gradient unmistakable without
              lifting text off the paper/mist base. The dark scheme keeps its navy gradient unchanged. */}
          <LinearGradient id="ocean-mesh-wash" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor={brand.navy} stopOpacity={0.1} />
            <Stop offset="65%" stopColor={brand.navy} stopOpacity={0} />
          </LinearGradient>
          <Pattern id="ocean-mesh-grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <Path
              d={`M ${GRID} 0 L 0 0 0 ${GRID}`}
              fill="none"
              stroke={dark ? DARK_GRID_LINE : LIGHT_GRID_LINE}
              strokeWidth={StyleSheet.hairlineWidth}
            />
          </Pattern>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill="url(#ocean-mesh-base)" />
        {dark ? null : <Rect x={0} y={0} width={width} height={height} fill="url(#ocean-mesh-wash)" />}
        <Rect x={0} y={0} width={width} height={height} fill="url(#ocean-mesh-grid)" />
      </Svg>
      <Animated.View
        pointerEvents="none"
        style={[styles.driftLayer, { opacity, transform: [{ translateY }] }]}
      >
        <Svg width={width} height={driftHeight} viewBox={`0 0 ${width} ${driftHeight}`}>
          {squares.map((square) => (
            <Rect
              key={square.key}
              x={square.x}
              y={square.y}
              width={dot}
              height={dot}
              fill={dark ? DARK_DOT_FILL : LIGHT_DOT_FILL}
            />
          ))}
        </Svg>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  driftLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' },
});
