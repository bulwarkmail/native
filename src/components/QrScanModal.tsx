import React from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { X } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import Button from './Button';

interface QrScanModalProps {
  visible: boolean;
  onClose: () => void;
  // Fires once with the raw decoded QR string. The parent is responsible for
  // closing the modal and interpreting the payload.
  onScanned: (data: string) => void;
}

export function QrScanModal({ visible, onClose, onScanned }: QrScanModalProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [permission, requestPermission] = useCameraPermissions();
  // Guards against the camera firing onBarcodeScanned dozens of times for the
  // same code before the modal tears down.
  const handled = React.useRef(false);

  React.useEffect(() => {
    if (visible) handled.current = false;
  }, [visible]);

  const handleBarcode = React.useCallback(
    (result: BarcodeScanningResult) => {
      if (handled.current) return;
      handled.current = true;
      onScanned(result.data);
    },
    [onScanned],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.container}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarcode}
          />
        ) : null}

        <SafeAreaView style={styles.overlay}>
          <View style={styles.header}>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeButton}>
              <X size={24} color="#ffffff" />
            </Pressable>
            <Text style={styles.title}>Scan QR code</Text>
            <View style={styles.closeButton} />
          </View>

          {permission?.granted ? (
            <View style={styles.frameWrap}>
              <View style={styles.frame} />
              <Text style={styles.hint}>
                Point your camera at the QR code shown on the webmail settings screen.
              </Text>
            </View>
          ) : (
            <View style={styles.permissionWrap}>
              <Text style={styles.permissionText}>
                {permission && !permission.canAskAgain
                  ? 'Camera access is disabled. Enable it in Settings to scan a sign-in QR code.'
                  : 'Bulwark Mail needs camera access to scan a sign-in QR code.'}
              </Text>
              <Button variant="default" size="md" onPress={() => void requestPermission()}>
                Allow camera access
              </Button>
            </View>
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000000' },
    overlay: { flex: 1, justifyContent: 'flex-start' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingTop: Platform.OS === 'android' ? spacing.xl : spacing.sm,
      paddingBottom: spacing.md,
    },
    closeButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    title: { ...typography.h3, color: '#ffffff' },
    frameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
    frame: {
      width: 240,
      height: 240,
      borderWidth: 3,
      borderColor: '#ffffff',
      borderRadius: radius.lg,
      backgroundColor: 'transparent',
    },
    hint: {
      ...typography.caption,
      color: '#ffffff',
      textAlign: 'center',
      paddingHorizontal: spacing.xxl,
    },
    permissionWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.lg,
      paddingHorizontal: spacing.xxl,
      backgroundColor: c.background,
    },
    permissionText: { ...typography.body, color: c.text, textAlign: 'center' },
  });
}
