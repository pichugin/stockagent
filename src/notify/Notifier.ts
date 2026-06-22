import notifier from 'node-notifier';
import type { NotificationsConfig } from '../config.js';
import type { DB } from '../db.js';
import { errMsg, log } from '../util.js';
import {
  coalescedNotification,
  decideNotifications,
  notificationBody,
  notificationTitle,
  type NotifiableSignal,
} from './decision.js';

/** A single native push. Injectable so tests never touch the real OS notifier. */
export interface PushFn {
  (note: { title: string; message: string }): Promise<void>;
}

/** Default push backend: node-notifier → native macOS Notification Center. */
export const nodeNotifierPush: PushFn = (note) =>
  new Promise<void>((resolve, reject) => {
    notifier.notify({ title: note.title, message: note.message }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

/**
 * Owns the *delivery* of actionable signals as native notifications, enforcing
 * the Phase-5 discipline: fire-once (tied to Phase-4 dedup via `notified_at`),
 * actionable-only (the DB query already filters), quiet-hours, throttle/coalesce,
 * and startup suppression.
 *
 * It is deliberately resilient: a push failure is logged (with a one-time
 * permission hint) and never propagates, so the monitoring loop is never taken
 * down by the notification channel.
 */
export class Notifier {
  /** Epoch-ms of recent successful/attempted pushes, for the rolling window. */
  private readonly sentAt: number[] = [];
  private warnedPermission = false;

  constructor(
    private readonly db: DB,
    private readonly config: NotificationsConfig,
    private readonly push: PushFn = nodeNotifierPush,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Startup suppression: treat all currently-pending actionable signals as
   * already-known so a restart doesn't replay a backlog of pushes. Only
   * transitions that happen *during* this run will notify.
   */
  seedSuppression(now: string): void {
    const n = this.db.suppressPendingNotifications(now);
    if (n > 0) {
      log.info(`notifications — suppressed ${n} pre-existing actionable signal(s) at startup`);
    }
  }

  private windowCount(nowMs: number): number {
    const cutoff = nowMs - this.config.windowMinutes * 60_000;
    while (this.sentAt.length > 0 && this.sentAt[0] < cutoff) this.sentAt.shift();
    return this.sentAt.length;
  }

  /**
   * Dispatch notifications for this cycle's pending actionable signals. Decides
   * (individual / coalesced / quiet-suppressed) via {@link decideNotifications},
   * pushes accordingly, and stamps every consumed signal `notified_at` so it
   * never re-fires while it stays active. Quiet-suppressed signals are stamped
   * too (they're surfaced in the dashboard but never retroactively replayed).
   */
  async dispatch(now: string, marketOpen: boolean): Promise<void> {
    if (!this.config.enabled) return;

    const candidates: NotifiableSignal[] = this.db.pendingNotifications();
    if (candidates.length === 0) return;

    const nowMs = this.clock();
    const plan = decideNotifications(candidates, {
      marketOpen,
      quietHoursOutsideMarket: this.config.quietHoursOutsideMarket,
      maxPerWindow: this.config.maxPerWindow,
      recentCount: this.windowCount(nowMs),
    });

    for (const s of plan.individual) {
      await this.safePush({ title: notificationTitle(s), message: notificationBody(s) });
      this.db.markNotified(s.id, now);
    }
    if (plan.individual.length > 0) {
      log.info(
        `notifications — pushed ${plan.individual.length} actionable signal(s): ` +
          plan.individual.map((s) => `${s.symbol}/${s.code}`).join(', '),
      );
    }

    if (plan.coalesced && plan.coalesced.length > 0) {
      await this.safePush(coalescedNotification(plan.coalesced.length));
      for (const s of plan.coalesced) this.db.markNotified(s.id, now);
      log.info(
        `notifications — coalesced ${plan.coalesced.length} actionable signal(s) into one summary push`,
      );
    }

    // Quiet-suppressed: consumed (won't replay), surfaced in the dashboard only.
    for (const s of plan.quietSuppressed) this.db.markNotified(s.id, now);
    if (plan.quietSuppressed.length > 0) {
      log.info(
        `notifications — quiet hours: held back ${plan.quietSuppressed.length} actionable ` +
          `signal(s) (visible in dashboard / "signals --active")`,
      );
    }
  }

  /** Push once, recording the attempt for throttling; never throws. */
  private async safePush(note: { title: string; message: string }): Promise<void> {
    this.sentAt.push(this.clock());
    try {
      await this.push(note);
    } catch (err) {
      // Never let a notification failure crash the loop. Log a one-time hint in
      // case macOS notification permission is denied.
      log.warn(`notification push failed: ${errMsg(err)}`);
      if (!this.warnedPermission) {
        this.warnedPermission = true;
        log.warn(
          'If notifications never appear, grant permission in System Settings → ' +
            'Notifications (allow “terminal-notifier”/your terminal app). The loop continues regardless.',
        );
      }
    }
  }
}
