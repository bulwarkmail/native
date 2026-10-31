import React from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { ClipboardPaste, QrCode, Mail, Plus, Server } from '../../components/icons';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors, useResolvedTheme } from '../../theme/colors';
import type { AccountEntry } from '../../stores/account-store';
import { getAccountInitials } from '../../lib/avatar-utils';
import { accountRowText, serverHostLabel } from '../../lib/account-utils';
import { accountServerLine } from '../../lib/account-labels';
import OptionTile from './OptionTile';
import LoginNotice from './LoginNotice';
import { useLocaleStore } from '../../stores/locale-store';

// The white mark disappears on the light palette, so pick per theme. `require`
// can't take an expression, hence the pair.
const LOGO_LIGHT = require('../../../assets/logos/Bulwark Logo Dark.png');
const LOGO_DARK = require('../../../assets/logos/Bulwark Logo White.png');

interface ChooseStepProps {
  isAddMode: boolean;
  accounts: AccountEntry[];
  /**
   * The servers of the signed-in accounts, the active one first, each
   * offered as a shortcut in add mode.
   */
  knownServerUrls: string[];
  onScan: () => void;
  /** Paste the sign-in link instead of scanning its code. */
  onPaste: () => void;
  onUseEmail: () => void;
  onUseKnownServer: (serverUrl: string) => void;
  onManualSetup: () => void;
  notice?: { title: string; detail?: string } | null;
  disabled?: boolean;
}

function initialsOf(account: AccountEntry): string {
  return getAccountInitials(account.displayName ?? '', account.email || account.username);
}

/**
 * The entry point. Leads with the two routes that don't require knowing a
 * server address; manual setup stays one tap away for people who do.
 */
export default function ChooseStep({
  isAddMode,
  accounts,
  knownServerUrls,
  onScan,
  onPaste,
  onUseEmail,
  onUseKnownServer,
  onManualSetup,
  notice,
  disabled = false,
}: ChooseStepProps) {
  const c = useColors();
  const theme = useResolvedTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const hasKnownServer = isAddMode && knownServerUrls.length > 0;

  // Sits right under the scan tile, wherever that is.
  const pasteTile = (
    <OptionTile
      title={t('login.mobile.paste_title', 'Paste sign-in link')}
      renderIcon={(color, size) => <ClipboardPaste size={size} color={color} />}
      onPress={onPaste}
      disabled={disabled}
    />
  );

  return (
    <View style={styles.root}>
      {isAddMode ? (
        <View style={styles.addHeading}>
          <Text style={styles.title}>{t('login.mobile.add_title', 'Add another account')}</Text>
          {accounts.length > 0 ? (
            <Text style={styles.subtitle}>{t('login.mobile.add_subtitle', "You're signed in to these already.")}</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.branding}>
          <Image
            source={theme === 'light' ? LOGO_LIGHT : LOGO_DARK}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>Bulwark Mail</Text>
          <Text style={styles.subtitle}>{t('login.mobile.choose_subtitle', "Choose how you'd like to sign in.")}</Text>
        </View>
      )}

      {isAddMode && accounts.length > 0 ? (
        <View style={styles.accountList}>
          {accounts.map((account) => {
            // The address leads when another account has the same name, and
            // the server shows when another has the same address or the port
            // isn't the default, as in the switcher.
            const rowText = accountRowText(account, accounts);
            const server = accountServerLine(account, accounts);
            return (
              <View key={account.id} style={styles.accountRow}>
                <View style={[styles.avatar, { backgroundColor: account.avatarColor }]}>
                  <Text style={styles.avatarText}>{initialsOf(account)}</Text>
                </View>
                <View style={styles.accountText}>
                  <Text style={styles.accountName} numberOfLines={1}>
                    {rowText.title}
                  </Text>
                  {rowText.subtitle ? (
                    <Text style={styles.accountEmail} numberOfLines={1}>
                      {rowText.subtitle}
                    </Text>
                  ) : null}
                  {server ? (
                    <Text style={styles.accountEmail} numberOfLines={1}>
                      {server}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {notice ? (
        <View style={styles.notice}>
          <LoginNotice title={notice.title} detail={notice.detail} />
        </View>
      ) : null}

      <View style={styles.options}>
        {hasKnownServer ? (
          knownServerUrls.map((url, i) => (
            <OptionTile
              key={url}
              emphasis={i === 0 ? 'primary' : undefined}
              title={t('login.mobile.known_server_title', 'Another account on {host}', { host: serverHostLabel(url) })}
              description={t('login.mobile.known_server_desc', "We already know this server, so there's no setup")}
              renderIcon={(color, size) => <Plus size={size} color={color} />}
              onPress={() => onUseKnownServer(url)}
              disabled={disabled}
            />
          ))
        ) : (
          <>
            <OptionTile
              emphasis="primary"
              title={t('login.mobile.scan_title', 'Scan a sign-in code')}
              description={t('login.mobile.scan_desc', "The fastest way in if you're signed in on the web")}
              renderIcon={(color, size) => <QrCode size={size} color={color} />}
              onPress={onScan}
              disabled={disabled}
            />
            {pasteTile}
          </>
        )}

        <OptionTile
          title={isAddMode ? t('login.mobile.elsewhere_title', 'An account somewhere else') : t('login.mobile.email_title', 'Use my email address')}
          description={t('login.mobile.email_desc', "We'll find your mail server")}
          renderIcon={(color, size) => <Mail size={size} color={color} />}
          onPress={onUseEmail}
          disabled={disabled}
        />

        {hasKnownServer ? (
          <>
            <OptionTile
              title={t('login.mobile.scan_title', 'Scan a sign-in code')}
              renderIcon={(color, size) => <QrCode size={size} color={color} />}
              onPress={onScan}
              disabled={disabled}
            />
            {pasteTile}
          </>
        ) : null}
      </View>

      <Pressable onPress={onManualSetup} disabled={disabled} hitSlop={8} style={styles.manual}>
        <Server size={14} color={c.textMuted} />
        <Text style={styles.manualText}>{t('login.mobile.manual', 'Enter server details manually')}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.xl },
    branding: { gap: spacing.xs, marginBottom: spacing.md },
    logo: { width: 40, height: 40, marginBottom: spacing.sm },

    addHeading: { gap: spacing.xs },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },

    accountList: { gap: spacing.md },
    accountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    avatar: { width: 36, height: 36, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
    avatarText: { ...typography.bodySemibold, color: c.primaryForeground },
    accountText: { flex: 1 },
    accountName: { ...typography.bodyMedium, color: c.text },
    accountEmail: { ...typography.caption, color: c.textMuted },

    notice: { marginTop: -spacing.xs },
    options: { gap: spacing.md },

    manual: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    manualText: { ...typography.body, color: c.textMuted },
  });
}
