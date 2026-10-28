import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_CHANNEL, hashtagKey, MAX_PACKET_BYTES } from './protocol';
import {
  encodeSerialFrame,
  FRAGMENT_ASSEMBLY_TTL_MS,
  FRAGMENT_PAYLOAD_BYTES,
  MAX_FRAGMENT_ASSEMBLIES,
  MeshCoreClient,
  RADIO_TEXT_MAX_BYTES,
  SerialFrameParser,
  stripSenderPrefix,
} from './transports';

function inboundSerialFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.byteLength + 3);
  frame[0] = 0x3e;
  frame[1] = payload.byteLength & 0xff;
  frame[2] = payload.byteLength >>> 8;
  frame.set(payload, 3);
  return frame;
}

function channelText(text: string, channel = 1): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const frame = new Uint8Array(8 + bytes.byteLength);
  frame[0] = 8;
  frame[1] = channel;
  frame.set(bytes, 8);
  return frame;
}

const clients: MeshCoreClient[] = [];

afterEach(() => {
  for (const client of clients) client.stop();
  clients.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface RadioSlot { name: string; secret: Uint8Array }

describe('Bluetooth radio selection', () => {
  async function harness(savedId?: string) {
    vi.resetModules();
    const { BLEAdapter, MeshCoreClient, NORDIC_UART_SERVICE } = await import('./transports');
    vi.spyOn(MeshCoreClient.prototype, 'start').mockResolvedValue();
    const characteristic = {
      startNotifications: vi.fn().mockResolvedValue(undefined),
      stopNotifications: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      writeValueWithResponse: vi.fn().mockResolvedValue(undefined),
    };
    const gatt = {
      connected: true,
      connect: vi.fn().mockImplementation(async () => gatt),
      disconnect: vi.fn(),
      getPrimaryService: vi.fn().mockResolvedValue({
        getCharacteristic: vi.fn().mockResolvedValue(characteristic),
      }),
    };
    const device = { id: 'radio-1', gatt };
    const bluetooth = {
      requestDevice: vi.fn().mockResolvedValue(device),
      getDevices: vi.fn().mockResolvedValue([device]),
    };
    const values = new Map(savedId ? [['meshchess-bluetooth-device', savedId]] : []);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.stubGlobal('navigator', { bluetooth });
    const onLog = vi.fn();
    return { BLEAdapter, bluetooth, device, values, onLog, NORDIC_UART_SERVICE };
  }

  it('uses the Mesh Wars chooser filters and reuses the device on reconnect', async () => {
    const { BLEAdapter, bluetooth, values, NORDIC_UART_SERVICE } = await harness();
    const adapter = new BLEAdapter();
    await adapter.connect();
    expect(bluetooth.requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [NORDIC_UART_SERVICE] }, { namePrefix: 'MeshCore' }],
      optionalServices: [NORDIC_UART_SERVICE],
    });
    expect(values.get('meshchess-bluetooth-device')).toBe('radio-1');
    await adapter.disconnect();
    const next = new BLEAdapter();
    await next.connect();
    expect(bluetooth.requestDevice).toHaveBeenCalledTimes(1);
    await next.disconnect();
  });

  it('restores a previously authorized radio after a reload without opening the chooser', async () => {
    const { BLEAdapter, bluetooth } = await harness('radio-1');
    const adapter = new BLEAdapter();
    await adapter.connect();
    expect(bluetooth.getDevices).toHaveBeenCalledOnce();
    expect(bluetooth.requestDevice).not.toHaveBeenCalled();
    await adapter.disconnect();
  });

  it('can explicitly choose a different radio', async () => {
    const { BLEAdapter, bluetooth } = await harness('radio-1');
    const adapter = new BLEAdapter();
    await adapter.connect();
    await adapter.disconnect();
    await adapter.connect(undefined, true);
    expect(bluetooth.requestDevice).toHaveBeenCalledOnce();
    await adapter.disconnect();
  });

  it('opens the chooser if the saved permission is no longer available', async () => {
    const { BLEAdapter, bluetooth } = await harness('radio-1');
    bluetooth.getDevices.mockResolvedValue([]);
    const adapter = new BLEAdapter();
    await adapter.connect();
    expect(bluetooth.requestDevice).toHaveBeenCalledOnce();
    await adapter.disconnect();
  });

  it('logs restoration errors and lets the user select a radio', async () => {
    const { BLEAdapter, bluetooth, onLog } = await harness('radio-1');
    bluetooth.getDevices.mockRejectedValue(new Error('Permission lookup failed'));
    const adapter = new BLEAdapter({ onLog });
    await adapter.connect();
    expect(onLog).toHaveBeenCalledWith('Could not restore Bluetooth selection: Permission lookup failed');
    expect(bluetooth.requestDevice).toHaveBeenCalledOnce();
    await adapter.disconnect();
  });

  it('surfaces a failed saved-radio connection without silently pairing another device', async () => {
    const { BLEAdapter, bluetooth, device } = await harness('radio-1');
    device.gatt.connect.mockRejectedValue(new Error('Radio unavailable'));
    const onState = vi.fn();
    await expect(new BLEAdapter({ onState }).connect()).rejects.toThrow('Radio unavailable');
    expect(bluetooth.requestDevice).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({
      kind: 'ble', status: 'error', detail: 'Radio unavailable',
    });
  });
});

