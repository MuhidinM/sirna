/**
 * The savings tree (docs/design.md → Savings tree): a night scene with stars,
 * grass and a pot, and a stem that grows with the share saved. Leaves come
 * one per eighth; the 25/50/75% amounts sit beside the stem where the plant
 * reaches them, and the goal sits above the tip. Pure SVG, deterministic.
 */
import { useEffect, useRef, useState } from "react";

const W = 640;
const H = 300;
/** The sky and the grass are drawn this wide and cropped to the card. */
const WIDE = 1600;
const BASE = 246; // top of the pot
const STEM = 196; // full height at 100%
const CX = W / 2;

/** A small seeded random, so the stars and grass never jump between renders. */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The height the plant has reached at a share (a seedling shows even at 0). */
const reach = (share: number) => STEM * (0.14 + 0.86 * Math.max(0, Math.min(1, share)));

/** The stem's x at a height above the pot: a gentle S. */
const stemX = (up: number) => CX + 7 * Math.sin((up / STEM) * Math.PI * 1.6);

function stemPath(height: number): string {
  const steps = 18;
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const up = (height * i) / steps;
    points.push(`${stemX(up).toFixed(1)},${(BASE - up).toFixed(1)}`);
  }
  return `M${points.join(" L")}`;
}

/** One leaf, pointing right, base at 0,0. */
const LEAF = "M0 0 C 10 -14 30 -20 52 -16 C 40 -2 22 6 0 0 Z";

function Stars({ seed }: { seed: number }) {
  const rand = seeded(seed);
  const sparkles = Array.from({ length: 16 }, () => ({
    x: 20 + rand() * (WIDE - 40),
    y: 14 + rand() * 120,
    r: 2.6 + rand() * 2.6,
  }));
  const dots = Array.from({ length: 70 }, () => ({
    x: rand() * WIDE,
    y: rand() * 190,
    r: 0.5 + rand() * 0.9,
    o: 0.25 + rand() * 0.5,
  }));
  return (
    <g>
      {dots.map((dot, i) => (
        <circle key={i} cx={dot.x} cy={dot.y} r={dot.r} fill="#8b93a1" opacity={dot.o} />
      ))}
      {sparkles.map((star, i) => (
        <path
          key={i}
          className="tree-sparkle"
          style={{ animationDelay: `${(i * 0.7) % 4}s` }}
          d={`M${star.x} ${star.y - star.r * 1.6} Q${star.x} ${star.y} ${star.x + star.r * 1.6} ${star.y} Q${star.x} ${star.y} ${star.x} ${star.y + star.r * 1.6} Q${star.x} ${star.y} ${star.x - star.r * 1.6} ${star.y} Q${star.x} ${star.y} ${star.x} ${star.y - star.r * 1.6} Z`}
          fill="#e2cf98"
        />
      ))}
    </g>
  );
}

function Grass({ seed }: { seed: number }) {
  const rand = seeded(seed + 7);
  const layer = (color: string, tall: number, step: number) => {
    let d = `M0 ${H}`;
    for (let x = 0; x <= WIDE; x += step) {
      const h = tall * (0.45 + rand() * 0.55);
      const lean = (rand() - 0.5) * 8;
      d += ` L${x} ${H} L${x + step / 2 + lean} ${H - h} L${x + step} ${H}`;
    }
    return <path d={`${d} Z`} fill={color} />;
  };
  return (
    <g>
      {layer("#1a2228", 46, 9)}
      {layer("#20292f", 32, 7)}
      {layer("#252f35", 18, 6)}
    </g>
  );
}

function Pot() {
  return (
    <g>
      <ellipse cx={CX} cy={BASE + 2} rx="38" ry="7" fill="#3b2a26" />
      <path
        d={`M${CX - 36} ${BASE} L${CX + 36} ${BASE} L${CX + 28} ${BASE + 40} Q${CX} ${BASE + 46} ${CX - 28} ${BASE + 40} Z`}
        fill="#8a5643"
      />
      <path
        d={`M${CX - 36} ${BASE} L${CX + 36} ${BASE} L${CX + 34} ${BASE + 9} L${CX - 34} ${BASE + 9} Z`}
        fill="#a86a50"
      />
      <path
        d={`M${CX + 6} ${BASE + 10} L${CX + 31} ${BASE + 10} L${CX + 26} ${BASE + 39} Q${CX + 14} ${BASE + 43} ${CX + 4} ${BASE + 44} Z`}
        fill="#6e4335"
        opacity="0.6"
      />
      <ellipse cx={CX} cy={BASE} rx="33" ry="4.5" fill="#2b1f1b" />
    </g>
  );
}

