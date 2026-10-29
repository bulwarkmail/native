import type { ModalProps } from 'react-native';

/**
 * Every RN `<Modal>` passes this. Without it iOS presents a modal in portrait
 * only, which rotates an iPad (or a landscape iPhone) back to portrait while
 * the modal is open.
 */
export const MODAL_ORIENTATIONS: NonNullable<ModalProps['supportedOrientations']> = [
  'portrait',
  'portrait-upside-down',
  'landscape',
  'landscape-left',
  'landscape-right',
];
