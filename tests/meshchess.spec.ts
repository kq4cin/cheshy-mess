import { expect, test } from '@playwright/test';
import { decodePacket, encodePacket, hashtagKey, PACKET_KINDS } from '../src/lib/protocol';
import type { PersistedState } from '../src/types';

test('local demo highlights radio connection actions on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  const connection = page.locator('.connection-pill');
  const mesh = page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Mesh', exact: true });
  await expect(connection).toHaveText('Connect radio');
  await expect(connection).toHaveClass(/mesh-call-to-action/);
  await expect(connection).toHaveAccessibleName(/Demo channel connected.*Connect a MeshCore radio/);
  for (const width of [1440, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(connection).toBeInViewport({ ratio: 1 });
    if (width <= 900) {
      await expect(mesh).toBeInViewport({ ratio: 1 });
      await expect(mesh).toHaveClass(/mesh-call-to-action/);
    }
    expect(await page.evaluate(() => document.body.scrollWidth)).toBe(width);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(mesh).toHaveCSS('animation-name', 'none');
  await expect(mesh).not.toHaveCSS('box-shadow', 'none');
  await mesh.click();
  await expect(page.getByRole('heading', { name: 'Mesh connection' })).toBeVisible();
  await expect(page.locator('.mesh-call-to-action')).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect demo', exact: true }).click();
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: /^Games/ }).click();
  await expect(connection).toHaveText('Off-grid');
  await expect(page.locator('.mesh-call-to-action')).toHaveCount(0);
});

