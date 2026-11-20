import type { Vec2 } from "../peel/PeelSimulation";

export const CREASE_START_RISK = 0.62;
export const GESTURE_START_RISK = 0.82;

const svgNamespace = "http://www.w3.org/2000/svg";
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Screen space cues keep their contrast and size across sticker materials and camera zoom. */
export class TearWarningOverlay {
  private readonly svg = document.createElementNS(svgNamespace, "svg");
  private readonly crease: SVGPathElement;
  private readonly gesture: SVGGElement;
  private readonly arrow: SVGPathElement;

  constructor(host: HTMLElement) {
    this.svg.classList.add("tear-warning-overlay");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.innerHTML = `
      <path class="tear-warning-crease" fill="#fff" stroke="#111" stroke-linejoin="round" />
      <g class="tear-warning-gesture" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
        <circle r="17" fill="#111" stroke="#111" stroke-width="4" />
        <circle r="16" stroke-width="1.5" />
        <path class="tear-warning-hand" transform="translate(-12 -12)" stroke-width="1.55"
          d="M18 11V6a1.5 1.5 0 0 0-3 0v5-7a1.5 1.5 0 0 0-3 0v7-6a1.5 1.5 0 0 0-3 0v8l-2-2a1.7 1.7 0 0 0-2.5 2.3l4.2 5.2A7 7 0 0 0 21 14v-4a1.5 1.5 0 0 0-3 0v1" />
        <path class="tear-warning-arrow" stroke-width="2.2" d="M-8 0H8M3-5l5 5-5 5" />
      </g>`;
    this.crease = this.svg.querySelector(".tear-warning-crease")!;
    this.gesture = this.svg.querySelector(".tear-warning-gesture")!;
    this.arrow = this.svg.querySelector(".tear-warning-arrow")!;
    this.hide();
    host.appendChild(this.svg);
  }

  drawCrease(point: Vec2 | null, angle: number, risk: number) {
    this.svg.style.display = "";
    this.crease.style.display = point ? "" : "none";
    if (!point) return;
    const intensity = clamp((risk - CREASE_START_RISK) / (1 - CREASE_START_RISK), 0, 1);
    const half = 6 + 12 * intensity;
    this.crease.setAttribute("transform", `translate(${point.x} ${point.y}) rotate(${angle})`);
    this.crease.setAttribute("d", `M${-half} 2 Q0 ${-1 - 5 * intensity} ${half} 2 Q0 ${1 - 2 * intensity} ${-half} 2Z`);
    this.crease.setAttribute("stroke-width", String(1.8 + 1.2 * intensity));
  }

  drawGesture(pointer: Vec2 | null, bounds: DOMRect | null, redirect: Vec2 | null) {
    if (!pointer || !bounds) {
      this.svg.removeAttribute("data-action");
      return;
    }
    const x = pointer.x - bounds.left;
    const y = pointer.y - bounds.top;
    const above = y >= 92;
    const left = x >= bounds.width / 2;
    const badgeX = clamp(x + (above ? 0 : left ? -62 : 62), 24, bounds.width - 24);
    const badgeY = clamp(y - (above ? 62 : 0), 24, bounds.height - 24);
    this.gesture.setAttribute("transform", `translate(${badgeX} ${badgeY})`);
    const action = redirect ? "redirect" : "release";
    if (this.svg.dataset.action !== action) this.svg.dataset.action = action;
    if (redirect) this.arrow.setAttribute("transform", `rotate(${Math.atan2(-redirect.y, redirect.x) * 180 / Math.PI})`);
  }

  hide() {
    this.svg.style.display = "none";
    this.svg.removeAttribute("data-action");
  }

  dispose() {
    this.svg.remove();
  }
}
