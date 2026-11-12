import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** The times the app last wrote to an account's out-of-office event, as ISO instants. */
export interface WrittenBlock {
  start: string;
  end: string;
}

/**
 * "Block my calendar" (lib/vacation-calendar.ts): the user's choice and the
 * busy event the app last wrote, per login and account. The webmail keeps
 * both in its settings (vacationBlockCalendar, vacationCalendarBlocks).
 */
interface VacationCalendarState {
  /** The user's choice; null until they made one (on by default). */
  block: boolean | null;
  /** Keyed by `<login>|<accountId>`. */
  written: Record<string, WrittenBlock>;
  setBlock: (block: boolean) => void;
  remember: (key: string, block: WrittenBlock | null) => void;
}

export const useVacationCalendarStore = create<VacationCalendarState>()(
  persist(
    (set, get) => ({
      block: null,
      written: {},
      setBlock: (block) => set({ block }),
      remember: (key, block) => {
        const next = { ...get().written };
        if (block) next[key] = block;
        else delete next[key];
        set({ written: next });
      },
    }),
    {
      name: 'vacation-calendar-block',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ block: state.block, written: state.written }),
    },
  ),
);
