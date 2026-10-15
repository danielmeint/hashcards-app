# Design

Mockups for the 1.0 UI (`PLAN-1.0.md`, M8). The live canvas, where they can be
viewed and clicked through, is at
https://claude.ai/artifact/QBA9HtpubgxwE8xqsi3LXs (private to Daniel).

`mockups/` holds the source of each artboard. They are plain HTML with inline
styles inside a `<x-dc>` wrapper, so the markup and every colour, size and
spacing value can be read directly:

| File | Screen |
|---|---|
| `Main.dc.html` | Today, phone |
| `CaughtUp.dc.html` | Today when nothing is due, phone |
| `ReviewQuestion.dc.html` | Review, question side, phone |
| `ReviewAnswer.dc.html` | Review, answer side with grade buttons, phone |
| `ReviewSwipe.dc.html` | Review mid-swipe (right = Good, left = Forgot), phone |
| `ReviewDark.dc.html` | Review, code card, dark palette, phone |
| `Stats.dc.html` | Statistics, phone |
| `Settings.dc.html` | Settings, phone |
| `TodayDesktop.dc.html` | Today, 1280 wide |
| `ReviewDesktop.dc.html` | Review, 1280 wide, with keyboard hints |
| `StatsDesktop.dc.html` | Statistics, 1280 wide |

## Tokens

| Token | Light | Dark |
|---|---|---|
| background | `#F7F7F5` | `#111317` |
| surface | `#FFFFFF` | `#1A1D22` |
| border | `#E6E6E2` | `#2A2E35` |
| divider | `#EFEFEC` | `#262A31` |
| text | `#16181D` | `#E8EAED` |
| text muted | `#5F646D` | `#9AA0A8` |
| accent | `#2F62E0` | `#7AA2FF` |
| accent tint | `#EEF2FD` | `#1B2A4A` |
| success | `#2F855A` | `#3FB950` |

Grade buttons (background / text):

| Grade | Light | Dark |
|---|---|---|
| Forgot | `#FCEBE5` / `#A3320A` | `#3A2119` / `#FFB49A` |
| Hard | `#FBF1DE` / `#845508` | `#352A15` / `#F2C77A` |
| Good | `#E2F2E8` / `#1C6541` | `#17311F` / `#8FDDA9` |
| Easy | `#E7EDFC` / `#1F45AA` | `#1B2A4A` / `#A9C1FF` |

Type: the system UI font everywhere, and Source Serif 4 for card content only.
Radii are 22px for the card, 14–16px for buttons and groups, and 999px for
pills. Touch targets are at least 44px.
