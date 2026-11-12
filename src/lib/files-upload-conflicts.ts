/*
 * Uploading a file whose name is already taken in the target folder. The
 * upload asks first, per name: Replace, Keep both or Skip. Ported from the
 * webmail's lib/files-upload-conflicts.ts (file uploads; the app has no
 * folder upload).
 *
 * - Replace gives the existing file the new content, so it keeps its id,
 *   its shares and its links.
 * - Keep both adds "name (1).ext", as every upload did before.
 * - A file and a folder of the same name can't replace each other: the file
 *   is kept beside it with a number, without asking.
 */

export type UploadConflictKind = 'file' | 'folder';

export interface UploadConflict {
  name: string;
  kind: UploadConflictKind;
}

export type UploadConflictChoice = 'replace' | 'keep' | 'skip';

export interface ExistingEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * What of `incoming` clashes with `existing`, in the order of `incoming`.
 * Only same-kind clashes are conflicts; each name is listed once.
 */
export function findUploadConflicts(incoming: UploadConflict[], existing: ExistingEntry[]): UploadConflict[] {
  const files = new Set(existing.filter((e) => !e.isDirectory).map((e) => e.name));
  const folders = new Set(existing.filter((e) => e.isDirectory).map((e) => e.name));
  const seen = new Set<string>();
  const conflicts: UploadConflict[] = [];
  for (const entry of incoming) {
    const key = `${entry.kind}:${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if ((entry.kind === 'file' ? files : folders).has(entry.name)) conflicts.push(entry);
  }
  return conflicts;
}

/** A conflict's answer: the choice, whether it covers the rest, or stop. */
export type ConflictAnswer = { choice: UploadConflictChoice; applyToAll: boolean } | null;

/**
 * Goes through the conflicts one question at a time; "Do this for all"
 * answers the rest with the same choice. Null when a question was called off.
 */
export async function resolveConflictsInTurn(
  conflicts: UploadConflict[],
  ask: (conflict: UploadConflict, index: number, total: number) => Promise<ConflictAnswer>,
): Promise<Map<string, UploadConflictChoice> | null> {
  const choices = new Map<string, UploadConflictChoice>();
  for (let i = 0; i < conflicts.length; i++) {
    const answer = await ask(conflicts[i], i, conflicts.length);
    if (!answer) return null;
    if (answer.applyToAll) {
      for (const rest of conflicts.slice(i)) choices.set(rest.name, answer.choice);
      break;
    }
    choices.set(conflicts[i].name, answer.choice);
  }
  return choices;
}

/** A node in the target folder, as the upload sees it. */
export interface UploadTarget extends ExistingEntry {
  id: string;
  isSymlink?: boolean;
}

/** What an upload does with each picked name once its conflicts are answered. */
export interface UploadPlan {
  /** Names to upload as new content of the file that has the name: its id. */
  replace: Map<string, string>;
  /** Names not to upload. */
  skip: Set<string>;
}

/**
 * Asks about each picked name that a file in the folder has, and says what
 * to replace and what to skip; the rest is kept beside what is there. Null
 * when the user called the upload off. A symlink's name is taken but it
 * can't be replaced: the file is kept beside it, without asking.
 */
export async function uploadChoices(
  names: string[],
  folder: UploadTarget[],
  ask: (conflict: UploadConflict, index: number, total: number) => Promise<ConflictAnswer>,
): Promise<UploadPlan | null> {
  const replaceable = folder.filter((n) => !n.isSymlink);
  const conflicts = findUploadConflicts(names.map((name) => ({ name, kind: 'file' as const })), replaceable);
  const plan: UploadPlan = { replace: new Map(), skip: new Set() };
  if (conflicts.length === 0) return plan;
  const choices = await resolveConflictsInTurn(conflicts, ask);
  if (!choices) return null;
  for (const [name, choice] of choices) {
    if (choice === 'skip') plan.skip.add(name);
    if (choice === 'replace') {
      const node = replaceable.find((n) => n.name === name && !n.isDirectory);
      if (node) plan.replace.set(name, node.id);
    }
  }
  return plan;
}
