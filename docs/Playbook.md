_OpenFront.io · v33 · mechanics from the game's source (src/core, commit c046d49) · play from strong players' own commentary_

# OpenFront Playbook

_Ported from the artifact on 2026-08-30; this file is now the source of truth. Per the guide's own rule, the bot (`src/core/execution/playbook/`) is the reference for every number: where this text and the bot's defaults disagree, the bot's lab-measured value wins and this file should be updated._

Everything you need to know, phase by phase, for a free-for-all game: what the board looks like, what to do, why it works — with the numbers the game actually runs on — and what strong players say and do. Ranked 1v1 and team games get their own section at the end.

<a id="read"></a>

## How to read this

_the three loops_

OpenFront is three interlocking loops. **Land → cap → troops → land:** every tile raises your troop cap a little; troops grow into the cap on a curve that peaks at 42 % full; troops take land. **Gold → buildings → cap or gold:** everyone earns a flat 1,000 gold a second; cities convert gold into cap (+250,000 a level), ports convert coast into far more gold. **Diplomacy → safe borders → freedom to spend:** an ally is a border you don't have to defend, so every troop and coin goes somewhere useful. Each phase below is about which loop is the bottleneck right now.

> **Numbers in this guide** come from the game's code: costs, cap formulas, combat losses, trade payouts, nuke effects, AI behaviour. They are current for v33. Older guides and wiki pages often quote values that have changed; where that matters it is flagged.

> **"Strong players say"** boxes paraphrase or quote players with ranked, clan and tournament results — Ultimus_Rex (UN), TheBiff, Enzo, Lonely_Millennial, ChampionEver — plus openfront.fyi's v33 guides. Sources with dates are listed at the end.

**Chart: The growth curve.** Troops gained per second against how full your troop cap is, drawn for a 2M cap (x: how full your troop cap is; y: troops gained per second). Formula: (10 + troops^0.73 ÷ 4) × (1 − troops ÷ cap) × 10.

| Cap full | Troops at home | Troops per second |
| -------- | -------------- | ----------------- |
| 0 %      | 0              | 100               |
| 5 %      | 100,000        | 10,704            |
| 10 %     | 200,000        | 16,760            |
| 15 %     | 300,000        | 21,252            |
| 20 %     | 400,000        | 24,657            |
| 25 %     | 500,000        | 27,192            |
| 30 %     | 600,000        | 28,983            |
| 35 %     | 700,000        | 30,110            |
| 40 %     | 800,000        | 30,634            |
| 45 %     | 900,000        | 30,597            |
| 50 %     | 1,000,000      | 30,035            |
| 55 %     | 1,100,000      | 28,976            |
| 60 %     | 1,200,000      | 27,443            |
| 65 %     | 1,300,000      | 25,456            |
| 70 %     | 1,400,000      | 23,030            |
| 75 %     | 1,500,000      | 20,182            |
| 80 %     | 1,600,000      | 16,924            |
| 85 %     | 1,700,000      | 13,266            |
| 90 %     | 1,800,000      | 9,221             |
| 95 %     | 1,900,000      | 4,796             |
| 100 %    | 2,000,000      | 0                 |

**The growth curve, the one chart to memorise.** Troops gained per second against how full your troop cap is (drawn for a 2M cap; the shape is identical at every size). Peak at 42 % full; a sixth of the peak at 95 %; zero at 100 %. Troops inside an attack or a boat do not grow at all. Every phase's troop advice is a consequence of this curve.

<a id="clock"></a>

## The clock

_a timed plan, engine-verified where it can be_

The numbers below are not estimates. Where a rule has a percentage or a frequency, it was found by running the actual game simulation (the same `src/core` code the servers run) headlessly: policies were played against each other on a shared map and the one that claimed more land and kept more troops won. Where a step depends on the map — when your border meets a bot, when a neighbour's port appears — the trigger is stated instead of a time. Maps and neighbours vary; the rules don't.

<a id="runsheet"></a>

### The run sheet

Every step in the order it happens, with the trigger that starts it and the number to use. Each one links to the section that shows why. If you only read one thing, read this; if a step feels wrong in a game, follow the link.

