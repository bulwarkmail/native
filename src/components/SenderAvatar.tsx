import React from 'react';
import { View, Text, Image, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import {
  avatarContent,
  generateEmailAvatarColor,
  getContactPhotoForEmail,
  getEmailInitials,
  getFaviconDomain,
  getFaviconUrl,
  hasFaviconFailed,
  markFaviconFailed,
} from '../lib/avatar-utils';
import type { ContactPhotoRef } from '../lib/contact-utils';
import { useContactPhotoSource } from '../lib/use-contact-photo';
import { useSettingsStore } from '../stores/settings-store';
import { useContactsStore } from '../stores/contacts-store';
import { useColors } from '../theme/colors';
import { ShieldAlert } from './icons';

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
  /**
   * The photo of the contact this avatar stands for (see getContactPhotoRef).
   * Left undefined, the address is looked up among the contacts; null means
   * the contact has no photo, so no other card's photo is borrowed.
   */
  photo?: ContactPhotoRef | null;
  /**
   * The message's sender check failed or is unverified (see
   * useSenderWarning): a warning shield with this label instead of any photo,
   * favicon or initials, so a forged From doesn't get the real sender's logo
   * or photo (webmail #1439).
   */
  senderWarning?: string | null;
}

// Mirrors the webmail `Avatar` priority for the subset available on native:
// sender warning → address-book photo → company favicon (if sender domain is
// non-personal and `senderFavicons` is on) → initials over HSL-hashed color.
export default function SenderAvatar({ name, email, size = 40, style, disableImages, photo, senderWarning }: SenderAvatarProps) {
  const c = useColors();
  const warned = !!senderWarning;
  const senderFavicons = useSettingsStore((s) => s.senderFavicons) && !disableImages && !warned;
  // Compared shallowly, so only avatars whose photo changed re-render when the
  // contacts change; the index behind it is built once per contacts array.
  const indexedPhoto = useContactsStore(
    useShallow((s) => (photo === undefined && !warned ? getContactPhotoForEmail(s.contacts, email) : undefined)),
  );
  const contactPhoto = photo === undefined ? indexedPhoto : photo;
  // A blob photo (Stalwart 1.0) has no source while it waits for its
  // download or after it failed; the favicon or initials show meanwhile.
  const { source: photoSource, onLoad: onPhotoLoad, onError: onPhotoError } =
    useContactPhotoSource(disableImages || warned ? null : contactPhoto);
  const [imgError, setImgError] = React.useState(false);

  React.useEffect(() => {
    setImgError(false);
  }, [email]);

  const primaryName = (name ?? '').split(',')[0].trim();
  const initials = getEmailInitials(primaryName, email ?? undefined);
  const bgColor = generateEmailAvatarColor(primaryName, email ?? undefined);

  const faviconDomain = getFaviconDomain(email ?? undefined);
  const domainFailed = faviconDomain ? hasFaviconFailed(faviconDomain) : false;
  const content = avatarContent({
    senderWarning,
    hasPhoto: !disableImages && !!photoSource,
    showFavicon: senderFavicons && !!faviconDomain && !imgError && !domainFailed,
  });

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
      backgroundColor: content === 'warning'
        ? c.errorBg
        : content === 'photo' ? 'transparent' : content === 'favicon' ? '#ffffff' : bgColor,
    },
    style,
  ];

  const fontSize = Math.round(size * 0.4);

  if (content === 'warning') {
    return (
      <View
        style={containerStyle}
        accessible
        accessibilityLabel={`${primaryName || email || ''} (${senderWarning})`}
        testID="sender-warning-avatar"
      >
        <ShieldAlert size={Math.round(size * 0.5)} color={c.error} />
      </View>
    );
  }

  if (content === 'photo' && photoSource) {
    return (
      <View style={containerStyle}>
        <Image
          source={photoSource}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          resizeMode="cover"
          onLoad={onPhotoLoad}
          onError={onPhotoError}
        />
      </View>
    );
  }

  if (content === 'favicon' && faviconDomain) {
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
