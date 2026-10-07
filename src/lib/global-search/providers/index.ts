import type { SearchProvider } from '../types';
import { calendarProvider } from './calendar';
import { contactsProvider } from './contacts';
import { filesProvider } from './files';
import { mailProvider } from './mail';

export const GLOBAL_SEARCH_PROVIDERS: readonly SearchProvider[] = [
  mailProvider,
  contactsProvider,
  calendarProvider,
  filesProvider,
];
