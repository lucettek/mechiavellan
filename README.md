# Mechiavellan

A 2D side-scrolling mech shooter built around **customization above everything
else**. Before you deploy you build your machine in the hangar — chassis, then
hardpoints, then weapons — and the machine you build genuinely plays differently.

There is a way to *win*: cross 1500 m of hostile ground to the extraction beacon.

> *mech* + *Machiavellian* = **Mechiavellan**

Zero dependencies. No build step. All art is drawn procedurally with the Canvas
API and all sound is synthesized with the Web Audio API.

## Running it

ES modules must be served over HTTP (opening `index.html` via `file://` is
blocked by browser CORS rules), so start any static server from this folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## The hangar

The game opens in the hangar. Pick a chassis, fill its hardpoints, hit
**DEPLOY**. Reopen it from the game-over/victory screen with `H`, or `Enter` to
redeploy the same loadout.

1. **Chassis** — hardpoint count, hull, speed, agility, armour and heat sink.
2. **Hardpoints** — select a weapon, click a hardpoint to install; click a filled
   hardpoint to clear it, or use the `×` on the slot to clear just that one.
   Selecting a different weapon first swaps it in place. Duplicates allowed. The
   readout shows the loadout's
   heat balance, burst and sustained damage, and how many hardpoints need ammo.
3. **Armory** — every weapon, with its delivery mode, range, damage and ammo.

## Weapons: ten very different things

Weapons are not a damage number at a different rate. Each has a distinct
delivery, shown on its card:

| Weapon | Class | Mode | What makes it different |
| --- | --- | --- | --- |
| Vulcan Autocannon | Ballistic | Direct fire | Belt-fed stream, 480 rounds, huge spread |
| Battle Autocannon | Ballistic | **Burst fire** | Three-round bursts, accurate, paces your heat |
| Scatter Cannon | Ballistic | Direct fire | 6 pellets, brutal at contact range only |
| Flak Cannon | Ballistic | Direct fire | Shell that **cracks into 6 fragments** at end of flight |
| Rail Cannon | Energy | **Charge-up** | Hold to spool, releases at full power, **pierces 4** |
| Beam Laser | Energy | **Continuous beam** | Hitscan ray, no ammo, pours heat in while it burns |
| Arc Emitter | Energy | **Chain arc** | Lightning that leaps to 2 further targets |
| Plasma Projector | Energy | Direct fire | Slow fat projectile with a **110 px splash** |
| Missile Pod | Missile | Direct fire | 2 homing missiles, hot launch, **can be shot down** |
| Flamer Warfer | Thermal | Direct fire | **Double-wide cone** that fans out as it travels |

### Ammo vs heat: the real build choice

Only six weapons carry ammo, and that is the point of the axis.

- **Ballistic / missile** weapons hit hard, run relatively cool, and **run dry**.
  Each has a magazine, a reload time and a reserve. Running empty triggers an
  automatic reload (`R` reloads everything manually).
- **Energy** weapons never need a box of shells, but they cook you alive.

Destroyed enemies drop **ammo crates** roughly a third of the time. Walk over one
and every ammo-fed hardpoint gains a magazine's worth of reserve (capped at four
magazines). No crates, no ballistics.

Burning ammo also **adds heat on top of the weapon's own** (`AMMO_HEAT` per
round), so holding the trigger on a belt-fed gun heats you faster than the weapon
card alone suggests.

### Heat is now dangerous

```
heatRatio  = heat / heatSink
cycleScale = 1 + heatRatio * 1.6        // multiplies every weapon's cooldown
```

Escalating consequences:

| Heat | Effect |
| --- | --- |
| any | Rate of fire throttles — the hotter you are, the slower everything cycles |
| > 55% | **Armour plating melts.** Flat damage reduction scales to zero at 100% |
| > 80% | **The hull itself burns**, up to 10 hp/s at maximum heat |
| 100% | **OVERHEAT** — weapons lock until the sink vents to 35% |

