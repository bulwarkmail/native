import React from 'react';
import { Modal, type ModalProps } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * A Modal with its own safe-area provider. A Modal is a separate native
 * window, and a SafeAreaView inside a slide-up Modal measured no insets: the
 * view starts off screen when the slide begins, so on iPhones with a notch or
 * Dynamic Island the header (and its close button) ended up under the status
 * bar, where taps don't reach it. Use this for full-screen modals with a
 * SafeAreaView header.
 */
export function SafeAreaModal({ children, ...props }: ModalProps) {
  return (
    <Modal {...props}>
      <SafeAreaProvider>{children}</SafeAreaProvider>
    </Modal>
  );
}
