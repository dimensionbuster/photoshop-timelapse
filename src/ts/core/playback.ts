import { storage as uxpStorage } from "uxp";
import type { UxpFileEntry } from "uxp";
import { listFrameEntries } from "./storage";

const LRU_LIMIT = 20;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

export interface PlaybackSession {
  load(): Promise<number>;
  frameAt(index: number): Promise<string | null>;
  frameCount(): number;
}

export function createPlaybackSession(docKey: string, frameGeneration: number): PlaybackSession {
  let entries: UxpFileEntry[] = [];
  const cache = new Map<number, string>(); // index -> data URL, small LRU so scrubbing stays smooth

  async function load(): Promise<number> {
    entries = await listFrameEntries(docKey, frameGeneration);
    cache.clear();
    return entries.length;
  }

  async function frameAt(index: number): Promise<string | null> {
    if (index < 0 || index >= entries.length) return null;
    const cached = cache.get(index);
    if (cached) return cached;

    const entry = entries[index];
    if (!entry) return null;
    const buffer = (await entry.read({ format: uxpStorage.formats.binary })) as ArrayBuffer;
    const dataUrl = `data:image/jpeg;base64,${arrayBufferToBase64(buffer)}`;

    if (cache.size >= LRU_LIMIT) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(index, dataUrl);
    return dataUrl;
  }

  function frameCount(): number {
    return entries.length;
  }

  return { load, frameAt, frameCount };
}
