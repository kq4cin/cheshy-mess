import { describe, expect, it } from 'vitest';
import { isRadioDeliveryPaused, recordOutboxAttempt, retryPausedOutboxItems, shouldSendOutboxItem } from './outbox';
import type { OutboxItem } from '../types';

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'outbox', packetId: 'move', kind: 'move', wire: 'packet',
    createdAt: 1000, attempts: 0, lastAttempt: 0, ...overrides,
  };
}

describe.each(['serial', 'ble'] as const)('%s retry limits', (kind) => {
  it('sends a new packet immediately and retries only after five minutes', () => {
    expect(shouldSendOutboxItem(item(), kind, 1000)).toBe(true);
    const sent = item({ attempts: 1, lastAttempt: 1000 });
    expect(shouldSendOutboxItem(sent, kind, 300_999)).toBe(false);
    expect(shouldSendOutboxItem(sent, kind, 301_000)).toBe(true);
  });

  it.each([2, 3, 100])('keeps saved packets with %i attempts paused indefinitely', (attempts) => {
    const saved = JSON.parse(JSON.stringify(item({ attempts, lastAttempt: 1000 }))) as OutboxItem;
    expect(isRadioDeliveryPaused(saved)).toBe(true);
    expect(shouldSendOutboxItem(saved, kind, 10_000_000)).toBe(false);
  });

  it('allows exactly one additional attempt for an explicit manual retry', () => {
    const original = item({ attempts: 10, lastAttempt: 1000 });
    const [retried] = retryPausedOutboxItems([original]);
    expect(shouldSendOutboxItem(retried, kind, 1001)).toBe(true);
    expect(shouldSendOutboxItem(recordOutboxAttempt(retried, kind, 1001), kind, 10_000_000)).toBe(false);
    expect(original.attempts).toBe(10);
  });

  it('does not accelerate unpaused packets when manually retrying', () => {
    const fresh = item();
    const waiting = item({ attempts: 1, lastAttempt: 1000 });
    expect(retryPausedOutboxItems([fresh, waiting])).toEqual([fresh, waiting]);
    expect(shouldSendOutboxItem(waiting, kind, 1001)).toBe(false);
  });

  it('applies the cap to unreliable packets and failed attempts too', () => {
    expect(shouldSendOutboxItem(item({ kind: 'hello', attempts: 2, lastAttempt: 1000 }), kind, 10_000_000)).toBe(false);
  });

  it('does not spend the radio budget on demo attempts or reset it when switching transports', () => {
    const demo = item({ attempts: 100, lastAttempt: 1000, radioAttempts: 0, radioLastAttempt: 0 });
    expect(shouldSendOutboxItem(demo, kind, 1001)).toBe(true);
    const first = recordOutboxAttempt(demo, kind, 1001);
    expect(shouldSendOutboxItem(first, kind, 1002)).toBe(false);
    const second = recordOutboxAttempt(first, kind, 301_001);
    const afterDemo = recordOutboxAttempt(second, 'demo', 302_000);
    expect(shouldSendOutboxItem(afterDemo, kind, 10_000_000)).toBe(false);
  });
});

it('preserves demo retry/backoff without a cap', () => {
  expect(shouldSendOutboxItem(item({ attempts: 1, lastAttempt: 1000 }), 'demo', 10_999)).toBe(false);
  expect(shouldSendOutboxItem(item({ attempts: 1, lastAttempt: 1000 }), 'demo', 11_000)).toBe(true);
  expect(shouldSendOutboxItem(item({ attempts: 2, lastAttempt: 1000 }), 'demo', 20_999)).toBe(false);
  expect(shouldSendOutboxItem(item({ attempts: 2, lastAttempt: 1000 }), 'demo', 21_000)).toBe(true);
  expect(shouldSendOutboxItem(item({ attempts: 10, lastAttempt: 1000 }), 'demo', 301_000)).toBe(true);
});
