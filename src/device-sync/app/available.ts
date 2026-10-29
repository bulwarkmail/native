/**
 * The gate of every app-side device sync feature (docs/device-sync.md, "App
 * integration"): Android, and a build that carries the native module. iOS,
 * and an Android build without the module, behave as if device sync did not
 * exist.
 */
import { supportsDeviceSync } from '../../lib/platform-capabilities';
import { isDeviceSyncAvailable } from '../native';

export function deviceSyncAvailable(): boolean {
  if (!supportsDeviceSync) return false;
  try {
    return isDeviceSyncAvailable();
  } catch {
    return false;
  }
}
