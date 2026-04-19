import React from 'react';
import { View, Text, Image, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import {
  generateEmailAvatarColor,
  getEmailInitials,
  getFaviconDomain,
  getFaviconUrl,
  hasFaviconFailed,
  markFaviconFailed,
} from '../lib/avatar-utils';
import { useSettingsStore } from '../stores/settings-store';

interface SenderAvatarProps {
  name?: string | null;
  email?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

// Mirrors the webmail `Avatar` priority for the subset available on native:
// company favicon (if sender domain is non-personal and `senderFavicons` is on)
// → initials over HSL-hashed color.
export default function SenderAvatar({ name, email, size = 40, style }: SenderAvatarProps) {
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const [imgError, setImgError] = React.useState(false);

  React.useEffect(() => {
    setImgError(false);
  }, [email]);

  const primaryName = (name ?? '').split(',')[0].trim();
  const initials = getEmailInitials(primaryName, email ?? undefined);
  const bgColor = generateEmailAvatarColor(primaryName, email ?? undefined);

  const faviconDomain = getFaviconDomain(email ?? undefined);
  const domainFailed = faviconDomain ? hasFaviconFailed(faviconDomain) : false;
  const showFavicon = senderFavicons && !!faviconDomain && !imgError && !domainFailed;

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
      backgroundColor: showFavicon ? '#ffffff' : bgColor,
    },
    style,
  ];

  const fontSize = Math.round(size * 0.4);

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
