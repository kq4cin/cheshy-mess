import type { PersistedState, Profile } from '../types';
import { uniqueId } from './protocol';

const DATABASE_NAME = 'meshchess';
const STORE_NAME = 'state';
const STATE_KEY = 'current';
const LOCAL_STORAGE_KEY = 'meshchess-state-v1';
const SESSION_PROFILE_KEY = 'meshchess-profile-v1';

let databasePromise: Promise<IDBDatabase> | null = null;

export function createDefaultState(): PersistedState {
  return {
    profile: createProfile(),
    games: [],
    challenges: [],
    peers: [],
    results: [],
    chats: [],
    outbox: [],
    seen: [],
  };
}

function createProfile(): Profile {
  return {
    id: uniqueId('player'),
    name: `Guest ${Math.floor(1000 + Math.random() * 9000)}`,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB open was blocked'));
  });
  return databasePromise;
}

async function readStoredState(): Promise<PersistedState | null> {
  try {
    const database = await openDatabase();
    return await new Promise<PersistedState | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
      request.onsuccess = () => resolve(normalizeState(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read IndexedDB'));
    });
  } catch {
    try {
      const value = globalThis.localStorage?.getItem(LOCAL_STORAGE_KEY);
      return value ? normalizeState(JSON.parse(value)) : null;
    } catch {
      return null;
    }
  }
}

function normalizeState(value: unknown): PersistedState | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<PersistedState>;
  if (!candidate.profile || typeof candidate.profile.id !== 'string' || typeof candidate.profile.name !== 'string') {
    return null;
  }
  return {
    profile: candidate.profile,
    games: Array.isArray(candidate.games) ? candidate.games : [],
    challenges: Array.isArray(candidate.challenges) ? candidate.challenges : [],
    peers: Array.isArray(candidate.peers) ? candidate.peers : [],
    results: Array.isArray(candidate.results) ? candidate.results.slice(0, 20) : [],
    chats: Array.isArray(candidate.chats) ? candidate.chats : [],
    outbox: Array.isArray(candidate.outbox) ? candidate.outbox : [],
    seen: Array.isArray(candidate.seen) ? candidate.seen.slice(-2000) : [],
  };
}

function sessionProfile(): Profile | null {
  try {
    const value = globalThis.sessionStorage?.getItem(SESSION_PROFILE_KEY);
    if (!value) return null;
    const profile = JSON.parse(value) as Partial<Profile>;
    if (typeof profile.id !== 'string' || !profile.id || typeof profile.name !== 'string') return null;
    return { id: profile.id, name: profile.name };
  } catch {
    return null;
  }
}

function storeSessionProfile(profile: Profile): void {
  try {
    globalThis.sessionStorage?.setItem(SESSION_PROFILE_KEY, JSON.stringify(profile));
  } catch {}
}

export async function loadState(): Promise<PersistedState> {
  const stored = await readStoredState();
  const state = stored ?? createDefaultState();
  const profile = sessionProfile() ?? createProfile();
  storeSessionProfile(profile);
  const loaded = { ...state, profile };
  await saveState(loaded);
  return loaded;
}

export async function saveState(state: PersistedState): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save IndexedDB'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB save was aborted'));
    });
  } catch {
    globalThis.localStorage?.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
  }
}
