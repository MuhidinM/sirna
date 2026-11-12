import { type Stage, STAGE_NAMES } from "../features/savings/savings";

/**
 * The savings plant (plan §3.13): seed, sprout, small plant, bushy,
 * flowering, tree. It only grows; nothing here can wilt.
 */
export function Plant({ stage, size = 72 }: { stage: Stage; size?: number }) {
  const leaf = (x: number, y: number, flip: boolean, scale = 1) => (
    <path
      key={`${x}-${y}-${flip ? "l" : "r"}`}
      className="plant-leaf"
      transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}
      d="M0 0 C 6 -8, 16 -8, 20 -2 C 14 2, 6 4, 0 0 Z"
    />
  );
  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      className="plant"
      role="img"
      aria-label={STAGE_NAMES[stage]}
    >
      {stage === 5 ? (
        <>
          <rect className="plant-trunk" x="36" y="44" width="8" height="26" rx="2" />
          <circle className="plant-crown" cx="40" cy="30" r="20" />
          <circle className="plant-crown" cx="26" cy="38" r="12" />
          <circle className="plant-crown" cx="54" cy="38" r="12" />
          <circle className="plant-flower" cx="32" cy="24" r="2.5" />
          <circle className="plant-flower" cx="48" cy="30" r="2.5" />
          <line className="plant-ground" x1="16" y1="70" x2="64" y2="70" />
        </>
      ) : (
        <>
          <path className="plant-pot" d="M24 56 H56 L52 74 H28 Z" />
          <rect className="plant-soil" x="24" y="53" width="32" height="4" rx="2" />
          {stage === 0 && <ellipse className="plant-seed" cx="40" cy="52" rx="4" ry="3" />}
          {stage >= 1 && (
            <line
              className="plant-stem"
              x1="40"
              y1="54"
              x2="40"
              y2={[54, 44, 34, 26, 22][stage] ?? 22}
            />
          )}
          {stage >= 1 && [leaf(40, 46, false, 0.6), leaf(40, 46, true, 0.6)]}
          {stage >= 2 && [leaf(40, 38, false, 0.8), leaf(40, 36, true, 0.8)]}
          {stage >= 3 && [leaf(40, 30, false), leaf(40, 28, true), leaf(40, 42, true, 0.9)]}
          {stage >= 4 && (
            <>
              <circle className="plant-flower" cx="40" cy="20" r="5" />
              <circle className="plant-flower-heart" cx="40" cy="20" r="2" />
            </>
          )}
        </>
      )}
    </svg>
  );
}