const PUBLIC_SLOT: RadioSlot = { name: 'Public', secret: Uint8Array.from({ length: 16 }, (_, index) => index + 1) };
const EMPTY_SLOT = (): RadioSlot => ({ name: '', secret: new Uint8Array(16) });

// Mirrors MeshCore companion firmware: CMD_GET_CHANNEL strcpy()s the name into a reused output
// buffer (bytes after the NUL are stale), and out-of-range slots answer ERR_CODE_NOT_FOUND.
async function clientHarness(options: { slots?: RadioSlot[]; reportedChannels?: number } = {}) {
  const gameSecret = await hashtagKey(GAME_CHANNEL);
  const slots = options.slots ?? [PUBLIC_SLOT, { name: GAME_CHANNEL, secret: gameSecret }];
  const received: string[] = [];
  const writes: Uint8Array[] = [];
  const radioTexts: string[] = [];
  const logs: string[] = [];
  const outFrame = new Uint8Array(172).fill(0x58);
  let client: MeshCoreClient;
  client = new MeshCoreClient((frame) => {
    writes.push(frame.slice());
    let response: Uint8Array;
    if (frame[0] === 0x16) response = Uint8Array.of(13, 3, 0, options.reportedChannels ?? slots.length);
    else if (frame[0] === 0x01) response = Uint8Array.of(5);
    else if (frame[0] === 0x1f) {
      const slot = slots[frame[1]];
      if (!slot) response = Uint8Array.of(1, 2);
      else {
        outFrame[0] = 18;
        outFrame[1] = frame[1];
        const name = new TextEncoder().encode(slot.name);
        outFrame.set(name, 2);
        outFrame[2 + name.byteLength] = 0;
        outFrame.set(slot.secret, 34);
        response = outFrame.slice(0, 50);
      }
    } else if (frame[0] === 0x20) {
      if (frame.byteLength < 50 || !slots[frame[1]]) response = Uint8Array.of(1, 2);
      else {
        const nameField = frame.subarray(2, 34);
        const end = nameField.indexOf(0);
        slots[frame[1]] = {
          name: new TextDecoder().decode(end < 0 ? nameField : nameField.subarray(0, end)),
          secret: frame.slice(34, 50),
        };
        response = Uint8Array.of(0);
      }
    } else if (frame[0] === 0x0a) response = Uint8Array.of(10);
    else if (frame[0] === 0x03) {
      radioTexts.push(new TextDecoder().decode(frame.subarray(7)));
      response = Uint8Array.of(6);
    } else throw new Error(`Unexpected command ${frame[0]}`);
    queueMicrotask(() => client.handleFrame(response));
  }, {
    onMessage: (text) => received.push(text),
    onLog: (text) => logs.push(text),
  }, {
    fragmentDelayMs: 0,
    syncIntervalMs: 60_000,
  });
  clients.push(client);
  await client.start();
  return { client, received, writes, radioTexts, logs, slots };
}

