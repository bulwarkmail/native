import {
  Folder, Star, Heart, Bookmark, Tag, Flag, Briefcase, Users, Bell,
  Zap, Globe, Lock, Eye, MessageSquare, Mail, Inbox, Archive, FileText,
  type LucideIcon,
} from 'lucide-react-native';
import type { FolderIconName } from '../lib/folder-icons';

const COMPONENTS: Record<FolderIconName, LucideIcon> = {
  Folder, Star, Heart, Bookmark, Tag, Flag, Briefcase, Users, Bell,
  Zap, Globe, Lock, Eye, MessageSquare, Mail, Inbox, Archive, FileText,
};

/** The lucide component for a folder icon name chosen in Settings → Folders. */
export function folderIconComponent(name: FolderIconName): LucideIcon {
  return COMPONENTS[name];
}
