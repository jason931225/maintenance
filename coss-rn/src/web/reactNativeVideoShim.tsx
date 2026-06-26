import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

type VideoSource = { uri?: string } | number | string | undefined;

type VideoProps = {
  accessibilityLabel?: string;
  controls?: boolean;
  muted?: boolean;
  paused?: boolean;
  repeat?: boolean;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'none';
  source?: VideoSource;
  style?: StyleProp<ViewStyle>;
};

function sourceUri(source: VideoSource) {
  if (!source) return undefined;
  if (typeof source === 'string') return source;
  if (typeof source === 'object' && 'uri' in source) return source.uri;
  return undefined;
}

export default function Video({
  accessibilityLabel,
  controls = false,
  muted = false,
  paused = false,
  repeat = false,
  resizeMode = 'cover',
  source,
  style,
}: VideoProps) {
  const flattenedStyle = StyleSheet.flatten(style) as React.CSSProperties;
  const objectFit =
    resizeMode === 'stretch'
      ? 'fill'
      : resizeMode === 'none'
        ? 'none'
        : resizeMode;
  const fillParent =
    flattenedStyle.position === 'absolute' &&
    flattenedStyle.width === undefined &&
    flattenedStyle.height === undefined;

  return React.createElement('video', {
    'aria-label': accessibilityLabel,
    autoPlay: !paused,
    controls,
    loop: repeat,
    muted,
    playsInline: true,
    src: sourceUri(source),
    style: {
      ...flattenedStyle,
      ...(fillParent ? { width: '100%', height: '100%' } : null),
      objectFit,
      pointerEvents: 'none',
    },
  });
}
