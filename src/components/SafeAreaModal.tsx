import React from 'react';
import { Modal, type ModalProps } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * A Modal with its own safe-area provider. A Modal is a separate native
 * window, and a SafeAreaView inside a Modal whose content slides in (a
 * slide-up Modal, or a drawer or sheet the app animates itself) measured no
 * insets: the view starts off screen. On iPhones with a notch or Dynamic
 * Island headers (and their close buttons) ended up under the status bar,
 * where taps don't reach them, and bottom rows on the home indicator. Use
 * this for any Modal with a SafeAreaView inside.
 */
export function SafeAreaModal({ children, ...props }: ModalProps) {
  return (
    <Modal {...props}>
      <SafeAreaProvider>{children}</SafeAreaProvider>
    </Modal>
  );
}
