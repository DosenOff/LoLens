# LoLens

A real-time League of Legends draft companion. LoLens watches your live
champion select and surfaces your own match history against whoever's
being picked or banned — plus how that compares to a real, rank-specific
population baseline. Not generic tier-list advice — your actual numbers,
next to real ones.

![LoLens champion select screen](image.png)

## Status

Core loop is working end-to-end: LoLens runs in the background, detects
League launching, and tracks live champion select (picks, bans, timer,
turn state). For any enemy pick, it shows your personal win rate against
them, broken down by which of your champions you played. For your own
pick, it shows your win rate next to a sampled population baseline
(Emerald/Diamond/Master+) for that champion, that specific matchup, and
synergy with your picked allies.

## How it works

- **Electron** shell for the desktop app, tray icon, and corner overlay
- **League Client API (LCU)** — local, unofficial — for live champion
  select state
- **Riot Web API** — for personal match history, plus a sampled
  rank-specific population baseline (built from Riot's own league/match
  endpoints — no scraping, no third-party data)

### A note on the population baseline

This isn't Riot's own statistic — there isn't one. LoLens samples real
players from specific rank tiers/divisions via `league-v4`, pulls their
recent ranked matches, and counts *only that known-rank player's own
game result* per match (not all 10 participants — the other 9 players'
ranks aren't actually knowable from match data, so counting them would
silently mislabel the sample). This means the numbers are a real but
deliberately modest sample, not a comprehensive statistic — sample sizes
are shown alongside every number so you can judge confidence yourself.

## Running it locally
 
```
npm install
cp .env.example .env   # then fill in your Riot API key and Riot ID
npm start
```
 
To pull your own match history for personal matchup stats:
```
npm run fetch-champion-data
npm run fetch-match-ids
npm run fetch-match-details
```
 
To build the population baseline (rerun anytime to grow the sample):
```
npm run fetch-population-data
```
 
To get real rank emblem art for the overlay's tier badge (one-time setup -
this is a static Riot-hosted asset, not something that needs regenerating
per patch):
```
curl -fL https://static.developer.riotgames.com/docs/lol/ranked-emblems-latest.zip -o ranked-emblems.zip
mkdir -p assets/rank-emblems
unzip ranked-emblems.zip -d assets/rank-emblems
cd "assets/rank-emblems/Ranked Emblems Latest"
for f in Rank=*.png; do
  name=$(echo "$f" | sed -E 's/Rank=(.*)\.png/\1/' | tr '[:upper:]' '[:lower:]')
  mv "$f" "../${name}.png"
done
cd ..
rm -rf "Ranked Emblems Latest" "Tier Wings" "Wings"
```
Without this, the overlay's tier badge falls back to a plain gold diamond
rather than the real emblem - it degrades gracefully, it just won't look
as sharp.

To get the real role icons the overlay shows underneath a portrait while
it's being dragged (one-time setup - these are fixed, patch-independent
assets, not something that needs regenerating per patch):
```
mkdir -p assets/role-icons
BASE="https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions"
for role in top jungle middle bottom utility; do
  curl -fL "$BASE/icon-position-$role.png" -o "assets/role-icons/$role.png"
done
```
Without this, that drag backdrop falls back to the plain TOP/JG/MID/BOT/SUP
text label instead of the icon - again, degrades gracefully rather than
showing a broken image. If CommunityDragon is ever down or this path
changes, browse
https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/
directly to find the current filenames and adjust the curl loop above.

## Roadmap

- [x] Connect to live LCU champion select session
- [x] Pull real match history via Riot API
- [x] Show matchup-specific win rate stats, live, in-app
- [x] Rank-specific population baseline (Emerald/Diamond/Master+)
- [x] Matchup-specific and team-synergy population comparisons
- [ ] Gold differential @15 (requires match timeline data)
- [ ] Packaged .app build
- [ ] Auto-launch at system login (optional)

## Legal

LoLens is not endorsed by Riot Games and does not reflect the views or
opinions of Riot Games or anyone officially involved in producing or
managing League of Legends. League of Legends and Riot Games are
trademarks or registered trademarks of Riot Games, Inc.

The League Client API used here is unofficial and not supported by Riot
for third-party use.