/**
 * Line icons (24 × 24, 1.8 stroke, round joins), drawn for Sirna so the
 * app needs no icon package. Colour follows `currentColor`.
 */
import { type SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconToday = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="3.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <circle cx="9" cy="14.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="14.5" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPlan = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
  </Svg>
);

export const IconProjects = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8.5V18a2.5 2.5 0 0 0 2.5 2.5h12a2.5 2.5 0 0 0 2.5-2.5v-7.5A2.5 2.5 0 0 0 18 8H11l-2-2.5H6A2.5 2.5 0 0 0 3.5 8.5Z" />
    <path d="M6.5 5.5V5a2 2 0 0 1 2-2h3l1.5 2" />
  </Svg>
);

export const IconMoney = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5Z" />
    <path d="M20 10h-4a2 2 0 0 0 0 4h4" />
    <circle cx="16.2" cy="12" r=".6" fill="currentColor" />
  </Svg>
);

export const IconDashboard = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3.5h7.5L19.5 8.5v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" />
    <path d="M14 3.5V9h5.5" />
    <path d="M9 17v-3M12 17v-5M15 17v-2" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8l1.6 1.9 2.5-.3.9 2.3 2.3.9-.3 2.5 1.9 1.6-1.9 1.6.3 2.5-2.3.9-.9 2.3-2.5-.3L12 21.2l-1.6-1.9-2.5.3-.9-2.3-2.3-.9.3-2.5L2.8 12l1.9-1.6-.3-2.5 2.3-.9.9-2.3 2.5.3Z" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10Z" />
  </Svg>
);

export const IconArrowUpRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 17 17 7M8 7h9v9" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
);

export const IconDots = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h16M7 20v-6M12 20V8M17 20v-9" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const IconExpand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" />
  </Svg>
);

/**
 * Sirna's mark: a yellow rounded square with a slot at the top-right, a check
 * and a seed (src-tauri/icons/source/sirna.svg draws the app icon from it).
 */
export function Logo({ size = 34 }: { size?: number }) {
  // The slot (as wide as the check, round inner end) runs from just past the
  // seed out through the top-right corner; matches src-tauri/icons/source/sirna.svg.
  const id = "sirna-slot";
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <defs>
        <mask id={id}>
          <rect width="1024" height="1024" fill="#fff" />
          <path d="M919 203 L1150 -28" stroke="#000" strokeWidth="118" strokeLinecap="round" />
        </mask>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="220" fill="#ffb413" mask={`url(#${id})`} />
      <path
        d="M296 534 L448 686 L700 432"
        fill="none"
        stroke="#141414"
        strokeWidth="118"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="818" cy="304" r="60" fill="#141414" />
    </svg>
  );
}

export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 5.5 18.5 9.5M4 20l1-4.5L15.8 4.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L8.5 19Z" />
  </Svg>
);
