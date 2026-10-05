import { create } from 'zustand';

// Lightweight port of the webmail's stores/toast-store.ts: a queue of typed
// toasts with an optional action, rendered by components/ToastHost. Use it
// for post-action acknowledgements and non-blocking errors instead of a
// modal Alert.

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  action?: ToastAction;
  /** A second button beside `action`, e.g. Undo plus "Apply to existing". */
  secondaryAction?: ToastAction;
  // ms; errors default to 10 s like the webmail, everything else to 5 s.
  duration: number;
  createdAt: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id' | 'createdAt' | 'duration'> & { duration?: number }) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

let counter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = `toast-${Date.now().toString(36)}-${(counter++).toString(36)}`;
    const entry: Toast = {
      ...toast,
      id,
      createdAt: Date.now(),
      duration: toast.duration ?? (toast.type === 'error' ? 10_000 : 5_000),
    };
    // Keep the queue short: a burst of errors should not stack up forever.
    set((state) => ({ toasts: [...state.toasts.slice(-2), entry] }));
    return id;
  },

  removeToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  clearToasts: () => set({ toasts: [] }),
}));

interface ToastOptions {
  message?: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
  duration?: number;
}

function show(type: ToastType, title: string, options?: string | ToastOptions): string {
  const opts = typeof options === 'string' ? { message: options } : options;
  return useToastStore.getState().addToast({
    type,
    title,
    message: opts?.message,
    action: opts?.action,
    secondaryAction: opts?.secondaryAction,
    duration: opts?.duration,
  });
}

export const toast = {
  success: (title: string, options?: string | ToastOptions) => show('success', title, options),
  error: (title: string, options?: string | ToastOptions) => show('error', title, options),
  info: (title: string, options?: string | ToastOptions) => show('info', title, options),
  warning: (title: string, options?: string | ToastOptions) => show('warning', title, options),
  dismiss: (id: string) => useToastStore.getState().removeToast(id),
};
