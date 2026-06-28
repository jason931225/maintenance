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
  const uri = sourceUri(source);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) {
      video.pause();
      return;
    }
    void video.play().catch(() => {
      // Autoplay can still be denied by a browser policy; the poster/background remains visible.
    });
  }, [paused, uri]);

  return React.createElement('video', {
    ref: videoRef,
    'aria-label': accessibilityLabel,
    autoPlay: !paused,
    controls,
    loop: repeat,
    muted,
    playsInline: true,
    preload: 'auto',
    src: uri,
    style: {
      ...flattenedStyle,
      ...(fillParent ? { width: '100%', height: '100%' } : null),
      objectFit,
      pointerEvents: 'none',
    },
  });
}