Sustained damage still works out to about `cooling × (sum of dps) / (sum of
heat)` — note the absence of hardpoint count, which is what stops six guns being
three times the damage. Measured on identical loadouts, the three chassis land
within **1.07×** of each other on sustained damage, while burst scales **2.9×**.

## Firing in two directions

Hardpoints alternate between two banks:

| | Hardpoints | Aim | Fire |
| --- | --- | --- | --- |
| **Bank A** | even slots (1st, 3rd, 5th) | the cursor | left mouse / `J` |
| **Bank B** | odd slots (2nd, 4th, 6th) | independent | right mouse / `K` |

`V` cycles what bank B does:

- **REAR** (default) — auto-tracks the nearest enemy *behind* you, so you can
  fight forward and backward at once.
- **MIRROR** — exactly opposite your cursor.
- **SYNC** — same direction as bank A.

The rack labels each hardpoint with its hotkey and bank (`1A`, `2B`, …). `1`–`6`
fires a single hardpoint on its own, which is how you manage heat on a six-gun
chassis.

## Chassis

| Frame | Hardpoints | Hull | Speed | Jump | Armor | Heat sink |
| --- | --- | --- | --- | --- | --- | --- |
| WRAITH-2 (Light) | 2 | 100 | 470 | 910 | 0 | 30 |
| BASTION-4 (Medium) | 4 | 135 | 385 | 830 | 1 | 40 |
| LEVIATHAN-6 (Large) | 6 | 165 | 290 | 700 | 2 | 55 |

Every chassis cools at the same rate (8/s), so they end up doing nearly the same
*sustained* damage. What differs is burst, speed, size and how long you can hold
the trigger before the sink saturates.

## Controls

| Action | Input |
| --- | --- |
| Move | `A` / `D` or `←` / `→` |
| Jump | `Space` / `W` / `↑` |
| Aim (bank A) | mouse |
| Fire bank A | left mouse / `J` |
| Fire bank B | right mouse / `K` |
| Fire one hardpoint | hold `1` … `6` |
| Cycle bank B mode | `V` |
| Reload everything | `R` |
| Deploy / redeploy | `Enter` |
| Return to hangar | `H` |

## Winning

Travel **1500 m** to the extraction beacon — a glowing pad with a light beam,
tracked by a progress bar at the top of the screen. Reaching it is worth a
1000-point bonus and ends the run in victory rather than death. A garrison of
five enemies guards the pad, and enemies spawn **from both directions** (~35%
from behind), so a flat-out sprint has a real cost.

### Enemies

- **Drone** — fast hoverer that detonates on contact.
- **Wrecker** — armored walker that closes for melee.
- **Turret** — stationary, aimed shots, only ever ahead of you.

## Project layout

```
index.html          canvas + hangar overlay markup
css/style.css       game shell, hangar UI, responsive layout
js/weapons.js       frames, the 10 weapons, ammo + heat model (pure data/maths)
js/hangar.js        loadout UI: chassis -> hardpoints -> armory
js/main.js          bootstrap
js/game.js          state machine, extraction objective, spawning, collisions
                    (splash, submunitions, missile interception, ammo crates)
js/entities.js      player mech (per-hardpoint ammo/heat/burst/charge, dual-bank
                    aiming, beam + chain delivery), 3 enemies, bullets, crates
js/world.js         parallax backdrop + curved terrain
js/input.js         keyboard + mouse (both buttons), per-frame edge detection
js/audio.js         Web Audio synth sound effects
js/utils.js         math helpers
```

The hangar is a DOM overlay rather than canvas UI — real buttons and focus rings
beat hand-rolled hit-testing for something this central. The simulation only ever
sees a `{ frame, weapons }` loadout.

## Where this is going

Part-by-part mech building (legs, reactor, plating, radiators as separate parts),
weapon mass limits, per-hardpoint placement in a painter, and loadout
save/export.

We made a mecha game where the player designs a robot, then fights others with it.
We got to making different frames and weapons, with heat and ammo as factors.
The agent did well, and did not misunderstand anything.
We made no request too big for the agent.
We barely understood what the agent said, but it explained things and we clicked links and things just worked.
I spent 15 cents on tokens.