describe('SerialFrameParser', () => {
  it('uses 3c outbound and assembles fragmented inbound 3e frames', () => {
    const payload = Uint8Array.from({ length: 300 }, (_, index) => index & 0xff);
    const outbound = encodeSerialFrame(payload);
    expect(Array.from(outbound.subarray(0, 3))).toEqual([0x3c, 0x2c, 0x01]);
    const wire = inboundSerialFrame(payload);
    expect(Array.from(wire.subarray(0, 3))).toEqual([0x3e, 0x2c, 0x01]);
    const parser = new SerialFrameParser();
    const frames: Uint8Array[] = [];
    for (const byte of wire) frames.push(...parser.push(Uint8Array.of(byte)));
    expect(frames).toEqual([payload]);
  });

  it('extracts coalesced frames and retains a trailing partial frame', () => {
    const first = Uint8Array.of(1, 2, 3);
    const second = Uint8Array.of(0x3e, 9, 8);
    const firstWire = inboundSerialFrame(first);
    const secondWire = inboundSerialFrame(second);
    const combined = new Uint8Array(firstWire.length + secondWire.length);
    combined.set(firstWire);
    combined.set(secondWire, firstWire.length);

    const parser = new SerialFrameParser();
    expect(parser.push(combined.subarray(0, firstWire.length + 2))).toEqual([first]);
    expect(parser.push(combined.subarray(firstWire.length + 2))).toEqual([second]);
  });

  it('skips line noise and handles empty frames', () => {
    const parser = new SerialFrameParser();
    const wire = new Uint8Array([
      0x0d, 0x0a, 0x41,
      ...inboundSerialFrame(new Uint8Array(0)),
      0x00,
      ...inboundSerialFrame(Uint8Array.of(7)),
    ]);
    expect(parser.push(wire)).toEqual([new Uint8Array(0), Uint8Array.of(7)]);
    expect(parser.push(new Uint8Array(0))).toEqual([]);
  });

  it('resynchronizes after an oversized header and can be reset', () => {
    const parser = new SerialFrameParser(4);
    const wire = new Uint8Array([0x3e, 5, 0, ...inboundSerialFrame(Uint8Array.of(4))]);
    expect(parser.push(wire)).toEqual([Uint8Array.of(4)]);
    parser.push(Uint8Array.of(0x3e, 1));
    parser.reset();
    expect(parser.push(Uint8Array.of(0, 99))).toEqual([]);
  });
});

describe('MeshCore text fragmentation', () => {
  it('negotiates companion v3 and preserves ordinary text', async () => {
    const { client, received, writes, radioTexts } = await clientHarness();
    expect(writes.find((frame) => frame[0] === 1)?.[1]).toBe(3);
    await client.sendChannel('ordinary text');
    expect(radioTexts).toEqual(['ordinary text']);
    client.handleFrame(channelText('ordinary incoming ♞'));
    expect(received).toEqual(['ordinary incoming ♞']);
  });

  it('fragments unicode into bounded envelopes and reassembles out of order', async () => {
    const { client, received, radioTexts } = await clientHarness();
    const text = `MC1:${'Moves 🙂♟ and sync '.repeat(30)}`;
    await client.sendChannel(text);
    expect(radioTexts.length).toBeGreaterThan(3);
    for (const fragment of radioTexts) {
      expect(new TextEncoder().encode(fragment).byteLength).toBeLessThanOrEqual(RADIO_TEXT_MAX_BYTES);
      expect(fragment).toMatch(/^MCF:[0-9a-f]{8}:\d+:\d+:[A-Za-z0-9+/]+={0,2}$/);
    }
    for (const fragment of [...radioTexts].reverse()) client.handleFrame(channelText(fragment));
    expect(received).toEqual([text]);
    for (const fragment of radioTexts) client.handleFrame(channelText(fragment));
    expect(received).toEqual([text]);
  });

  it('rejects oversized outbound packets and inbound fragment counts', async () => {
    const { client, received, radioTexts } = await clientHarness();
    await expect(client.sendChannel('x'.repeat(MAX_PACKET_BYTES + 1))).rejects.toThrow(/exceeds/);
    expect(radioTexts).toEqual([]);
    client.handleFrame(channelText(`MCF:limit1:0:251:${'A'.repeat(64)}`));
    client.handleFrame(channelText('still ordinary'));
    expect(received).toEqual(['still ordinary']);
  });

  it('evicts the stalest partial packet so lost fragments cannot block new traffic', async () => {
    const { client, received } = await clientHarness();
    vi.useFakeTimers();
    const firstChunk = btoa('x'.repeat(FRAGMENT_PAYLOAD_BYTES));
    for (let index = 0; index <= MAX_FRAGMENT_ASSEMBLIES; index += 1) {
      client.handleFrame(channelText(`MCF:assembly${index}:0:2:${firstChunk}`));
      vi.advanceTimersByTime(10);
    }
    client.handleFrame(channelText(`MCF:assembly0:1:2:${btoa('y')}`));
    client.handleFrame(channelText(`MCF:assembly${MAX_FRAGMENT_ASSEMBLIES}:1:2:${btoa('z')}`));
    expect(received).toEqual(['x'.repeat(FRAGMENT_PAYLOAD_BYTES) + 'z']);
  });

  it('expires stale partial assemblies', async () => {
    const { client, received } = await clientHarness();
    vi.useFakeTimers();
    client.handleFrame(channelText(`MCF:stale1:0:2:${btoa('x'.repeat(FRAGMENT_PAYLOAD_BYTES))}`));
    vi.advanceTimersByTime(FRAGMENT_ASSEMBLY_TTL_MS + 1);
    client.handleFrame(channelText(`MCF:stale1:1:2:${btoa('y')}`));
    expect(received).toEqual([]);
  });

  it('does not accept a matching channel name with the wrong secret', async () => {
    await expect(clientHarness({ slots: [PUBLIC_SLOT, { name: GAME_CHANNEL, secret: new Uint8Array(16).fill(7) }] }))
      .rejects.toThrow(/No free MeshCore channel slot/);
  });
});

