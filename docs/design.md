# Sirna's look (replaces plan §3.14's colours)

The reference is the Neura planner dashboard (Dribbble shot 26050193): a dark
frame, an icon rail, dark panels, one big white canvas, cream circles, and
loud pink, yellow, orange and purple used sparingly. The savings tree follows
the plant in Mamuku's "$200k in 2026" card. Colours below were sampled from
the reference images.

## Rules

1. **One scroll per page.** The frame never scrolls; `.app-page` is the only
   scroll container. No `overflow: auto` inside a page except a text field
   or a code block capped at 16 lines.
2. **No sideways scroll at any width from 640 px.** Grids wrap; wide charts
   squeeze (SVG `viewBox` with `preserveAspectRatio`) or wrap into rows.
3. **Three layouts:** wide ≥ 1200 px (rail · side column · canvas), medium
   900–1199 (rail · one column, side panels go below the canvas in two
   columns), narrow < 900 (rail · one column).
4. Colour carries meaning once per screen: **yellow** is "now"/the primary
   action, **pink** is a date or count that needs you, **cream** is a
   neutral chip or day. Everything else is the panel or the canvas.
5. Numbers use tabular figures.

## Tokens

| Token                 | Night                 | Forest                | Use                                  |
| --------------------- | --------------------- | --------------------- | ------------------------------------ |
| `--frame`             | `#0e0e0e`             | `#0f2a17`             | window background, rail              |
| `--panel`             | `#161616`             | `#133c1e`             | dark cards                           |
| `--panel-line`        | `#262626`             | `#1f4a2a`             | 1 px card border                     |
| `--raised`            | `#2a2a28`             | `#2c5036`             | calendar card, hover, inputs on dark |
| `--chip`              | `#30302e`             | `#2c5036`             | unselected pill on dark              |
| `--bar` / `--bar-top` | `#373632` / `#3e3d39` | `#2c5036` / `#365f41` | chart bars (two tones)               |
| `--ink`               | `#f4f2ec`             | `#fef4dc`             | text on dark                         |
| `--ink-2`             | `#a3a29c`             | `#99bea2`             | secondary text on dark               |
| `--ink-3`             | `#6f6e69`             | `#6a9174`             | axis, hints on dark                  |

Shared in both themes:

| Token                        | Value                             | Use                                       |
| ---------------------------- | --------------------------------- | ----------------------------------------- |
| `--canvas`                   | `#ffffff`                         | the white working surface                 |
| `--canvas-2`                 | `#f6f6f4`                         | search field, segmented track, row hover  |
| `--canvas-line`              | `#e6e6e3` (dashed)                | hour lines, dividers on white             |
| `--canvas-ink` / `-2` / `-3` | `#141414` / `#5b5b57` / `#a3a39e` | text on white                             |
| `--cream` / `--cream-ink`    | `#fdf1da` / `#2f2319`             | day circles, selected chip                |
| `--pink`                     | `#f66399`                         | marked days, count badges, + button       |
| `--yellow`                   | `#ffb413`                         | now card, primary button, highlighted bar |
| `--orange`                   | `#ee6300`                         | button on yellow, event card              |
| `--purple`                   | `#bd9af1`                         | event card                                |
| `--mint` / `--mint-ink`      | `#dff1e6` / `#22a45d`             | "add" ghost card                          |

Area colours (blocks, chips): work `--orange`, job hunt `--pink`, coding
`--purple`, experiments `--yellow`, gym `#8fd6a8`, Quran `#8ec5ff`, admin
`--cream`, rest `--raised`. Text on any of them is `#141414`, except white on
orange and pink.

Type: **Bricolage Grotesque** (variable, bundled). Page title 34/700 with the
second part in `--canvas-ink-3` ("June, 2025"); card title 17/600; body 14/450;
small 12/500; numbers `font-variant-numeric: tabular-nums`.

Radii: frame panels 26 px, canvas 28 px, event cards 18 px, pills 999 px,
day circles 50 %. Spacing steps 4/8/12/16/20/24/32. Shadows: none on dark;
event cards on white get `0 1px 0 rgb(0 0 0 / 4%)`.

## Components

- **Rail** (72 px): logo glyph, page icons (40 px, `--ink-3`, active
  `--ink` on `--raised`), a spacer, the pink round **+** (capture), and the
  sun/moon pill that switches Night and Forest.
- **Panel**: `--panel`, 1 px `--panel-line`, radius 26, padding 20. Title
  row: icon in a cream circle (optional), title, sub-line in `--ink-2`, and
  a ↗ or ⋯ action at the right.
- **Canvas**: `--canvas`, radius 28, padding 24. Header: big title, a
  segmented control (track `--canvas-2`, selected `#141414` pill with white
  text), a search pill, and a yellow primary pill at the right.
- **Now card**: `--yellow` panel, time range small at top, a white pill with
  the time left ("48 min") at the right, title 26/700, an orange button and a
  plain text button.
- **Month grid**: 7 columns of 40 px circles; days `--cream`; leading blanks
  dashed `--ink-3` rings; marked days `--pink` and joined into a pill when
  consecutive; arrows and the month name under it.
- **Event card** on the canvas: radius 18, colour by area, a small label in
  60 % ink ("Project"), title 15/700, optional checklist and progress bar.
  Jobs and fixed blocks get a soft gradient header instead of a photo.
- **Ghost card**: dashed `--mint-ink` border on `--mint`, centred + in a
  circle and "Add …" in `--mint-ink`.
- **Bar chart**: two-tone muted bars (`--bar` body, `--bar-top` cap), the
  highlighted bar `--yellow` with diagonal stripes and a cream cap; a dark
  tooltip card with coloured squares.
- **List rows** on dark: 44 px, icon + label + muted suffix; selected row
  `--raised`; a trailing icon on hover.
- **Checkbox**: 18 px rounded square, `--ink-3` ring; checked `--ink` fill
  with a dark tick. **Badge**: 18 px `--pink` circle, white 11/700.
- **Buttons**: primary yellow pill; secondary `--chip` pill on dark, white
  pill on yellow, `--canvas-2` pill on white; icon buttons are 36 px
  squares with radius 12.

## Pages

| Page      | Side column (wide)                             | Canvas                                                                             | Below                                            |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| Today     | month grid · Now card · Loose ends             | "Sunday, 15 Nov": brief lines, Top 3, today's plan as a timeline of event cards    | focus this week (bar chart) · money today (list) |
| Plan      | month grid · this week's outcomes              | segmented tabs (This week, Tasks, Routine, Review, Notes, Kits); the tab's content | —                                                |
| Projects  | —                                              | board of project cards (columns wrap)                                              | —                                                |
| Money     | safe to spend (Now-card style) · accounts list | segmented tabs (Month, Ledger, Pay and bills, Lent, Accounts, Categories)          | —                                                |
| Dashboard | savings tree panel full width on top           | charts in panels                                                                   | —                                                |
| Settings  | status strip as panels                         | forms on the canvas                                                                | —                                                |

## Savings tree

A dark night panel (`#141414` → `#1b1b1b`), faint stars, a grass line along
the bottom, a terracotta pot in the middle, and a stem whose leaves grow with
the share saved: one leaf per 20 %, leaf labels at 25/50/75 % of the target,
"Goal: <target>" above the tip, and the amount saved large in `--yellow` at
the bottom right with "62 % reached" under it. Pure SVG; grows smoothly
(400 ms) when the share changes.
