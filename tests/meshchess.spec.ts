import { expect, test } from '@playwright/test';
import { encodePacket } from '../src/lib/protocol';
import type { PersistedState } from '../src/types';

for (const droppedKind of ['resign', 'ack'] as const) {
  test(`mobile resignation recovers a lost ${droppedKind} and a finished game can be removed`, async ({ context }) => {
    await context.addInitScript(() => {
      const postMessage = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (message: unknown) {
        if (typeof message === 'string' && message.startsWith('MC2:')) {
          const packet = JSON.parse(message.slice(4)) as { K?: string };
          if (packet.K === sessionStorage.getItem('drop-packet-kind')) return;
        }
        postMessage.call(this, message);
      };
    });
    const white = await context.newPage();
    const black = await context.newPage();
    await Promise.all([white.goto('/'), black.goto('/')]);
    await Promise.all([white.waitForSelector('.welcome-board'), black.waitForSelector('.welcome-board')]);
    await white.getByRole('button', { name: 'Start a new game' }).click();
    await white.getByRole('button', { name: '♔ White' }).click();
    await white.getByRole('button', { name: 'Post challenge to mesh' }).click();
    await black.getByRole('button', { name: /^Lobby/ }).click();
    await black.getByRole('button', { name: /^Accept/ }).click();
    await expect(black.getByText('Board synchronized')).toBeVisible();
    await (droppedKind === 'resign' ? black : white).evaluate((kind) => {
      sessionStorage.setItem('drop-packet-kind', kind);
    }, droppedKind);
    await black.setViewportSize({ width: 390, height: 844 });
    await black.getByRole('button', { name: 'Resign', exact: true }).click();
    await black.getByRole('button', { name: 'Resign game', exact: true }).click();
    await expect(black.locator('.turn-banner')).toContainText('White wins by resignation');
    await expect(black.getByRole('button', { name: 'New game', exact: true })).toBeVisible();
    await black.getByRole('button', { name: 'New game', exact: true }).click();
    await expect(black.getByRole('dialog', { name: 'Create a new game' })).toBeVisible();
    await black.getByRole('button', { name: 'Close dialog' }).click();
    await expect(black.getByText('Delivering move')).toHaveCount(0);
    await black.getByTitle('Retry pending game update').click();
    await expect(black.getByText('Confirming result')).toHaveCount(0);
    await white.getByRole('button', { name: /^My games/ }).click();
    await expect(white.locator('.turn-banner')).toContainText('White wins by resignation');
    await expect(black.getByRole('button', { name: /^e7, black pawn/ })).toBeDisabled();
    await expect(black.getByRole('button', { name: /^e5, legal move/ })).toHaveCount(0);
    await black.getByRole('button', { name: 'Remove game', exact: true }).click();
    await black.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(black.locator('.turn-banner')).toContainText('White wins by resignation');
    await black.getByRole('button', { name: 'Remove game', exact: true }).click();
    await black.getByRole('dialog').getByRole('button', { name: 'Remove game', exact: true }).click();
    await expect(black.locator('.welcome-board')).toBeVisible();
    await black.reload();
    await expect(black.locator('.welcome-board')).toBeVisible();
    expect(await black.evaluate(() => document.body.scrollWidth)).toBe(390);
  });
}

