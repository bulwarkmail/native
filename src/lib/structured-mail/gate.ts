// Mirrors webmail lib/structured-mail-gate.ts at 8098039d6, which reads the
// admin policy's `structuredMailEnabled`. Off: no booking, parcel or order
// cards, no parsing of markup and no .pkpass download.
//
// App: there is no org policy in the app yet, so the gate is on. When the
// policy arrives, read it here; every caller already goes through this.

/** Whether booking cards are shown, outside React. */
export function isStructuredMailEnabled(): boolean {
  return true;
}

/** Whether booking cards are shown, for components. */
export function useStructuredMailEnabled(): boolean {
  return isStructuredMailEnabled();
}