| #   | When                                                                                                            | Do exactly this                                                                                                                                                                                                                     | Watch for                                                                                    | Why                                        |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | Lobby, −0:30                                                                                                    | Score two or three coastal spots: bots within 150 tiles good, any nation within 110 disqualifies, edge or corner behind you, fewer dots than land. Hover the best; shift at the last second away from any dot that landed near you. | Where the dots cluster in the last ten seconds.                                              | [Phase 0](#p0)                             |
| 2   | 0:00                                                                                                            | Slider to **20 %**. One click a second into empty land, aimed down the corridor between you and the nearest neighbour, through any bots in it. Stop clicking if home troops drop under a quarter of cap.                            | A rival's border anywhere on your front = stay at 20 %.                                      | [Phase 1](#p1)                             |
| 3   | 0:05–0:10                                                                                                       | One **20 %** boat to a bot or empty shore across water if one is in view; **1 %** boats to every other empty shore (three boats max).                                                                                               | Nothing across water → skip.                                                                 | [Boats in the opening](#p1)                |
| 4   | When your front only touches free land (≈0:30)                                                                  | Slider to **10 %**, still one click a second. Keep the flow into free land going; a tribe you touch can wait unless a 1.67× click is small (step 6).                                                                                | Home troops climbing every second; back to 20 % the moment a rival touches your front again. | [Growth curves](#p1)                       |
| 5   | The first alliance request, or a nation's border at ~0:45                                                       | **Accept every request; send one to every nation and human touching you** before 3:00, while nations accept on a coin flip.                                                                                                         | Allies list; requests expire.                                                                | [How nations decide](#p3)                  |
| 6   | Free land on your side gone — or earlier, when a tribe's troops × 1.67 is under 15 % of home                    | Smallest tribe first: **1.67×** its troops (2.5× if you need it dead in 14 s). **Re-click the moment the arrows vanish.** Two clicks 10 s apart if one would be over 30 % of home. Ring any tribe you can — rings are free.         | Tribe troops in its tooltip; your slider % from the by-the-minute table.                     | [Phase 2](#p2)                             |
| 7   | Gold 125k (≈2:00)                                                                                               | **City 1**, 15+ tiles behind any border.                                                                                                                                                                                            | Cap jumps 250k.                                                                              | [First city](#p2)                          |
| 8   | Gold 125k after city 1 — facing a foreign port 300+ tiles away if one exists, otherwise any ocean coast by 2:30 | **Port 1**. Ally the partner's owner. Don't wait for a partner: nations have ports by minute 3–5 and yours pays from the moment they do.                                                                                            | Ships leaving within 12 s.                                                                   | [How ports pay](#p3)                       |
| 9   | Any human or nation attack, or a nation with half your troops on your border                                    | **Defense post (50k)** 5–10 tiles behind that border. Don't counter-attack a small wave; let the post eat it.                                                                                                                       | Posts cover 30 tiles.                                                                        | [Defense posts](#p4)                       |
| 10  | 250k, then 500k                                                                                                 | **City 2, City 3.** Keep eating tribes between purchases; never hit a human or nation.                                                                                                                                              | Troops 40–70 % of cap.                                                                       | [Order of operations](#p2)                 |
| 11  | Three cities, port 1 exists                                                                                     | **Level the port to 3** (250k, 500k). Then port 2 if a second water has a partner, otherwise a **factory** line: factory → anchor city 100 tiles out → cities every 16 tiles on the rail, ally cities nearest the factory.          | Port payback under 2 min; a line pays 2,300/s own, 8,000/s allied.                           | [Build or level?](#levels) · [Rail](#rail) |
| 12  | Troops above 60 % of cap between fights                                                                         | **City level** with every spare 250k–1M.                                                                                                                                                                                            | Growth peaks at 42 % of cap.                                                                 | [Build or level?](#levels)                 |
| 13  | 30 s before any nation alliance expires (10 min after it began)                                                 | Post on that border. If you can't match its troops, **gift it a seventh of its cap**; it renews. Let the weakest neighbour's alliance lapse on purpose — it's your next meal.                                                       | Alliance timer in the panel.                                                                 | [Reputation](#p3)                          |
| 14  | 10:00, three cities, three port levels                                                                          | **Silo (1M)** inland, then hold 750k for a bomb.                                                                                                                                                                                    | —                                                                                            | [Phase 5](#p5)                             |
| 15  | Any unfriendly silo on the map                                                                                  | **SAM (1.5M)** over the city stack, then level 2. Two bombs 9 s apart beat a level-1 SAM.                                                                                                                                           | Silos are visible on the map.                                                                | [SAMs](#p5)                                |
| 16  | Troops at 70 % of cap, a neighbour with fewer troops per tile than you and no post facing you                   | One war at a time: **atom bomb their building cluster**, then send **2× their whole army** from 70 % of cap; re-click; embargo them for the war.                                                                                    | Density in the tooltip: troops ÷ tiles.                                                      | [Phase 4](#p4)                             |
| 17  | Your attack under 0.75× what's left of theirs, or a counter-wave as big as yours appears                        | **Retreat.** 25 % lost is cheaper than 100 %.                                                                                                                                                                                       | Attack troops vs target troops on the arrow.                                                 | [Retreating](#p4)                          |
| 18  | A wave bigger than 15 % of your troops comes in                                                                 | **Counter with the same size** (they cancel), then retreat the counter when the wave is gone.                                                                                                                                       | Only for big waves; posts handle small ones.                                                 | [Running the attack](#p4)                  |
| 19  | Ports paying under 2,000/s each, or 25:00                                                                       | **Stop buying income.** Gold goes to city levels, bombs, MIRV.                                                                                                                                                                      | Ships at sea 400+.                                                                           | [Endgame composition](#comp)               |
| 20  | A neighbour who could MIRV you                                                                                  | Kill or ally them before they have 25M. Keep SAM level 3+.                                                                                                                                                                          | Their gold in the leaderboard.                                                               | [Phase 6](#p6)                             |
| 21  | 25:00+, 7–10M troops, 25M gold                                                                                  | **Launch first** (raises everyone else's MIRV price), wait for the warheads, full-send into the emptied land. Hold at 75 % until MIRV-capable players are dead or allied; take the last 5 % in one push.                            | 80 % of non-fallout land ends the game.                                                      | [The whole plan](#plan)                    |

> **The five habits that do most of the work.** Click once a second, never bigger than your growth can carry. Re-click every attack the moment it stops. Ally everyone in the first three minutes and fortify every border 30 seconds before an alliance lapses. Buy cities until troops sit under 60 % of cap; buy income until minute 25 and not after. Fight one war at a time, at twice the target's army, bomb first, retreat what isn't winning.

### How the opening numbers were found

Two players spawned 40 tiles apart on a 10,000-tile all-plains map, each running one expansion policy, and the engine ran for two minutes. The policy that claimed more of the contested land won; troops were checked to make sure the winner hadn't bankrupted itself.

**Head-to-head duels: the 10 %-every-second player against one rival schedule at a time. Land is tiles claimed at 60 s out of 10,000 contested; troops are home troops at 60 s and 120 s, the 10 %-every-second player first.**

| Rival schedule  | Tiles won by 10 % every 1 s | Tiles won by the rival schedule | Troops at 60 s (10 %/1 s · rival) | Troops at 120 s (10 %/1 s · rival) | Verdict                                         |
| --------------- | --------------------------- | ------------------------------- | --------------------------------- | ---------------------------------- | ----------------------------------------------- |
| 10 % every 3 s  | 6,107                       | 3,893                           | 362k · 348k                       | 474k · 385k                        | Slower clicking loses 60 % more land            |
| 5 % every 1 s   | 5,631                       | 4,369                           | 362k · 360k                       | 456k · 406k                        | Half-size clicks lose land and, later, troops   |
| 20 % every 3 s  | 5,288                       | 4,712                           | 360k · 362k                       | 443k · 420k                        | Bigger, slower: still loses                     |
| 30 % every 5 s  | 5,445                       | 4,555                           | 361k · 358k                       | 449k · 413k                        | Loses                                           |
| 50 % every 10 s | 5,745                       | 4,255                           | 362k · 348k                       | 460k · 401k                        | Loses clearly                                   |
| 30 % every 1 s  | 6,075                       | 3,925                           | 357k · 167k                       | 473k · 387k                        | Spamming: least land _and_ half the troops      |
| 15 % every 1 s  | 4,812                       | 5,188                           | 356k · 325k                       | 424k · 439k                        | Slightly more land, fewer troops early — a wash |
| 5 % every 0.5 s | 4,968                       | 5,032                           | 358k · 360k                       | 430k · 433k                        | Same flow, same result                          |
| 10 % every 2 s  | 5,647                       | 4,353                           | 362k · 359k                       | 457k · 405k                        | Half the flow loses                             |

> **The rule the bot plays: 20 % a second while any rival borders you, 10 % a second once your front is free, never below a quarter of cap at home.** The duels above are two players on empty plains; they show that flow beats click size and that 10 %/s is the efficient rate in a fair race. The real game is a race against Hard nations that open all-in, and there the bot was run for 30 ten-minute games with each schedule: 20 %/10 % survived 24 of 30 with 800k tiles; the all-in "everything above 15 % of cap every 5 s" 22 alive, 705k; 10 %/6 % 24 alive but 553k; 10 % flat 22 alive, 600k. Bigger clicks while contested buy the corridor; the quarter-of-cap floor stops the collapse the 20 %-forever curve shows.

### Boats in the opening

The same engine, a player spawned on a 5,152-tile island on the world map: without a boat it fills the island by 30 s and stalls at a 437k cap forever. With one boat at 5 s carrying 20 % of its troops (5,800) to the nearest mainland shore 48 tiles away, it holds 16,000 tiles at 60 s and 75,000 at 3 minutes. Three boats did no better than one; a bigger boat at 10 s (30 %) did the same as the small one at 5 s; boats at 30 s and 60 s caught up by 3 minutes but were 1,000 tiles behind at 60 s. The land attack you are already running feeds the landing automatically — every click into empty land expands from every border you own, including the beachhead.

- **Send the first boat by 0:05–0:10 if there is anything worth reaching.** Targets in order: a bot on another coast (gold + land nobody else is racing for), an empty island, a far empty shore that a neighbour would otherwise take.
- **20 % is plenty; 10 % works.** A boat costs only what it carries; it lands and becomes a normal attack, and unused troops come back when it runs out of land. The three-boat limit is the constraint, not the troops.
- **A boat to a bot is a bot attack**: bring ≥ 1.67× the bot's troops or it stalls on the beach. A boat to empty land can be 2,000 troops.
- **Boats die to one warship shell** and nobody has a warship in the first minutes — the window closes later, so take the water early.

### Killing a bot, timed

Engine, all-plains map: a bot spawned 50 tiles from the player, both expanding; at 40 s the bot holds 4,235 tiles and 16k troops, the player 11,000 tiles and 63k. The attack is re-sent at the chosen multiple of the bot's _current_ troops every time the previous attack finishes.

| Attack size vs. bot's troops | Bot dead after (attack at 40 s) | Bot dead after (attack at 90 s (bot 10.6k tiles / 48k)) | Note                                                       |
| ---------------------------- | ------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| 2.5×                         | 14 s                            | 17 s                                                    | Fastest; cost per tile the same as 1.67×                   |
| 1.67×                        | 24 s                            | 23 s                                                    | Cheapest per tile (~17 troops, like empty land)            |
| 1×                           | 66 s                            | 44 s                                                    | Works, but the bot grows meanwhile                         |
| 0.5×                         | 217 s                           | 103 s                                                   | Three times the cost per tile; the bot out-grows you       |
| Any size, one click only     | never                           | never                                                   | The attack runs out and the bot regrows; you must re-click |

A bot is eliminated the moment it is attacked while holding fewer than 100 tiles, and its whole treasury (500 gold per second since the game began) is yours. Ringing it first turns the same kill into zero losses.

<a id="p0"></a>

## Phase 0 · Lobby and spawn

_the 30-second spawn phase_

#### The board

Every player and nation is choosing a start tile; bots (tribes) are already scattered as filler. You have 25,000 troops and will get a circle of about 50 tiles, which gives a troop cap of about 120,000. Nothing can attack for the first 5 seconds after the phase ends, and no nukes can fly.

> **Do.** Spawn where there are few players and many bots, with your own stretch of coast and flat land in front of you. Avoid islands, peninsulas that a boat can cut off, and crowded fertile regions. Look for a corner or an interior pocket that only one or two neighbours can reach.

> **Why.** The first six minutes are a race for two finite resources — empty land and bots — and every neighbour is a competitor for both. A crowded start means less of each and a border you must defend before you can afford to. Coast matters because ports are the only serious gold engine and they must sit on your own shoreline; a coast is also a border nobody can walk across. Islands are a trap: land runs out fast, reinforcements arrive by boat (three at a time, one hit point each), and a single enemy warship isolates you.

> **Strong players say.** "Always choose less dense areas, regardless of terrain" (UN clan tutorial). Rex, reviewing three FFA losses: "This is not the meta you want to be island maxing in. It's pretty bad… the life of an island man is quite miserable," and on Crete, "never spawn in there if you want to win." Both ranked-1v1 players conclude position decides the game: "positioning is super important, it pretty much does the whole game" (TheBiff); "the way you win these games is by taking bots for a longer period of time than your neighbour" (Rex).

**Terrain (hold Space in game to see it)**

| Terrain                 | Troop cost per tile (vs. plains) | Time per tile (vs. plains) | Use                                              |
| ----------------------- | -------------------------------- | -------------------------- | ------------------------------------------------ |
| Plains (light green)    | 1×                               | 1×                         | Expand across it; attack through it              |
| Highland / desert (tan) | 1.25×                            | 1.2×                       | Slightly worse to take; slightly better to hold  |
| Mountain (white)        | 1.5×                             | 1.5×                       | Best behind you as a wall; worst in front of you |

_Diagram (two panels of sea and land). Left, position A: "you" in a corner of a landmass on the coast, four bots between you and a single "player" — caption "A: corner, coast, bots between you and your one neighbour". Right, position B: "you" inland in the middle of a landmass with four human players around you and no coast — caption "B: inland, four human neighbours, no coast"._

**Where to spawn.** Bots (tan) are gold and land nobody will contest as hard as a human will; a coast (blue) is both a safe border and a future port. Position A has both; position B has neither and will spend its whole opening defending.

### The spawn scorecard

This is how the lab bot scores every shore tile in the 30-second spawn phase, and it is a fair summary of what the pros do by eye. Score the two or three spots you are considering; take the highest.

| Check                                                            | Points   | Why                                                                                                                                                             |
| ---------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On a coast (an ocean, not a lake)                                | required | A coast is a border nobody walks across, the site of every port, and — under the encirclement rule — the thing that makes you impossible to annex.              |
| Land around you: at least 7 of every 10 tiles within 15 are land | required | Thin peninsulas and islands run out of land by 0:40 and are cut off by one boat.                                                                                |
| A nation's spawn inside 110 tiles                                | veto     | It grows at your speed, has a city by minute 2 and an army by minute 4. Rex spawns "between nations" only on huge maps where he can eat one before it eats him. |
| Each nation within 200 tiles                                     | −4       | Contested land and an alliance you will need to keep renewing.                                                                                                  |
| Each nation within 300 tiles                                     | −1       | A minute-five neighbour.                                                                                                                                        |
| Each tribe within 150 tiles                                      | +3       | Gold and land that only you will contest. "Spawn in between bots" (Enzo).                                                                                       |
| Each tribe within 250 tiles                                      | +1       | Your second wave of meals.                                                                                                                                      |
| A map edge or corner at your back                                | +2       | One less side to defend; the pocket behind you is yours whenever you want it.                                                                                   |
| Humans already sitting on the spot                               | −3 each  | Whoever moves last wins the spot. Pivot at the last second (Enzo does it every game); never spawn on top of someone unless you intend to kill them by 0:30.     |
| Flat green land in front, mountains behind                       | +1       | Plains cost 16 a tile to take, mountains 24; a mountain wall behind you is 1.5× harder for anyone to climb.                                                     |

- **Read the lobby, not just the map.** Watch where the dots cluster in the last ten seconds. A fertile coast with six dots is worse than a plain one with none: Rex's Baikal corner has one of the highest win rates on the map precisely because "people who spawn there want to play as mitochondria" — small, peaceful, and profitable to sit next to.
- **Move at 0:25.** Hover over your first choice, and at the last second shift a few tiles so your first pushes form "weird borders" that wrap a bot or a nation rather than meet a neighbour head-on (Enzo). The spawn circle is placed where your pointer is when the phase ends, not where you first clicked.
- **Islands are a plan, not a spawn.** Enzo's trade-island and pirate-base games are deliberate low-cap, high-gold strategies that need a SAM stack by minute 8 and win one game in five. Rex: "the life of an island man is quite miserable."
- **Nation clusters are for annexation, not neighbours.** On the Europe or Middle East maps Rex spawns next to three or four nations because a landlocked nation surrounded by his land is handed over whole. Do this only where you can reach a coast first.

<a id="p1"></a>

## Phase 1 · The land grab

_0:00 – 2:00_

#### The board

Everyone is expanding into empty land at once. Your cap is tiny and your troops are small, so both are growing fast. The neighbours who spam their whole army will briefly look enormous and then stall.

> **Do.** Slider at **20 %**, one click into empty land every second, for as long as any neighbour's border touches your front. Then drop to **10 %** a second and keep clicking: the flow, not the click size, is what buys land, and every troop left at home compounds. Never click when home troops are under a quarter of cap. Aim the flow toward bots and along the corridor between you and your nearest neighbour; leave the pocket behind you for later. Send one 20 % boat by 0:10 to any bot or empty shore across water, and 1 % boats to every other empty shore you can see. Never let your home count fall: if the troop number on your bar goes down between clicks, you are clicking too big.

> **Why: the loop is cap-limited, so land is what you are buying.** At spawn your cap is ~120k and rises by about 250 per tile; by 1,000 tiles it is ~226k (rising 76 per tile); by 3,000 tiles ~350k. Your troops grow into whatever cap exists — 3,300 a second at 25,000 troops, and faster the more you have — but troops inside an attack do not grow. So each push trades growth for cap, and the trade is only good if the push is small: a 10 % push barely dents growth, while a 50 % push halves it for as long as the troops are away.

**What a push costs in growth (early game, cap 150k)**

| Troops left at home | Growth per second | How you got there                                 |
| ------------------- | ----------------- | ------------------------------------------------- |
| 25,000              | 3,470             | Nothing sent yet                                  |
| 22,500              | 3,250             | One 10 % push                                     |
| 17,500              | 2,830             | One 30 % push                                     |
| 12,500              | 2,300             | One 50 % push                                     |
| 5,000               | 1,310             | Spam-clicked 80 % — and it barely expanded faster |

### Why more troops don't expand faster

Empty land has no defender. Every tile costs a fixed 16 troops on plains (20 highland, 24 mountain) no matter how big the attack is. Attack size affects only speed, and speed hits its ceiling at about 6,600 troops on plains — an amount you will not have to spare for minutes. But the curve is steep at the bottom: 2,500 troops already expand at ~40 % of the ceiling. So a stream of 10 % clicks is a perfectly good expansion, and it has three properties that make it better than one big push:

- **Clicks merge.** A new attack into the same empty region joins the running attack instead of starting a second one. Ten small clicks behave like one attack that is constantly topped up.
- **Leftovers come home free.** When an attack on empty land runs out of tiles, its survivors return with no penalty. Overshooting costs nothing except the growth those troops missed while away.
- **Your home troops stay high**, which is both growth (above) and deterrence: nations in free-for-all never attack anyone with more troops than they have, and humans mostly don't either.

**Chart: Expansion speed vs. troops in the attack** (x: troops in the expansion attack; y: tiles per second, per 100 border tiles). Series: plains, highland, mountain.

| Troops in the attack | Plains | Highland | Mountain |
| -------------------- | ------ | -------- | -------- |
| 250                  | 20     | 20       | 20       |
| 500                  | 30     | 25       | 20       |
| 1,000                | 61     | 50       | 40       |
| 1,500                | 91     | 75       | 60       |
| 2,000                | 121    | 100      | 80       |
| 2,500                | 152    | 125      | 100      |
| 3,000                | 182    | 150      | 120      |
| 4,000                | 242    | 200      | 160      |
| 5,000                | 303    | 250      | 200      |
| 6,000                | 364    | 300      | 240      |
| 6,600                | 400    | 330      | 264      |
| 8,000                | 400    | 400      | 320      |
| 10,000               | 400    | 400      | 400      |
| 12,500               | 400    | 400      | 400      |
| 15,000               | 400    | 400      | 400      |

**Expansion speed vs. troops in the attack** (tiles per second per 100 tiles of border with empty land). Each terrain hits its ceiling — 6,600 troops on plains, 8,000 highland, 10,000 mountain — and 2,000–3,000 troops already gets you a large share of it. Past the ceiling extra troops are idle.

**Chart: Land taken by each opening schedule** (x: seconds; y: tiles held), one player alone on open plains, measured in the engine.

| Seconds | 5% every 1 s | 7% every 1 s | 10% every 1 s | 20% every 1 s | all-in every 5 s (keep 15% cap) |
| ------- | ------------ | ------------ | ------------- | ------------- | ------------------------------- |
| 0       | 49           | 49           | 49            | 49            | 49                              |
| 5       | 393          | 538          | 746           | 1,289         | 475                             |
| 10      | 1,075        | 1,401        | 1,785         | 2,410         | 1,015                           |
| 15      | 1,953        | 2,451        | 2,943         | 3,315         | 2,012                           |
| 20      | 3,070        | 3,728        | 4,258         | 4,118         | 3,093                           |
| 25      | 4,446        | 5,249        | 5,730         | 4,859         | 4,536                           |
| 30      | 6,096        | 7,016        | 7,352         | 5,564         | 6,159                           |
| 35      | 8,030        | 9,031        | 9,116         | 6,241         | 8,055                           |
| 40      | 10,257       | 11,291       | 11,016        | 6,900         | 10,175                          |
| 45      | 12,783       | 13,795       | 13,038        | 7,548         | 12,536                          |
| 50      | 15,605       | 16,531       | 15,174        | 8,190         | 15,127                          |
| 55      | 18,728       | 19,496       | 17,418        | 8,827         | 17,949                          |
| 60      | 22,153       | 22,684       | 19,761        | 9,462         | 20,998                          |
| 65      | 25,878       | 26,088       | 22,195        | 10,097        | 24,272                          |
| 70      | 29,902       | 29,698       | 24,713        | 10,727        | 27,769                          |
| 75      | 34,221       | 33,508       | 27,308        | 11,357        | 31,487                          |
| 80      | 38,717       | 37,487       | 29,976        | 11,987        | 35,423                          |
| 85      | 40,000       | 39,999       | 32,710        | 12,617        | 39,576                          |
| 90      | 40,000       | 40,000       | 35,503        | 13,247        | 40,000                          |
| 95      | 40,000       | 40,000       | 38,283        | 13,877        | 40,000                          |
| 100     | 40,000       | 40,000       | 40,000        | 14,507        | 40,000                          |
| 105     | 40,000       | 40,000       | 40,000        | 15,140        | 40,000                          |
| 110     | 40,000       | 40,000       | 40,000        | 15,775        | 40,000                          |
| 115     | 40,000       | 40,000       | 40,000        | 16,410        | 40,000                          |
| 120     | 40,000       | 40,000       | 40,000        | 17,045        | 40,000                          |

**Land taken by each opening schedule**, one player alone on open plains, measured in the engine. 20 % a second collapses the army and stalls by 0:30; 5–7 % a second overtakes 10 % before 0:45 and is still accelerating when the 10 % player is out of troops.

**Chart: Troops at home under the same schedules** (x: seconds; y: troops at home).

| Seconds | 5% every 1 s | 7% every 1 s | 10% every 1 s | 20% every 1 s | all-in every 5 s (keep 15% cap) | nothing (growth only) |
| ------- | ------------ | ------------ | ------------- | ------------- | ------------------------------- | --------------------- |
| 0       | 23,750       | 23,250       | 22,500        | 20,000        | 18,100                          | 25,000                |
| 5       | 34,483       | 31,150       | 26,571        | 14,834        | 27,510                          | 43,356                |
| 10      | 47,292       | 40,382       | 31,338        | 12,310        | 34,632                          | 63,153                |
| 15      | 61,710       | 50,360       | 36,169        | 10,828        | 44,418                          | 80,914                |
| 20      | 77,339       | 60,755       | 40,892        | 9,912         | 52,989                          | 94,721                |
| 25      | 93,894       | 71,366       | 45,417        | 9,327         | 62,702                          | 104,402               |
| 30      | 111,139      | 82,032       | 49,700        | 8,945         | 72,238                          | 110,730               |
| 35      | 128,891      | 92,632       | 53,717        | 8,693         | 82,168                          | 114,689               |
| 40      | 146,988      | 103,077      | 57,462        | 8,535         | 92,212                          | 117,100               |
| 45      | 165,304      | 113,304      | 60,941        | 8,428         | 102,451                         | 118,544               |
| 50      | 183,731      | 123,264      | 64,159        | 8,361         | 112,831                         | 119,397               |
| 55      | 202,181      | 132,930      | 67,132        | 8,328         | 123,352                         | 119,901               |
| 60      | 220,594      | 142,275      | 69,873        | 8,295         | 133,997                         | 120,198               |
| 65      | 238,898      | 151,287      | 72,402        | 8,283         | 144,757                         | 120,371               |
| 70      | 257,050      | 159,962      | 74,729        | 8,279         | 155,624                         | 120,474               |
| 75      | 275,013      | 168,300      | 76,874        | 8,279         | 166,592                         | 120,524               |
| 80      | 292,719      | 176,294      | 78,851        | 8,279         | 177,649                         | 120,568               |
| 85      | 367,607      | 183,853      | 80,672        | 8,279         | 188,794                         | 120,568               |
| 90      | 468,922      | 292,138      | 82,355        | 8,279         | 190,117                         | 120,568               |
| 95      | 572,338      | 386,293      | 83,907        | 8,280         | 190,269                         | 120,568               |
| 100     | 672,582      | 486,485      | 85,322        | 8,281         | 190,306                         | 120,568               |
| 105     | 765,418      | 587,368      | 160,775       | 8,299         | 190,232                         | 120,568               |
| 110     | 848,060      | 684,016      | 233,239       | 8,312         | 190,070                         | 120,568               |
| 115     | 919,205      | 772,633      | 318,345       | 8,316         | 189,851                         | 120,568               |
| 120     | 978,783      | 850,884      | 412,227       | 8,319         | 189,606                         | 120,568               |

**Troops at home under the same schedules.** Growth is proportional to troops^0.73, so a bigger home count grows faster and can afford a bigger flow: at 1:00 the 5 % player has 220k at home and is sending 11k a second; the 10 % player has 69k and is sending 7k. The 20 % player is pinned at 8k for the whole game.

**What these curves say, and what they don't.** Alone on open land, a smaller flow (5–7 % a second) ends with the most troops and as much land as 10 %, and 20 % a second collapses the army. That is the shape of the trade-off — bigger clicks buy land now at the cost of growth — but it is not the rule, because you are never alone: Hard nations open all-in, and the land they take at 0:40 is gone for the game. Run against them for 30 games, the schedule that wins is **20 % a second while any rival borders you, 10 % once the front is free, with a floor of a quarter of cap at home** (24 of 30 alive, 800k tiles; 10 %/6 % gave 553k). The floor is what keeps you off the red curve above.

_Diagram: "you" on the west of a landmass, a "player" to the north-east, four bots between and around you, sea to the east. A red arrow runs from you toward the neighbour through the bots ("1 · contested corridor first: the bots between you and the neighbour"); dashed black arrows curl back into the pocket bots behind you ("2 · then ring the pocket bots nobody else can reach"); a blue arrow runs to the coast ("3 · reach the coast (un-annexable, ports)"); and a note off the coast reads "4 · a 20 % boat to a bot across water at 0:10"._

**The shape of a good opening.** Red: the first 30 seconds at 10 %, straight down the corridor a neighbour could take. Dashed: the 5 % flow afterwards, wrapping bots so their pocket becomes a bank only you can draw on. Blue: a coast before a neighbour cuts you off from it. The order matters because the corridor is contested now and the pocket is not.

> **Strong players say.** The reported openers cluster low: "start at 10 % and don't spam-click, let the troops build" (Node_acz); "about 30 % every couple of seconds" (Enzo); "I just clicked 20 % now, and then I'm going to spam the 10 %" (TheBiff, ranked 1v1); "wait until ~5k troops for the first attack, then attack in 1k increments" (UN tutorial). openfront.fyi calls 60–70 % "a first-match default, not a universal optimum". Lonely_Millennial on the failure mode: spam-clickers "become the biggest player on the map — and then they're completely out of troops… everybody else takes over them while they're still waiting for their army to recover."

### Where to expand

- **Toward bots and toward the interior.** Land near the map edge or coast nobody else can reach is yours whenever you want it; land between you and a neighbour is contested now. Take the contested corridor first and leave the safe pocket for later.
- **Plains over mountains** — 16 vs. 24 troops a tile and 1.5× the time. The attack itself prefers tiles already surrounded by your land and flat terrain, so it "fills in" bays before it climbs hills.
- **Don't cross into a nation.** Attacking a nation costs 60–100 relation points (of a 200-point range) and they recover at half a point per tick; a hostile nation attacks whoever is attacking it first. See Phase 2.

<a id="p2"></a>

## Phase 2 · Bots and the first cities

_1:30 – 6:00_

#### The board

Your expansion has reached the bots and probably a human. Cap is now 200–400k and your army is filling it. Gold is 100–250k and idle. The players who took bots by surrounding them are pulling ahead; the ones who bled troops into the wilderness are stalling.

> **Do.** Take the free land first; eat tribes when it runs out, or earlier when a 1.67× click is small. Smallest first; ring one when the map lets you (a ring costs nothing), otherwise click and re-click. Spend your first 125k on a **city**, and get to three cities as fast as tribes and gold allow. Stay off the nations; ally them instead. Put a 50k defense post on any border where a human is pushing.

> **Measured: free land first, tribes after — and it is a smaller edge than it looks.** The lab bot was run both ways over 30 ten-minute games (six regions, three spawn placements, Hard and Medium). Waiting for the wilderness to run out before touching tribes gave the same survival (22 of 30 either way) and 16 % more land in total, but 18 of the 30 pairs were identical — no tribe in reach — and of the 12 that differed, waiting won 7 and eating early won 5. A first six-game trial on poor spawns had said the opposite by 17 %; that was noise. The honest rule: **free land first, because it never gets dearer; tribes when the front stops, or earlier if one is cheap — and the difference is small enough that the click size matters more than the order.**

### Bots are the early game's gold

> **Why.** A bot starts with 10,000 troops, has a third of a human's cap, grows at half speed, never builds, and attacks with only 5 % of its troops. You take 30 % fewer losses attacking it than attacking a human. And it banks 500 gold a second from the first tick and never spends any of it: **when you eliminate a bot you receive its whole treasury** — 60k at minute 2, 150k at minute 5, 240k at minute 8. Two bots at minute 5 is a city and most of a port.

**Bots, nations, and you**

|                        | Bot (tribe)                                                                   | Nation                                                   | You                                        |
| ---------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| Starting troops        | 10,000                                                                        | 12.5k – 31k by difficulty                                | 25,000                                     |
| Troop cap              | ⅓ of a human's                                                                | 0.5× – 1.25× by difficulty                               | 1×                                         |
| Troop growth           | ½                                                                             | 0.9× – 1.05×                                             | 1×                                         |
| Gold                   | 500/s, never spent                                                            | 1,000/s, spends it on cities, ports, silos, SAMs         | 1,000/s + ports                            |
| Attacks with           | 5 % of troops, ~every 4–8 s                                                   | waits for 30–60 % of cap, then attacks on a 3–10 s timer | —                                          |
| Buildings              | **none, ever** — anything it captures is marked for deletion and gone in 30 s | yes, and they transfer with the land                     | —                                          |
| Your losses against it | ×0.7                                                                          | ×1                                                       | —                                          |
| Eliminating it pays    | all of its gold                                                               | all of its gold                                          | half of yours, if you ever attacked anyone |

### Encirclement: land and gold for zero troops

Every couple of seconds the game looks at each separate piece of every player's territory. If a piece is bordered entirely by **one** hostile player — no water on its edge, no third player touching it — the whole piece transfers to that player **instantly and without any troop losses**, and if it was the bot's last land, so does the bot's gold. A lake inside the piece does not protect it; a river or sea on its edge does. This is the single highest-value move in the first ten minutes, and strong players build their opening around it.

_Diagram, three cases side by side. Left: a bot ringed entirely by your land — "your land all the way round → transfers to you instantly, 0 losses". Middle: a bot whose territory reaches the coast — "bot touches the coast → no transfer; must be conquered". Right: a bot ringed by you except for a wedge where another player touches it — "another player touches it → no transfer until that contact is gone"._

**The three encirclement cases.** Only a piece whose entire border is yours (and no water) flips. Reach around a bot rather than through it; when two bots are side by side, closing the ring on one often hands you the second "as a little gift" (Biffer).

**The exact rule** (checked every 2 seconds for every player, nations included): the game splits a player's land into connected pieces. The **largest** piece is handed over only if every tile bordering it belongs to _one_ non-allied player — no empty land, no fallout, no ocean shore tile and no map-edge tile anywhere in the piece. Every **smaller** piece is handed over if it touches only owned land (any owners) and has no shore or map-edge tile at all. Two consequences the pros play around: a player who reaches any coast can never be annexed outright ("once we get to the water, getting pinched off will not cause annexation" — Rex), and an atom bomb dropped on the neck of an enemy region cuts off the far part, which then flips to whoever surrounds it the moment your attack closes the ring — Enzo's "bomb split", which took half a base in one hit.

_Diagram: your land wraps a corridor along the coast around three bots; a neighbour sits to the east. Captions: "you own the corridor; the bots behind it are yours later" and "the neighbour can't reach them"._

**Corralling.** Expand _around_ a group of bots that sits between you and a coast or map edge. You now hold a bank of land and gold to draw on later, while the open map is fought over. The mirror image — a neighbour expanding past you toward a bot pocket — is them taking your bank: claim that corridor first.

> **Strong players say.** "Take smaller bots first, don't overspend on troops" (UN). "Bots with a lot of green pixels are usually the easiest and most profitable" (Lonely_Millennial). "You can corral off bots so that no one can take them while you take other bots… you're saving a little honeypot for yourself" (UN). In ranked: "the name of the game is annexations" (Rex), and his loss analysis of an opponent: "he's had multiple opportunities to get annexations and he's kind of looked past them." The failure mode: "I see so many people that blow all their troops and once the wildlands expansion is over, they just don't have any troops to attack the bots."

> **Strong players say.** "Take smaller bots first, don't overspend on troops" (UN). "Bots with a lot of green pixels are usually the easiest and most profitable" (Lonely_Millennial). "You can corral off bots so that no one can take them while you take other bots… you're saving a little honeypot for yourself" (UN). In ranked: "the name of the game is annexations" (Rex), and his loss analysis of an opponent: "he's had multiple opportunities to get annexations and he's kind of looked past them." The failure mode: "I see so many people that blow all their troops and once the wildlands expansion is over, they just don't have any troops to attack the bots."

### Order of operations

- **Small bots first, at 1.67× their troops, re-clicked.** A bot you can eliminate in twenty seconds is pure profit; a big one soaks troops you need for growth. Bots with lots of empty-looking green land are the easiest and most profitable. Whatever the size, send at least 1.67× the bot's current troop count and click again the moment the attack finishes — in the engine a single push never kills a bot (it stalls and the bot regrows), while re-clicked 1.67× kills a 4,000-tile bot in about 24 s at the same cost per tile as empty land.
- **Don't overspend.** Guides repeatedly warn about players who "blow all their troops" on the wilderness and then have nothing left for the bots. The bots are the point; the wilderness is the road to them.
- **Corral a reserve.** If a group of bots sits between you and a map edge or a coast, expand _around_ them so no one else can reach them. You now own a bank you can withdraw from whenever you need land or gold, while your neighbours fight over the open map.
- **Don't get cut off.** The mirror image: a neighbour expanding past you toward a bot pocket is taking your bank. Claim the corridor first.
- **Bots respond to traitors.** A bot will happily attack a neighbour who is flagged as a traitor (see Phase 3). Keep that in mind before you break an alliance next to one.

### How many troops a tribe costs

Against a bot you lose 0.7 × the normal amount per tile: on plains, **16 + 0.3 × its density** per tile when your attack is at least 1.67× its troops (density = its troops ÷ its tiles), **27 + 0.3 × density** at equal size, **54 + 0.3 × density** at half. Bots are always sparse (2–6 troops per tile), so the density term is a rounding error and the cost is essentially the same as empty land. A bot is eliminated as soon as it is attacked while holding fewer than 100 tiles, so you only pay for the tiles down to that point.

**Tribe attack calculator, plains, re-clicking at 1.67× until dead**

| Bot                             | Density | Send per click (1.67× its troops) | Total troops you lose | Clicks (≈) | Time  | Its gold at min 3 / 6 |
| ------------------------------- | ------- | --------------------------------- | --------------------- | ---------- | ----- | --------------------- |
| Small: 1,500 tiles, 8k troops   | 5       | 13.4k                             | ~25k                  | 2          | ~10 s | 90k / 180k            |
| Medium: 4,000 tiles, 16k troops | 4       | 27k                               | ~68k                  | 3          | ~24 s | 90k / 180k            |
| Large: 10,000 tiles, 48k troops | 5       | 80k                               | ~170k                 | 3–4        | ~25 s | 90k / 180k            |
| Any bot, surrounded first       | —       | 0                                 | 0                     | 0          | ≤ 2 s | 90k / 180k            |

Every bot pays the same gold regardless of size — 500 a second since the game began — so the small one is strictly the better deal, and the ring is the best deal of all. At 0.5× its troops the same medium bot costs ~230k and takes over three minutes; at 1× it costs ~110k and a minute.

### What percent to click, by the minute

The slider is a percentage of your home troops, but the target is a fixed number: 1.67× the tribe's troops, or 2.5× if you want it dead in 14 seconds instead of 24. So the right percentage falls every minute as you grow. Tribes on World start with about 20,000 troops on ~1,900 tiles and grow to ~30,000 by 1:00 and 40,000–70,000 by 2:00 if nobody eats them (measured across 30 tribes per game).

| Clock | Your troops (typical) | A tribe's troops | Slider for 1.67× | Slider for 2.5× | How to click it                                                                         |
| ----- | --------------------- | ---------------- | ---------------- | --------------- | --------------------------------------------------------------------------------------- |
| 0:30  | 60k                   | 20k              | 55 %             | 85 %            | Too big. Don't: expand around it instead, or wait.                                      |
| 0:45  | 110k                  | 25k              | 38 %             | 57 %            | Two clicks of 20 % ten seconds apart (they merge); the second lands as the first thins. |
| 1:00  | 230k                  | 31k              | 23 %             | 34 %            | One 25 % click, re-clicked at 25 % the moment the arrows vanish.                        |
| 1:30  | 450k                  | 40k              | 15 %             | 22 %            | One 20 % click; second click only if the bot is still alive at 0:20.                    |
| 2:00  | 750k                  | 55k              | 12 %             | 18 %            | One 20 % click kills it in one go; keep the remainder moving into the next bot.         |
| 3:00+ | 1M+                   | 60–70k           | 10 %             | 15 %            | 10–15 % clicks, one bot after another; the leftovers chain into the next.               |

- **Why 1.67×.** Below it your losses per tile climb steeply (27 a tile at 1×, 54 at 0.5×); above it they don't fall. 2.5× only buys speed.
- **The two-click.** A second click on the same bot merges into the running attack. Use it when one click would be over ~30 % of home: send 20 %, wait ~10 s for the first wave to thin, send 20 % again. Home troops never drop below 60 %, growth stays high, and the bot still dies in under 30 s.
- **The re-click.** A single attack never finishes a bot: it stalls when its remaining troops can't take the next tile and the survivors come home. Watch for the arrows disappearing and click again at the same slider. Two clicks is normal, three for a large one.
- **Bigger is not faster past 2.5×.** Sending half your army at a 20k bot kills it in 14 s instead of 24, and costs you the growth of those troops for the whole trip. The lab bot that attacked bots at 2.5× died in four games of six.

### Click micro

- **The double-tap.** Clicking the same target again while your attack is running doesn't start a second attack — the engine merges the new troops into the existing one. That is how you top up an attack that is running low without retreating it, and why "spam" is only bad because of what it does to your home troops, not because of extra attacks.
- **Re-click on completion, not on a timer.** An attack on a player ends (and its survivors come home) the moment it runs out of reachable enemy tiles for its size. Against a bot that happens every 5–10 s; click again as soon as the arrows disappear. A single click never kills a bot.
- **T and Y** step the attack ratio without moving the pointer; the second press of a build key toggles ×1/×5 for upgrades.
- **Bulk-buying two defense posts in one shot for 50k each** is reported by ranked players; in the current code each construction re-reads the price when it executes, so the second one costs 100k unless both land in the same tick. Treat it as unreliable.
- **1 % boats to a bot across water** are a bot attack, not a claim: the boat must carry 1.67× the bot's troops or it stalls on the beach. Send 1 % boats to _empty_ shores; send 20 % boats to bots.

### Nations: don't

Nations are the AI countries with names and flags. They build cities, ports, silos and SAMs; they grow at full speed; and they remember. Attacking one costs 60–100 relation points (out of a −100…+100 range), "targeting" it costs 40, betraying it costs 100, and relations recover only half a point per tick — about 3½ minutes from hostile back to neutral. A hostile nation attacks whoever is attacking it first, then the weakest neighbour that is already under attack by half its own troop count, then anyone it hates. So a nation you poke and don't kill is a permanent tax on your border.

**An allied nation will still betray you in four cases**, and they are worth knowing because two of them are about position, not strength. On Medium and above a nation breaks an alliance (1) with a player who is at **under 20 % of their troop cap** counting troops out in attacks (Hard and Impossible only) and has fewer troops than the nation; (2) with a player it out-troops **ten to one** (Easy and Medium); (3) with a **traitor** it has at least 0.83× as many troops as; and (4) with **its only bordering player**, if it has three times that player's troops. Case 4 is the boxed-in nation: if you wall a nation in so that you are the only player it touches, and you then fall behind it in troops, it turns on you — the wall you built gives it nowhere else to go. Keep a boxed-in nation either allied and out-trooped, or dead. Nations with no land enemies at all also start boating to the nearest reachable enemy.

The reverse is also true: nations accept alliances readily early (70 % of requests in the first 3 minutes on Medium, 50 % on Hard) and will always ally with someone they consider a threat — on Medium anyone with 2.5× their troops, on Hard anyone with more troops and double their cap. An allied nation is a free wall for five minutes at a time. And because it builds, a nation you eventually take comes with cities and ports that transfer to you and don't raise your prices.

> **Strong players say.** "Do not aggro the nations unless you can take them out immediately… if it says hostile, it's probably going to just be sacking into you forever" (UN). "I always clear the bots first and then I go for the nations" (Enzo). A French tutorial suggests deliberately leaving a small nation alive so it builds cities and ports you take later.

### The first city, and why it comes before a port

> **Why city first.** By minute 2–3 you hold 1,000–3,000 tiles: a cap of 225–350k, filling fast. The next 1,000 tiles of land would add about 40k cap and cost you troops; a 125k city adds 250,000 — as much as tens of thousands of tiles. Since troops are what take bots and hold borders, the first city is the cheapest way to keep the loop turning. The second is 250k, the third 500k, then 1M each; three cities is +750,000 cap for 875k gold.

> **Why not a port yet.** A port earns nothing on its own. It launches ships only to **other players' ports** on the same water, and a route under 300 tiles pays almost nothing (5k a ship at 100 tiles, 14k at 200 — against 91k at 400). At minute 2 there are usually no such partners. When there are, a port is the best building in the game (Phase 3), and if you spawned on an already-busy coast, port first is right. Ranked 1v1 has no other players' ports at all: "early port is diabolically bad — who are you trading with?" (Rex).

**Chart: Troop cap gained per extra tile, by how much land you already hold** (x: tiles you already hold, log scale; y: cap gained per extra tile). Formula: 2000 × 0.6 × tiles^−0.4.

| Tiles you already hold | Cap gained per extra tile |
| ---------------------- | ------------------------- |
| 500                    | 100                       |
| 1,000                  | 76                        |
| 2,000                  | 57                        |
| 5,000                  | 40                        |
| 10,000                 | 30                        |
| 20,000                 | 23                        |
| 50,000                 | 16                        |
| 100,000                | 12                        |
| 200,000                | 9                         |

**Troop cap gained per extra tile, by how much land you already hold.** ~65 per tile at 1,000 tiles, 30 at 10,000, 12 at 100,000. A city level is a flat +250,000 at any size, so past a few thousand tiles cities are the better buy for cap. Land still pays in coast, in building room, in the win condition, and in denying it to others.

**Phase-2 purchases**

| Building       | 1st  | 2nd  | 3rd  | 4th+     | Build time | Effect                                                                                                                                       |
| -------------- | ---- | ---- | ---- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| City           | 125k | 250k | 500k | 1M       | 2 s        | +250,000 troop cap per level. No gold. Upgrading costs the same as the next new one and needs no land.                                       |
| Defense post   | 50k  | 100k | 150k | 200–250k | 5 s        | Attackers within 30 tiles lose 5× as many troops per tile and move 3× slower. Posts don't stack. Destroyed, not captured, if its tile falls. |
| Port / Factory | 125k | 250k | 500k | 1M       | 5 s / 2 s  | Income — see Phase 3. Share one price ladder.                                                                                                |

- **Don't sit on gold.** Gold in the bank does nothing; a city compounds. Every experienced player names hoarding as a mistake they still catch themselves making ("I've been holding on to way too much money").
- **Placement.** A little back from the front, not on a coast or river where a boat can land on it, and never clustered: an atom bomb destroys every building within 30 tiles, so two cities 20 tiles apart are one target. Rex reads opponents' strength by city count and notes that weaker players "aren't zooming out and looking at your larger position" — spread buildings make that harder.
- **Defense posts before the breach.** A 50k post takes 5 s to build and multiplies an attacker's losses by 5 inside a 30-tile radius; strong players note that most opponents build none, "which is why their land falls so fast." Place it slightly behind a border you expect to be hit, so the fight happens inside its radius.

### What to build next: the decision list

Run this list top to bottom every time you have the gold for the next item; the first line whose condition is true is what you buy. Prices are for your first of each; each purchase of the same kind doubles the next up to 1M.

| #   | If…                                                                            | Buy                                                                 | Because                                                                                       |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | A non-bot attack is hitting you, or a nation borders you with half your troops | **Defense post** (50k) behind that border                           | 5× losses for the attacker inside 30 tiles. Cheaper than any counter-attack.                  |
| 2   | You have 125k and no city                                                      | **City 1**                                                          | +250k cap for 125k; the next 1,000 tiles would add 40k.                                       |
| 3   | Another player's port sits 300+ tiles away on your water                       | **Port 1** (125k) on the shore facing it                            | 7,700/s at level 1 on a 400-tile route — the best gold per gold in the game.                  |
| 4   | Fewer than three city levels                                                   | **City** (level up the safest one after the second)                 | Troops win the bot phase and hold borders; three cities is the floor before wars.             |
| 5   | Port 1 exists and is under level 3                                             | **Level the port**                                                  | Each level pays back in under 4 minutes; a level needs no shore and is one fewer bomb target. |
| 6   | No trade partner within 300 tiles, or an ally's cities within 110 tiles        | **Factory** (125k) → anchor city 100 tiles out → cities on the rail | Landlocked income, 2,300/s a line of your own, 8,300/s through an ally's.                     |
| 7   | Troops sit above 60 % of cap between fights                                    | **City level**                                                      | Growth is fastest at 42 % of cap; above 60 % you are wasting growth.                          |
| 8   | Port 1 is level 3+ and a second coast or water body has a partner              | **Port 2**                                                          | New partners, spread against bombs.                                                           |
| 9   | Minute 10, three cities, three port levels, any rival with two cities in reach | **Silo** (1M) inland, then keep 750k for a bomb                     | An atom bomb takes every building within 30 tiles — the cheapest way to open a war.           |
| 10  | Any unfriendly player has a silo                                               | **SAM** (1.5M) over your city stack, then level 2                   | Two bombs 9 s apart beat a level-1 SAM.                                                       |
| 11  | Ports pay under ~2,000/s each (sea full) or minute 25                          | **Stop buying income.** City levels, bombs, MIRV fund.              | Nothing bought after minute 25 pays back before the game ends.                                |

In a typical good spawn that order lands as: city 1 at 2:00 → port 1 at 3:00 → city 2 at 4:30 → port level 2 at 5:30 → city 3 at 7:00 → port level 3 at 8:00 → posts as needed → port 2 or factory at 9:00 → silo at 10–12:00 → SAM when a neighbour's silo appears → city levels with every spare 1M until 25:00.

<a id="levels"></a>

### Build another, or level up?

Price never decides this. The game counts **levels**, not buildings: a level-3 city and three level-1 cities both make your next city cost 1M, and an upgrade costs exactly what a new one would. What differs is everything else — land, exposure, speed, and what a level actually adds for that building.

| Building     | What a level adds                                                                                                                     | What a second building adds                                                                                                                      | Verdict                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| City         | +250,000 troop cap, instantly, on the tile you already hold.                                                                          | The same +250,000 after a 2-second build, on a fresh tile 15+ from every other building; a new rail stop if a factory is in range; a new target. | **Level up**, unless you need the rail stop or a bait city for farming. One atom bomb kills a level-10 city as surely as a level-1, so keep two or three cities spread out and pour the rest of the levels into the safest one, 40+ tiles from any coast. |
| Port         | One more launch attempt every second, one more lottery ticket in every foreign port's draw. Instant.                                  | Its own coast: a different water body, a different set of partners, a spread against bombs and landings. 5-second build.                         | **Level up** the port with the best route (level 3 before you buy a second). **Build another** only for a new water body or a partner the first port can't reach — a port only trades with ports on the same water.                                       |
| Factory      | One more launch attempt per tick, diluted by every level you own. Past level 3 each level costs 1M and pays back in 16–42 minutes.    | Extends the line another 110 tiles with more paying stops, and doubles launches on an existing line for 250k.                                    | **Build another** at the far end of the line. Levels only after the line can't grow.                                                                                                                                                                      |
| Defense post | Nothing — it can't be levelled.                                                                                                       | Another 30-tile radius. Posts don't stack where they overlap.                                                                                    | **Build another**, about 60 tiles apart along a threatened border, so the circles touch.                                                                                                                                                                  |
| SAM          | One more interceptor in flight (its slot starts empty) and range 70 → 81 → 90 → 97 → 102 at level 5, the range ramping in over 4.5 s. | Another 70-tile circle — 3M for the second, the same as two levels.                                                                              | **Level up** to level 2–3 first: a single level-1 SAM is beaten by two bombs fired 9 s apart. **Build another** once level 3, because a hydrogen bomb kills everything within 100 tiles and one SAM can't cover a big empire.                             |
| Missile silo | One more missile in flight from the same spot; each slot reloads in 9 s.                                                              | A second launch point — shorter flights past enemy SAMs, and a silo that survives when the first is bombed. 1M either way.                       | **Level up** for volleys (two bombs at once beat a level-1 SAM); **build another** for reach and survival once you plan to bomb regularly.                                                                                                                |
| Warship      | Can't be levelled.                                                                                                                    | Each patrols its own 100-tile circle; price climbs 250k a ship.                                                                                  | Only more ships.                                                                                                                                                                                                                                          |

- **Levels are instant; new buildings are targets.** Every new building must sit 15 tiles from the others, can be landed on from the sea, and is one more thing a 30-tile atom bomb can take. Stacking levels into one deep, inland city is the safest way to hold troop cap — as long as you never stack all of it in one place.
- **Levels die with the building.** Whatever falls — captured, nuked, or deleted by a bot — takes every level with it, and your next build is priced as if you still owned nothing of it. That is the whole city-farming trick below, and the reason a 10-level city on a border is a gift.
- **Ports are the exception where a second one can be free money:** a second coast reaches partners the first port can't, and each of your ports also draws other players' ships to it.

### The city-farming trick

Your price for the next city is set by the _lower_ of "cities you currently own" and "cities you have ever built". Bots delete any building they capture, but only after a 30-second mark, and a recapture clears the mark. Ranked and team players exploit this: build a city on the border next to a bot that is attacking you; when the bot takes the tile, your owned count drops and the next city is 125k again; build it; then retake the first city within 30 seconds. TheBiff: "we managed to sneak that down to 500k instead of 825." Rex farms nine cities this way in a team game. It needs a bot that is actually attacking you and a corner where you control the timing — and it works because captured buildings never count toward your price, which is also why every building you take from a nation or a human is free.

_Diagram, three panels. 1 · build city C on the bot border (owned 1, built 1). 2 · bot takes it (owned 0) → build the next for 125k. 3 · retake within 30 s: two cities for 250k._

**City farming.** Legal, well known among ranked players, and dependent on a bot that is pushing into you. The 30-second window is the bot's deletion timer; a bot can only mark one building every 30 s.

<a id="p3"></a>

## Phase 3 · Economy and alliances

_5:00 – 12:00_

#### The board

Bots are mostly gone. You have three or so cities, 400k–1M cap, and a border with two to four humans and maybe a nation. Other players' ports are appearing on the coasts. The players who will win the game are the ones whose gold income leaves 1,000/s behind in this window.

> **Do.** Send alliance requests to every neighbour, especially the strongest, and accept the ones you receive. Build a port the moment another player's port exists 300+ tiles away on your water; get to 3–4 ports, then **upgrade** the one facing the busiest water. Keep buying city levels whenever your troops sit above ~60 % of cap. If you are landlocked, build a factory instead and run its line through an ally's cities. Aim to have at least three cities and three ports before you start fighting humans.

### How ports pay

> **Why ports.** Base income is 1,000 gold a second for everyone, always. A level-1 port whose trade partner is 400 tiles away earns about 7,700 a second on top — nearly eight times base — and a level-3 port about 21,000. Nothing else in the game moves the gold number like this.

**Chart: Gold per second from one port vs. route length, one line per level** (x: route length, tiles sailed; y: gold per second). Gold per ship = floor(75,000 ÷ (1 + e^(−0.03 × (tiles − 300))) + 50 × tiles); seconds between launches by level: L1 11.94, L2 6.22, L3 4.34, L5 2.80, L7 2.14, L10 1.65, L15 1.27, L20 1.09, L30 1.00 (levels 30 and 50 coincide).

| Route (tiles) | Level 1 | Level 2 | Level 3 | Level 5 | Level 7 | Level 10 | Level 15 | Level 20 | Level 30 | Base income (1,000/s) |
| ------------- | ------- | ------- | ------- | ------- | ------- | -------- | -------- | -------- | -------- | --------------------- |
| 0             | 1       | 1       | 2       | 3       | 4       | 5        | 7        | 8        | 9        | 1,000                 |
| 100           | 434     | 834     | 1,195   | 1,852   | 2,423   | 3,142    | 4,083    | 4,757    | 5,185    | 1,000                 |
| 200           | 1,135   | 2,179   | 3,124   | 4,841   | 6,335   | 8,216    | 10,674   | 12,437   | 13,556   | 1,000                 |
| 300           | 4,397   | 8,441   | 12,097  | 18,750  | 24,533  | 31,818   | 41,339   | 48,165   | 52,500   | 1,000                 |
| 400           | 7,659   | 14,701  | 21,070  | 32,658  | 42,730  | 55,420   | 72,002   | 83,893   | 91,443   | 1,000                 |
| 500           | 8,360   | 16,047  | 22,999  | 35,648  | 46,642  | 60,493   | 78,594   | 91,572   | 99,814   | 1,000                 |
| 600           | 8,793   | 16,879  | 24,191  | 37,496  | 49,061  | 63,630   | 82,669   | 96,321   | 104,990  | 1,000                 |
| 700           | 9,213   | 17,685  | 25,345  | 39,285  | 51,401  | 66,666   | 86,613   | 100,917  | 109,999  | 1,000                 |
| 800           | 9,631   | 18,489  | 26,497  | 41,071  | 53,738  | 69,696   | 90,550   | 105,504  | 114,999  | 1,000                 |
| 1000          | 10,469  | 20,096  | 28,802  | 44,642  | 58,411  | 75,757   | 98,424   | 114,678  | 124,999  | 1,000                 |
| 1200          | 11,306  | 21,704  | 31,106  | 48,214  | 63,084  | 81,818   | 106,298  | 123,852  | 134,999  | 1,000                 |

**Gold per second from one port vs. route length, one line per level.** The dashed line is the 1,000/s everyone earns anyway. Under 200 tiles every level is worthless; the cliff at 300 lifts all of them at once; beyond 500 each line climbs only gently (50 gold per extra tile per ship). Levels 30 and 50 coincide because a port can't launch more than one ship a second. Allies don't change the payout per ship — an allied partner only makes your ships pick that port more often — so there is no "ally" line for ports.

**Chart: The port levelling curve on a 400-tile route** (x: port level, 400-tile route, sea not full; left y: gold per second, bars; right y: minutes to pay back this level, line).

| Port level | Gold per second | Added by this level | Cost of this level | Minutes to pay back this level |
| ---------- | --------------- | ------------------- | ------------------ | ------------------------------ |
| 1          | 5,300           | 5,300               | 125k               | 0.4                            |
| 2          | 10,200          | 4,900               | 250k               | 0.9                            |
| 3          | 14,900          | 4,700               | 500k               | 1.8                            |
| 4          | 19,500          | 4,600               | 1M                 | 3.6                            |
| 5          | 23,700          | 4,200               | 1M                 | 4.0                            |
| 6          | 27,700          | 4,000               | 1M                 | 4.2                            |
| 7          | 31,600          | 3,900               | 1M                 | 4.3                            |
| 8          | 35,100          | 3,500               | 1M                 | 4.8                            |
| 9          | 38,700          | 3,600               | 1M                 | 4.6                            |
| 10         | 41,900          | 3,200               | 1M                 | 5.2                            |

**The port levelling curve on a 400-tile route: gold per second by level (bars) and how long each level takes to pay for itself (line).** Levels 1–3 pay back in under two minutes; levels 4–10 each cost 1M and pay back in 4–5 minutes. So the rule is simple: **keep levelling while the game has more than twice the payback left** — every level to 10 before minute 20, and none after minute 25. The curve breaks when the sea fills (Phase 6): then a new level adds only your share of a fixed pot, about 1,700/s, and payback stretches to 10 minutes.

- A port tries to launch a ship once a second per level. Each failed try raises the next try's odds, so in practice level 1 launches every ~12 s, level 2 every ~6 s, level 3 every ~4 s, level 5 every ~3 s.
- Each ship sails to another player's port on the same water, chosen by lottery: each candidate gets tickets equal to its level, doubled if it is among the nearest third of candidates _and_ at least 300 tiles away, plus a further level's worth if its owner is your ally and it is 300+ away. Under 300 tiles: base tickets only.
- On arrival **both** port owners receive the full payout, set by tiles sailed: 5k at 100, 14k at 200, 52k at 300, 91k at 400, 100k at 500, 125k at 1,000.
- Your port's level also buys tickets in every other player's lottery, so a tall port attracts their ships and you are paid for those too. One level-3 port beats three level-1 ports on the same coast, and costs less.

**Chart: Gold per ship vs. route length** (x: route length, tiles sailed; y: gold per ship). Formula: floor(75,000 ÷ (1 + e^(−0.03 × (tiles − 300))) + 50 × tiles).

| Route length (tiles) | Gold per ship |
| -------------------- | ------------- |
| 0                    | 9             |
| 100                  | 5,185         |
| 200                  | 13,556        |
| 300                  | 52,500        |
| 400                  | 91,443        |
| 500                  | 99,814        |
| 600                  | 104,990       |
| 700                  | 109,999       |
| 800                  | 114,999       |
| 900                  | 119,999       |
| 1000                 | 124,999       |
| 1100                 | 129,999       |
| 1200                 | 134,999       |

**Gold per ship vs. route length.** A cliff at 300 tiles, most of the value by 450.

**Chart: Ships launched per minute by port level** (x: port level; y: ships launched per minute).

| Port level | < 300 ships at sea map-wide | 400 ships at sea | 500 ships at sea |
| ---------- | --------------------------- | ---------------- | ---------------- |
| L1         | 5.0                         | 3.5              | 2.2              |
| L2         | 9.6                         | 6.8              | 4.3              |
| L3         | 13.8                        | 9.9              | 6.3              |
| L4         | 17.7                        | 12.8             | 8.3              |
| L5         | 21.4                        | 15.6             | 10.2             |
| L6         | 24.8                        | 18.3             | 12.1             |
| L7         | 28.0                        | 20.8             | 13.8             |
| L8         | 31.1                        | 23.2             | 15.5             |
| L9         | 33.7                        | 25.5             | 17.1             |
| L10        | 36.4                        | 27.6             | 18.8             |

**Ships launched per minute by port level.** Three lines for how crowded the seas are: under 300 trade ships at sea map-wide (normal), 400, and 500. Level 1 launches five a minute; level 10 about 36; the engine's ceiling is 60.

**Gold per second from one port, by level and route length**

| Route (tiles) | Level 1 | Level 2 | Level 3 | Level 4 | Level 5 |
| ------------- | ------- | ------- | ------- | ------- | ------- |
| 200           | 1.1k    | 2.2k    | 3.1k    | 4.0k    | 4.8k    |
| 300           | 4.4k    | 8.4k    | 12.1k   | 15.6k   | 18.7k   |
| 400           | 7.7k    | 14.7k   | 21.1k   | 27.1k   | 32.5k   |
| 700           | 9.2k    | 17.7k   | 25.4k   | 32.7k   | 39.1k   |
| 1,000         | 10.5k   | 20.1k   | 28.8k   | 37.1k   | 44.5k   |

_Diagram: a port P on a coast with three distance rings drawn on the sea. Inside the red dashed ring: "under 300 tiles: 5–50k a ship, no bonus tickets". Between the two green rings: "400–700 tiles: 90–110k a ship, the sweet spot". Beyond: "beyond ~700: +50 gold per tile per ship, more ships at sea to lose". Two enemy ports and one bot port are marked on the far shores._

**Port distance.** Distances for the bonus rule are counted as horizontal + vertical tiles; the payout uses tiles actually sailed, which is at least as long. A partner on the far shore is the ideal: it pays well, it can't walk to you, and if allied its ships prefer your port.

_Diagram: the World map (2,000 × 1,000 tiles) drawn to scale as a pixel map, with the nations' spawn points marked — UK, Spain, Italy, Germany, Egypt, Iran, India, USA, Brazil, China, Japan, Australia — and three scale bars beneath it labelled 300 tiles, 400 tiles and 700 tiles._

**How far 400–700 tiles is.** The World map is 2,000 × 1,000 tiles, drawn to scale with the nations' spawn points. Distances are counted as horizontal + vertical tiles: UK → Italy is 143, Spain → Egypt 262 (too close to earn bonus tickets), UK → Iran 436, US → Brazil 490, Germany → India 499, US → UK 539, UK → India 573. On the World map "400–700 tiles" means trading across the Mediterranean and beyond, or across the Atlantic — never with the country next door. Other maps are bigger: Europe is 2,904 × 1,672, so 400 tiles there is roughly Paris → Berlin. For scale, a 10,000-tile mid-game country is about a 100 × 100 square.

- **Ships take time and are exposed.** They sail at 10 tiles a second and pay only on arrival: a 1,000-tile route delivers its first gold 112 s after the port is built, and keeps ~8 of your ships at sea per port level, each capturable by any warship unless it hugs a coast. 400–700 tiles is nearly all the income with a fraction of the exposure.
- **Attacking a player embargoes you both for 5 minutes**, cancelling every ship in flight between you. Don't attack your trade partner.
- **Several of your ports on one coast don't compete** — each launches its own ships — but each raises the price of the next port _or factory_. Upgrade one rather than sprawl.
- **A lake with no foreign port on it is dead water.** Check before you build.

> **Strong players say.** Rex on v32+: "with the current buffs of the ports, it's probably better to just buy ports in most cases." His trade-max corner game: "I've got 13 ports — no one else has as many ports as me" by minute 9, 67 ports by the end. Lonely_Millennial's back-line recipe: "city, port, city, port, city, port — after that, build up to between seven and ten ports. Now your economy is blazing and it's time to build a SAM site and a missile silo." Enzo gifts gold to a neighbour specifically to open a trade route: "this dude, I think we need to start trading with him." openfront.fyi: "routes below 300 tiles are particularly weak; a 420-tile voyage significantly outperforms."

<a id="rail"></a>

### Factories and rail lines

A factory is the income building for anyone without a good sea route, and the only building whose payout depends on **shape**. Every number below was measured in the game engine (30-minute runs on flat land) and matches the formulas in the code.

#### How trains pay

- **A factory turns every city, port and factory within 110 tiles into a rail station** — anyone's, not just yours — and joins them with rails. A city with no factory within 110 tiles is not a station, even if it sits between two of yours.
- **Only factories launch trains.** Each train picks a random paying station on its network (any city or port whose owner is not embargoing you), takes the fewest-stops route, and **pays at every city or port it passes**, including the destination. Factories it passes pay nothing.
- **Each stop pays the train's owner** 10,000 at their own station, 25,000 at any other player's, 35,000 at an ally's — and pays the station's owner the same amount when it isn't you. Stops 1–10 pay in full; stops 11 onward pay 5,000 less each, down to a floor of 5,000.
- **Launch rate.** One level-1 factory launches about 3.4 trains a minute (one every 17.5 s). Levels add launches but every level you own anywhere dilutes the odds of every other level, so income per level falls as you stack them (table below). A factory can never launch more than one train every second.
- Trains move 20 tiles a second and never queue, so rail length and bends cost nothing; a 110-tile line is a 5.5-second trip.
- **Ports are stations too.** A train pays at a port exactly as at a city (10k / 25k / 35k), and a port within 110 tiles of a factory joins the line automatically. A port at the far end of your line earns twice: from every train that reaches it and from its ships.

| Factory level (alone) | Trains per minute | Seconds between trains | Cost of this level (no ports owned) | Gold/s, 7-stop line of your own cities | Payback of this level |
| --------------------- | ----------------- | ---------------------- | ----------------------------------- | -------------------------------------- | --------------------- |
| 1                     | 3.4               | 17.5                   | 125k                                | 2,300                                  | 55 s                  |
| 2                     | 6.0               | 10                     | 250k                                | 4,000                                  | 2.4 min               |
| 3                     | 8.0               | 7.5                    | 500k                                | 5,300                                  | 6 min                 |
| 4                     | 9.6               | 6.3                    | 1M                                  | 6,400                                  | 16 min                |
| 5                     | 10.9              | 5.5                    | 1M                                  | 7,300                                  | 19 min                |
| 6                     | 12.0              | 5.0                    | 1M                                  | 8,000                                  | 23 min                |
| 7                     | 12.9              | 4.6                    | 1M                                  | 8,600                                  | 27 min                |
| 8                     | 13.7              | 4.4                    | 1M                                  | 9,100                                  | 32 min                |
| 9                     | 14.4              | 4.2                    | 1M                                  | 9,600                                  | 36 min                |
| 10                    | 15.0              | 4.0                    | 1M                                  | 10,000                                 | 42 min                |
| 15                    | 17.1              | 3.5                    | 1M                                  | 11,400                                 | —                     |
| 20                    | 18.5              | 3.3                    | 1M                                  | 12,300                                 | —                     |

Two rules set the rate. Two factories at level 1 launch as many trains as one factory at level 2, because the game counts total levels; and each level's price is set by how many ports _and_ factories you own, so a player with four ports pays 1M for a first factory. On an ally's line every payout is 3.5× higher and every payback 3.5× shorter — a level-3 factory pays for itself in under two minutes.

#### Three rules decide the shape

1. **Buildings must be 15 tiles apart**, and a rail can be at most 155 tiles long.
2. **A new station links to its nearest station.** Then it checks every other station within 110 tiles: if any is more than four stops away by rail, it builds a direct rail to it as well. So a plain line of cities can never be more than four stops deep — the fifth city gets a shortcut straight back to the factory.
3. **A building placed on an existing rail (within 3 tiles) splits that rail** and becomes a stop on it, with no shortcut check at all. This is the loophole every good line is built on.

_Diagram, three rows. 1. Factory first (F). 2. Anchor city 100 tiles away — one long rail appears ("≤110 tiles straight-line, rail ≤155 tiles long"). 3. Click cities onto the drawn rail, 16 tiles apart — six cities numbered 1–6 along the rail from the factory: "7 stops from one factory"._

**The build order is the whole trick.** Factory, then the far city, then fill the rail in from the factory outward. Built in any other order — cities first, then the factory — the same seven cities earn 1,100 gold/s instead of 2,400, because the game wires shortcuts back to the factory and most trains pay at one stop. On flat land the rail is straight; where it bends around a lake or mountains it can be up to 155 tiles long and hold two more cities.

#### Which shape earns the most

**Chart: Gold per second from one level-1 factory on a line, measured in the engine** (x: network shape; y: gold per second).

| Network shape                         | Gold/s |
| ------------------------------------- | ------ |
| plain line, 8 cities (shortcut rails) | 889    |
| snapped line, 4 cities                | 1,367  |
| snapped line, 6 cities                | 1,694  |
| snapped line, 7 cities                | 2,383  |
| 2 factories at the ends, 8 cities     | 4,728  |
| 3 factories on the line, 8 cities     | 5,656  |

**Gold per second from one level-1 factory on a line, measured in the engine.** Every train pays once per station it passes, so the value of a line is its length in stops: a plain line stops at four (the shortcut rule), a snapped line at seven, and a second factory at the far end doubles both the launch rate and the stops.

**Chart: How one factory's income grows with each city you add to its line** (x: cities on the line, one level-1 factory at the end; y: gold per second). Formula: 0.0571 × (stops + 1) ÷ 2 × payout per stop.

| Cities on the line | Your own cities (10k a stop) | An ally's cities (35k a stop) | A stranger's cities (25k) | Measured, own cities |
| ------------------ | ---------------------------- | ----------------------------- | ------------------------- | -------------------- |
| 1                  | 571                          | 1,998                         | 1,428                     | —                    |
| 2                  | 856                          | 2,996                         | 2,140                     | —                    |
| 3                  | 1,142                        | 3,997                         | 2,855                     | 994                  |
| 4                  | 1,427                        | 4,994                         | 3,568                     | 1,367                |
| 5                  | 1,713                        | 5,996                         | 4,282                     | —                    |
| 6                  | 1,998                        | 6,993                         | 4,995                     | 1,694                |
| 7                  | 2,284                        | 7,994                         | 5,710                     | 2,383                |

**How one factory's income grows with each city you add to its line.** A train's average payout is (stops + 1) ÷ 2 stations, so income climbs by a straight ~290/s per city of your own and ~1,000/s per ally city; the gold dots are engine measurements. Seven cities is the most one factory can serve in a straight line (110 tiles at 16-tile spacing); beyond that, add a second factory at the far end rather than a level.

- **One straight line, factory at one end.** Not four arms around a central station: the centre is the worst place for the factory, because it is the one station every train leaves from and never pays at. Bends are free.
- **Extend before you upgrade — and know where to stop.** On your own line, stop at level 3 (level 4 costs 1M and pays back in 16 minutes). On an ally's line every payback is 3.5× shorter, so level to 6–8 while more than ten minutes remain. Past level 3, a factory level costs 1M and pays back in 16–40 minutes on your own line. A second level-1 factory at the far end of the line costs 250k, adds 2,400 gold/s (more than upgrading to level 2 does), and lets the line continue another 110 tiles with more cities on it.
- **Cities you would build anyway.** The stations are ordinary cities; each still adds its 250,000 troop cap. Line them up and you pay nothing extra for the rail income. A port at the end of the line is a stop too, and trades by sea as well.
- **Keep the line inside your defended land.** If a station in the middle is captured or nuked, the far end detaches; if it falls to a bot, the bot deletes it 30 seconds later. An enemy station on your line pays that enemy 25,000 per train that reaches it — embargo them and their station drops off your network (and your trains stop there).

#### Build toward allies — and put their stations nearest the factory

**Chart: The same seven-stop line, one level-1 factory, by who owns the stations** (x: who owns the stations; y: gold per second).

| Who owns the stations           | You earn | The station owner earns |
| ------------------------------- | -------- | ----------------------- |
| all your own                    | 2,383    | 0                       |
| all a stranger's                | 5,958    | 5,958                   |
| your 3 near, ally 4 far         | 4,717    | 3,267                   |
| ally 3 near, your 4 far         | 6,008    | 5,075                   |
| all an ally's                   | 8,342    | 8,342                   |
| yours + ally factory at far end | 9,639    | 7,544                   |

**The same seven-stop line, one level-1 factory, by who owns the stations.** An ally's stations pay 3.5× your own, a stranger's 2.5×, and the station's owner earns the same again. Ownership order matters: the stations nearest the factory are passed by almost every train, the far ones by few. Three ally cities next to the factory and four of yours beyond earn 6,000/s; the reverse earns 4,700/s. If the ally builds their own factory at the far end, their trains pay you 35,000 at each of your stations and you both earn about 9,600/s from one level-1 factory each — the best gold-per-cost in the game.

- **Your factory hooks their cities automatically** if they are within 110 tiles, but their cities were built before your rail, so they get wired with shortcuts. Better: anchor your first rail on one of their existing cities (≤110 tiles from your factory), then both of you drop cities onto the drawn rail on your own side of the border, ally's side first.
- **Ask the ally for a factory at their end.** Two factories, one each end, is the doubling; it costs them 125k.
- **Any trading player pays.** Trains pay 25,000 at a non-allied neighbour's stations without any alliance, and pay the neighbour too — fine with a peaceful neighbour, a gift to an enemy. Embargo anyone you are about to fight.

**Chart: Gold per second by factory level** (x: factory level; y: gold per second), from the launch-rate formula rate(level, total levels) = 10 ÷ (10 + (total + 10) × 15 ÷ level), checked against engine runs within 5 %.

| Factory level | 7 stops, your own cities (10k a stop) | 7 stops, a stranger's (25k) | 7 stops, an ally's (35k) | Two factories at this level, 8 own cities |
| ------------- | ------------------------------------- | --------------------------- | ------------------------ | ----------------------------------------- |
| 1             | 2,286                                 | 5,714                       | 8,000                    | 4,737                                     |
| 2             | 4,000                                 | 10,000                      | 14,000                   | 7,826                                     |
| 3             | 5,333                                 | 13,333                      | 18,667                   | 10,000                                    |
| 4             | 6,400                                 | 16,000                      | 22,400                   | 11,613                                    |
| 5             | 7,273                                 | 18,182                      | 25,455                   | 12,857                                    |
| 6             | 8,000                                 | 20,000                      | 28,000                   | 13,846                                    |
| 7             | 8,615                                 | 21,538                      | 30,154                   | 14,651                                    |
| 8             | 9,143                                 | 22,857                      | 32,000                   | 15,319                                    |
| 9             | 9,600                                 | 24,000                      | 33,600                   | 15,882                                    |
| 10            | 10,000                                | 25,000                      | 35,000                   | 16,364                                    |
| 12            | 10,667                                | 26,667                      | 37,333                   | 17,143                                    |
| 15            | 11,429                                | 28,571                      | 40,000                   | 18,000                                    |
| 20            | 12,308                                | 30,769                      | 43,077                   | 18,947                                    |

**Gold per second by factory level**, from the launch-rate formula (checked against engine runs within 5%): a seven-stop line of your own cities, of a stranger's, of an ally's, and a two-factory chain of eight cities where each factory has this level. The curves flatten because every level dilutes the others and no factory launches more than one train a second. Compare a level-1 port on a 400-tile route: about 7,700/s.

#### When to build a factory

- **Landlocked, or no foreign port within 300 tiles of your coast:** a factory line is your economy. Build it from city three onward, when the line already has stops to pay at.
- **Sharing a long border with an ally:** build it even if you have ports. An allied line beats a level-1 port at 400 tiles from level 1 (8,300 vs 7,700/s), and a shared chain beats everything but a level-5+ port.
- **Coastal with good routes and no ally to line up with:** ports first. Your own 7-stop line at level 1 is 2,300/s; the same 125k on a level-1 port earns three times that on a 400-tile route.
- **Ranked 1v1 and team games:** no trade partners and allied borders respectively — a factory is the move in both.

> **Strong players say.** "I don't have enough money for city number three, so I should probably just consider getting a factory" (Rex, inland position); in ranked 1v1, where there are no trade partners, "a factory might be the move." Enzo's late-game regret: "the factories, it's just going to benefit everyone else a lot more" — true when your stations feed strangers' trains; the fix is the embargo, not skipping the factory.

### Alliances: a border you don't have to defend

> **Why.** An alliance is a five-minute contract: neither side can attack the other, your ships prefer each other's ports (3× tickets), trains pay 35k at their stations, and you can donate troops or gold. It costs nothing. In a game where every troop at home is growth and every troop on a border is not, an allied border is the cheapest defense there is — and it lets you fight someone else with a safe back.

| Rule             | What happens                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Duration         | 5 minutes (host-configurable 1–15). Renewal needs both clicks and resets the full duration.                                                                                                                                                                                    |
| Requests         | Last 20 s; 30 s before you can ask the same player again. Accepting sets both relations to +100.                                                                                                                                                                               |
| Expiry           | The alliance ends cleanly. **No traitor status.** Either side can attack at once.                                                                                                                                                                                              |
| Breaking early   | You are a **traitor for 30 s**: everyone attacking you loses only half as many troops, your attacks move 20 % slower, the betrayed player's relation to you is set to the floor, their neighbours' drops by 40, nations refuse you 90 % of the time, and bots will attack you. |
| Attacking anyone | 5-minute mutual embargo (no trade), and any pending alliance request from them is rejected.                                                                                                                                                                                    |
| Nuking an ally   | Breaks the alliance (traitor) if the blast destroys any allied building or hits ~100+ allied tiles. Below that it doesn't.                                                                                                                                                     |

- **Ally the biggest neighbour.** "I like to ally with my biggest neighbours — they're the players most capable of ending my game" (Lonely_Millennial). Enzo allies whoever holds the crown.
- **Accept nearly everything.** "Becoming a traitor is still better than multiple players ganging up on you" (ChampionEver). Competent-looking players are worth allying because "they often build ports" you can trade with; an AFK player with a port is the best partner of all.
- **Let alliances expire; don't break them.** Expiry has no penalty; breaking makes you the map's target for 30 s. Rex on a rival's betrayal: "you didn't need to get a betrayal debuff to do that." The clean move is troops already massed on the border when the timer ends.
- **Keep more troops than your neighbours.** "Just have more troops than any of your neighbours — they're not going to attack you." Nations obey this rule literally.
- **De-escalate.** A heart or handshake emoji to a neighbour who is eyeing you costs nothing; "do not escalate conflict" you can't finish.

#### How nations decide (verified in the code)

Nations are not fickle; they run a fixed checklist, and on Hard it decides most solo games. When you ask a nation for an alliance, or it decides whether to renew one, it accepts if **any** of these holds, in this order:

1. **You are a threat to it:** more troops than it has _and_ a troop cap over twice its own. (Medium: 2.5× its troops.)
2. **It likes you:** relation Friendly (+50 or more), which it accepts 83 % of the time on Hard. Relation starts at 0 and rises by **+50 for a troop gift of at least a seventh of its cap** (a ninth to a seventh, rolled each time; a ninth to an eleventh on Medium). Relation falls by 20 while you embargo it, by 70–80 when you attack it, by 100 if you nuke it, and drifts back toward 0 by 0.05 a tick.
3. **It is early:** in the first 3 minutes a Hard nation says yes half the time regardless (Medium: 70 % in the first 3 minutes; Easy: 90 % in the first 5).
4. **You are its equal:** your troops (plus troops out attacking) are at least 75–85 % of its own, or your land is 85–95 % of its own with at least half its troops.

It refuses outright if you are a traitor (90 %), if you already hold alliances with half the human-or-nation players on the map (Hard; a quarter on Impossible), or if it is in a team game. And it **betrays** an ally on Hard the moment that ally's troops fall under 20 % of their cap while also below the nation's own — the "boxed-in nation" attack from Phase 4 is this rule firing after a bad war.

> **Do, in solo games.** Ally every bordering nation in the first three minutes while the coin-flip is on. Thirty seconds before each five-minute expiry, check rule 4: if you are not within 20 % of that nation's army, either gift it a seventh of its cap (a Hard nation with a 1M cap wants ~145k troops — cheaper than the war) or build two defense posts on that border, because on Hard a nation whose alliance lapses attacks within seconds, with waves the size of your whole army. Never embargo a nation you want to keep: that is −20 relation for nothing.

> **Why counter-attacks are not a defence.** An attack into a player who is attacking you cancels troop for troop, which is the right answer to one big wave. It is the wrong answer to a nation, which sends a wave every 5–6 seconds on Hard: each counter marches on into its land after the cancel and dies there, and the lab bot bled a 1.4M army to nothing in four minutes this way. Cancel only waves that threaten real land (over ~15 % of your troops), retreat the counter the moment the wave is gone, and let defense posts do the rest — behind a post the attacker loses five troops for each of yours.

#### Reputation: how the map judges you

Every nation keeps a private score for you from −100 to +100, and it acts on the band the score falls in: **Hostile** below −50, **Distrustful** below 0, **Neutral** up to 50, **Friendly** at 50 and above. Humans see none of this; it only drives nations and bots. Scores drift back toward zero by half a point a second, so an insult is forgotten in about three minutes and a favour in about three and a half.

| What you do                         | Their score for you                            | Notes                                                                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accept or form an alliance          | set to +100                                    | Both directions.                                                                                                                                                                           |
| Gift troops (allies only)           | +50                                            | Only if the gift is at least a seventh to a ninth of their cap on Hard (an eleventh to a ninth on Medium). Smaller gifts change nothing. One gift per recipient every 10 s.                |
| Gift gold (allies only)             | +5 per chunk, max +100                         | A chunk is 12,500 gold on Hard (25,000 Impossible) and grows with time: doubled at minute 5, tripled at minute 10. Reaching Friendly from zero costs 125k at the start, 375k at minute 10. |
| Attack them                         | −80                                            | −60 Easy, −70 Medium, −100 Impossible. One click is enough to go Hostile from Neutral.                                                                                                     |
| Nuke them or MIRV them              | −100                                           | Straight to the floor.                                                                                                                                                                     |
| Mark them as a target               | −40                                            | The "target" button. It also asks your allies to attack them.                                                                                                                              |
| Embargo them                        | −20 while it lasts                             | Restored when you lift it.                                                                                                                                                                 |
| Break an alliance                   | set to −100, and −40 with their neighbours     | Plus 30 s of traitor status: half defence, 0.8× attack speed, bots attack you, nations refuse you 90 % of the time.                                                                        |
| Ask an ally to help against someone | their score for _you_ −20 per attack they send | Favours are charged, and refused below Friendly.                                                                                                                                           |

**Embargoes follow the score.** A nation stops trading with you the moment its score for you reaches Hostile (−50), and on Hard and Impossible it **never** lifts that embargo — not when the score recovers, not even after it accepts an alliance with you. On Easy and Medium the embargo ends once you are back to Neutral. Rex's complaint is exact: "when you take the alliance of a nation that embargoed you beforehand, you're screwed — it won't un-embargo you." So on Hard, one attack click on a coastal nation costs you that trade partner for the rest of the game.

**What a nation does with the score.** Each attack cycle (every 4.5–6 s on Hard) it runs a fixed priority list and takes the first that applies: **bots** next to it → **whoever nuked it** → **retaliation** against whoever is attacking it → **assisting an ally's target** → **betraying** a collapsing ally → **anyone it rates Hostile** (unless that player has 3× its troops) → **AFK players** → **traitors** → the **weakest neighbour** → islands → donations. So one attack click on a nation, even a probe, moves you to the "hated" slot for the next three minutes and it will keep coming as long as it can afford to; an emoji does nothing to the score. The safest reputation is boring: allied, no embargo, no probes, and a gift before each renewal if you are the weaker side.

### Managing troops in this phase

- Your cap is now large enough that the 42 % rule bites: if your troop bar sits above 60–80 % during quiet moments, buy a city level; if it rarely reaches 50 %, cap isn't your problem — spend on income.
- Rex's mid-game floor: "just going to try and stay over 200,000" at home as a reserve. Enzo's confession: "I'm going definitely too low on my troop levels. I think that's really kind of an issue."
- The cap-overflow rule (Lonely_Millennial): if home troops plus a returning attack exceed the cap, the excess "will simply vanish" — start the next push before the previous one comes back.
- Hotkeys: T and Y step the attack ratio without moving the pointer; a second press of a build key toggles ×1/×5 for upgrades.

<a id="p4"></a>

## Phase 4 · Wars of position

_10:00 – 20:00_

#### The board

The empty land is gone. Everyone's growth is now cap-limited and income-limited, and the only land left is other people's. Alliances are expiring on visible timers. Someone will build the first silo in this window.

> **Do.** Choose targets by what is on their land and how thinly they hold it, not by their troop total. Attack with at least as many troops as the defender's _whole_ army — 1.67× for the cheapest tiles — across the widest border you can, and retreat the moment the ratio falls near 0.5. Time attacks to alliance expiries. Land 1 % boats to create borders. Keep one warship on any coast an enemy could land on. Put defense posts where you expect to be hit, before you are hit.

### Choosing a target

> **Why density decides.** For every tile that changes hands, the defender loses their troop density (troops ÷ tiles) and you lose a fixed amount set by the size of your attack relative to their whole army — 23 per plains tile if your attack is 1.67× their army or more, 38 at equal size, 77 at half or less — plus 0.42 × their density. So against a big, thinly-held empire you lose several times more troops than they do at any attack size: you are buying land, not killing an army, and you should buy it at the cheapest rate and stop. Against a small, dense player every tile costs them more than you, and the fight itself is profitable. Terrain scales both halves of your loss: plains ×0.8, highland ×1.0, mountain ×1.2 — so the same defender at the same density costs you half again as much per mountain tile as per plains tile, and a defense post multiplies the whole figure by five.

**Chart: Troops lost per plains tile vs. the defender's density** (x: defender density, their troops ÷ their tiles; y: troops lost per tile). Your loss = 0.6 × clamp(1 ÷ ratio, 0.6, 2) × 64 + 0.4 × 1.3 × density × 0.8.

| Defender density | Defender loses | You lose, attack ≥ 1.67× their army | You lose, attack = their army | You lose, attack ≤ 0.5× their army |
| ---------------- | -------------- | ----------------------------------- | ----------------------------- | ---------------------------------- |
| 0                | 0              | 23                                  | 38                            | 77                                 |
| 25               | 25             | 33                                  | 49                            | 87                                 |
| 50               | 50             | 44                                  | 59                            | 98                                 |
| 75               | 75             | 54                                  | 70                            | 108                                |
| 100              | 100            | 65                                  | 80                            | 118                                |
| 125              | 125            | 75                                  | 90                            | 129                                |
| 150              | 150            | 85                                  | 101                           | 139                                |
| 175              | 175            | 96                                  | 111                           | 150                                |
| 200              | 200            | 106                                 | 122                           | 160                                |
| 225              | 225            | 117                                 | 132                           | 170                                |
| 250              | 250            | 127                                 | 142                           | 181                                |
| 275              | 275            | 137                                 | 153                           | 191                                |
| 300              | 300            | 148                                 | 163                           | 202                                |

**Troops lost per plains tile vs. the defender's density.** Grey: what they lose. Coloured: what you lose at three attack sizes. You come out ahead only to the right of where your line crosses the grey — roughly 40 troops per tile for an overwhelming attack, 130 for a weak one.

**What strong players look at before they attack**

| Signal                                           | Why it matters                                                                                                    | Who says so                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Someone just "full-sent"                         | Their home troops are near zero and their attack is losing 50 % more per tile than a defender would; hit them now | Rex: "the greatest way to destroy someone's troop quantity"         |
| AFK or disconnected                              | No response; nations pile on too                                                                                  | Rex: "9652 is AFK, which means we can boat in"                      |
| Buildings, no defense posts                      | Free cities and ports at the cheap rate                                                                           | Rex; Enzo: "we're going to cap his one missile silo"                |
| Alliance about to lapse while their army is away | Your border is ready, theirs is empty                                                                             | Rex: "Underscore is about to expire… doesn't have troops right now" |
| Their cap vs. yours, their terrain               | 200k cap vs. 150k is a fight; highland is not worth it                                                            | Enzo: "He's in highland, so I don't think I want to fight him"      |
| They hold a hydrogen bomb                        | Wounding them buys a 5M retaliation                                                                               | Rex: "I'd have to actually exterminate him"                         |

> **Strong players say.** openfront.fyi's Land Combat guide: "Don't compare only total troop counts" — a default click sends a fifth, so "a 200k army against 100k might actually be 40k versus 100k." Look at the force actually committed, the defender's troops per tile, terrain, defense-post coverage, both players' size, and any attack already on its way back.

### Running the attack

- **Ratio.** Losses stop improving at 1.67× their army and triple by 0.5×. As your attack shrinks the ratio falls, so an attack that started at 1.5× is at 0.75× by the time it has lost half its troops. Retreat then; retreat from a player costs 25 % of what is left, but staying costs more per tile.
- **Border width.** Speed is proportional to the length of the shared border, rises steeply from 5 % to 100 % of the defender's army, and then stops: beyond 1× only a wider front is faster. A 100-tile plains front at 1× takes ~455 tiles a second; inside a defense post, 150.
- **Size.** Above 100,000 tiles a defender's attackers lose less and move faster (0.8× at 200k); an attacker above 100k tiles loses fewer troops per tile but moves markedly slower (0.66× at 200k, 0.44× at 400k). Big empires are hit from several sides at once.
- **Merging and cancelling — and the counter-attack.** A second attack on the same target merges into the first. If two players attack each other, the attacks cancel troop-for-troop and only the larger continues. That is the real defense mechanic: when someone sends 100k at you, an attack of 105k back at them erases theirs on contact and leaves you with a 5k push — far cheaper than letting 100k troops grind through your tiles at your density. Answer every serious attack with a counter of the same size (a defense post behind the border makes what gets through cost them 5×).
- **Encirclement works on players.** Split a territory so a piece has no coast and touches only you, and it flips for free. Landing a boat behind a peninsula to cut it off is the standard version.

**Chart: Conquest speed vs. attack size**, per 100 tiles of border (x: your attack ÷ their total troops, log scale; y: tiles/s per 100 border tiles).

| Attack ÷ their troops | Plains | Mountain | Plains, in a defense post |
| --------------------- | ------ | -------- | ------------------------- |
| 0.01×                 | 12     | 8        | 4                         |
| 0.02×                 | 24     | 16       | 8                         |
| 0.05×                 | 61     | 40       | 20                        |
| 0.1×                  | 61     | 40       | 20                        |
| 0.2×                  | 91     | 60       | 30                        |
| 0.5×                  | 227    | 150      | 76                        |
| 1×                    | 455    | 300      | 152                       |
| 2×                    | 455    | 300      | 152                       |
| 5×                    | 455    | 300      | 152                       |
| 10×                   | 455    | 300      | 152                       |

**Conquest speed vs. attack size**, per 100 tiles of border. Dashed: inside a defense post.

**Chart: Troops lost taking 1,000 plains tiles** (defender density 20; x: your attack ÷ their total troops; y: troops lost per 1,000 tiles).

| Attack ÷ their troops | You lose, open ground | You lose, behind a defense post | Defender loses |
| --------------------- | --------------------- | ------------------------------- | -------------- |
| 0.2×                  | 85,120                | 425,600                         | 20,000         |
| 0.25×                 | 85,120                | 425,600                         | 20,000         |
| 0.5×                  | 85,120                | 425,600                         | 20,000         |
| 0.75×                 | 59,520                | 297,600                         | 20,000         |
| 1×                    | 46,720                | 233,600                         | 20,000         |
| 1.25×                 | 39,040                | 195,200                         | 20,000         |
| 1.5×                  | 33,920                | 169,600                         | 20,000         |
| 1.67×                 | 31,360                | 156,800                         | 20,000         |
| 2×                    | 31,360                | 156,800                         | 20,000         |
| 2.5×                  | 31,360                | 156,800                         | 20,000         |
| 3×                    | 31,360                | 156,800                         | 20,000         |

**Troops lost taking 1,000 plains tiles** (defender density 20; they lose 20k flat). Dashed: behind a defense post.

### Retreating: the button almost nobody presses

Every attack you own can be pulled back (click the attack's arrow, or the retreat button on it). Against a player the survivors come home minus 25 %; from empty land they come home whole; a transport boat turns around minus 25 %. Four situations where the 25 % is the best deal on the table:

- **The ratio has fallen under 0.75×.** Your losses per tile at 0.5× are triple what they were at 1.67×. An attack that started at 1.5× is at 0.75× once it has lost half its troops — from there every tile costs more than it is worth. Pull it back and re-send at full ratio later.
- **A counter-attack is coming.** Opposing attacks cancel troop for troop, and only troops _inside_ an attack are cancelled. If a counter as big as your wave appears, retreating turns a 100 % loss into a 25 % loss; Rex, seeing an opponent do exactly this: "he retreated the attack because he knows how to play against this."
- **You got what you came for.** Rex on a nation: "I'm going to retreat the attack as soon as we breach the defense post" — the city behind the post was the target; grinding on through the 5× zone was not.
- **The retreat is a feint.** A big boat that turns around still cost the defender a warship and a panic. Enzo cancels boats mid-route once the target has burned its troops "blunting" them.

The lab bot retreats when a wave is down to 20 % of what was sent while the target still holds 70 % of its army — that is, when the attack is being eaten rather than eating — and it retreats every counter-attack the moment the wave it was sent to cancel is gone. Those two rules were worth more survival than any change to how it attacks.

### Boats

- A transport carries the slider share of your troops, moves a tile a tick, has 1 HP, and you may have three at once. Retreating one costs 25 %; a sunk one loses everything aboard.
- **1 % boats create borders.** If the target land changes hands while a boat is en route, the boat still takes one tile on arrival — a "sleeper cell" that is hard to spot and gives you a land border when an alliance ends. Enzo plants them deliberately; Rex "bomb-chips" a pixel of coast with an atom bomb and lands a boat on the fallout.
- **Boat stacking.** Troops aboard a boat don't count toward your cap. Sending a boat far and retreating it lets you exceed the cap briefly — TheBiff's 1v1 alpha strike: "we go low on troops on purpose… we have 60k in that boat stack… full send him right when the boat comes back."
- **Never boat a stack into a defended coast.** One warship shell sinks it. Rex's post-mortem: "we got to stop sending in concentrated boats."

_Diagram, two panels of enemy coast. Left: a single tile of yours inside the enemy's land where a boat landed — "1 % boat → one tile, a border for later". Right: a landing strip of yours cuts an enemy territory in two; the severed part is shaded — "cut off: no coast of its own → yours, free"; caption "a landing that splits a territory"._

**Two boat plays.** Left: a sleeper cell. Right: a landing that severs a piece from the enemy's coast — the severed piece is fully enclosed by you and transfers without a fight.

### Defense

- **Defense posts:** 30-tile radius, ×5 attacker losses, ×3 slower, don't stack, destroyed when captured. Put them slightly behind the border so the fight happens inside the radius, and before the breach — "starting one after the attack has begun is too late." Chain them ~50 tiles apart along a front.
- **One warship closes a coast.** 1,000 HP, fires every 2 s for 200–300 at anything within 130 tiles, targets transports first, retreats to port below 75 %. Inside its patrol no invasion boat survives; it also captures trade ships that aren't hugging a coast, if you own a port on that water. But "lose five warships and you've thrown away 5 million" (UN) — one or two on a real lane, not a fleet.
- **Warships as shields.** In team games Rex sends a warship ahead of transports to absorb enemy shells.

_Diagram: your land on the left, the enemy's on the right. A post DP placed just behind the border has a green circle that covers the border and the first 40 tiles of theirs — "30-tile radius covers the border and the first 40 tiles of theirs"; "post is 50 tiles back: attackers pay ×5 for the whole approach". A second, faded post deep inside your land has a red circle that never reaches the border — "too far back: the border fight is outside it"._

**Defense post placement.** The radius is 30 tiles from the post. Placed at the border it covers 30 tiles of the enemy's approach as well; placed deep it covers nothing that matters until you are already losing.

### The first silo

Somewhere in this phase the first missile silo (1M) appears, and the game's economics change: any building worth more than 750k on an exposed tile is now a target. Rex's rule for ranked: get your three cities, then "it's very important to beat them to the silo — if they lob a bomb and take out your silo before you can do anything with it, you just lost a million." TheBiff, as the victim: "I'm not going to place another city; if I do he's going to nuke it with a 750 and that's just going to make him gain 250k." In a big free-for-all the first silos go down around minutes 6–10 among strong players, immediately after a first player kill pays for them. Whether or not you build one, **start a SAM before you see a warning** — it takes 30 s to build. Phase 5 covers the rest.

<a id="p5"></a>

## Phase 5 · The nuclear age

_15:00 – 30:00_

#### The board

Silos are common, SAMs are the tell of who is prepared, hydrogen bombs are within reach of the top few economies, and everyone is counting toward 25M. Land pushes are now preceded by bombs, and buildings are placed with blast radii in mind.

> **Do.** Cover your cities and ports with SAMs — upgraded ones, overlapping, with the silo and SAM inside a city's coverage. Bomb a target's defense posts and dense core, then push. Bomb only what costs the victim more than 750k to replace. Never provoke a player who holds a hydrogen bomb unless you can finish them. Keep gold for a counter-MIRV once anyone nears 25M, and never telegraph a betrayal against someone who can afford one.

> **Why nukes kill what they kill.** A blast removes every tile within the inner radius (12 for an atom bomb, 80 for hydrogen) and half the tiles out to the outer radius (30 / 100), destroys every building and ship inside the outer radius, turns the land to fallout (2.5–5× harder to conquer, and no longer counted in the 80 % win total), and kills troops in proportion to the **share** of the victim's land removed: the fraction that survives is (tiles left ÷ tiles before) to the fifth power. That is applied separately to their home troops, to every attack they have out, and to every boat.

**Chart: Share of a player's troops killed vs. share of their land inside the blast** (x: share of their land inside the blast; y: % of troops killed). Formula: 1 − (1 − share)^5.

| Share of their land inside the blast | Troops killed |
| ------------------------------------ | ------------- |
| 0 %                                  | 0 %           |
| 500 %                                | 23 %          |
| 1000 %                               | 41 %          |
| 1500 %                               | 56 %          |
| 2000 %                               | 67 %          |
| 2500 %                               | 76 %          |
| 3000 %                               | 83 %          |
| 3500 %                               | 88 %          |
| 4000 %                               | 92 %          |
| 4500 %                               | 95 %          |
| 5000 %                               | 97 %          |
| 5500 %                               | 98 %          |
| 6000 %                               | 99 %          |

**Share of a player's troops killed vs. share of their land inside the blast.** An atom bomb covers ~1,640 tiles: 16 % of a 10,000-tile player (58 % of their army), 3 % of a 50,000-tile player (15 %).

**Nuclear purchases**

| Item          | Cost                                | What it does                                                                                                                                                                                                                                        |
| ------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missile silo  | 1M                                  | Launches from the nearest silo with a free slot. Each level is one more missile in flight; a slot reloads in 9 s. Builds in 10 s.                                                                                                                   |
| Atom bomb     | 750k                                | ~1,640 tiles. Destroys all buildings within 30. Flies at 10 tiles a tick.                                                                                                                                                                           |
| Hydrogen bomb | 5M                                  | ~25,800 tiles. Destroys all buildings within 100 — out-ranges a SAM's 70–102, so an aimed hydrogen bomb kills SAMs.                                                                                                                                 |
| SAM           | 1.5M, then 3M                       | Range 70 at level 1, 81, 90, 97, 102 at level 5; one interceptor in flight per level, 9 s reload each, a new level's slot starts empty. Always hits if the missile's path enters range early enough. Defends only its owner's land. Builds in 30 s. |
| MIRV          | 25M + 15M per MIRV anyone has fired | Splits into up to 350 warheads across 1,500 tiles; each kills up to ~500 troops from the part of the army above 3 % of cap, and every building in its 18-tile radius. The carrier can't be intercepted; the warheads can.                           |

### Using bombs

- **Bomb, then push.** Enzo's pattern, narrated: "I'm going to bomb right here to get rid of his defense post and lower his troop levels a little bit — now we're going to double-tap this." An atom bomb on a 10k-tile neighbour removes 58 % of their army and every post and city in the blast for 750k; the land push afterwards takes territory that would otherwise have cost more than that in troops.
- **Bomb what's worth it.** Rex: "I'm going to wait for him to build another structure and then we can bomb it — I don't want to bomb a 500,000-priced city" with a 750k bomb. A level-4+ city (1M), a port cluster, a silo, a SAM: yes. Bare land: usually no.
- **Don't bomb a small ally.** Under ~100 allied tiles and no allied building, an atom bomb doesn't break an alliance; over it, you're a traitor.
- **Flight path.** Shortest from a silo directly above or below the target; a SAM only intercepts if the path enters its range in time, so an attack from an unexpected angle beats a perimeter of SAMs.
- **Bunkers.** v33 players nuke their own back line to leave a few specks of fallout-ringed land: fallout is 2.5–5× harder to take and excluded from the win count, so the bunker survives long after the rest falls. Enzo: "he's made a super bunker in the back of his base"; a MIRV on a bunkered player "did absolutely nothing."

### SAM coverage

_Diagram, two layouts over your land. Left: four level-1 SAMs in a square with gaps between their circles — "4 level-1 SAMs: 4 shots, gaps between". Right: two level-5 SAMs whose large circles overlap over a cluster of cities, ports and a silo — "2 level-5 SAMs over the core: 10 shots, range 102, overlapping"._

**Depth, not perimeter.** Cities, ports and silos (gold) inside overlapping upgraded SAMs. Two SAMs never fire at the same missile, so overlap is extra shots, not waste. A level-5 SAM has five interceptors and 102 range; four level-1s have four and 70.

> **Strong players say.** "One upgraded SAM site is usually far more effective than placing two basic ones side by side" (Lonely_Millennial); Rex on an opponent: "he's buying more SAMs, he's not stacking them — it's terrible." openfront.fyi: "Build depth, not perimeter"; "starting one after a missile warning is often too late." Rex hides his silo under a city so the same SAM covers both; Enzo puts his SAM "a little bit further back" than the front.

### The MIRV standoff

A MIRV costs 25M and rises 15M every time anyone fires one, so the first is 25, the second 40, the third 55. Its warheads take an army down to a few percent of cap and level every building they touch, but leave a sliver — and a bunkered opponent may lose almost nothing. So the late game becomes a standoff: the player who fires first at the leader is usually then MIRVed by the third player. Enzo fires first only when he judges he is "the person who's much more likely to get pushed," and times it to the second an alliance expires. Rex keeps "a 55 million MIRV just for counter-MIRV's sake," reasons that "the person that throws the MIRV at me would get immediately backstabbed by the other player," and names the meta problem: "someone thinks they're an absolute hero and just dumps a MIRV on the crown." The UN doctrine: "let other people MIRV each other to death — don't push for the 80 % land win unless there are no other active players that can afford MIRVs." And the counter when someone is nearly there: "bum rush him; the only plan is to stop him from getting MIRV" (Enzo). Three hydrogen bombs (15M) are "really comparable to a MIRV" against a single dense target.

<a id="p6"></a>

## Phase 6 · Endgame

_25:00 onward_

#### The board

Three to six players hold nearly all the land. Everyone has silos and SAMs; the top two can afford MIRVs. The leader needs 80 % of the non-fallout land and does not have it; the game will end either by someone crossing the bar or by the host's overtime rules dragging the bar down to them.

> **Do.** If you are the leader: spend on what protects your share — SAM depth, city levels (troops are what hold land), a warship on each trade lane — renew the alliances that cover your flanks, and keep a counter-MIRV fund. If you are not: let alliances run out on your schedule, coordinate against the leader with whoever else can't win alone, and be ready for the moment their alliance with you expires. Everyone: stop taking land that doesn't move the win condition.

- **The win condition** is strictly more than 80 % of land tiles (95 % in team games), **fallout excluded**. Every tile anyone nukes lowers the bar. With overtime on (host option; default start minute 30) the threshold drops 2 points a minute until someone crosses it, so a stalemate always resolves — leaders protect what qualifies, challengers time pushes just before the bar steps down.
- **Land stops paying past ~100k tiles.** Each extra tile adds ~12 cap, your attacks slow to two-thirds and worse, and you become the map's obvious nuke target. Cities, SAMs and silos convert gold into safety better than another province does.
- **Cities in the endgame.** Cap is troops and troops are land, so strong players never stop: Rex reports 38 cities at minute 21 and 81 at the end of a long game; Enzo faces a "level 100" city. Every level is 1M for +250k cap.
- **Alliance timers decide the end.** Everyone's five-minute timers are visible. The player who has troops massed when a timer ends wins that exchange; the player who telegraphs ("give them a demon emoji and expect them not to instant-MIRV you when the alliance expires" — Rex, on his own loss) does not.
- **Eliminations still pay.** A human who has attacked anyone gives half their gold; a nation, all of it. Late stockpiles are tens of millions.

### Mistakes that lose games, as named by the players above

- [ ] Emptying your home troops in the first minute, or "full-sending" at any point after.
- [ ] Island or peninsula spawns; crowded spawns.
- [ ] Bleeding troops into the wilderness and having none left for the bots; walking past encirclements.
- [ ] Aggroing a nation you can't finish.
- [ ] Waiting too long for the first three cities; hoarding gold.
- [ ] Building a port with no partner ports 300+ tiles away on that water.
- [ ] Building 1M cities or ports into a neighbour's live silo without a SAM.
- [ ] Judging a target by troop total instead of density, buildings, posts and what their army is doing.
- [ ] No defense posts on the front; assuming posts stack.
- [ ] Boating a stack into a coast with a warship, or losing track of transports.
- [ ] Breaking an alliance manually when an expiry would do; telegraphing a betrayal to someone who can afford a MIRV.
- [ ] Starting a SAM after the warning; spreading basic SAMs instead of upgrading one.
- [ ] Pushing for 80 % while another active player can afford a MIRV.

<a id="comp"></a>

### Endgame composition: how many ports, and when factories win

Ports do not scale forever, and the reason is on the map, not in your empire. **The whole map shares one pool of trade ships.** Every port's launch odds fall as the number of ships at sea rises — halved at 400 ships, near zero past 600 — so on World the sea holds about 400–550 ships no matter how many ports exist. Once it is full, ports stop adding trade and start dividing it: your income is your share of the port levels on the water, times a fixed pot.

**Chart: Your gold per second by your port levels, measured on the World map** (x: your port levels, ports × level; y: your gold per second).

| Your port levels | vs 80 rival port levels (sea full) | vs 20 rival port levels |
| ---------------- | ---------------------------------- | ----------------------- |
| 0                | 0                                  | 0                       |
| 5                | 36,879                             | —                       |
| 10               | 98,184                             | 108,842                 |
| 20               | 147,715                            | 130,131                 |
| 40               | 236,874                            | 195,455                 |
| 80               | 304,881                            | 345,008                 |
| 160              | 434,211                            | —                       |

**Your gold per second by your port levels, measured on the World map** (5-minute runs; you on the American coast, two rivals on the Europe–Africa and Asian coasts, all level 1 unless marked). Against 80 rival port levels the first ten ports pay about 10,000/s each; ports 20–40 pay 4,500/s each; ports 40–80 pay 1,700/s each — for 1M apiece, a ten-minute payback. Against a smaller rival fleet (20 levels) the first ports pay the same, and ports 40–80 pay 3,700/s each instead of 1,700/s, because the sea is emptier — the fewer ports the rest of the map has, the longer yours keep paying. Levels and ports are interchangeable: 40 ports at level 2 earn the same as 80 ports at level 1.

| 1M spent on…                                  | Adds, early (sea not full)          | Adds, late (sea full, 80+ rival levels)      | Notes                                                                                  |
| --------------------------------------------- | ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| One more port level, 400-tile route           | 7,000–12,000/s                      | 1,500–2,000/s                                | Your share of a fixed pot; every level also takes trade from rivals.                   |
| Factory levels 1–10 on your own 7-stop lines  | 2,300/s per level at first, falling | same — nobody else's buildings affect trains | Per player: total trains cap at 0.67 a second; ten levels reach half of that.          |
| Factory levels 1–10 on an ally's 10-stop line | 8,000/s per level at first          | same                                         | The best late-game gold in the game, and it pays the ally the same again.              |
| Factory levels beyond ~20                     | under 500/s                         | under 500/s                                  | Dilution: each level slows every other level you own.                                  |
| One city level                                | +250,000 troop cap                  | +250,000 troop cap                           | Gold only matters as troops and bombs. Past the income curves' knees, this is the buy. |

**The composition that follows.** Ports until your marginal port pays under about 2,000/s — on a full World sea that is roughly 40–80 of your own levels against a comparable rival fleet, and Rex's "no more than 100 ports" is the same knee seen from the ledger. Then 10–20 factory levels, on allied lines first, which are untouched by the crowded sea and beat the eightieth port five to one. Then stop buying income: every further 1M is 250,000 troops or three-quarters of an atom bomb, and by minute 25 neither a port nor a factory level will pay itself back before the game ends. Level ports rather than adding them once your coast is covered — a level needs no shore, no 15-tile gap, and is one fewer thing to bomb.

<a id="modes"></a>

## Other modes

_ranked 1v1 and team games_

### Ranked 1v1 (10-minute timer, bots only, compact maps)

- **It is a bot race.** "The way you win these games is by taking bots for a longer period of time than your neighbour" (Rex). Position, encirclements and city farming decide it; both ranked players call it "the name of the game is annexations."
- **No alliances.** "Rule number one is you probably don't want to be taking alliances in this game mode." With one opponent an alliance only delays the fight until they choose the moment.
- **No ports.** There is nobody to trade with. A factory is the income building if you need one.
- **Three cities, then the silo — first.** "Beat them to the silo": a silo bombed before it has fired is a million gold gone. After that, "save for bombs — the more cities we grab, the less we have for bombs." Don't place a 1M building your opponent can bomb for 750k.
- **Boat stacking is the alpha strike.** Go low on home troops on purpose, hold 60k in a distant boat, and full-send the moment it returns.

### Team games

- **Spawn on the same coast as your team;** take bots _toward_ the enemy first to starve them of theirs; never eat a teammate's bot pool or cut them from the coast (Lonely_Millennial).
- **Roles.** Front-liners need at least three cities and three ports before fighting players; back-liners build city-port-city-port to 7–10 ports, then SAM and silo, and **donate** 30–40 % of their troops every time they hit ~50 % of cap ("every time I see a player sat in the backline on full troops, a baby panda sadly passes away"). Donations share one 10-second cooldown per recipient.
- **Trade only with teammates:** right-click yourself and turn off trading with everyone else, so your ships never feed the enemy. Teammate train stops pay 25k, not 35k.
- **Bait and shield.** Forward cities "in disrespect" draw the enemy into your posts; a warship ahead of your transports absorbs shells. Win condition is 95 % of land; ranked 2v2 has a 1-minute spawn immunity.

<a id="plan"></a>

## The whole plan

_small, dense, rich — and how that becomes 80 %_

Everything above compresses to one shape of game. You do not need the most land; you need the most _troops per tile_, the most gold per minute, and a border nobody wants to cross — then you buy the ending.

| Clock       | Land                                                                              | Troops                              | Gold                                                                | The one thing to do                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:30   | 20 % a second down the contested corridor                                         | never falling between clicks        | —                                                                   | Reach bots and coast before the neighbour does.                                                                                                                                                                         |
| 0:30–2:00   | 10 % a second into free land (20 % wherever a rival touches); ring the bot pocket | compounding at home                 | 1,000/s                                                             | Ally every nation that borders you while the coin-flip is on. One 20 % boat.                                                                                                                                            |
| 2:00–6:00   | bots, smallest first, 1.67× re-clicked; rings where possible                      | city 1 at 2:00, city 2, city 3      | port 1 at 3:00 if a 300-tile partner exists                         | Turn bots into cap and gold. Never attack a human or a nation.                                                                                                                                                          |
| 6:00–10:00  | hold; posts on every nation border 30 s before its alliance expires               | keep 40–70 % of cap                 | port to level 3, second port or factory line, 10–20k/s              | Gift a seventh of a nation's cap before renewal if you can't match it. Let the weakest neighbour's alliance lapse on purpose.                                                                                           |
| 10:00–20:00 | one war at a time, at 2× the target's whole army, from 70 % of cap                | city levels with every spare 1M     | silo at 10:00, bomb fund, port levels while payback < time left ÷ 2 | Atom-bomb the building cluster, tap, retreat what doesn't win. Embargo the one you fight.                                                                                                                               |
| 20:00–25:00 | dense, not wide: take cities, leave sparse land                                   | at cap; SAM level 3+ over the stack | stop buying ports; factories on allied lines if the sea is full     | Prune neighbours who could MIRV you; keep mitochondria who build for you.                                                                                                                                               |
| 25:00+      | the finish                                                                        | 7–10M is enough                     | 1–2 MIRVs, never 100M idle                                          | Launch first to raise the MIRV price on everyone else, wait for the warheads, then full-send into the emptied land. Hold at 75 % until the MIRV-capable players are dead or allied, then take the last 5 % in one push. |

> **Why small and dense wins.** A defender loses their troops-per-tile for every tile that changes hands, and an attacker's losses climb steeply as that density rises — so a 10,000-tile empire holding 3M troops (300 a tile) costs an attacker over 100 troops a tile on plains before a single defense post, while a 100,000-tile empire with the same army (30 a tile) costs 26. Bombs follow the same law in reverse: troops lost to a blast are proportional to the share of your land it removes, to the fifth power, so a compact stack under a level-5 SAM barely notices a hydrogen bomb that would gut a sprawl. Gold favours the same shape: a port's income is set by its partners and levels, not by your land, and a rail line wants 110 tiles, not 10,000. Land only matters twice — as cap (which cities replace at 250k a level) and at the very end, when 80 % of it has to be yours. The plan is to be unattackable and rich for 25 minutes, then convert gold into that last stretch of land faster than anyone can respond.

<a id="design"></a>

### How the bot is built

Until 29 Aug the bot was a fixed-order loop: every second it ran _counter → retreat → expand → tribes → wars_, and every second _build_, each step reading the game on its own with no shared picture and no limits it had to respect. That is how it lost a real game at 1:44 — three tribe attacks and 20 % clicks at once drained home troops under 20 % of cap, and a Hard nation betrays an ally in that state on sight. The nations' own code is more robust for one reason: it keeps a troop reserve as a hard rule and decides from one evaluated situation. The bot now works the same way.

| Layer      | What it is                                                                                                                                                                                                                                                                                                                                                                                                       | Why                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Situation  | One snapshot per tick: troops, cap and share of cap, gold, neighbours by kind (tribes, rivals, friends, free land), incoming attacks, outgoing attacks and how many are on tribes, boats at sea, neighbours that have just collapsed, alliances expiring within 45 s.                                                                                                                                            | Every rule reads the same picture; no rule re-derives state or acts on a number another rule has already changed. |
| Invariants | Every troop that leaves home goes through one door, which keeps a reserve of 30 % of the troops at home (a share of _troops_, as the nations do — a share of cap was tried first and froze the bot whenever troops were low, costing a third of its land). Boats go through the same door. One tribe attack at a time under 60 % of cap, two above. One sea landing at a time. Follow-up clicks only 10 s apart. | These cannot be violated by a rule that "seemed fine on its own"; they are the mistakes the real game showed.     |
| Events     | Differences since the last tick: an alliance ended (bring tribe waves home if they are stronger, mark the post), a new attack arrived, a neighbour's troops or land halved (strike now at 1×, ignoring the war gate).                                                                                                                                                                                            | Reactions in under a second, before the regular rules run.                                                        |
| Rules      | A prioritized table, each with its own cadence: counter (1 s), retreats (1 s), expand (1 s), tribes (1 s), wars (1 s), diplomacy (30 s), early boat (2 s until sent), tribe boats (10 s), sea invasion (20 s), build and bombs (1 s).                                                                                                                                                                            | Adding a behaviour is adding a row; ordering is explicit; each rule is small enough to test alone.                |

The lab runs the same code on the real World map with the online defaults — 72 nations and 400 tribes — for 30 ten-minute games per rule; the real client is used to catch what the lab's fixed spawns never show.

<a id="medium"></a>

### What wins on Medium: the strategy the data points to

Two hundred recorded 30-minute games against Medium and Hard nations, read through the viewer, come down to a short list. The crowns (South America 591k tiles, Australia 414k, East Asia 235k, Africa 211k) all followed the same arc; every death and every stall broke it at one of the same six points.

| Stage       | What the crown games did                                                                                                                  | What the losing games did instead                                                                                                         | The rule now                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–2:00   | Spawned on an open coast with room behind them, ate tribes one at a time, sent the first boat to free shore                               | Spawned in a pocket between two nations (North America died five times out of five at one tile), or boated 2× troops onto a tribe's beach | Room and "sandwiched" terms in the spawn score; boats prefer free shore                                                                        |
| 2:00–8:00   | City 1 at 2:00, port by 3:00, three cities by 6:00; land 30–50k by 8:00 mostly from tribes and boats                                      | Allied all four neighbours by 1:00 and had nobody to grow into for ten minutes; sat at cap from 4:00 with gold idle                       | The weakest neighbour is never allied; wars start when 2× its army is affordable, not at 70 % of cap; port levels while a city is unaffordable |
| 8:00–15:00  | One war at a time against the weakest un-allied neighbour, sent whole; the rest of the army on boats to free coasts and collapsed players | Six to eight half-wars at 1.3–1.7× against different nations — every one of them then nuked back                                          | Sticky war target; wars whole or not at all; home never under 30 % of cap                                                                      |
| Any time    | Kept the territory in one piece                                                                                                           | Let a nation's push cut the land in two and watched the smaller piece get handed over by the encirclement rule                            | Split watch every 20 s: the owner of the gap becomes the war target at 1.2×, free land in the gap gets the contested rate                      |
| Any time    | Used an economic lead: bombed a neighbour's cluster and attacked while it could not rebuild                                               | Waited for 2× troops it would never have against a nation whose cap grew as fast as its own                                               | With twice the target's cap and 1M spare: bomb first, then 1.5× is enough                                                                      |
| 15:00–30:00 | Stayed under the nations' steamroll line (city units, not levels), SAMs over the stack, silo by 10:00, a MIRV fund from 20:00             | 91 cities and no SAM: crown at 21:00, dead at 27:00                                                                                       | City-unit cap, SAM per 8 cities from 12:00, full MIRV price reserved in the top three                                                          |

The endgame failure, read from 30 transcripts: eight games ended holding 25–57M gold because the MIRV price (25M plus 15M for every launch on the map) ran away from the fund, while the army sat at 60–90 % of cap with every neighbour allied. The fix was not more savings but the opposite — a fund capped at 40M, gold above 8M spent on hydrogen bombs, alliances with neighbours under half our troops allowed to lapse from 15:00, and short boat jumps at 2×. The finish now has a rule (above); it is the one rule in this guide without a 30-game number behind it yet.

<a id="subsystems"></a>

### Subsystem audit: bot against the guide and against the nations

The nation AI (the code behind Hard nations) is the strongest player the bot meets, so each of its subsystems is the yardstick. "Nations" describes what their code does; "bot" what ours does after 29 Aug.

| Subsystem          | The guide                                                                              | Nations                                                                                                                                                                        | Bot                                                                                                                                                                                                              | Verdict                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Expansion          | Flow into free land; 20 % contested, 10 % free; floor                                  | Everything above a 30–40 % troop reserve into empty land every 4–6 s, then random neighbours                                                                                   | 20 %/10 % clicks each second through one door that keeps 30 % of troops home; contested rate while ringing an annex target                                                                                       | Matched; measured better than the nations' all-in over 30 games                         |
| Attack choice      | Density, expiring allies, bombed neighbours, one war at a time, 2× the army            | Ordered list: retaliate → assist allies' targets → betray weak allies → hated → afk → traitors → weakest → island; size = troops minus reserve                                 | Scored list with the same signals plus buildings and density; 2× the army with 30 % of cap kept home; one war at a time; collapsed targets first                                                                 | Matched; the bot is stricter about size, the nations about cadence                      |
| Assisting allies   | —                                                                                      | Attack whoever an ally is attacking                                                                                                                                            | Not done                                                                                                                                                                                                         | Gap (small)                                                                             |
| Defense posts      | On any human attack; behind a nation with half your troops                             | Only when incoming ≥ 35 % of own troops; one post per 40 % of that ratio                                                                                                       | On any non-tribe attack and on threats; up to 8                                                                                                                                                                  | Matched; the bot over-builds early (50k each) — the nations' 35 % rule is worth copying |
| Cities             | City 1 at 125k, three fast, then levels when troops sit above 60 %                     | Always first; upgrade rather than build past one structure per 1,500 tiles                                                                                                     | Same triggers; new cities go on the rail first; capped under the nations' steamroll line, then levels                                                                                                            | Matched                                                                                 |
| Ports              | First when a partner is 300+ away; level to 3; stop at a full sea or 25:00             | 0.75 per city, on water bodies over 3,000 tiles                                                                                                                                | Partner-scored placement, level to 3 before a second, 400-ship and 25:00 stops                                                                                                                                   | Matched; the bot's placement is better, the nations build more of them                  |
| Factories and rail | Landlocked or allied lines; extend, don't level past 3                                 | 0.75 per city inland, 0.25 on a coast; stations toward reachable clusters                                                                                                      | One line (factory → anchor → infill), extended once; from 3:00 with ports or 5:00 landlocked                                                                                                                     | ~ Under-built: the nations run three times the factories of the bot in 30-minute games  |
| Silos              | One at 10:00 with three cities and three port levels                                   | First at 0.4 per city (so from 3 cities), then 0.2 per city up to three; levelled to 5 for range                                                                               | Was: one, only when a rival had two cities — in real games often never. Now: one at four cities or 10:00, two at twelve, three at twenty; a level when a bomb target sat out of range                            | Fixed to the nations' shape                                                             |
| Bombs              | Atom bomb the building cluster before a war; never into a SAM umbrella                 | Target = whoever attacks them, an ally's target, or a hostile; hydrogen when affordable; tile score over structures; on Hard, no shot a SAM can intercept along the trajectory | Was: only the current war target or an idle-at-cap pick. Now also attackers over 5 % of our troops, the ally we let lapse, and collapsed neighbours; hydrogen at 5M on big targets; tiles outside SAM range only | Fixed; the nations' trajectory check is still better than the bot's range circle        |
| SAMs               | On the first enemy silo; level 2+; depth over the stack                                | 0.25 per city on Hard from the start (a 20-city nation has five)                                                                                                               | Was: one, only after an enemy silo. Now: one per five cities from the first silo on the map or 12:00, level 3 when leading, spread over the stack                                                                | Fixed to the nations' shape                                                             |
| MIRV               | Launch first; the price rises 15M for everyone per launch                              | Counter-MIRV → victory denial at 70 % of the map (Hard) → steamroll stop at 1.25× the runner-up's cities                                                                       | Counter → over half the map → from 20:00 in the top three, whoever is above us; full price reserved from 20:00                                                                                                   | Matched, and it stays under the steamroll line itself                                   |
| Warships           | Boats die to one shell; warships kill pirates                                          | Keep one warship near a port; sink incoming transports and trade raiders; counter a "warship infestation"                                                                      | Was: none. Now one per four ports when gold is spare                                                                                                                                                             | Fixed (basic); no retaliation logic yet                                                 |
| Boats              | Early boat, boats when the land border closes, follow a bomb with a landing            | Boat attacks to neighbours they don't border; boats to empty land when no land border                                                                                          | Early boat at 0:06 to open shore; sea expansion every 10 s (free shore, collapsed, weak, tribes); one landing at a time                                                                                          | Bot ahead: measured +6 survivors over 30 games                                          |
| Alliances          | Ask everyone early except the weakest; renew; gift when weaker; look strong at renewal | Accept if the asker is a threat, friendly, early, or similar strength; reject traitors; betray weak allies under 20 % of cap                                                   | Ask all but the weakest and any annex target; renew; gift a seventh of cap; hold the army home 45 s before a stronger nation's alliance lapses                                                                   | Matched                                                                                 |
| Retreat            | Under 0.75×; dodge counters                                                            | None — nations never retreat                                                                                                                                                   | At 20 % of the wave with the target above 70 %; counters retreat when the wave is gone                                                                                                                           | Bot ahead                                                                               |
| Reactions          | Fortify before expiry; strike a bombed neighbour                                       | Retaliate against attackers at the top of the list every 4–6 s                                                                                                                 | Events each tick: alliance ended, new attack, neighbour collapsed                                                                                                                                                | Matched                                                                                 |
| Spawn              | Scorecard                                                                              | Fixed spawn cells                                                                                                                                                              | Scored coast pick once nations have landed                                                                                                                                                                       | Bot ahead                                                                               |

The pattern behind "it never builds nukes or SAMs": every one of those was behind a condition tied to a _specific opponent state_ (a rival with two cities, an enemy silo) instead of to the bot's own size. The nations build by ratio to their own city count and never wait for a reason; the bot now does the same.

<a id="audit"></a>

### Guide against bot: the audit

Every rule in this guide, checked against what the bot actually does in a game (read from its code and watched in the lab and the real client on 29 Aug). "Fixed" means the bot was changed that day to match; "gap" means the bot still doesn't do it.

| Section                                                   | The guide says                                                                                                         | The bot does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Phase 0 · spawn                                           | Score coasts by the scorecard; ocean, not lake; no nation within 110; on the shore itself                              | In the real client the bot only took over after the spawn phase, so it spawned wherever the click or the random placement put it — next to a nation, and once on the Caspian. Now it scores and picks its own tile once every nation has landed, ocean coasts only. Stepping 8 tiles inland so the spawn circle is all land was tested and lost badly (18 of 30 alive against 27 on the shore): an inland circle can be surrounded, a coast cannot, and the boat and port come later.                                                                                                                                                                                       | Fixed, tested                                       |
| Phase 1 · opening                                         | 20 % a second while contested, 10 % free, floor ¼ cap                                                                  | Exactly that (the guide was rewritten to the bot's 30-game winner).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Matched                                             |
| Phase 1 · first boat                                      | One 20 % boat by 0:10 to a tribe or empty shore across water                                                           | Only sent a boat when its own landmass was under 20,000 tiles — never from a continent. Now a boat at 0:06 to the nearest tribe (2× its troops) or empty shore, and only to shores no land path reaches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fixed                                               |
| Phase 1 · first boat's target                             | Open shore across water first; a tribe only if there is none                                                           | Preferred a tribe (2× its troops, losses on the beach) over free land. Now open shore first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Fixed                                               |
| Phase 3–6 · boats in the mid and late game                | Boats are the answer to a closed land border; follow a bomb or MIRV with a landing                                     | Sat idle with three boats free and empty coasts in sight, and never followed a MIRV. Now a sea-expansion rule runs every 10 s from 1:00: whenever a boat is free and the land front is blocked or troops are above 40 % of cap, it lands on the best target across water — free shore (15 % of home), a collapsed player (the follow-up), a weak player without posts at 3×, a tribe at 2×. In the check game it sent 25 boats in 20 minutes, including two into a MIRVed Sri Lanka.                                                                                                                                                                                        | Fixed                                               |
| Phase 2 · wilderness that opens after a kill              | Take free land whenever it appears                                                                                     | Right after tribe fights, troops sat under the 25 %-of-cap floor and expansion into free land was blocked. Free land now respects only the 30 %-of-troops reserve — unused troops come home anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Fixed                                               |
| Phase 2 · tribes                                          | 1.67×, re-click, clicks capped at 30 % with a follow-up, free land first                                               | All four, each tested over 30 games.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Matched                                             |
| Phase 2–3 · rings and annexation                          | Surround a tribe when the map lets you; a landlocked neighbour you enclose is handed over whole                        | It allied every neighbour — and an ally's land can never flip, so it had ruled annexation out. Now a landlocked neighbour with no map edge whose border is already 40 % ours is never allied, its alliance is let lapse, and the expansion keeps the contested rate until the ring closes.                                                                                                                                                                                                                                                                                                                                                                                  | Fixed                                               |
| Phase 2 · boats to tribes                                 | A boat to a tribe needs 1.67×+; don't stack boats                                                                      | Sent a second boat to the same tribe 10 s after the first, and hunted tribes reachable by land — the "boats that take no land". Now one landing at a time, 2× for a beach, across water only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fixed                                               |
| Phase 2 · cities                                          | City 1 at 125k, three cities as fast as gold allows                                                                    | City 1 on time. On one boxed-in spawn, 50k threat-posts delayed city 2 by five minutes; but blocking threat posts until city 2 is affordable measured 8 % _less_ land over 30 games at the same survival, so posts stay. The single spawn was misleading; the batch wasn't.                                                                                                                                                                                                                                                                                                                                                                                                 | Matched, tested                                     |
| Phase 3 · port 1                                          | When a foreign port sits 300+ tiles away on your water                                                                 | Waited for that partner — on one spawn until 7:00, on 1,000 gold a second the whole time. Now: facing a partner if there is one, otherwise on any ocean coast from 2:30; nations have ports by minute 3–5. The run sheet's step 8 now says the same.                                                                                                                                                                                                                                                                                                                                                                                                                        | Fixed, guide updated                                |
| Phase 3 · port levels                                     | Level to 3 before a second port; stop at a full sea or 25:00                                                           | Levels to 3 first; stops at 400 ships map-wide; the 25:00 stop was missing and is now in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fixed                                               |
| Phase 3 · rail                                            | Factory → anchor 100 tiles out → cities every 16 tiles; ally cities nearest the factory                                | Three bugs: it waited 6 s for a factory that takes 10 s to build, gave up, and bought another (21 factories, 1 anchor in 30 games); it demanded an 80–104-tile straight line that a 5,000-tile empire never has; and spare-gold cities went to "interior" tiles, not the rail. Now 40 s, lines from 40 tiles, and every new city goes on the rail first.                                                                                                                                                                                                                                                                                                                    | Fixed                                               |
| Phase 3 · alliances                                       | Accept all, ask everyone early — except the weakest neighbour, which stays your next meal; look strong at renewal time | It allied all four neighbours by 1:00 and, since an alliance lasts ten minutes, could not fight anyone until 11:00: the mid-game stall. Now the single weakest neighbour is never allied from 0:30 when 2× its army fits in the spendable troops; the rest are allied as before, with posts 45 s before expiry and gifts to nations when weaker. On Hard, every death in 30-minute games was a stronger nation attacking the moment an alliance lapsed — it renews only if you hold 75–85 % of its troops at that instant, and the bot's army was out on tribes and boats. Now nothing but counters leaves home in the 45 s before an alliance with a stronger nation ends. | Fixed, in test                                      |
| Phase 4 · wars                                            | One at a time, at 2× the army, bomb first, embargo the target                                                          | Waited for troops to reach 70 % of a cap that every new city raised, so a rich bot sat idle. Now a war starts whenever 2× a neighbour's whole army fits in the spendable troops (after 5:00), or at 70 % of cap as before.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Fixed                                               |
| Phase 4 · retreat & counters                              | Retreat under 0.75×; counter big waves then retreat                                                                    | Retreats at 20 % of sent while the target holds 70 %; counters waves over 15 % and retreats the counter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Matched                                             |
| Phase 4 · nuked neighbours                                | A bombed or MIRVed neighbour is the best target on the map                                                             | Watched two rivals get MIRVed and did nothing — no rule existed. Now any neighbour whose troops or land halve within 10 s is attacked at once, at 1×, ignoring the 70 % gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fixed                                               |
| Phase 4 · sea invasion                                    | Only when boxed in, at a clear multiple, never into posts                                                              | Landed 206k on a 108k nation with posts and lost it. Now 3× minimum, no posts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fixed                                               |
| Phase 5 · silo & SAM                                      | Silo at 10:00 with three cities and three port levels; SAM on the first enemy silo, then level 2                       | Same triggers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Matched                                             |
| Phase 5–6 · the crown gets MIRVed                         | SAM depth over the stack; don't be the runaway city leader                                                             | In 30-minute games the bot was crown at 21:00 with 91 cities and no SAM, and dead by 27:00: the nations MIRV whoever has more than 10 city units and 1.25× the runner-up's count (1.5× on Medium). Now it stays under that line and buys city levels instead (the rule counts units, not levels), builds a SAM once it is top three after 15:00, levels it to 3 when leading, and adds launchers as the stack grows. The same game re-run: alive at 30:00, rank 2 at 89 % of the leader.                                                                                                                                                                                    | Fixed, tested                                       |
| Phase 4 · one war at a time; home never under 30 % of cap | One war at a time; troops at home                                                                                      | It fought seven nations at once and once sent a 2× wave that left 9 % of cap at home — Hard nations betray anyone under 20 %. Wars now keep 30 % of cap home, one at a time (two after 25:00 at cap), and the "bombed neighbour" strike only fires after 5:00 on a target under half our troops.                                                                                                                                                                                                                                                                                                                                                                            | Fixed                                               |
| Phase 6 · MIRV                                            | Launch first — the price rises 15M for everyone with every launch                                                      | Never bought one in 30 games: the fund was half the price and cities ate the rest while the price climbed from 25M to 70M. Now from 20:00 in the top three the full price is reserved (economy pauses unless troops are under 40 % of cap) and it fires at whoever is above it, at anyone over half the map, or back at anyone who fires first.                                                                                                                                                                                                                                                                                                                             | Fixed, in test                                      |
| Phase 6 · the hold and the last push                      | Hold under the line until the MIRV-capable players are gone, then one push                                             | The line is the nations' own: they fire victory-denial MIRVs at anyone over 65 % of the map on Medium, 55 % on Hard, allies included. From three points under it, while any un-allied player has a silo and 20M+ gold (or a MIRV in hand), the bot takes no more land: it fights only those players, bombs them, and MIRVs the richest. When none are left, or from 45 % with none in sight, it pushes — contested expansion, wars at 1.2× with 70 % of the army, boats everywhere.                                                                                                                                                                                         | Built; unmeasured (a 40-minute sweep was cut short) |

The pattern in the fixes: none of them were tuning. They were rules the guide states that the bot simply didn't have, or had behind a condition that never came true in a real game (island-only boats, partner-only ports, 100-tile-only rail). The lab didn't show them because six spawns on one map hit the same conditions every time; the real client did within two minutes.

<a id="audit2"></a>

### Audit, 30 Aug: what the bot still lacks

A second pass over the run sheet after the rebuild (docs/PlaybookBotPlan.md) and a day of watching the real client. "On" means the rule is in the bot and switched on by default; "flag" means built but off until its A/B; "gap" means not built. The lab now scores full games to a win (`MIN=full`), so every "on" below still owes a full-game removal test.

| Run-sheet step                         | The guide says                                                             | The bot today                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                |
| -------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 3 · opening boats                      | One 20 % boat by 0:10; 1 % boats to every other empty shore, three at most | One early boat, now aimed at the shore nearest our own coast by the sailed water path (was: from the middle of our border, straight-line — the "long routes"); a second boat to the same shore is refused while the first is at sea (was: sent again every 10 s). The 1 % scouting boats are not built.                                                                                                                                                                      | On (nearest, water path, dedupe); gap (scout boats)   |
| 3 · boats before the coast             | Reach the coast nearest the target by land, then boat                      | Holding the early boat until free land runs out (`boatsAfterCoast`) lost its smoke badly: the stepping-stone shore was gone by then. The rule the guide wants is "expand _toward_ the coast nearest the target", which nothing does yet.                                                                                                                                                                                                                                     | Flag (off); gap (directed expansion)                  |
| 6 · rings and annexation               | Ring any tribe you can; an enclosed neighbour is handed over whole         | A neighbour with a single coastal or map-edge tile could never be annexed (the check failed on it). Now a target 40 % ringed by us and touching third parties on ≤ 15 % of its border is annexable, coast or not, and becomes a war at 1.2× instead of only a "contested" expansion.                                                                                                                                                                                         | On (`annexWars`)                                      |
| 13 · let the weakest ally lapse        | Let the weakest neighbour's alliance lapse — it is the next meal           | Was renewed whenever a second hostile neighbour existed. Now an ally the war scorer would pick over every unfriendly neighbour is let lapse regardless (safety: not while a stronger unfriendly neighbour borders us, unless the ally is annexable).                                                                                                                                                                                                                         | On (`lapseToAttack`)                                  |
| 14 · hold 750k for a bomb              | Silo, then keep 750k for a bomb                                            | Cities and ports are bought first; a bomb comes from what is left above 250k, so 30-minute games fire ~24 atoms and almost never a hydrogen (7 in 45 games). Escrowing the next bomb's price ahead of discretionary buys (`bombBudget`) deferred buildings without adding a bomb on its smoke — the hydrogen geometry (an 8k-tile cluster 105 tiles clear of allies) is rare on Medium.                                                                                      | Flag (off); atoms are the right bomb most of the time |
| 16 · one war at a time, 2×, bomb first | Atom the building cluster, then 2× their whole army; embargo               | Wars are now allowed two or three at once when each wave fits above the reserve (`multiWar`) — a departure from the guide that the full-game A/B must settle. The bomb still lands _after_ the wave in most wars: bomb-before-wave only fires on a "richer" target. Every war now logs what it returned (`WAR RESULT`): winning wars cost 140–270 troops per tile against ~20 for free land.                                                                                 | On (multi-war, unproven); gap (bomb-first sequencing) |
| 16 · target choice by density          | A neighbour with fewer troops per tile than you                            | The scorer rewards _dense_ targets (+density/50) and vetoes big thin empires — the opposite of the run sheet — and the engine charges the attacker against the defender's whole army whatever the border, so a "bite" out of a thin empire lost every test. The WAR RESULT data can now decide which of the two is right.                                                                                                                                                    | Open question — guide and bot disagree                |
| 16 · what a push returns               | Fight for land and cities, not for the fight                               | Retreating a war once it costs over 120 troops per tile (`warYield`) recalled a nearly-won war and lost a crown; Medium pushes simply cost that much. Kept off; the per-100-tick cost trend is logged so a threshold can be fitted from data.                                                                                                                                                                                                                                | Flag (off)                                            |
| 17 · retreat                           | Under 0.75×, retreat                                                       | Until 29 Aug every retreat the bot ordered froze forever (it set the flag but never scheduled the engine's retreat). Fixed; turning it back off costs ten of eleven crowns on a 45-game ladder — the largest single gain of the rebuild.                                                                                                                                                                                                                                     | On, confirmed                                         |
| 20 · a neighbour who could MIRV you    | Kill or ally them before 25M; SAM level 3+                                 | The bot holds under the victory-denial line while such a rival exists and buys SAMs by city count, but does not go after a nation approaching MIRV gold before the hold. Its own crown MIRV (5 of 6 launches) is answered by the target's counter-MIRV rule, and cities _captured_ in wars can push it over the steamroll line (10 units and 1.5× the runner-up) with nothing reacting. Diagnostics (`MIRV RISK`, `MIRVED by`) and a `nationMirvAware` flag are being built. | Partial; in progress                                  |
| — · irradiated land                    | Take free land whenever it appears                                         | The engine hides unowned fallout from the neighbour list, so a bot ringed by irradiated land believed it had no wilderness and never expanded, although an expand click takes those tiles (at 2.5–5× the loss) and capture clears the fallout. Now expands into bordering fallout at ≥ 70 % of cap.                                                                                                                                                                          | On (`takeFallout`)                                    |
| — · finishing an opponent by boat      | Boats are the answer to a closed border                                    | A war target's land-unreachable remnant (across a strait, in a pocket) is now landed on with 2× its share of troops.                                                                                                                                                                                                                                                                                                                                                         | On (`finishByBoat`)                                   |
| — · assisting allies                   | —                                                                          | Nations attack whoever an ally marks; the bot neither assists nor marks (marking lost its A/B: allies' nukes follow the mark, 4 deaths vs 0).                                                                                                                                                                                                                                                                                                                                | Gap (small)                                           |
| — · factories                          | Landlocked or allied lines                                                 | Nations still run about three times the bot's factories in 30-minute games; the rail rule builds one line and extends it once.                                                                                                                                                                                                                                                                                                                                               | Gap (unmeasured since the rebuild)                    |
| — · the finish at full length          | Hold at 75 %, then one push to 80 %                                        | Every number above comes from 20- and 30-minute games. The lab runs to a real win now; no full-game result exists yet.                                                                                                                                                                                                                                                                                                                                                       | Untested                                              |
| — · Hard                               | The guide's numbers are Medium's                                           | Every default was tuned on Medium; Hard nations betray under 20 % of cap, keep 75 % of the strongest neighbour's troops home, and MIRV at 1.25× the runner-up's cities.                                                                                                                                                                                                                                                                                                      | Untested since the rebuild                            |

What changed most since the last audit is not any rule but the accounting: every war reports its cost per tile, every boat its sailed distance, every flag whether it changed a decision, and the lab pairs games and stops sequentially. The three open questions the data can now settle are density of target, multi-war versus one-at-a-time, and how much a push may cost before it should stop.

### Pressure-tested: 30 games per rule

Every rule the bot plays was run against its alternatives for 30 ten-minute games on World (six regions × three spawn placements, Hard and Medium nations; 30 tribes for the rows below, 400 — the online default — from 29 Aug on). Alive and total land at 10:00; "vs default" counts games the change won or lost outright, the rest being identical (no situation where the rule mattered).

| Rule                                                                                                                                  | Alive / 30   | Land               | Won · lost vs default                                            | Kept?                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening: 20 % a second contested, 10 % free, floor ¼ cap                                                                              | 24           | 800k               | 14 · 12                                                          | Yes — the new default                                                                                                                        |
| Opening: all-in above 15 % of cap every 5 s (old default)                                                                             | 22           | 705k               | —                                                                | No                                                                                                                                           |
| Opening: 10 % contested, 6 % free                                                                                                     | 24           | 553k               | 13 · 14                                                          | No — the plains-duel rule loses the corridor                                                                                                 |
| Opening: 10 % flat                                                                                                                    | 22           | 600k               | 9 · 17                                                           | No                                                                                                                                           |
| All-in but keep 25 % of cap                                                                                                           | 22           | 527k               | 12 · 14                                                          | No                                                                                                                                           |
| Tribes only after the free land is gone                                                                                               | 22           | 705k               | 7 · 5 (18 identical)                                             | Yes, weakly                                                                                                                                  |
| Tribe clicks capped at 30 % of home, follow-up 10 s later                                                                             | 23           | 705k               | 4 · 4 (22 identical)                                             | Yes — same land, one more survivor                                                                                                           |
| Tribe clicks capped at 20 %                                                                                                           | 21           | 633k               | 5 · 10                                                           | No — too slow, the tribe grows back                                                                                                          |
| Start wars at 55 % of cap instead of 70 %                                                                                             | 22           | 636k               | 4 · 5                                                            | No                                                                                                                                           |
| Start wars at 90 % of cap                                                                                                             | 23           | 522k               | 2 · 13                                                           | No — sits idle                                                                                                                               |
| All real-game fixes together (spawn, boat, rail, collapse, economy)                                                                   | 25           | 844k               | — (new spawns)                                                   | Yes — +12 % land vs before the fixes; three fewer survivors, not traced to any one change                                                    |
| …with threat posts blocked until city 2 is affordable                                                                                 | 25           | 779k               | 10 · 12                                                          | No                                                                                                                                           |
| …without the partner-less port at 2:30                                                                                                | 25           | 779k               | 0 · 0 (30 identical)                                             | Inert in the lab; kept for real games where partners come late                                                                               |
| Restructured bot, reserve = ¼ of cap (400 tribes)                                                                                     | 20           | 537k               | —                                                                | No — froze whenever troops were low                                                                                                          |
| Restructured bot, reserve = 30 % of troops, shore spawn (400 tribes)                                                                  | 26           | 819k               | 19 · 8                                                           | Yes — the default                                                                                                                            |
| …spawn 8 tiles inland (30 tribes)                                                                                                     | 18           | 597k               | 12 · 16 vs shore                                                 | No                                                                                                                                           |
| …reserve off / three tribes at once / no retreat on alliance end                                                                      | 18 / 17 / 18 | 570k / 598k / 597k | ≈ identical                                                      | Neutral — kept as invariants                                                                                                                 |
| Scored for the crown: 30 games of 15 minutes, 400 tribes, the default above                                                           | 26           | 1,169k             | 2 crowns · 6 top-3 · mean rank 20.6 · mean share of leader 0.28  | The baseline every rule is measured against from here; 30-minute games next                                                                  |
| 30-minute games, 400 tribes: bot before the endgame rules                                                                             | 15           | 1,217k             | 0 crowns · 6 top-3 · share 0.17                                  | Half die between 20:00 and 28:00 — MIRVed as the runaway city leader                                                                         |
| …with the city-unit cap, SAM policy, one war at a time                                                                                | 17           | 1,374k             | 0 crowns · 6 top-3 · share 0.19                                  | Six rank-2/3 finishes at 60–76 % of the leader; deaths now from over-committed wars                                                          |
| …wars keep 30 % of cap at home, one at a time, full MIRV fund from 20:00                                                              | 17           | 1,217k             | 2 crowns · 6 top-3 · share 0.17                                  | The first crowns (Medium, East Asia and Africa, 210–225k tiles); Hard still loses 17 of 18                                                   |
| …with the boat rework (sea expansion every 10 s, open shore first, free land after kills)                                             | 23           | 1,264k             | 1 crown · 6 top-3                                                | Yes — the biggest survival gain of the day; the crown game reached 413k tiles from Australia                                                 |
| …nation-style structure ratios (silos, SAMs, warships by city/port count)                                                             | 24           | 810k               | 1 crown · 3 top-3                                                | No — the 1M silos and 1.5M SAMs starved the cap; kept in a leaner form (silo at 10:00, a SAM per 8 cities, warships from 15:00)              |
| …wars sent whole or not at all, and one enemy to the end (sticky target)                                                              | 24           | 1,454k             | 2 crowns · 6 top-3 · 12 · 9 vs off (9 identical)                 | Yes — found by reviewing a recording: eight half-wars at 1.3–1.7× made eight nuclear enemies                                                 |
| Medium only, 30 games: split watch + economic-advantage wars                                                                          | 29           | 2,755k             | 4 crowns · 12 top-3 · 13 · 9 vs off (27 alive, 5 crowns, 3,181k) | Split watch kept; the 1.5× economic war is the likely land cost and is measured separately below                                             |
| Medium only: wars at 1.67× whenever affordable, from 3:00                                                                             | 29           | 2,965k             | 5 crowns · 12 top-3 · 13 · 17 vs 2×                              | No — one more crown, 13 % less land, three fewer top-3; 2× stays, the "attack whenever affordable" gate stays                                |
| Medium only: wars at 2× whenever affordable, from 3:00 (no 70 %-of-cap wait)                                                          | 29           | 3,404k             | 4 crowns · 15 top-3 · share 0.41                                 | Yes — the default                                                                                                                            |
| Medium only: endgame v2 — hydrogen bombs instead of hoarding, MIRV fund capped at 40M, weak allies lapse from 15:00, short boat jumps | 30           | 2,726k             | 3 crowns · 14 top-3 · 13 · 12 vs v1 (30 alive, 2 crowns, 2,614k) | Yes — the 25–57M hoards are gone (median peak gold after 20:00: 1.9M); 453 wars, 951 boats and 295 bombs in the last ten minutes of 30 games |

Six-game trials were retired after one of them reversed on a re-run; 30 is the bar now, and a rule with fewer than ten decided games is reported as "weak" whichever way it points. From 29 Aug the lab scores **rank and share of the leader's land** rather than survival — the aim is the crown, and a bot that survives at rank 14 has not done its job. Games are 30 minutes long from then on — crowns are decided after 25:00 — with 10-minute runs only for opening rules.

<a id="pros"></a>

## The pros' numbers, checked

_every instinct they state as a number, run through the engine_

Strong players rarely explain why; they say a number. Below is every number found in seventeen hours of Rex, Enzo, TheBiff, Lonely_Millennial, ChampionEver, UN-clan and Node_acz footage, next to what the game's code or the lab says about it. **Verdicts:** ✓ the engine agrees, ~ right in some situations, ✗ the engine disagrees.

| Instinct                          | Who                         | Their number                                                                                                                                                                                                                    | Engine verdict                                                                                                                                                                                                                                                                                               |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Opening ratio                     | Node_acz, Rex               | 10 % ("avoid spam-clicking"); Rex 15 %                                                                                                                                                                                          | ~ In a fair duel on empty land 10 %/s is the efficient flow. Against Hard nations over 30 lab games, 20 %/s while contested and 10 %/s free beat 10 %/6 % by 45 % more land at equal survival. Under 5 % loses land, over 30 % loses troops.                                                                 |
| Opening ratio                     | UN clan, ChampionEver, Enzo | 30 % at the start; 50 % "is efficient early"                                                                                                                                                                                    | ~ Against bots only. A 50 % click at 100k troops is 2.5× a 20k bot and kills it in 14 s instead of 24 s — but the lab bot that attacked bots at 2.5× instead of 1.67× died in 4 of 6 games, because the troops were away when a nation came. Use 50 % on bots when no neighbour can punish it.               |
| Tribes before or after free land? | Common advice, Josh         | Take the wilderness first, tribes once it runs out                                                                                                                                                                              | ✓ (weakly) 30 lab games: same survival either way, +16 % land for waiting, but 18 of 30 games identical and the rest split 7–5. A first six-game trial said the opposite; it was noise. Order matters less than clicking at 1.67× and re-clicking.                                                           |
| First push                        | Lonely_Millennial           | Wait until ~5k troops, then attack; then every 1k; free play from 8–10k                                                                                                                                                         | ✓ Exactly the speed cap: on plains an expansion moves at full speed once it carries 2,000 × 16.5 ÷ 5 = 6,600 troops; below that it crawls. 5k is where a single click stops being slow.                                                                                                                      |
| Home troops                       | Beginner guide, UN clan     | Keep the bar near 42 %; "attack around 50 % of cap"; keep 30–50 %                                                                                                                                                               | ✓ 42 % is the growth peak. ~ The lab disagrees on when to start wars: starting them at 70 % of cap grew 37 % more land than starting at 45–55 %, with the same survival, because the extra troops let the first attack be 2× the target's whole army.                                                        |
| Growth cue                        | Beginner guide              | "When the growth number turns orange, launch a 40 % attack into a bot"                                                                                                                                                          | ✓ The "+troops/s" figure turns orange the moment growth per second starts falling — i.e. the bar has passed the 42 % peak. It is the 42 % rule read off the screen; 40 % of home at that point is 1.67–2.5× a typical bot.                                                                                   |
| Annex threshold                   | Rex                         | "Wait till we're at 20k / 25k before pushing"; "get pop to 45k, then see about annexations"                                                                                                                                     | ✓ Rex's 20–25k is the point where 60 % of home is 2× a 6–8k tribe or a 10k-troop bot: the 2× rule in absolute numbers for the ranked map size.                                                                                                                                                               |
| Attack size vs humans             | Rex, Enzo                   | "200k pushes"; "I sent 100k and I'm not gaining land"                                                                                                                                                                           | ✓ Enzo's complaint is the density formula: 100k into a defender holding 20 troops a tile and 30k troops costs 26 troops a tile on plains — 100k buys under 4,000 tiles and stalls.                                                                                                                           |
| Boats                             | Rex, UN clan, team players  | "Nice little 3k boats sneaking in"; "two 1 % boats for a better front"; "50 % boat" for an annex                                                                                                                                | ✓ A 1 % boat costs almost nothing, makes a land border you can push through, and still takes one tile if the land changes hands en route. ~ A 50 % boat is right only when the target's whole army is under a quarter of yours — the lab's early 40 % boats to distant nations got the home base overrun.    |
| Reading strength                  | Rex                         | "He's got 114 cities to my 50 — a problem"; "68 cities vs his 97"                                                                                                                                                               | ✓ Cities are cap: 114 cities is 28.5M more cap than 0. Rex counts cities, not troops, because troops swing with every attack and cap does not.                                                                                                                                                               |
| Defense posts                     | Enzo                        | "Something I'm not building enough — it's only 150k"                                                                                                                                                                            | ✓ Behind a post the attacker loses 5× per tile. The lab bot went from 3/6 to 5/6 survival on Hard mostly by placing posts before alliances lapsed.                                                                                                                                                           |
| Double-buy                        | Enzo                        | "I click very fast and make two in one shot — both cost 125k"                                                                                                                                                                   | ~ Each construction re-reads the price when it executes, so both clicks must land in the same 100 ms tick to pay the old price. It happens — Enzo shows it — but it cannot be relied on.                                                                                                                     |
| Nuking cities                     | TheBiff (ranked)            | "If he nukes my city it costs me 500k to rebuild — I'll rebuild every time"                                                                                                                                                     | ✓ A bombed city is a 750k bomb against a 500k+ rebuild that also resets the victim's price ladder — bad trade for the bomber unless the city was level 3+ or the blast takes several buildings. ✗ for the bomber otherwise.                                                                                  |
| Trains                            | TheBiff                     | "It's only 10k per train"                                                                                                                                                                                                       | ~ 10k per stop at your own station, but a train pays at every stop: a seven-stop line pays 40k a train on average, 140k through an ally's cities.                                                                                                                                                            |
| Ports late                        | Rex                         | "Is it worth more ports for 95 million?"; "no one has as many ports as me"                                                                                                                                                      | ✓ Past 40–80 of your own levels on a full sea the marginal port pays 1,700/s — a 1M port at minute 25 never pays back. Rex's hesitation is the knee in the port-scaling chart.                                                                                                                               |
| Team ports                        | Team FFA (Rex's team)       | "33 ports for you, 18 for you, 9 for me"                                                                                                                                                                                        | ✓ Back-liners hold the ports; ports share one map-wide ship pool so spreading them by role, not by player, is right.                                                                                                                                                                                         |
| Alliance expiry                   | Rex                         | "You can't let a 30-second timer expire on someone, give them a demon emoji, and expect not to be MIRVed"                                                                                                                       | ✓ For nations the emoji does nothing but the expiry is decisive: a Hard nation attacks within seconds of a lapse unless you pass one of its four renewal tests (Phase 3).                                                                                                                                    |
| Betrayal                          | UN clan, Rex                | Betray for the defence debuff: "the traitor has 50 % less effective defence"; Rex: "betrayal full send" when far behind in cities                                                                                               | ✓ The betrayed side does not get a debuff — the traitor does (half defence, 0.8× speed, 30 s). So a betrayal is a 30-second window in which everyone can hit _you_ at half price; it pays only if the push ends the war inside that window.                                                                  |
| Cancelling attacks                | Node_acz                    | "You lose 25 % of the troops when you cancel"                                                                                                                                                                                   | ✓ Retreating an attack on a player returns 75 % of what is left; pulling back from empty land is free. Still far better than losing the whole wave.                                                                                                                                                          |
| The 80 % finish                   | Lonely_Millennial, Enzo     | "Don't push for 80 % while anyone can afford MIRVs"; "double MIRV to end it — you win at 80 %"                                                                                                                                  | ✓ The win check is 80 % of non-fallout land; a 25M MIRV in the wrong hands undoes a 79 % position. Hold at 70–75 % until the MIRV-capable players are dead or allied.                                                                                                                                        |
| Nations and bots                  | Rex, Enzo                   | "NPCs do not push people before they finish bot clearing"; "attacking bots before the wilderness is done is noob behaviour — bots have no money yet"                                                                            | ✓ A nation's attack list starts with bordering bots, so it never hits a human while a bot still touches it. ✓ A bot earns 50 gold a tick, so at 30 s it holds 1,500 gold; its land also costs about 19 troops a tile against 16 for plains wilderness. Take empty land first, bots when they are worth gold. |
| Water access                      | Rex                         | "As soon as you get water access, send out boats everywhere — always have boats outbound"; "if you get to the water you can't be annexed"                                                                                       | ✓ Both from the encirclement rule: a coast tile anywhere in your main piece makes you un-annexable, and every 1 % boat is a future border. The lab bot's sea invasions failed only when it sent 40 % of the army; 1 % landings cost nothing.                                                                 |
| The bomb split                    | Enzo                        | "Bomb split at 0 seconds — we stole half his base in one hit"                                                                                                                                                                   | ✓ Alliance expiry, one atom bomb on the neck joining two regions, then a tap: the cut-off region has no shore and touches only you, so it flips under the 2-second cluster check. Needs a target with an inland neck; a coastal region never flips.                                                          |
| Annexing nations                  | Rex                         | "The mythical one-bot-kill annexation — it only requires the Keton Marsh"                                                                                                                                                       | ✓ Nations are subject to the same rule. A landlocked nation whose every neighbour is you (kill the bots between you and it) is handed over whole, buildings included. Coastal nations must be fought.                                                                                                        |
| Trade pool                        | Enzo, Rex                   | "There's a limited number of trade ships on the map; once you have enough ports it just comes down to a higher percentage of the trade"; "later on you rely on factory trade because of massively diminishing returns to ports" | ✓ Measured in the engine: the sea saturates at ~400–550 ships and income becomes your share of port levels. Enzo's level-350 port is the endpoint of that logic — one port holding most of the map's tickets.                                                                                                |
| SAM depth                         | Enzo, Rex                   | "Level 5 protects itself"; "60–70 levels is invincible"; "a 10- or 20-stack near the ports, not 35 spread out"                                                                                                                  | ✓ One interceptor per level, 9 s reload each: a level-5 SAM eats a five-bomb cluster; a MIRV drops hundreds of warheads so only 60+ levels in one place shrug it off. ✓ Spread SAMs each defend one spot; a stack defends the spot that matters.                                                             |
| Cluster bombs                     | Rex                         | "Press 8 twice and the atom bomb becomes a five-stack — 51 bombs got through a 51-stack of SAMs"                                                                                                                                | ✓ One build order can carry up to 50 bombs; each SAM level intercepts one, so N bombs beat N−1 interceptors. At 750k each it is only worth it against a stack guarding something decisive.                                                                                                                   |
| MIRV price                        | Enzo, Rex                   | "40, 55, 70, 85 — a triple MIRV is 165 million"                                                                                                                                                                                 | ✓ 25M plus 15M for every MIRV anyone has launched. Rex's trick: launching first raises the price for everyone else, so his rival "can only afford two".                                                                                                                                                      |
| After a MIRV                      | Rex, Enzo                   | "In v33 you have to wait until the warheads land before you push, or the bombs overlap your own troops"; "never hold 100 million — nobody throws 20 hydrogen bombs in a fast endgame"                                           | ✓ Warheads kill troops on the tiles they hit regardless of owner, and gold has no value the moment the game ends. One or two MIRVs plus cities is the whole late-game budget.                                                                                                                                |
| Hydrogen bombs and size           | Rex                         | "Hydro efficacy scales inversely with land — the larger you are, the less you lose"                                                                                                                                             | ✓ Troops lost are proportional to the share of land destroyed, to the fifth power; the same 100-tile blast is a rounding error on 100,000 tiles.                                                                                                                                                             |
| Nation embargoes                  | Rex                         | "If it embargoed you before the alliance, you're screwed — it won't un-embargo you"                                                                                                                                             | ✓ On Hard and Impossible a nation's embargo is permanent once you reach Hostile; on Easy and Medium it lifts at Neutral.                                                                                                                                                                                     |
| Impossible mode                   | Enzo                        | "Corner nations off one at a time, ally the rest; impossible nations don't accept alliances or restart trading once you've hit them"                                                                                            | ✓ An attack costs −100 on Impossible — straight to Hostile — and the embargo never lifts, so each nation is a one-way decision. Enzo beat it on World with the same eat-the-weakest-neighbour loop the lab bot runs.                                                                                         |
| The implication                   | Rex                         | "The more money you have, the more scared people are"; "give nuclear emoji and they take the alliance"; "the more aggressively you expand, the more hated you become"                                                           | ~ Against humans only: nations ignore emojis and bank balances, but their attack list does target whoever they rate Hostile — and you become Hostile by attacking. The engine's version of "hated" is that −80 click.                                                                                        |
| Mitochondria                      | Rex, Enzo                   | Keep small allied players who build cities and factories for you; "the more cities a mitochondria buys, the more killable it becomes"                                                                                           | ✓ Their factories pay you 35k a stop and their trains pay you at your stations; a stacked ally is also the ally a Hard nation betrays first (its troops fall under 20 % of a big cap).                                                                                                                       |
| Attacker casualties               | Rex (team)                  | "In v31 the attacker takes 50 % more casualties than the defender"                                                                                                                                                              | ~ Not a flat 50 %: the attacker's loss per tile is 0.6 × (defender ÷ attack, clamped 0.6–2) × terrain × 0.8 + 0.4 × 1.3 × defender density × terrain ÷ 100, the defender's is their density. At equal armies on plains the attacker loses about 1.5× — Rex's number for the common case.                     |

The table draws on 38 saved transcripts (15 Enzo, 9 Rex, plus TheBiff, Lonely_Millennial, ChampionEver, the UN clan and Node_acz), all from v29–v33 play.

**Where the pros and the engine part ways:** the pros start wars at 50 % of cap and open at 30–50 % against bots; the lab finds 70 % of cap and 1.67× on bots stronger in crowded games, and the difference is the same in both cases — the pros play maps where their neighbours are humans who hesitate, and the lab plays nations that punish an absent army within seconds. Against humans, take their numbers; against nations, take the lab's.

<a id="sources"></a>

## Sources

_and how current they are_

- Game source: src/core/configuration/Config.ts and src/core/execution/\* at commit c046d49 (v33) — every cost, formula and AI rule above.
- Ultimus_Rex (UN clan; 209-player OFM Summer 2026 finalist): "The most underrated progression tactic", "This spawn gets you a Mito player", "Railing needs to be nerfed", "This silo update changes everything", "The spawn meta is unraveling", "Can I win without building anything" (all Aug 2026, v33); ranked 1v1 (Jan 2026, v29), "The Meta has Shifted" (Jun 2026, v32), "Do not make this spawn mistake" (Jun 2026), team games (May 2025).
- TheBiff: "Becoming the BEST 1v1 Player (Ranked)" (Jan 2026, v29.4); "Uncovering The Tactics To Win" (Feb 2025).
- Enzo Plays: "v33 has Changed the Meta", "Harness the Power of Nuclear Weapons", "Peaceful Trade Island", "Inland Start", "Break Stalemates", "Defend Against a MIRV", "Ultimate Port", "Trade Bunker", "Blockade Hormuz", "Strongest Tactics", "Power of Trade", "Devastating Endgame Strategy", "Ultimate Pirate Base", "Defeat Impossible Mode on World", "150 SAMs vs a MIRV", "Ultimate Mitochondria" (Jul–Aug 2026, v33); "How to Win" / "How to Win Quickly" (May & Oct 2025).
- Lonely_Millennial: Beginner Guide (Jul 2026) and Team Game Guide (Jul 2026), v32/33.
- ChampionEver (Mar 2025, three guides); UN clan "ULTIMATE Tutorial" (Apr 2025, v23 — city cap value outdated); Node_acz French tutorial (May 2025).
- openfront.fyi v33 guides (Aug 2026): FFA Opening, Economy, Building Timing, Land Combat, Population & City Cap, Train Network, Trade vs Piracy, Diplomacy, Nuclear Deterrence, MIRV, Team Roles, Winning Overtime, Hotkeys.
- openfront.wiki (v33) and openfront.miraheze.org (v23–33; its Attacking Guide is flagged inaccurate) for cross-checks.
- Things older guides get wrong for v33: there is no worker/troop slider (the slider is attack ratio only; gold is flat 1,000/s); a city is +250k cap, not +25k; SAMs always hit inside range; captured buildings don't raise your prices; bots have no buildings; defense post range is 30, not 40.
