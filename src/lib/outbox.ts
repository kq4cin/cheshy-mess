import type { OutboxItem, TransportKind } from '../types';

export const RADIO_MAX_ATTEMPTS = 2;
const RADIO_RETRY_DELAY_MS = 300_000;

export function isRadioDeliveryPaused(item: OutboxItem): boolean {
  return (item.radioAttempts ?? item.attempts) >= RADIO_MAX_ATTEMPTS;
}

export function shouldSendOutboxItem(item: OutboxItem, kind: TransportKind, now: number): boolean {
  if (kind !== 'demo' && isRadioDeliveryPaused(item)) return false;
  const retryAfter = kind === 'demo'
    ? Math.min(300_000, 10_000 * 2 ** Math.min(Math.max(item.attempts - 1, 0), 5))
    : RADIO_RETRY_DELAY_MS;
  const attempts = kind === 'demo' ? item.attempts : item.radioAttempts ?? item.attempts;
  const lastAttempt = kind === 'demo' ? item.lastAttempt : item.radioLastAttempt ?? item.lastAttempt;
  return attempts === 0 || lastAttempt === 0 || now - lastAttempt >= retryAfter;
}

export function recordOutboxAttempt(item: OutboxItem, kind: TransportKind, now: number): OutboxItem {
  return {
    ...item, attempts: item.attempts + 1, lastAttempt: now,
    ...(kind === 'demo' ? {} : {
      radioAttempts: (item.radioAttempts ?? item.attempts) + 1,
      radioLastAttempt: now,
    }),
  };
}

export function retryPausedOutboxItems(items: OutboxItem[]): OutboxItem[] {
  return items.map((item) => isRadioDeliveryPaused(item)
    ? { ...item, radioAttempts: RADIO_MAX_ATTEMPTS - 1, radioLastAttempt: 0 }
    : item);
}
