import React from 'react';
import { View, Text, Image, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import {
  generateEmailAvatarColor,
  getContactPhotoForEmail,
  getEmailInitials,
  getFaviconDomain,
  getFaviconUrl,
  hasFaviconFailed,
  markFaviconFailed,
} from '../lib/avatar-utils';
import { useSettingsStore } from '../stores/settings-store';
import { useContactsStore } from '../stores/contacts-store';

interface SenderAvatarProps {
  name?: string | null;
  email?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
  /**
   * Never show an image (contact photo or favicon) — initials only. The list
   * passes this inside Junk unless `showAvatarsInJunk` is on (webmail 1.5.1),
   * so a spam sender's domain is not contacted by merely listing the folder.
   */
  disableImages?: boolean;
}

// Mirrors the webmail `Avatar` priority for the subset available on native:
// address-book photo → company favicon (if sender domain is non-personal and
// `senderFavicons` is on) → initials over HSL-hashed color.
export default function SenderAvatar({ name, email, size = 40, style, disableImages }: SenderAvatarProps) {
  const senderFavicons = useSettingsStore((s) => s.senderFavicons) && !disableImages;
  // Selects a string, so only avatars whose photo changed re-render when the
  // contacts change; the index behind it is built once per contacts array.
  const contactPhoto = useContactsStore((s) => getContactPhotoForEmail(s.contacts, email));
  const [imgError, setImgError] = React.useState(false);
  const [photoError, setPhotoError] = React.useState(false);

  React.useEffect(() => {
    setImgError(false);
  }, [email]);

  React.useEffect(() => {
    setPhotoError(false);
  }, [contactPhoto]);

  const primaryName = (name ?? '').split(',')[0].trim();
  const initials = getEmailInitials(primaryName, email ?? undefined);
  const bgColor = generateEmailAvatarColor(primaryName, email ?? undefined);

  const faviconDomain = getFaviconDomain(email ?? undefined);
  const domainFailed = faviconDomain ? hasFaviconFailed(faviconDomain) : false;
  const showPhoto = !disableImages && !!contactPhoto && !photoError;
  const showFavicon = !showPhoto && senderFavicons && !!faviconDomain && !imgError && !domainFailed;

  const handleError = React.useCallback(() => {
    setImgError(true);
    if (faviconDomain) markFaviconFailed(faviconDomain);
  }, [faviconDomain]);

  const containerStyle = [
    styles.container,
    {
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: showPhoto ? 'transparent' : showFavicon ? '#ffffff' : bgColor,
    },
    style,
  ];

  const fontSize = Math.round(size * 0.4);

  if (showPhoto && contactPhoto) {
    return (
      <View style={containerStyle}>
        <Image
          source={{ uri: contactPhoto }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          resizeMode="cover"
          onError={() => setPhotoError(true)}
        />
      </View>
    );
  }

  if (showFavicon && faviconDomain) {
    return (
      <View style={containerStyle}>
        <Image
          source={{ uri: getFaviconUrl(faviconDomain) }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          resizeMode="cover"
          onError={handleError}
        />
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <Text style={[styles.initials, { fontSize }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
    elevation: 1,
  },
  initials: {
    fontWeight: '700',
    color: '#ffffff',
  },
});
