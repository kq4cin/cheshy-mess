import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_CHANNEL, hashtagKey, MAX_PACKET_BYTES } from './protocol';
import {
  encodeSerialFrame,
  FRAGMENT_ASSEMBLY_TTL_MS,
  MAX_FRAGMENT_ASSEMBLIES,
  MeshCoreClient,
  RADIO_TEXT_MAX_BYTES,
  SerialFrameParser,
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
});

async function clientHarness(secret = hashtagKey(GAME_CHANNEL)) {
  const received: string[] = [];
  const writes: Uint8Array[] = [];
  const radioTexts: string[] = [];
  const channelSecret = await secret;
  let client: MeshCoreClient;
  client = new MeshCoreClient((frame) => {
    writes.push(frame.slice());
    let response: Uint8Array;
    if (frame[0] === 0x16) response = Uint8Array.of(13, 3, 0, 2);
    else if (frame[0] === 0x01) response = Uint8Array.of(5);
    else if (frame[0] === 0x1f) {
      response = new Uint8Array(50);
      response[0] = 18;
      response[1] = frame[1];
      response.set(new TextEncoder().encode(GAME_CHANNEL), 2);
      response.set(channelSecret, 34);
    } else if (frame[0] === 0x20) response = Uint8Array.of(0);
    else if (frame[0] === 0x0a) response = Uint8Array.of(10);
    else if (frame[0] === 0x03) {
      radioTexts.push(new TextDecoder().decode(frame.subarray(7)));
      response = Uint8Array.of(6);
    } else throw new Error(`Unexpected command ${frame[0]}`);
    queueMicrotask(() => client.handleFrame(response));
  }, {
    onMessage: (text) => received.push(text),
  }, {
    maxChannels: 2,
    fragmentDelayMs: 0,
    syncIntervalMs: 60_000,
  });
  clients.push(client);
  await client.start();
  return { client, received, writes, radioTexts };
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

  it('bounds concurrent assemblies without evicting active messages', async () => {
    const { client, received } = await clientHarness();
    const firstChunk = btoa('x'.repeat(48));
    for (let index = 0; index <= MAX_FRAGMENT_ASSEMBLIES; index += 1) {
      client.handleFrame(channelText(`MCF:assembly${index}:0:2:${firstChunk}`));
    }
    client.handleFrame(channelText(`MCF:assembly0:1:2:${btoa('y')}`));
    client.handleFrame(channelText(`MCF:assembly${MAX_FRAGMENT_ASSEMBLIES}:1:2:${btoa('z')}`));
    expect(received).toEqual(['x'.repeat(48) + 'y']);
  });

  it('expires stale partial assemblies', async () => {
    const { client, received } = await clientHarness();
    vi.useFakeTimers();
    client.handleFrame(channelText(`MCF:stale1:0:2:${btoa('x'.repeat(48))}`));
    vi.advanceTimersByTime(FRAGMENT_ASSEMBLY_TTL_MS + 1);
    client.handleFrame(channelText(`MCF:stale1:1:2:${btoa('y')}`));
    expect(received).toEqual([]);
  });

  it('does not accept a matching channel name with the wrong secret', async () => {
    await expect(clientHarness(Promise.resolve(new Uint8Array(16)))).rejects.toThrow(/No free MeshCore channel slot/);
  });
});
