import React, { useEffect, useRef, useState } from "react";
import * as controller from "../core/controller";
import type { PlaybackSession } from "../core/playback";
import { frameRect, outputCanvas } from "../core/frame-geometry";

const PLAY_INTERVAL_MS = 1000 / 12;
const LOAD_TIMEOUT_MS = 400;
// Ring of in-DOM <img> layers: one is visible at a time, the rest sit ready
// (or loading) a few frames ahead of playback. UXP's webview has no
// drawImage() on canvas 2d and no decode() on <img> to check readiness up
// front, but load *does* fire reliably on an in-DOM element — so instead of
// starting a frame's load right when it's needed (racing decode against
// LOAD_TIMEOUT_MS, and occasionally losing that race, which is the flicker),
// every non-visible slot is kept a few frames ahead so its load has already
// finished well before it's ever swapped in.
const POOL_SIZE = 3;

interface Props {
  onClose(): void;
  onNoFrames(reason: "no-session" | "no-frames"): void;
  onError(error: unknown): void;
}

function loadInto(el: HTMLImageElement, dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, LOAD_TIMEOUT_MS);
    el.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    el.onerror = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    el.src = dataUrl;
  });
}

interface Slot {
  el: HTMLImageElement | null;
  frameIndex: number | null;
  ready: boolean;
  // Bumped every time the slot is reassigned to a different frame, so a
  // stale in-flight load (the slot got reused before its own load finished)
  // can tell it's obsolete and skip touching the element or the ready flag.
  loadToken: number;
  loadPromise: Promise<void>;
}

function makeSlot(): Slot {
  return { el: null, frameIndex: null, ready: false, loadToken: 0, loadPromise: Promise.resolve() };
}

