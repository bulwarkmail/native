// Building blocks shared by the widget layouts. They mirror the webmail pieces
// the mockups copied: list rows, avatars, pills, event chips, buttons.
// react-native-android-widget turns these into RemoteViews, so only its own
// components (FlexWidget, TextWidget, SvgWidget, OverlapWidget) can appear.

import React from 'react';
import {
  FlexWidget,
  OverlapWidget,
  SvgWidget,
  TextWidget,
  type ColorProp,
  type FlexWidgetStyle,
  type TextWidgetStyle,
} from 'react-native-android-widget';
import { chipBackground, normalizeHex, type WidgetPalette } from './theme';
import { filledIcon, icon, type FilledIconName, type IconName } from './icons';
import type { WidgetClick } from './clicks';

/** Corner radius of the widget surface; launchers clip to roughly this on Android 12+. */
export const WIDGET_RADIUS = 22;

export function Surface({
  p,
  children,
  style,
  click,
}: {
  p: WidgetPalette;
  children?: React.ReactNode;
  style?: FlexWidgetStyle;
  click?: WidgetClick;
}) {
  return (
    <FlexWidget
      {...click}
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: p.bg,
        borderRadius: WIDGET_RADIUS,
        borderWidth: 1,
        borderColor: p.frame,
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </FlexWidget>
  );
}

export function Txt({
  text,
  color,
  size = 14,
  weight = '400',
  lines = 1,
  style,
  click,
}: {
  text: string;
  color: ColorProp;
  size?: number;
  weight?: TextWidgetStyle['fontWeight'];
  lines?: number;
  style?: TextWidgetStyle;
  click?: WidgetClick;
}) {
  return (
    <TextWidget
      {...click}
      text={text}
      maxLines={lines}
      truncate="END"
      style={{ color, fontSize: size, fontWeight: weight, ...style }}
    />
  );
}

export function Icon({
  name,
  color,
  size = 16,
  style,
  click,
}: {
  name: IconName;
  color: string;
  size?: number;
  style?: FlexWidgetStyle;
  click?: WidgetClick;
}) {
  return <SvgWidget {...click} svg={icon(name, color)} style={{ width: size, height: size, ...style }} />;
}

export function FilledIcon({ name, color, size = 14 }: { name: FilledIconName; color: string; size?: number }) {
  return <SvgWidget svg={filledIcon(name, color)} style={{ width: size, height: size }} />;
}

export function Spacer({ size, horizontal }: { size?: number; horizontal?: boolean }) {
  if (size === undefined) return <FlexWidget style={{ flex: 1 }} />;
  return <FlexWidget style={horizontal ? { width: size, height: 1 } : { height: size, width: 1 }} />;
}

export function Dot({ color, size = 8 }: { color: ColorProp; size?: number }) {
  return <FlexWidget style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Divider({ p }: { p: WidgetPalette }) {
  return <FlexWidget style={{ height: 1, width: 'match_parent', backgroundColor: p.border }} />;
}

/** Initials on the hashed avatar colour, as the webmail draws a sender without a photo. */
export function Avatar({
  initials,
  color,
  size = 32,
  ring,
}: {
  initials: string;
  color: string;
  size?: number;
  /** Draws a ring in this colour, for stacked avatars. */
  ring?: ColorProp;
}) {
  return (
    <FlexWidget
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: normalizeHex(color),
        justifyContent: 'center',
        alignItems: 'center',
        ...(ring ? { borderWidth: 2, borderColor: ring } : {}),
      }}
    >
      <TextWidget
        text={initials}
        allowFontScaling={false}
        style={{ color: '#ffffff', fontSize: Math.round(size * 0.38), fontWeight: '500' }}
      />
    </FlexWidget>
  );
}

/** `rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium` */
export function Pill({
  text,
  bg,
  color,
  size = 11,
}: {
  text: string;
  bg: ColorProp;
  color: ColorProp;
  size?: number;
}) {
  return (
    <FlexWidget style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <TextWidget text={text} maxLines={1} style={{ color, fontSize: size, fontWeight: '500' }} />
    </FlexWidget>
  );
}

/** Month/week-view event chip: calendar colour at ~14%, 3dp left edge, text in the colour. */
export function EventChip({
  title,
  time,
  color,
  height = 24,
  style,
  click,
}: {
  title: string;
  time?: string;
  color: string;
  height?: number;
  style?: FlexWidgetStyle;
  click?: WidgetClick;
}) {
  const hex = normalizeHex(color);
  return (
    <FlexWidget
      {...click}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height,
        width: 'match_parent',
        backgroundColor: chipBackground(hex),
        borderLeftWidth: 3,
        borderLeftColor: hex,
        borderRadius: 3,
        paddingLeft: 6,
        paddingRight: 4,
        ...style,
      }}
    >
      {time ? (
        <TextWidget text={`${time}  `} maxLines={1} style={{ color: `${hex}cc` as ColorProp, fontSize: 12, fontWeight: '500' }} />
      ) : null}
      <TextWidget text={title} maxLines={1} truncate="END" style={{ color: hex, fontSize: 12, fontWeight: '500' }} />
    </FlexWidget>
  );
}

