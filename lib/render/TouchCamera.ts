import type { Vec2 } from "../peel/PeelSimulation";
import type { PeelBounds } from "./PeelFraming";

export const TOUCH_CAMERA_QUERY = "(max-width: 950px) and (pointer: coarse)";
export const TOUCH_GESTURE_SLOP = 8;
export const MAX_MANUAL_ZOOM = 3.25;
const KEY = "peel.touchCamera";

export const TOUCH_CAMERA_MODES = {
  focus: { label: "Tap to focus", hint: "Tap or start peeling a small piece to zoom. Tap empty space to zoom out." },
  fit: { label: "Tighter fit", hint: "Fill more of the screen while keeping the whole sticker in view." },
  manual: { label: "Manual zoom", hint: "Pinch or use + and − to zoom. Pan with two fingers between peels." },
} as const;

export type TouchCameraMode = keyof typeof TOUCH_CAMERA_MODES;
export type TouchCameraPreference = { mode: TouchCameraMode; miniMap: boolean; followCurl: boolean };
export const DEFAULT_TOUCH_CAMERA: TouchCameraPreference = { mode: "focus", miniMap: false, followCurl: false };
export type TouchCameraView = { focused: boolean; canFocus: boolean; zoom: number };
export const DEFAULT_TOUCH_VIEW: TouchCameraView = { focused: false, canFocus: false, zoom: 1 };

export function readTouchCamera(): TouchCameraPreference {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return {
      mode: Object.hasOwn(TOUCH_CAMERA_MODES, saved?.mode) ? saved.mode : DEFAULT_TOUCH_CAMERA.mode,
      miniMap: saved?.miniMap === true,
      followCurl: saved?.followCurl === true,
    };
  } catch { return DEFAULT_TOUCH_CAMERA; }
}

export function saveTouchCamera(preference: TouchCameraPreference) {
  try { localStorage.setItem(KEY, JSON.stringify(preference)); } catch { /* Storage is optional. */ }
}

export type ManualView = { center: Vec2; zoom: number };

export function moveManualView(
  view: ManualView, previous: Vec2, next: Vec2, factor: number, overviewUnitsPerPixel: number, bounds: PeelBounds,
): ManualView {
  const zoom = Math.max(1, Math.min(view.zoom * factor, MAX_MANUAL_ZOOM));
  if (zoom === 1) {
    return { center: { x: (bounds.left + bounds.right) / 2, y: (bounds.bottom + bounds.top) / 2 }, zoom };
  }
  const center = {
    x: view.center.x + overviewUnitsPerPixel * (previous.x / view.zoom - next.x / zoom),
    y: view.center.y + overviewUnitsPerPixel * (previous.y / view.zoom - next.y / zoom),
  };
  return {
    center: {
      x: Math.min(bounds.right, Math.max(bounds.left, center.x)),
      y: Math.min(bounds.top, Math.max(bounds.bottom, center.y)),
    },
    zoom,
  };
}