export function PlaybackPanel({ onClose, onNoFrames, onError }: Props): React.JSX.Element | null {
  const sessionRef = useRef<PlaybackSession | null>(null);
  const indexRef = useRef(0);
  const countRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const nextLoadTokenRef = useRef(0);
  const slotsRef = useRef<Slot[]>(Array.from({ length: POOL_SIZE }, makeSlot));
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [visibleSlot, setVisibleSlot] = useState(0);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  // Track the preview area's size so the stage (latest frame's aspect) can be
  // fitted inside it; frames are placed on that stage in % so they stay
  // aligned at any panel size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      setBox((prev) => (prev && prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [ready]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = controller.openPlayback();
        if (!session) {
          onNoFrames("no-session");
          return;
        }
        sessionRef.current = session;
        const c = await session.load();
        if (cancelled) return;
        if (c === 0) {
          onNoFrames("no-frames");
          return;
        }
        countRef.current = c;
        setCount(c);
        setReady(true);
        await showFrame(0);
      } catch (e) {
        if (!cancelled) onError(e);
      }
    })();
    return () => {
      cancelled = true;
      stopPlaying();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Places the <img> on the stage at its frame's position relative to the
  // latest frame (crop = stage overflow hidden, pad = white stage background).
  // Untracked recordings keep the old contain-fit behavior.
  function applyGeometry(el: HTMLImageElement, frameIndex: number): void {
    const infos = sessionRef.current?.frameInfos() ?? [];
    const info = infos[frameIndex];
    const canvas = outputCanvas(infos);
    const rect = info ? frameRect(info, infos) : null;
    if (!canvas || !rect) {
      el.style.left = "0";
      el.style.top = "0";
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = "contain";
      return;
    }
    el.style.left = `${(rect.x / canvas.w) * 100}%`;
    el.style.top = `${(rect.y / canvas.h) * 100}%`;
    el.style.width = `${(rect.w / canvas.w) * 100}%`;
    el.style.height = `${(rect.h / canvas.h) * 100}%`;
    el.style.objectFit = "fill";
  }

  // Starts loading `frameIndex` into `slot`. Reads the frame *before*
  // touching slot.el (matching the original two-buffer code's ordering) so
  // the very first call — made synchronously on mount, before React has
  // committed the <img> refs — doesn't see a null element and give up; the
  // real disk read is enough of a delay for the refs to land.
  function loadSlot(slot: Slot, frameIndex: number): Promise<void> {
    const session = sessionRef.current;
    slot.frameIndex = frameIndex;
    slot.ready = false;
    const token = ++nextLoadTokenRef.current;
    slot.loadToken = token;
    const promise = (async () => {
      if (!session) return;
      const dataUrl = await session.frameAt(frameIndex);
      if (!dataUrl || slot.loadToken !== token) return;
      const el = slot.el;
      if (!el) return;
      applyGeometry(el, frameIndex);
      await loadInto(el, dataUrl);
    })()
      .catch((e) => onError(e))
      .then(() => {
        if (slot.loadToken === token) slot.ready = true;
      });
    slot.loadPromise = promise;
    return promise;
  }

  // Finds the slot already holding (or loading) `frameIndex`, or claims
  // whichever slot is currently furthest (by frame distance) from it and
  // starts loading there — naturally evicting frames playback has already
  // passed before ones still ahead of it.
  function ensureFrame(frameIndex: number): { slot: Slot; loaded: Promise<void> } {
    const slots = slotsRef.current;
    const existing = slots.find((s) => s.frameIndex === frameIndex);
    if (existing) return { slot: existing, loaded: existing.loadPromise };

    let victim = slots[0]!;
    let worstDistance = -Infinity;
    for (const s of slots) {
      const distance = s.frameIndex == null ? Infinity : Math.abs(s.frameIndex - frameIndex);
      if (distance > worstDistance) {
        worstDistance = distance;
        victim = s;
      }
    }
    return { slot: victim, loaded: loadSlot(victim, frameIndex) };
  }

  function prefetchAhead(from: number): void {
    for (let i = from + 1; i < from + POOL_SIZE && i < countRef.current; i++) {
      ensureFrame(i);
    }
  }

  async function showFrame(i: number): Promise<void> {
    if (!sessionRef.current || i < 0 || i >= countRef.current) return;
    indexRef.current = i;
    setIndex(i);
    const { slot, loaded } = ensureFrame(i);
    await loaded;
    if (indexRef.current !== i) return; // superseded while we were waiting
    setVisibleSlot(slotsRef.current.indexOf(slot));
    prefetchAhead(i);
  }

  function stopPlaying(): void {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPlaying(false);
  }

  function togglePlay(): void {
    if (timerRef.current != null) {
      stopPlaying();
      return;
    }
    setPlaying(true);
    timerRef.current = window.setInterval(() => {
      if (indexRef.current >= countRef.current - 1) {
        stopPlaying();
        return;
      }
      void showFrame(indexRef.current + 1);
    }, PLAY_INTERVAL_MS);
  }

  function handleClose(): void {
    stopPlaying();
    onClose();
  }

  if (!ready) return null;

  const infos = sessionRef.current?.frameInfos() ?? [];
  const canvas = outputCanvas(infos);
  let stageStyle: React.CSSProperties = { position: "absolute", inset: 0 };
  if (canvas && box && box.w > 0 && box.h > 0) {
    const fit = Math.min(box.w / canvas.w, box.h / canvas.h);
    const w = canvas.w * fit;
    const h = canvas.h * fit;
    stageStyle = {
      position: "absolute",
      left: (box.w - w) / 2,
      top: (box.h - h) / 2,
      width: w,
      height: h,
      overflow: "hidden",
      background: "#ffffff",
    };
  }

  const layerStyle = (visible: boolean): React.CSSProperties => ({
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    opacity: visible ? 1 : 0,
  });

  return (
    <div id="playback-section">
      <div id="playback-image" ref={containerRef}>
        <div style={stageStyle}>
        {slotsRef.current.map((_, i) => (
          <img
            key={i}
            ref={(el) => {
              slotsRef.current[i]!.el = el;
            }}
            alt={i === visibleSlot ? "frame preview" : ""}
            aria-hidden={i === visibleSlot ? undefined : true}
            style={layerStyle(i === visibleSlot)}
          />
        ))}
        </div>
      </div>
      <div className="playback-index">
        {index + 1} / {count}
      </div>
      <input
        id="playback-slider"
        type="range"
        min={0}
        max={Math.max(0, count - 1)}
        step={1}
        value={index}
        onChange={(e) => void showFrame(Math.round(Number(e.target.value)))}
      />
      <div className="button-row">
        <button onClick={togglePlay}>{playing ? "정지" : "재생"}</button>
        <button onClick={handleClose}>닫기</button>
      </div>
    </div>
  );
}
