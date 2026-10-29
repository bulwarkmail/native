import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export interface IconProps {
  size?: number;
  color?: string;
  /** Tabler draws at 2 on a 24 grid, like the webmail. */
  strokeWidth?: number;
  /** Fills the outline, for a starred star or a coloured tag. */
  fill?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export type AppIcon = React.ComponentType<IconProps>;

/** An icon component for one Tabler outline glyph (its path data). */
export function makeIcon(name: string, paths: readonly string[]): AppIcon {
  if (!paths?.length) throw new Error(`Icon ${name} has no glyph`);
  function Icon({ size = 24, color = '#000', strokeWidth = 2, fill = 'none', style, testID }: IconProps) {
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={style}
        testID={testID}
      >
        {paths.map((d, i) => <Path key={i} d={d} />)}
      </Svg>
    );
  }
  Icon.displayName = name;
  return React.memo(Icon);
}