/** The 4dp colour bar the agenda puts between the time and the title. */
export function ColorBar({ color, height = 36 }: { color: string; height?: number }) {
  return <FlexWidget style={{ width: 4, height, borderRadius: 2, backgroundColor: normalizeHex(color) }} />;
}

export function Button({
  p,
  label,
  iconName,
  variant = 'outline',
  click,
  height = 32,
  flex,
}: {
  p: WidgetPalette;
  label?: string;
  iconName?: IconName;
  variant?: 'primary' | 'outline';
  click?: WidgetClick;
  height?: number;
  flex?: number;
}) {
  const primary = variant === 'primary';
  const fg = primary ? p.primaryFg : p.fg;
  return (
    <FlexWidget
      {...click}
      style={{
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        height,
        ...(flex ? { flex } : { paddingHorizontal: label ? 12 : 0, width: label ? 'wrap_content' : height }),
        borderRadius: 6,
        backgroundColor: primary ? p.primary : p.bg,
        ...(primary ? {} : { borderWidth: 1, borderColor: p.input }),
      }}
    >
      {iconName ? <Icon name={iconName} color={fg} size={15} /> : null}
      {iconName && label ? <Spacer size={6} horizontal /> : null}
      {label ? <TextWidget text={label} maxLines={1} style={{ color: fg, fontSize: 13, fontWeight: '500' }} /> : null}
    </FlexWidget>
  );
}

/** Round primary action (compose, new event), the webmail's floating button. */
export function Fab({
  p,
  iconName,
  size = 32,
  click,
}: {
  p: WidgetPalette;
  iconName: IconName;
  size?: number;
  click?: WidgetClick;
}) {
  return (
    <FlexWidget
      {...click}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: p.primary,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Icon name={iconName} color={p.primaryFg} size={Math.round(size / 2)} />
    </FlexWidget>
  );
}

/** Icon-only ghost button (search in a header). */
export function GhostIcon({
  p,
  iconName,
  click,
  size = 32,
}: {
  p: WidgetPalette;
  iconName: IconName;
  click?: WidgetClick;
  size?: number;
}) {
  return (
    <FlexWidget {...click} style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <Icon name={iconName} color={p.muted} size={18} />
    </FlexWidget>
  );
}

/** Widget header bar: icon, title, optional count, trailing actions, bottom rule. */
export function Header({
  p,
  iconName,
  iconColor,
  title,
  count,
  trailing,
  height = 40,
  click,
}: {
  p: WidgetPalette;
  iconName?: IconName;
  iconColor?: string;
  title: string;
  count?: string;
  trailing?: React.ReactNode;
  height?: number;
  click?: WidgetClick;
}) {
  return (
    <FlexWidget style={{ width: 'match_parent' }}>
      <FlexWidget
        {...click}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          width: 'match_parent',
          height,
          paddingLeft: 14,
          paddingRight: 8,
        }}
      >
        {iconName ? <Icon name={iconName} color={iconColor ?? p.fg} size={16} /> : null}
        {iconName ? <Spacer size={8} horizontal /> : null}
        <Txt text={title} color={p.fg} size={14} weight="600" />
        {count ? <Spacer size={6} horizontal /> : null}
        {count ? <Txt text={count} color={p.muted} size={12} /> : null}
        <Spacer />
        {trailing}
      </FlexWidget>
      <Divider p={p} />
    </FlexWidget>
  );
}

/** Uppercase section label (`text-xs font-medium uppercase tracking-wider`). */
export function SectionLabel({ p, text }: { p: WidgetPalette; text: string }) {
  return (
    <TextWidget
      text={text.toUpperCase()}
      maxLines={1}
      style={{ color: p.muted, fontSize: 11, fontWeight: '500', letterSpacing: 0.05, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 }}
    />
  );
}

/** Centred message for empty, signed-out and error states. */
export function Placeholder({
  p,
  iconName,
  title,
  body,
  click,
}: {
  p: WidgetPalette;
  iconName: IconName;
  title: string;
  body?: string;
  click?: WidgetClick;
}) {
  return (
    <FlexWidget
      {...click}
      style={{ flex: 1, width: 'match_parent', justifyContent: 'center', alignItems: 'center', padding: 12 }}
    >
      <Icon name={iconName} color={p.muted} size={22} />
      <Spacer size={6} />
      <TextWidget text={title} maxLines={2} style={{ color: p.fg, fontSize: 13, fontWeight: '500', textAlign: 'center' }} />
      {body ? (
        <TextWidget text={body} maxLines={3} style={{ color: p.muted, fontSize: 12, textAlign: 'center', marginTop: 2 }} />
      ) : null}
    </FlexWidget>
  );
}

/** Wraps children so an absolutely placed dot/badge can sit on top (FrameLayout). */
export function Overlay({ children, style }: { children?: React.ReactNode; style?: FlexWidgetStyle }) {
  return <OverlapWidget style={style}>{children}</OverlapWidget>;
}
