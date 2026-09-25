import React from 'react';
import { Image, type ImageStyle, type StyleProp } from 'react-native';
import type { ContactPhotoRef } from '../../lib/contact-utils';
import { useContactPhotoSource } from '../../lib/use-contact-photo';

interface ContactPhotoProps {
  photo: ContactPhotoRef;
  style: StyleProp<ImageStyle>;
  /**
   * Shown while a photo stored as a blob (Stalwart 1.0) waits for its
   * download, and when the photo can't be loaded.
   */
  fallback: React.ReactNode;
}

export default function ContactPhoto({ photo, style, fallback }: ContactPhotoProps) {
  const { source, onLoad, onError } = useContactPhotoSource(photo);
  if (!source) return <>{fallback}</>;
  return (
    <Image
      source={source}
      style={style}
      resizeMode="cover"
      onLoad={onLoad}
      onError={onError}
      accessibilityIgnoresInvertColors
    />
  );
}
