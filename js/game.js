// Game orchestration: the state machine (hangar -> playing -> game over), the
// course assembly, collisions, camera and the render pass.
//
// The only thing the game needs to start a run is a loadout produced by the
// hangar, so a run is fully described by { frame, weapons }.

import { Input } from './input.js';
import { World } from './world.js';
import { AudioManager } from './audio.js';
import { Hangar } from './hangar.js';
import { Player, Drone, Wrecker, Turret, Bullet, AmmoBox, ParticleSystem } from './entities.js';
import { ARMOR_MELT_AT, HEAT_DAMAGE_AT } from './weapons.js';
import { clamp, rand, aabb } from './utils.js';

const BEST_KEY = 'mechiavellan.best';

/** Chance that a destroyed enemy leaves an ammo crate behind. */
const AMMO_DROP_CHANCE = 0.35;
const MAX_AMMO_BOXES = 6;

/** Distance the mech must cover to reach the extraction beacon. */
const OBJECTIVE_METERS = 1500;
const OBJECTIVE_DISTANCE = OBJECTIVE_METERS * 10;
/** A garrison is waiting at the pad, spawned this far out. */
const GARRISON_TRIGGER = OBJECTIVE_DISTANCE - 2400;

/** localStorage can throw (private mode, sandboxed iframes); never let it crash. */
function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

