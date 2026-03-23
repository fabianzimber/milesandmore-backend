# Logo Background Fix — Handoff Instructions

## Target repo
`https://github.com/fabianzimber/milesandmore-web.git`

## Branch
`claude/fix-logo-background-white-QNl94`

## What to do
1. Clone the repo (or use an existing checkout)
2. Create the branch: `git checkout -b claude/fix-logo-background-white-QNl94`
3. Apply the patch: `git apply .claude-handoff/logo-bg-white.patch`
4. Commit and push to `claude/fix-logo-background-white-QNl94`

## What the patch does
- Adds a white `<rect>` background to `public/logo.svg`
- Adds `bg-white` class to logo `<Image>` elements in:
  - `src/components/leaderboard/LeaderboardPageClient.tsx`
  - `src/components/commands/CommandsPageClient.tsx`
  - `src/components/admin/AdminDashboard.tsx`
