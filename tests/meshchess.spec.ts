import { expect, test } from '@playwright/test';
import { encodePacket, hashtagKey, PACKET_KINDS } from '../src/lib/protocol';
import type { PersistedState } from '../src/types';

test('radio retries once after five minutes, stays paused after reload, and allows one manual attempt', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(({ secret, resignKind }) => {
    Object.defineProperty(navigator, 'serial', { value: {
      requestPort: async () => {
        let reader: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream<Uint8Array>({ start(controller) { reader = controller; } });
        const writable = new WritableStream<Uint8Array>({
          write(serial) {
            const command = serial.subarray(3);
            let response: Uint8Array;
            if (command[0] === 0x16) response = Uint8Array.of(13, 3, 0, 1);
            else if (command[0] === 0x01) response = Uint8Array.of(5);
            else if (command[0] === 0x1f) {
              response = new Uint8Array(50);
              response[0] = 18;
              response.set(new TextEncoder().encode('#chess'), 2);
              response.set(secret, 34);
            } else if (command[0] === 0x0a) response = Uint8Array.of(10);
            else if (command[0] === 0x03) {
              const text = new TextDecoder().decode(command.subarray(7));
              if (text.startsWith('MC3:') && JSON.parse(text.slice(4))[1] === resignKind) {
                sessionStorage.setItem('radio-sends', String(Number(sessionStorage.getItem('radio-sends') ?? 0) + 1));
              }
              response = Uint8Array.of(6);
            } else throw new Error(`Unexpected mock radio command ${command[0]}`);
            const frame = new Uint8Array(response.length + 3);
            frame.set([0x3e, response.length, 0]);
            frame.set(response, 3);
            reader.enqueue(frame);
          },
        });
        return { readable, writable, open: async () => {}, close: async () => {} };
      },
    } });
  }, { secret: [...await hashtagKey()], resignKind: PACKET_KINDS.indexOf('resign') });
  await page.goto('/');
  await page.waitForSelector('.welcome-board');
  const wire = encodePacket({
    v: 1, id: 'resign_1234567890', kind: 'resign',
    from: { id: 'player_1234567890', name: 'Guest 1234' },
    to: 'player_0987654321', gameId: 'game_1234567890', payload: {}, sentAt: Date.now(),
  });
  await page.evaluate(async (wire) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('meshchess', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('state', 'readwrite');
      const store = transaction.objectStore('state');
      const request = store.get('current');
      request.onsuccess = () => {
        const state = request.result as PersistedState;
        store.put({ ...state, outbox: [{
          id: 'test-radio', packetId: 'resign_1234567890', kind: 'resign', wire,
          createdAt: Date.now(), attempts: 0, lastAttempt: 0, radioAttempts: 0, radioLastAttempt: 0,
        }] }, 'current');
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, wire);
  await page.reload();
  await page.waitForSelector('.welcome-board');
  await page.locator('.connection-pill').click();
  await page.getByRole('button', { name: 'Connect radio', exact: true }).click();
  const sends = () => page.evaluate(() => Number(sessionStorage.getItem('radio-sends') ?? 0));
  await expect.poll(sends).toBe(1);
  await page.clock.fastForward(299_000);
  expect(await sends()).toBe(1);
  await page.clock.fastForward(2000);
  await expect.poll(sends).toBe(2);
  await expect(page.getByRole('button', { name: 'Retry 1 paused packet once' })).toBeVisible();
  await page.clock.fastForward(900_000);
  expect(await sends()).toBe(2);
  await page.reload();
  await page.waitForSelector('.welcome-board');
  await page.locator('.connection-pill').click();
  await page.getByRole('button', { name: 'Connect radio', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry 1 paused packet once' })).toBeEnabled();
  await page.clock.fastForward(900_000);
  expect(await sends()).toBe(2);
  await page.getByRole('button', { name: 'Retry 1 paused packet once' }).click();
  await expect.poll(sends).toBe(3);
  await page.clock.fastForward(900_000);
  expect(await sends()).toBe(3);
});

test('display name supports continuous typing, replacement and persistence', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.welcome-board');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const close = page.getByRole('button', { name: 'Close dialog' });
  const name = page.getByRole('textbox', { name: 'DISPLAY NAME' });
  await expect(close).toBeFocused();
  await name.fill('');
  await name.pressSequentially('Alice Smith');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Alice Smith');
  await name.press('Home');
  await name.pressSequentially('New ');
  await expect(name).toHaveValue('New Alice Smith');
  await name.fill('');
  await expect(name).toHaveValue('');
  await name.pressSequentially('Bob Jones');
  await close.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(name).toHaveValue('Bob Jones');
  await name.fill('   ');
  await close.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(name).toHaveValue('Bob Jones');
  await name.fill('  Carol White  ');
  await name.press('Tab');
  await expect(name).toHaveValue('Carol White');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.waitForSelector('.welcome-board');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(name).toHaveValue('Carol White');
});

for (const droppedKind of ['resign', 'ack'] as const) {
  test(`mobile resignation recovers a lost ${droppedKind} and a finished game can be removed`, async ({ context }) => {
    await context.addInitScript((kinds) => {
      const postMessage = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (message: unknown) {
        if (typeof message === 'string' && /^MC[23]:/.test(message)) {
          const packet = JSON.parse(message.slice(4));
          const kind = Array.isArray(packet) ? kinds[packet[1]] : packet.K;
          if (kind === sessionStorage.getItem('drop-packet-kind')) return;
        }
        postMessage.call(this, message);
      };
    }, PACKET_KINDS);
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
  const readSaved = () => page.evaluate(async () => {
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
  await expect.poll(async () => (await readSaved()).games).toEqual([]);
  await page.reload();
  await expect(page.locator('.welcome-board')).toBeVisible();
  const saved = await readSaved();
  expect(saved.games).toEqual([]);
  expect(saved.chats).toEqual([]);
  expect(saved.outbox.filter((item) => item.gameId)).toEqual([]);
});

for (const droppedKind of ['move', 'ack'] as const) {
  test(`state sync recovers a lost ${droppedKind} without leaving the move delivering`, async ({ context }) => {
    await context.addInitScript((kinds) => {
      const postMessage = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (message: unknown) {
        const dropped = sessionStorage.getItem('drop-packet-kind');
        if (dropped && typeof message === 'string' && /^MC[23]:/.test(message)) {
          const packet = JSON.parse(message.slice(4));
          const kind = Array.isArray(packet) ? kinds[packet[1]] : packet.K;
          if (kind === dropped) return;
        }
        postMessage.call(this, message);
      };
    }, PACKET_KINDS);
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