function saveBest(value) {
  try {
    localStorage.setItem(BEST_KEY, String(value));
  } catch {
    /* ignore */
  }
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = new Input(canvas);
    this.audio = new AudioManager();

    this.dpr = 1;
    this.view = { w: 960, h: 540 };
    this.camera = { x: 0 };

    this.world = new World(this.view.w, this.view.h);
    this.particles = new ParticleSystem();
    this.bullets = [];
    this.enemies = [];
    this.ammoBoxes = [];
    this.pendingBullets = [];
    this.player = null;
    this.loadout = null;

    this.state = 'hangar';
    this.time = 0;
    this.shake = 0;
    this.score = 0;
    this.kills = 0;
    this.distance = 0;
    this.spawnTimer = 0;
    this.best = loadBest();

    this.hangar = new Hangar(document.getElementById('hangar'), (loadout) => this.deploy(loadout));

    window.addEventListener('resize', () => this.resize());

    // Audio can only start after a user gesture.
    const unlock = () => this.audio.resume();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this.resize();

    this._frame = this._frame.bind(this);
    this.last = null;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = dpr;
    this.view.w = w;
    this.view.h = h;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.world.resize(w, h);
  }

  start() {
    requestAnimationFrame(this._frame);
  }

  _frame(now) {
    if (this.last === null) this.last = now;
    const dt = Math.min((now - this.last) / 1000, 1 / 30) || 0;
    this.last = now;

    this.update(dt);
    this.render();
    this.input.endFrame();

    requestAnimationFrame(this._frame);
  }

  // --- Run lifecycle --------------------------------------------------------

  /** Called by the hangar when the player hits DEPLOY. */
  deploy(loadout) {
    this.loadout = loadout;
    this.audio.resume();
    this.reset(loadout);
    this.state = 'playing';
  }

  openHangar() {
    this.state = 'hangar';
    this.shake = 0;
    this.hangar.open();
  }

  reset(loadout) {
    this.player = new Player(180, 0, loadout);
    this.player.y = this.world.groundY(this.player.x + this.player.w / 2) - this.player.h - 30;
    this.bullets.length = 0;
    this.enemies.length = 0;
    this.ammoBoxes.length = 0;
    this.pendingBullets.length = 0;
    this.particles.clear();
    this.camera.x = this.player.x - this.view.w * 0.35;
    this.spawnTimer = 1.5;
    this.score = 0;
    this.kills = 0;
    this.distance = 0;
    this.shake = 0;
    this.garrisonSpawned = false;
  }

  // --- Update ---------------------------------------------------------------

  update(dt) {
    this.time += dt;

    if (this.state === 'hangar') {
      // The battlefield is hidden in the hangar, so there is nothing to animate.
      return;
    }

    if (this.state === 'gameover' || this.state === 'victory') {
      this.particles.update(dt);
      if (this.input.anyPressed('Enter', 'NumpadEnter', 'Space')) {
        this.deploy(this.loadout);
      } else if (this.input.anyPressed('KeyH')) {
        this.openHangar();
      }
      return;
    }

    this.updatePlaying(dt);
  }

  updatePlaying(dt) {
    const aim = {
      x: this.camera.x + this.input.mouse.x,
      y: this.input.mouse.y,
    };

    const ctx = {
      input: this.input,
      world: this.world,
      aim,
      player: this.player,
      particles: this.particles,
      audio: this.audio,
      enemies: this.enemies,
      spawnBullet: (b) => this.bullets.push(b),
      killEnemy: (enemy) => this.killEnemy(enemy),
    };

    this.player.update(dt, ctx);
    for (const enemy of this.enemies) enemy.update(dt, ctx);

    for (const bullet of this.bullets) {
      const wasAlive = !bullet.dead;
      bullet.update(dt, ctx);
      if (wasAlive && bullet.dead) this.onBulletDeath(bullet);
    }

    for (const box of this.ammoBoxes) box.update(dt, ctx);
    this.particles.update(dt);

    const targetX = this.player.x - this.view.w * 0.35;
    this.camera.x += (targetX - this.camera.x) * Math.min(1, dt * 5);

    const difficulty = clamp(this.distance / (OBJECTIVE_DISTANCE * 0.8), 0, 1);
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.enemies.length < 16) {
      this.spawnEnemy();
      this.spawnTimer = rand(1.3, 2.2) * (1 - difficulty * 0.5);
    }

    // The extraction pad is guarded, so arriving is a fight rather than a
    // formality (and sprinting the whole course has a price).
    if (!this.garrisonSpawned && this.distance > GARRISON_TRIGGER) {
      this.garrisonSpawned = true;
      for (let i = 0; i < 5; i++) this.spawnEnemy(true);
    }

    this.handleCollisions();

    const far = this.view.w * 1.5;
    this.bullets = this.bullets.filter(
      (b) => !b.dead && Math.abs(b.x - this.camera.x - this.view.w / 2) < far
    );
    this.enemies = this.enemies.filter((e) => !e.dead);
    this.ammoBoxes = this.ammoBoxes.filter((b) => !b.dead);

    this.distance = Math.max(this.distance, Math.max(0, this.player.x - 180));
    this.score = this.kills * 100 + Math.floor(this.distance / 12);
    this.shake = Math.max(0, this.shake - dt * 40);

    if (this.state === 'playing' && this.distance >= OBJECTIVE_DISTANCE) {
      this.state = 'victory';
      this.score += 1000; // extraction bonus
      if (this.score > this.best) {
        this.best = this.score;
        saveBest(this.best);
      }
      this.particles.spawnExplosion(this.player.cx, this.player.cy - 20, 40, '#7fe6ff');
      this.audio.tone({ freq: 520, type: 'triangle', duration: 0.5, gain: 0.06, sweep: 320 });
      this.shake = 10;
    }

    if (this.player.dead && this.state === 'playing') {
      this.state = 'gameover';
      if (this.score > this.best) {
        this.best = this.score;
        saveBest(this.best);
      }
      this.particles.spawnExplosion(this.player.cx, this.player.cy, 34, '#8fe9ff');
      this.audio.explode();
      this.shake = 18;
    }
  }

  /**
   * Enemies arrive from both sides now, so you cannot simply back away from
   * trouble — but you also cannot be flanked by a static gun.
   * @param {boolean} forceAhead garrison wave: always in front of the player
   */
  spawnEnemy(forceAhead = false) {
    const fromBehind = !forceAhead && Math.random() < 0.35;
    const x = fromBehind
      ? Math.max(20, this.camera.x - rand(50, 190))
      : this.camera.x + this.view.w + rand(80, 260);

    const roll = Math.random();
    let enemy;
    if (roll < 0.5) {
      enemy = new Drone(x, this.world.groundBase - rand(120, 280));
    } else if (roll < 0.82 || fromBehind) {
      // Nothing static behind you: a turret back there would just get culled.
      enemy = new Wrecker(x, 0);
    } else {
      enemy = new Turret(x, 0);
    }

    if (enemy.type !== 'drone') {
      enemy.y = this.world.groundY(x + enemy.w / 2) - enemy.h;
    }

    this.enemies.push(enemy);
  }

  killEnemy(enemy, award = true) {
    if (enemy.killed) return;
    enemy.killed = true;

    this.particles.spawnExplosion(
      enemy.x + enemy.w / 2,
      enemy.y + enemy.h / 2,
      22,
      enemy.type === 'drone' ? '#ff9d6b' : '#ffd257'
    );
    this.audio.explode();
    this.shake = Math.max(this.shake, 6);

    if (!award) return;
    this.kills += 1;
    if (this.ammoBoxes.length < MAX_AMMO_BOXES && Math.random() < AMMO_DROP_CHANCE) {
      this.ammoBoxes.push(new AmmoBox(enemy.x + enemy.w / 2, enemy.y + enemy.h / 2));
    }
  }

  /**
   * Splash damage and submunitions, applied exactly once per projectile however
   * it died (impact or expiry).
   */
  onBulletDeath(bullet) {
    if (bullet.deathHandled) return;
    bullet.deathHandled = true;

    if (bullet.splash > 0) {
      this.particles.spawnExplosion(bullet.x, bullet.y, 16, bullet.color);
      this.shake = Math.max(this.shake, 4);

      if (bullet.friendly) {
        for (const enemy of this.enemies) {
          if (enemy.dead) continue;
          const dx = enemy.x + enemy.w / 2 - bullet.x;
          const dy = enemy.y + enemy.h / 2 - bullet.y;
          const reach = bullet.splash + Math.max(enemy.w, enemy.h) / 2;
          if (Math.hypot(dx, dy) > reach) continue;
          if (enemy.hit(bullet.splashDamage)) this.killEnemy(enemy);
        }
      } else {
        const dx = this.player.cx - bullet.x;
        const dy = this.player.cy - bullet.y;
        if (Math.hypot(dx, dy) < bullet.splash + 24) {
          if (this.player.takeDamage(bullet.splashDamage)) this.audio.hurt();
        }
      }
    }

    if (bullet.fragments > 0) {
      const base = bullet.angle;
      for (let i = 0; i < bullet.fragments; i++) {
        const t = bullet.fragments === 1 ? 0.5 : i / (bullet.fragments - 1);
        const a = base + (t - 0.5) * 2 * bullet.fragmentSpread;
        this.pendingBullets.push(
          new Bullet({
            x: bullet.x,
            y: bullet.y,
            vx: Math.cos(a) * bullet.fragmentSpeed,
            vy: Math.sin(a) * bullet.fragmentSpeed,
            friendly: bullet.friendly,
            damage: bullet.fragmentDamage,
            color: bullet.color,
            w: 7,
            h: 7,
            life: bullet.fragmentLife,
            kind: bullet.kind,
            divergence: (Math.random() * 2 - 1) * 0.12,
          })
        );
      }
      this.particles.spawnSparks(bullet.x, bullet.y, 8, bullet.color);
    }
  }

  handleCollisions() {
    // Enemy fire can shoot incoming missiles out of the air.
    for (const hostile of this.bullets) {
      if (hostile.dead || hostile.friendly) continue;
      for (const missile of this.bullets) {
        if (missile.dead || !missile.friendly || !missile.interceptable) continue;
        if (!aabb(hostile.box, missile.box)) continue;
        hostile.dead = true;
        missile.dead = true;
        this.onBulletDeath(missile);
        this.particles.spawnExplosion(missile.x, missile.y, 12, '#ffd257');
        this.audio.hit();
        break;
      }
    }

    for (const bullet of this.bullets) {
      if (bullet.dead) continue;

      if (bullet.friendly) {
        for (const enemy of this.enemies) {
          if (enemy.dead) continue;
          if (bullet.hits.has(enemy)) continue;
          if (!aabb(bullet.box, enemy)) continue;

          bullet.hits.add(enemy);
          this.particles.spawnSparks(bullet.x, bullet.y, 5);

          if (enemy.hit(bullet.damage)) this.killEnemy(enemy);
          else this.audio.hit();

          // Piercing rounds keep going until their extra hits run out.
          if (bullet.pierce > 0) {
            bullet.pierce -= 1;
          } else {
            bullet.dead = true;
            this.onBulletDeath(bullet);
            break;
          }
        }
      } else if (aabb(bullet.box, this.player)) {
        bullet.dead = true;
        this.onBulletDeath(bullet);
        if (this.player.takeDamage(bullet.damage)) {
          this.audio.hurt();
          this.shake = Math.max(this.shake, 8);
          this.particles.spawnSparks(bullet.x, bullet.y, 8, '#ff8a6b');
        }
      }
    }

    if (!this.player.dead) {
      for (const enemy of this.enemies) {
        if (enemy.dead) continue;
        if (!aabb(this.player, enemy)) continue;

        if (this.player.takeDamage(enemy.contactDamage)) {
          this.audio.hurt();
          this.shake = Math.max(this.shake, 10);
          this.particles.spawnExplosion(this.player.cx, this.player.cy, 10, '#ff9d6b');
        }
        if (enemy.kamikaze) {
          enemy.dead = true;
          this.killEnemy(enemy, false);
        }
      }
    }

    // Ammo crates.
    for (const box of this.ammoBoxes) {
      if (box.dead || !aabb(box, this.player)) continue;
      if (!this.player.resupply()) continue;
      box.dead = true;
      this.particles.spawnSparks(box.x + box.w / 2, box.y + box.h / 2, 12, '#7fe6ff');
      this.audio.tone({ freq: 680, type: 'triangle', duration: 0.14, gain: 0.045, sweep: 320 });
    }

    // With enemies on both sides, only cull things that are genuinely gone.
    const behindLimit = this.camera.x - this.view.w * 1.1;
    const aheadLimit = this.camera.x + this.view.w * 2;
    for (const enemy of this.enemies) {
      if (enemy.x + enemy.w < behindLimit || enemy.x > aheadLimit) enemy.dead = true;
    }

    // Submunitions spawned above only join the pool once this pass is done.
    if (this.pendingBullets.length) {
      this.bullets.push(...this.pendingBullets);
      this.pendingBullets.length = 0;
    }
  }

  // --- Render ---------------------------------------------------------------

  render() {
    const ctx = this.ctx;
    const { w, h } = this.view;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // The hangar is a DOM overlay; hide the battlefield entirely behind it so
    // leftover camera shake and terrain do not show through.
    if (this.state === 'hangar') return;

    const shakeX = this.shake ? rand(-this.shake, this.shake) : 0;
    const shakeY = this.shake ? rand(-this.shake, this.shake) : 0;

    ctx.save();
    ctx.translate(shakeX, shakeY);
    this.world.draw(ctx, this.camera, this.view);

    ctx.save();
    ctx.translate(-Math.round(this.camera.x), 0);
    this.drawBeacon(ctx);
    this.particles.draw(ctx);
    if (this.player) this.player.drawBeams(ctx);
    for (const enemy of this.enemies) enemy.draw(ctx);
    if (this.player && !this.player.dead) this.player.draw(ctx);
    for (const box of this.ammoBoxes) box.draw(ctx);
    for (const bullet of this.bullets) bullet.draw(ctx);
    ctx.restore();
    ctx.restore();

    const vg = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.35,
      w / 2, h / 2, Math.max(w, h) * 0.75
    );
    vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vg.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    if (this.state === 'playing' || this.state === 'victory' || this.state === 'gameover') {
      this.drawHUD(ctx);
      this.drawWeaponRack(ctx);
      this.drawObjective(ctx);
    }
    if (this.state === 'playing') this.drawCrosshair(ctx);
    if (this.state === 'gameover') this.drawGameOver(ctx);
    if (this.state === 'victory') this.drawVictory(ctx);
  }

  drawHUD(ctx) {
    const { w } = this.view;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';

    const barW = 240;
    const barH = 16;
    const x = 22;
    const y = 26;

    ctx.fillStyle = 'rgba(8, 12, 22, 0.7)';
    ctx.fillRect(x - 4, y - 4, barW + 8, barH + 8);
    ctx.fillStyle = '#2a3346';
    ctx.fillRect(x, y, barW, barH);

    const hp = clamp(this.player.health / this.player.maxHealth, 0, 1);
    const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
    grad.addColorStop(0, hp < 0.35 ? '#ff5d5d' : '#3ee08a');
    grad.addColorStop(1, hp < 0.35 ? '#ff9d6b' : '#7fe6ff');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, barW * hp, barH);
    ctx.strokeStyle = 'rgba(120, 180, 220, 0.5)';
    ctx.strokeRect(x + 0.5, y + 0.5, barW, barH);

    ctx.fillStyle = '#9fb3d1';
    ctx.fillText(`HULL · ${this.player.frame.name.toUpperCase()}`, x, y + barH + 15);

    // Heat sink, with the two danger thresholds marked on the bar.
    const heatY = y + barH + 30;
    const heatH = 12;
    ctx.fillStyle = 'rgba(8, 12, 22, 0.7)';
    ctx.fillRect(x - 4, heatY - 4, barW + 8, heatH + 8);
    ctx.fillStyle = '#2a3346';
    ctx.fillRect(x, heatY, barW, heatH);

    const heat = this.player.heatRatio;
    const heatGrad = ctx.createLinearGradient(x, 0, x + barW, 0);
    heatGrad.addColorStop(0, '#8fe9ff');
    heatGrad.addColorStop(ARMOR_MELT_AT, '#ffd257');
    heatGrad.addColorStop(1, '#ff3b3b');
    ctx.fillStyle = heatGrad;
    ctx.fillRect(x, heatY, barW * heat, heatH);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + barW * ARMOR_MELT_AT, heatY);
    ctx.lineTo(x + barW * ARMOR_MELT_AT, heatY + heatH);
    ctx.moveTo(x + barW * HEAT_DAMAGE_AT, heatY);
    ctx.lineTo(x + barW * HEAT_DAMAGE_AT, heatY + heatH);
    ctx.stroke();

    ctx.strokeStyle = this.player.overheated
      ? 'rgba(255, 90, 90, 0.95)'
      : 'rgba(120, 180, 220, 0.5)';
    ctx.strokeRect(x + 0.5, heatY + 0.5, barW, heatH);

    let heatLabel = 'HEAT';
    let heatColor = '#9fb3d1';
    if (this.player.overheated) {
      heatLabel = 'OVERHEATED — VENTING';
      heatColor = '#ff5d5d';
    } else if (this.player.heatDamage > 0) {
      heatLabel = 'HULL BURNING';
      heatColor = '#ff5d5d';
    } else if (heat > ARMOR_MELT_AT) {
      heatLabel = `ARMOUR MELTING (${this.player.effectiveArmor.toFixed(1)})`;
      heatColor = '#ffd257';
    }

    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = heatColor;
    ctx.fillText(heatLabel, x, heatY + heatH + 12);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#dfeaff';
    ctx.font = '700 22px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(String(this.score).padStart(6, '0'), w - 22, 32);
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#8fa6c9';
    ctx.fillText(`${Math.floor(this.distance / 10)} m   ·   ${this.kills} kills`, w - 22, 56);

    ctx.restore();
  }

  /** One tile per hardpoint: weapon, hotkey, bank, ammo and reload state. */
  drawWeaponRack(ctx) {
    const weapons = this.player.weaponDefs;
    if (!weapons.length) return;

    const { w, h } = this.view;
    const boxW = 108;
    const boxH = 44;
    const gap = 8;
    const total = weapons.length * boxW + (weapons.length - 1) * gap;
    let x = (w - total) / 2;
    const y = h - 62;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    // Which way the independent bank is aimed.
    ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#8fa6c9';
    ctx.fillText(`BANK B: ${this.player.bankModeName}   [V]`, w / 2, y - 24);

    const status = this.player.overheated
      ? { text: 'OVERHEAT — VENTING', color: '#ff7a6b' }
      : this.player.heatDamage > 0
        ? { text: 'HULL BURNING — CEASE FIRE', color: '#ff5d5d' }
        : this.player.cycleScale > 1.05
          ? { text: `HEAT THROTTLE ×${this.player.cycleScale.toFixed(2)}`, color: '#ffd257' }
          : null;

    if (status) {
      ctx.font = '700 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = status.color;
      ctx.fillText(status.text, w / 2, y - 8);
    }

    ctx.textAlign = 'left';

    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i];
      const bank = i % 2;
      const cooldown = this.player.cooldowns[i];
      const reload = this.player.reloadTimers[i];
      const mag = this.player.mag[i];
      const reserve = this.player.reserve[i];
      const effectiveCooldown = weapon.cooldown * this.player.cycleScale;
      const ready =
        effectiveCooldown > 0 ? clamp(1 - cooldown / effectiveCooldown, 0, 1) : 1;
      const dry = !!weapon.ammo && mag <= 0 && reserve <= 0;

      ctx.fillStyle = 'rgba(8, 12, 22, 0.72)';
      ctx.fillRect(x, y, boxW, boxH);
      ctx.strokeStyle =
        reload > 0
          ? 'rgba(255, 177, 92, 0.8)'
          : ready >= 1
            ? 'rgba(127, 230, 255, 0.9)'
            : 'rgba(90, 110, 140, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, boxW - 1, boxH - 1);

      ctx.font = '700 14px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = dry ? '#6f83a3' : weapon.color;
      ctx.fillText(weapon.abbr, x + 8, y + 13);

      // Hotkey plus which bank it belongs to.
      ctx.textAlign = 'right';
      ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = bank === 0 ? '#7fe6ff' : '#ffb15c';
      ctx.fillText(`${i + 1}${bank === 0 ? 'A' : 'B'}`, x + boxW - 8, y + 13);
      ctx.textAlign = 'left';

      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      if (weapon.ammo) {
        ctx.fillStyle = dry ? '#ff5d5d' : reload > 0 ? '#ffb15c' : '#9fb3d1';
        ctx.fillText(`${mag}/${reserve}`, x + 8, y + 26);
      } else {
        ctx.fillStyle = '#6f83a3';
        ctx.fillText('ENERGY', x + 8, y + 26);
      }

      // Charge progress for charge-up weapons (rail cannon).
      if (weapon.mode === 'charge') {
        const charge = this.player.charges[i] / weapon.charge;
        if (charge > 0) {
          ctx.fillStyle = 'rgba(127, 230, 255, 0.95)';
          ctx.fillRect(x + 8, y + 33, (boxW - 16) * clamp(charge, 0, 1), 3);
        }
      }

      if (reload > 0) {
        const progress = 1 - reload / weapon.ammo.reload;
        ctx.fillStyle = '#ffb15c';
        ctx.fillRect(x + 8, y + boxH - 7, (boxW - 16) * clamp(progress, 0, 1), 3);
      } else {
        ctx.fillStyle = 'rgba(127, 230, 255, 0.85)';
        ctx.fillRect(x + 8, y + boxH - 7, (boxW - 16) * ready, 3);
      }

      x += boxW + gap;
    }

    ctx.restore();
  }

  drawCrosshair(ctx) {
    const { x, y } = this.input.mouse;
    ctx.save();
    ctx.strokeStyle = 'rgba(127, 230, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.moveTo(x - 18, y);
    ctx.lineTo(x - 6, y);
    ctx.moveTo(x + 6, y);
    ctx.lineTo(x + 18, y);
    ctx.moveTo(x, y - 18);
    ctx.lineTo(x, y - 6);
    ctx.moveTo(x, y + 6);
    ctx.lineTo(x, y + 18);
    ctx.stroke();
    ctx.fillStyle = 'rgba(127, 230, 255, 0.9)';
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    ctx.restore();
  }

  /** The extraction pad, drawn in world space so it scrolls into view. */
  drawBeacon(ctx) {
    const x = 180 + OBJECTIVE_DISTANCE;
    const groundY = this.world.groundY(x);
    const pulse = (this.time * 0.7) % 1;

    ctx.save();

    const beam = ctx.createLinearGradient(0, groundY - 700, 0, groundY);
    beam.addColorStop(0, 'rgba(127, 230, 255, 0)');
    beam.addColorStop(1, 'rgba(127, 230, 255, 0.4)');
    ctx.fillStyle = beam;
    ctx.fillRect(x - 30, groundY - 700, 60, 700);

    ctx.strokeStyle = 'rgba(127, 230, 255, 0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, groundY, 90, 18, 0, 0, Math.PI * 2);
    ctx.stroke();

    for (let i = 0; i < 2; i++) {
      const p = (pulse + i * 0.5) % 1;
      ctx.globalAlpha = 1 - p;
      ctx.beginPath();
      ctx.ellipse(x, groundY, 90 + p * 130, 18 + p * 26, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#7fe6ff';
    ctx.shadowColor = '#4fd6ff';
    ctx.shadowBlur = 24;
    ctx.fillRect(x - 6, groundY - 90, 12, 90);
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  /** Progress toward the extraction point. */
  drawObjective(ctx) {
    const { w } = this.view;
    const progress = clamp(this.distance / OBJECTIVE_DISTANCE, 0, 1);
    const barW = 200;
    const barH = 7;
    const x = (w - barW) / 2;
    const y = 30;

    const done = progress >= 1;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = done ? '#7fe6ff' : '#8fa6c9';
    ctx.fillText(
      done ? 'EXTRACTION REACHED' : `EXTRACTION  ${Math.floor(this.distance / 10)} / ${OBJECTIVE_METERS} m`,
      w / 2,
      y - 10
    );

    ctx.fillStyle = 'rgba(8, 12, 22, 0.7)';
    ctx.fillRect(x - 3, y - 3, barW + 6, barH + 6);
    ctx.fillStyle = '#2a3346';
    ctx.fillRect(x, y, barW, barH);

    const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
    grad.addColorStop(0, '#3ee08a');
    grad.addColorStop(1, '#7fe6ff');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, barW * progress, barH);
    ctx.strokeStyle = 'rgba(120, 180, 220, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, barW, barH);

    ctx.restore();
  }

  drawVictory(ctx) {
    const { w, h } = this.view;
    ctx.save();
    ctx.fillStyle = 'rgba(2, 14, 12, 0.6)';
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cy = h / 2;

    ctx.fillStyle = '#8ff0d0';
    ctx.shadowColor = '#3ee08a';
    ctx.shadowBlur = 26;
    ctx.font = '800 46px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('EXTRACTION COMPLETE', w / 2, cy - 84);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#dfeaff';
    ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(String(this.score).padStart(6, '0'), w / 2, cy - 26);

    ctx.fillStyle = '#8fa6c9';
    ctx.font = '600 14px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(
      `${Math.floor(this.distance / 10)} m   ·   ${this.kills} kills   ·   best ${String(this.best).padStart(6, '0')}`,
      w / 2,
      cy + 8
    );

    ctx.fillStyle = '#9fb3d1';
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(
      `${this.player.frame.name.toUpperCase()} · ${this.player.weaponDefs.map((x) => x.abbr).join('  ') || 'UNARMED'}`,
      w / 2,
      cy + 40
    );

    const pulse = 0.6 + 0.4 * Math.sin(this.time * 3);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#dfeaff';
    ctx.font = '700 18px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('[ ENTER ]  REDEPLOY     [ H ]  HANGAR', w / 2, cy + 88);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  drawGameOver(ctx) {
    const { w, h } = this.view;
    ctx.save();
    ctx.fillStyle = 'rgba(10, 2, 4, 0.55)';
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cy = h / 2;

    ctx.fillStyle = '#ff7a6b';
    ctx.shadowColor = '#ff3b3b';
    ctx.shadowBlur = 22;
    ctx.font = '800 52px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('SYSTEMS CRITICAL', w / 2, cy - 84);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#dfeaff';
    ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(String(this.score).padStart(6, '0'), w / 2, cy - 26);

    ctx.fillStyle = '#8fa6c9';
    ctx.font = '600 14px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(
      `${Math.floor(this.distance / 10)} m   ·   ${this.kills} kills   ·   best ${String(this.best).padStart(6, '0')}`,
      w / 2,
      cy + 8
    );

    ctx.fillStyle = '#9fb3d1';
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(
      `${this.player.frame.name.toUpperCase()} · ${this.player.weaponDefs.map((x) => x.abbr).join('  ') || 'UNARMED'}`,
      w / 2,
      cy + 40
    );

    const pulse = 0.6 + 0.4 * Math.sin(this.time * 3);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#dfeaff';
    ctx.font = '700 18px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('[ ENTER ]  REDEPLOY     [ H ]  HANGAR', w / 2, cy + 88);
    ctx.globalAlpha = 1;

    ctx.restore();
  }
}
