/**
 * A QR code, drawn as one SVG path.
 *
 * One path rather than a rectangle per module: a pairing payload runs to about
 * 130 characters, which is a 41×41 grid — 1681 elements if each dark module
 * were its own node. As path segments it stays a single draw.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import qrcode from 'qrcode-generator';

import { useTheme } from './theme';

/**
 * Build the path data for the dark modules.
 *
 * Coordinates are in module units; the viewBox scales them, so the same path
 * works at any rendered size.
 */
/**
 * Error correction is a density trade-off worth knowing about.
 *
 * A pairing payload is around 120 characters, which at level M is a 45×45
 * grid; level L would be 41×41 and thus roughly 10% larger modules. M is kept
 * because the code is read off a glossy screen, where glare and a tilted
 * camera cost more than the extra density does. Dropping `exp` from the
 * payload would buy a version too, at the price of a worse message when
 * someone scans a code that has already died.
 */
export function qrPath(text: string, errorCorrection: 'L' | 'M' | 'Q' | 'H' = 'M') {
  // Type 0 lets the library pick the smallest version that fits.
  const qr = qrcode(0, errorCorrection);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const segments: string[] = [];

  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) segments.push(`M${column} ${row}h1v1h-1z`);
    }
  }

  return { d: segments.join(''), count };
}

export function QrCode({
  value,
  size = 240,
  /** Quiet zone in modules. Four is what the spec asks for; scanners rely on it. */
  quietZone = 4,
}: {
  value: string;
  size?: number;
  quietZone?: number;
}) {
  const theme = useTheme();
  const { d, count } = useMemo(() => qrPath(value), [value]);
  const span = count + quietZone * 2;

  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${span} ${span}`}>
        {/* Always light-on-dark-modules, never themed: a scanner needs the
            contrast in that direction, and an inverted code does not read. */}
        <Rect x={0} y={0} width={span} height={span} fill="#ffffff" />
        <Path d={d} fill="#000000" transform={`translate(${quietZone} ${quietZone})`} />
      </Svg>
      {/* A hairline so a white code stays visible on a white surface. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderWidth: 1,
          borderColor: theme.border,
        }}
      />
    </View>
  );
}
