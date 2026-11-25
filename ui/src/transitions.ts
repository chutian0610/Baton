import type { TaskStatus } from './types';

/**
 * The status machine, mirrored verbatim from the daemon (src/lifecycle.ts
 * LEGAL_TARGETS — keep the two in lockstep). Everything not listed is illegal,
 * including same-status moves; the UI only ever OFFERS legal targets, while
 * the server remains the validator.
 */

export const LEGAL_TARGETS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['active', 'waiting', 'done', 'dropped'],
  active: ['waiting', 'done', 'dropped'],
  waiting: ['active', 'done', 'dropped'],
  done: ['pending', 'dropped'], // reopen; drop (any non-dropped -> dropped)
  dropped: ['pending', 'done'], // reopen; done (any non-done -> done)
};

export function legalTargets(status: TaskStatus): TaskStatus[] {
  return LEGAL_TARGETS[status];
}