test('removing an active offline game clears its saved chat and queued packets', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.welcome-board');
  await page.evaluate((wire) => {
    const channel = new BroadcastChannel('meshchess-demo-v1');
    channel.postMessage(wire);
    channel.close();
  }, encodePacket({
    v: 1, id: 'test-challenge', kind: 'challenge', from: { id: 'remote', name: 'Remote player' },
    payload: { challengeId: 'offline-challenge', hostColor: 'b' }, sentAt: Date.now(),
  }));
  await page.getByRole('button', { name: /^Lobby/ }).click();
  await page.getByRole('button', { name: /^Accept/ }).click();
  await page.getByRole('button', { name: /^e2, white pawn/ }).click();
  await page.getByRole('button', { name: /^e4, legal move/ }).click();
  await page.locator('.board-toolbar').getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('textbox', { name: 'Chat message' }).fill('Queued message');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('.connection-pill').click();
  await page.getByRole('button', { name: 'Disconnect demo' }).click();
  await page.getByRole('button', { name: /^My games/ }).click();
  await page.getByRole('button', { name: 'Remove game', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove game', exact: true }).click();
  await expect(page.locator('.welcome-board')).toBeVisible();
  await page.reload();
  await expect(page.locator('.welcome-board')).toBeVisible();
  const saved = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('meshchess', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<PersistedState>((resolve, reject) => {
        const request = database.transaction('state', 'readonly').objectStore('state').get('current');
        request.onsuccess = () => resolve(request.result as PersistedState);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
  expect(saved.games).toEqual([]);
  expect(saved.chats).toEqual([]);
  expect(saved.outbox.filter((item) => item.gameId)).toEqual([]);
});

for (const droppedKind of ['move', 'ack'] as const) {
  test(`state sync recovers a lost ${droppedKind} without leaving the move delivering`, async ({ context }) => {
    await context.addInitScript(() => {
      const postMessage = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (message: unknown) {
        const dropped = sessionStorage.getItem('drop-packet-kind');
        if (dropped && typeof message === 'string' && message.startsWith('MC2:')) {
          const packet = JSON.parse(message.slice(4)) as { K?: string };
          if (packet.K === dropped) return;
        }
        postMessage.call(this, message);
      };
    });
    const white = await context.newPage();
    const black = await context.newPage();
    await Promise.all([white.goto('/'), black.goto('/')]);
    await Promise.all([white.waitForSelector('.welcome-board'), black.waitForSelector('.welcome-board')]);
    await white.getByRole('button', { name: 'Start a new game' }).click();
    await white.getByRole('button', { name: '♔ White' }).click();
    await white.getByRole('button', { name: 'Post challenge to mesh' }).click();
    await black.getByRole('button', { name: /^Lobby/ }).click();
    await black.getByRole('button', { name: 'Accept', exact: false }).click();
    await white.getByRole('button', { name: /^My games/ }).click();
    await expect(black.getByText('Board synchronized')).toBeVisible();
    await (droppedKind === 'move' ? white : black).evaluate((kind) => {
      sessionStorage.setItem('drop-packet-kind', kind);
    }, droppedKind);

    await white.getByRole('button', { name: /^e2, white pawn/ }).click();
    await white.getByRole('button', { name: /^e4, legal move/ }).click();
    await expect(white.getByText('Delivering move')).toBeVisible();
    if (droppedKind === 'ack') {
      await expect(black.getByRole('button', { name: /^e4, white pawn, last move/ })).toBeVisible();
    } else {
      await expect(black.getByRole('button', { name: /^e2, white pawn/ })).toBeVisible();
    }

    await white.getByTitle('Request state sync').click();
    await expect(black.getByRole('button', { name: /^e4, white pawn, last move/ })).toBeVisible();
    await expect(white.getByText('Board synchronized')).toBeVisible();
    await expect(white.getByText('Delivering move')).toHaveCount(0);
    await black.getByRole('button', { name: /^e7, black pawn/ }).click();
    await black.getByRole('button', { name: /^e5, legal move/ }).click();
    await expect(white.getByRole('button', { name: /^e5, black pawn, last move/ })).toBeVisible();
  });
}

test('two tabs exchange challenges, legal moves, acknowledgements and chat', async ({ context }) => {
  const white = await context.newPage();
  const black = await context.newPage();
  await Promise.all([white.goto('/'), black.goto('/')]);
  await Promise.all([white.waitForSelector('.welcome-board'), black.waitForSelector('.welcome-board')]);

  await white.getByRole('button', { name: 'Start a new game' }).click();
  await white.getByRole('button', { name: '♔ White' }).click();
  await white.getByRole('button', { name: 'Post challenge to mesh' }).click();
  await expect(white.getByText('Your challenge is on the mesh')).toBeVisible();

  await black.getByRole('button', { name: /^Lobby/ }).click();
  await black.getByRole('button', { name: 'Accept', exact: false }).click();
  await expect(black.getByRole('region', { name: 'Chess game' })).toBeVisible();
  await white.getByRole('button', { name: /^My games/ }).click();
  await expect(white.getByRole('region', { name: 'Chess game' })).toBeVisible();

  await white.getByRole('button', { name: /^e2, white pawn/ }).click();
  await white.getByRole('button', { name: /^e4, legal move/ }).click();
  await expect(black.getByRole('button', { name: /^e4, white pawn, last move/ })).toBeVisible();
  await expect(white.getByText('Board synchronized')).toBeVisible();

  await black.getByRole('button', { name: /^e7, black pawn/ }).click();
  await black.getByRole('button', { name: /^e5, legal move/ }).click();
  await expect(white.getByRole('button', { name: /^e5, black pawn, last move/ })).toBeVisible();
  await expect(black.getByText('Board synchronized')).toBeVisible();

  await white.locator('.board-toolbar').getByRole('button', { name: 'Chat', exact: false }).click();
  await white.getByRole('textbox', { name: 'Chat message' }).fill('Good game — over the air!');
  await white.getByRole('button', { name: 'Send message' }).click();
  await black.locator('.board-toolbar').getByRole('button', { name: 'Chat', exact: false }).click();
  await expect(black.getByText('Good game — over the air!')).toBeVisible();
  await expect(white.locator('.chat-message.mine svg.lucide-check-check')).toBeVisible();

  await black.setViewportSize({ width: 390, height: 844 });
  await expect(black.getByRole('button', { name: 'Close chat' })).toBeVisible();
  await black.getByRole('textbox', { name: 'Chat message' }).fill('Mobile reply');
  await black.getByRole('button', { name: 'Send message' }).click();
  await expect(white.getByText('Mobile reply')).toBeVisible();
  await black.getByRole('button', { name: 'Close chat' }).click();
  await expect(black.locator('.mc-board')).toBeVisible();
  expect(await black.evaluate(() => document.body.scrollWidth)).toBe(390);

  await white.reload();
  await expect(white.getByRole('button', { name: /^e4, white pawn/ })).toBeVisible();
  await expect(white.getByRole('button', { name: /^e5, black pawn/ })).toBeVisible();
  await expect(white.getByText('Game synchronized')).toHaveCount(0);
  await white.getByRole('button', { name: 'Offer draw' }).click();
  await expect(black.locator('.mobile-draw-actions')).toBeVisible();
  await black.locator('.mobile-draw-actions').getByRole('button', { name: 'Accept' }).click();
  await expect(white.locator('.turn-banner').getByText('Game drawn')).toBeVisible();
});

test('production PWA reloads offline with its app shell and saved profile', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.waitForSelector('.welcome-board');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const manifest = await page.getAttribute('link[rel="manifest"]', 'href');
  expect(manifest).toContain('manifest.webmanifest');
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.welcome-board');
  await expect(page.getByRole('heading', { name: 'Your next move is off the grid.' })).toBeVisible();
  expect(errors).toEqual([]);
});