describe('MeshCore sender prefix', () => {
  it('reassembles fragments that arrive as "<node name>: <text>" like real firmware', async () => {
    const { client, received, radioTexts } = await clientHarness();
    const packet = `MC1:${JSON.stringify({ kind: 'challenge', pad: 'x'.repeat(150) })}`;
    await client.sendChannel(packet);
    expect(radioTexts.length).toBeGreaterThan(1);
    for (const fragment of radioTexts) client.handleFrame(channelText(`KQ4CIN Base: Camp: ${fragment}`));
    expect(received).toEqual([packet]);
  });

  it('strips the prefix from short packets and leaves ordinary chatter alone', () => {
    expect(stripSenderPrefix('Alice: MC1:{"v":1}')).toBe('MC1:{"v":1}');
    expect(stripSenderPrefix('MCF:abcd1234:0:1:QQ==')).toBe('MCF:abcd1234:0:1:QQ==');
    expect(stripSenderPrefix('Bob: hello everyone')).toBe('Bob: hello everyone');
  });
});

describe('MeshCore channel setup', () => {
  it('finds a manually created hashtag channel despite stale bytes after the name', async () => {
    const secret = await hashtagKey(GAME_CHANNEL);
    const { client, writes } = await clientHarness({ slots: [PUBLIC_SLOT, EMPTY_SLOT(), { name: GAME_CHANNEL, secret }] });
    expect(client.channelIndex).toBe(2);
    expect(writes.some((frame) => frame[0] === 0x20)).toBe(false);
  });

  it('matches on the hashtag key even when the app stored a different name', async () => {
    const secret = await hashtagKey(GAME_CHANNEL);
    const { client } = await clientHarness({ slots: [PUBLIC_SLOT, { name: 'chess', secret }] });
    expect(client.channelIndex).toBe(1);
  });

  it('creates the channel in the first empty non-public slot', async () => {
    const secret = await hashtagKey(GAME_CHANNEL);
    const busy = { name: 'Friends', secret: new Uint8Array(16).fill(9) };
    const { client, writes, slots, logs } = await clientHarness({ slots: [PUBLIC_SLOT, busy, EMPTY_SLOT(), EMPTY_SLOT()] });
    expect(client.channelIndex).toBe(2);
    const set = writes.find((frame) => frame[0] === 0x20);
    expect(set?.byteLength).toBe(50);
    expect(set?.[1]).toBe(2);
    expect(slots[2].name).toBe(GAME_CHANNEL);
    expect(Array.from(slots[2].secret)).toEqual(Array.from(secret));
    expect(logs.some((line) => line.includes('Created public channel #chess in slot 2'))).toBe(true);
  });

  it('stops scanning at ERR_CODE_NOT_FOUND when the reported slot count is too high', async () => {
    const { client } = await clientHarness({ slots: [PUBLIC_SLOT, EMPTY_SLOT()], reportedChannels: 40 });
    expect(client.channelIndex).toBe(1);
  });

  it('explains how to recover when every slot is in use', async () => {
    const busy = (fill: number) => ({ name: `ch${fill}`, secret: new Uint8Array(16).fill(fill) });
    await expect(clientHarness({ slots: [PUBLIC_SLOT, busy(2), busy(3)] }))
      .rejects.toThrow(/remove a channel in the MeshCore app/);
  });
});