test('mobile game hub filters saved games and returns from move review to a stable board', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.waitForSelector('.welcome-board');
  await page.evaluate((wire) => {
    const channel = new BroadcastChannel('meshchess-demo-v1');
    channel.postMessage(wire);
    channel.close();
  }, encodePacket({
    v: 1, id: 'hub-challenge', kind: 'challenge',
    from: { id: 'remote', name: 'Remote player' },
    payload: { challengeId: 'hub-game', hostColor: 'b' }, sentAt: Date.now(),
  }));
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  await navigation.getByRole('button', { name: /^Lobby/ }).click();
  await expect(page.locator('.connection-context')).toContainText('open a second browser tab');
  await page.getByRole('button', { name: /^Accept/ }).click();
  await page.getByRole('button', { name: /^e2, white pawn/ }).click();
  await page.getByRole('button', { name: /^e4, legal move/ }).click();
  await expect(page.locator('.turn-banner')).toContainText('Remote player');
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('meshchess', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('state', 'readwrite');
        const store = transaction.objectStore('state');
        const request = store.get('current');
        request.onsuccess = () => {
          const state = request.result as PersistedState;
          const base = state.games[0];
          store.put({ ...state, games: [
            base,
            { ...base, id: 'your-turn', challengeId: 'your-turn', moves: [], awaitingAck: null,
              black: { id: 'other', name: 'Awaiting you' } },
            { ...base, id: 'finished', challengeId: 'finished', status: 'resigned', winner: 'w', awaitingAck: null,
              black: { id: 'finished-player', name: 'A very long opponent display name' }, updatedAt: Date.now() + 1000 },
          ] }, 'current');
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
  await page.reload();
  const games = page.locator('.game-list-item');
  await expect(games).toHaveCount(3);
  await expect(games.first()).toContainText('Awaiting you');
  await expect(page.locator('.board-workspace')).toBeHidden();
  await page.getByRole('button', { name: /^Your turn/ }).click();
  await expect(games).toHaveCount(1);
  await expect(games).toContainText('Awaiting you');
  await page.getByRole('button', { name: /^Finished/ }).click();
  await expect(games).toHaveCount(1);
  await expect(games).toContainText('White wins by resignation');
  await page.getByRole('button', { name: /^All / }).click();
  await expect(games).toHaveCount(3);
  for (const width of [320, 820, 901, 1150, 1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(games.first()).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.body.scrollWidth)).toBe(width);
  }
  await games.filter({ hasText: 'Remote player' }).click();
  await expect(page.locator('.games-sidebar')).toBeHidden();
  await expect(page.getByRole('button', { name: /^e4, white pawn, last move/ })).toBeVisible();
  await page.locator('.board-toolbar').getByRole('button', { name: 'Moves', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Offer draw' })).toBeVisible();
  await page.locator('.move-row').getByRole('button', { name: 'e4', exact: true }).click();
  await expect(page.locator('.game-panel')).toBeHidden();
  await expect(page.getByText('Reviewing move 1 of 1')).toBeVisible();
  await expect(page.getByRole('button', { name: /^e4, white pawn/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Return to live' }).click();
  await expect(page.getByText('Reviewing move 1 of 1')).toHaveCount(0);
  await page.getByRole('button', { name: 'All games', exact: true }).click();
  await expect(games).toHaveCount(3);
  const create = navigation.getByRole('button', { name: 'New', exact: true });
  await create.click();
  const close = page.getByRole('button', { name: 'Close dialog' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Post challenge to mesh' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(create).toBeFocused();
  await navigation.getByRole('button', { name: 'Mesh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mesh connection' })).toBeVisible();
  await navigation.getByRole('button', { name: /^Games/ }).click();
  await expect(games).toHaveCount(3);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 820, height: 1180 },
]) {
  test(`chat stays dismissible and usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForSelector('.welcome-board');
    await page.evaluate((wire) => {
      const channel = new BroadcastChannel('meshchess-demo-v1');
      channel.postMessage(wire);
      channel.close();
    }, encodePacket({
      v: 1, id: 'mobile-challenge', kind: 'challenge',
      from: { id: 'remote', name: 'Remote player' },
      payload: { challengeId: 'mobile-game', hostColor: 'b' }, sentAt: Date.now(),
    }));
    await page.getByRole('button', { name: /^Lobby/ }).filter({ visible: true }).click();
    await page.getByRole('button', { name: /^Accept/ }).click();
    const open = page.locator('.board-toolbar').getByRole('button', { name: 'Chat', exact: true });
    const close = page.getByRole('button', { name: /^Close (chat|moves)$/ });
    const input = page.getByRole('textbox', { name: 'Chat message' });
    const send = page.getByRole('button', { name: 'Send message' });
    const expectReachable = async (locator: typeof close) => {
      await expect(locator).toBeInViewport({ ratio: 1 });
      await locator.click({ trial: true });
    };
    await open.click();
    await expect(close).toHaveText('Back to board');
    await expectReachable(close);
    for (let index = 0; index < 12; index += 1) {
      await input.fill(`Message ${index}: ${'A longer chat message. '.repeat(5)}`);
      await send.click();
    }
    await input.fill('Keep this draft');
    await expectReachable(close);
    // A reduced viewport exercises the space available while a mobile keyboard is open.
    await page.setViewportSize({ width: viewport.width, height: 360 });
    await expectReachable(close);
    await expect(input).toBeInViewport({ ratio: 1 });
    await expectReachable(send);
    await close.click();
    await expect(page.locator('.game-panel')).toBeHidden();
    await expect(open).toBeFocused();
    await open.click();
    await expect(input).toHaveValue('Keep this draft');
    await page.locator('.panel-tabs').getByRole('button', { name: 'Moves', exact: true }).click();
    await expectReachable(close);
    await page.keyboard.press('Escape');
    await expect(page.locator('.game-panel')).toBeHidden();
    await page.setViewportSize(viewport);
    await page.locator('.connection-pill').click();
    await page.getByRole('button', { name: /^Games/ }).filter({ visible: true }).or(
      page.getByRole('button', { name: /^My games/ }).filter({ visible: true }),
    ).click();
    await expect(page.locator('.game-panel')).toBeHidden();
    expect(await page.evaluate(() => document.body.scrollWidth)).toBe(viewport.width);
  });
}

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
  await page.getByRole('button', { name: /^My games/ }).click();
  await expect(page.locator('.connection-pill')).toHaveText('Radio online');
  await expect(page.locator('.mesh-call-to-action')).toHaveCount(0);
  await page.locator('.connection-pill').click();
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
  await page.getByRole('button', { name: 'Save and return' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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

test('reannouncing recovers a missed challenge without creating duplicates', async ({ context }) => {
  const host = await context.newPage();
  await host.addInitScript((challengeKind) => {
    const send = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message: unknown) {
      if (typeof message === 'string' && message.startsWith('MC3:')
        && JSON.parse(message.slice(4))[1] === challengeKind) {
        const wires: string[] = JSON.parse(sessionStorage.getItem('challenge-wires') ?? '[]');
        wires.push(message);
        sessionStorage.setItem('challenge-wires', JSON.stringify(wires));
        if (wires.length === 1) return;
      }
      send.call(this, message);
    };
  }, PACKET_KINDS.indexOf('challenge'));
  const guest = await context.newPage();
  await Promise.all([host.goto('/'), guest.goto('/')]);
  await Promise.all([host.waitForSelector('.welcome-board'), guest.waitForSelector('.welcome-board')]);
  await guest.getByRole('button', { name: /^Lobby/ }).click();
  // Wait for discovery before posting, so it cannot automatically reannounce the lost packet.
  await host.getByRole('button', { name: /^Lobby/ }).click();
  await expect(host.locator('.peer-row')).toHaveCount(1);
  await host.getByRole('button', { name: 'Create game', exact: true }).click();
  await host.getByRole('button', { name: 'Post challenge to mesh' }).click();
  await expect(guest.getByRole('button', { name: /^Accept/ })).toHaveCount(0);

  const reannounce = host.getByRole('button', { name: 'Reannounce challenges', exact: true });
  await reannounce.click();
  await expect(guest.getByRole('button', { name: /^Accept/ })).toHaveCount(1);
  await expect(host.getByText('Challenges queued for reannouncement')).toBeVisible();
  await reannounce.click();
  await expect.poll(async () => host.evaluate(() => JSON.parse(sessionStorage.getItem('challenge-wires') ?? '[]').length)).toBe(3);
  const wires: string[] = await host.evaluate(() => JSON.parse(sessionStorage.getItem('challenge-wires') ?? '[]'));
  const packets = wires.map((wire) => decodePacket<{ challengeId: string }>(wire));
  expect(new Set(packets.map((packet) => packet.payload.challengeId)).size).toBe(1);
  expect(new Set(packets.map((packet) => packet.id)).size).toBe(3);
  await expect(guest.getByRole('button', { name: /^Accept/ })).toHaveCount(1);

  await host.setViewportSize({ width: 390, height: 844 });
  await expect(reannounce).toBeVisible();
  expect(await host.evaluate(() => document.body.scrollWidth)).toBe(390);
  await host.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Mesh', exact: true }).click();
  await host.getByRole('button', { name: 'Disconnect demo' }).click();
  await host.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: /^Lobby/ }).click();
  await expect(reannounce).toBeDisabled();
  await host.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(reannounce).toHaveCount(0);
});

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