/** Animates a number towards its target over 600 ms (the plant growing). */
function useTween(target: number): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const begin = from.current;
    if (begin === target) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const tick = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - start) / 600);
      const eased = 1 - (1 - t) ** 3;
      const next = begin + (target - begin) * eased;
      from.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

export function SavingsTree({
  share,
  milestones,
  goalLabel,
  seed = 1,
  compact = false,
}: {
  share: number;
  /** Labels for 25, 50 and 75% (e.g. "22,500"). */
  milestones?: [string, string, string];
  /** "Goal: 90,000" above the tip. */
  goalLabel?: string;
  seed?: number;
  compact?: boolean;
}) {
  const grown = useTween(Math.max(0, Math.min(1, share)));
  const height = reach(grown);
  const leaves = Math.min(8, 1 + Math.floor(grown * 8));
  const tipX = stemX(height);
  const tipY = BASE - height;
  const plant = (
    <>
      {!compact && milestones && (
        <g className="tree-marks">
          {milestones.map((label, i) => {
            const at = (i + 1) / 4;
            const up = reach(at);
            const right = i % 2 === 1;
            const x = stemX(up) + (right ? 52 : -52);
            return (
              <text
                key={label + i}
                x={x}
                y={BASE - up + 4}
                textAnchor={right ? "start" : "end"}
                className={grown >= at ? "tree-mark reached" : "tree-mark"}
              >
                {label}
              </text>
            );
          })}
          {goalLabel && (
            <text x={CX} y={BASE - STEM - 18} textAnchor="middle" className="tree-goal">
              {goalLabel}
            </text>
          )}
        </g>
      )}
      <path
        d={stemPath(height)}
        stroke="#86a283"
        strokeWidth="4.5"
        fill="none"
        strokeLinecap="round"
      />
      {Array.from({ length: leaves }, (_, i) => {
        const at = (i + 0.7) / (leaves + 0.4);
        const up = height * Math.min(0.92, at);
        const right = i % 2 === 0;
        const size =
          (0.62 + 0.5 * Math.sin(Math.PI * Math.min(1, at + 0.1))) * (0.75 + grown * 0.45);
        const angle = right ? -28 - i * 3 : 180 + 28 + i * 3;
        return (
          <path
            key={i}
            d={LEAF}
            fill={i % 3 === 1 ? "#8eaa8a" : "#aec3a5"}
            transform={`translate(${stemX(up).toFixed(1)} ${(BASE - up).toFixed(1)}) rotate(${angle}) scale(${size.toFixed(2)})`}
          />
        );
      })}
      {grown >= 0.999 ? (
        <g transform={`translate(${tipX} ${tipY})`}>
          {[0, 72, 144, 216, 288].map((a) => (
            <ellipse
              key={a}
              cx="0"
              cy="-9"
              rx="5"
              ry="9"
              fill="#f6a5c4"
              transform={`rotate(${a})`}
            />
          ))}
          <circle r="5" fill="#ffd34d" />
        </g>
      ) : (
        <g transform={`translate(${tipX} ${tipY})`}>
          <path d={LEAF} fill="#c3d6b8" transform="rotate(-70) scale(0.42)" />
          <path d={LEAF} fill="#aec3a5" transform="rotate(-110) scale(0.36) scale(1 -1)" />
        </g>
      )}
      <Pot />
    </>
  );
  if (compact)
    return (
      <svg
        className="tree-svg compact"
        viewBox={`${CX - 70} 30 140 ${H - 30}`}
        preserveAspectRatio="xMidYMax meet"
        aria-hidden="true"
        focusable="false"
      >
        {plant}
      </svg>
    );
  // Three layers: the sky behind, the plant at its own size, the grass in front.
  return (
    <>
      <svg
        className="tree-svg tree-sky"
        viewBox={`0 0 ${WIDE} ${H}`}
        preserveAspectRatio="xMidYMax slice"
        aria-hidden="true"
        focusable="false"
      >
        <Stars seed={seed} />
      </svg>
      <svg
        className="tree-svg tree-plant"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMax meet"
        aria-hidden="true"
        focusable="false"
      >
        {plant}
      </svg>
      <svg
        className="tree-svg tree-grass"
        viewBox={`0 0 ${WIDE} ${H}`}
        preserveAspectRatio="xMidYMax slice"
        aria-hidden="true"
        focusable="false"
      >
        <Grass seed={seed} />
      </svg>
    </>
  );
}
