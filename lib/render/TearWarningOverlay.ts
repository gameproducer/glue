import type { Vec2 } from "../peel/PeelSimulation";

export const CREASE_START_RISK = 0.62;
export const GESTURE_START_RISK = 0.82;

const RELEASE_HINT_LIMIT = 3;
let releaseHintsShown = 0;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Keeps the recovery gesture beside the pointer and clear of the player's finger. */
export class TearWarningOverlay {
  private readonly overlay = document.createElement("div");
  private readonly gesture: HTMLDivElement;
  private readonly hint: HTMLSpanElement;
  private readonly arrow: SVGPathElement;
  private showReleaseHint: boolean | null = null;

  constructor(host: HTMLElement) {
    this.overlay.classList.add("tear-warning-overlay");
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.innerHTML = `
      <div class="tear-warning-gesture">
        <span class="tear-warning-emoji">⚠️</span>
        <svg class="tear-warning-redirect" width="24" height="24" viewBox="-12 -12 24 24"
          fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M-8 0H8M3-5l5 5-5 5" />
        </svg>
        <span class="tear-warning-hint" hidden>Let go!</span>
      </div>`;
    this.gesture = this.overlay.querySelector(".tear-warning-gesture")!;
    this.hint = this.overlay.querySelector(".tear-warning-hint")!;
    this.arrow = this.overlay.querySelector(".tear-warning-redirect path")!;
    this.hide();
    host.appendChild(this.overlay);
  }

  drawGesture(pointer: Vec2, bounds: DOMRect, redirect: Vec2 | null) {
    this.overlay.hidden = false;
    const action = redirect ? "redirect" : "release";
    if (!redirect && this.showReleaseHint === null) {
      this.showReleaseHint = releaseHintsShown < RELEASE_HINT_LIMIT;
      if (this.showReleaseHint) releaseHintsShown++;
    }
    const showHint = !redirect && this.showReleaseHint === true;
    this.hint.hidden = !showHint;

    const x = pointer.x - bounds.left;
    const y = pointer.y - bounds.top;
    const above = y >= 92;
    const left = x >= bounds.width / 2;
    const sidePadding = Math.min(showHint ? 46 : 24, bounds.width / 2);
    const badgeX = clamp(x + (above ? 0 : left ? -62 : 62), sidePadding, bounds.width - sidePadding);
    const badgeY = clamp(y - (above ? 62 : 0), 24, Math.max(24, bounds.height - (showHint ? 52 : 24)));
    this.gesture.style.transform = `translate(${badgeX}px, ${badgeY}px)`;
    if (this.overlay.dataset.action !== action) this.overlay.dataset.action = action;
    if (redirect) this.arrow.setAttribute("transform", `rotate(${Math.atan2(-redirect.y, redirect.x) * 180 / Math.PI})`);
  }

  hide() {
    this.overlay.hidden = true;
    this.overlay.removeAttribute("data-action");
    this.showReleaseHint = null;
  }

  dispose() {
    this.overlay.remove();
  }
}
