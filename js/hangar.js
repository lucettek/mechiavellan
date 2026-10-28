// The hangar: the pre-game loadout screen.
//
// Chassis -> hardpoints -> armory. It is a DOM overlay rather than canvas UI
// because customization is the point of the game and real buttons, focus rings
// and scrolling text are far better than hand-rolled canvas hit-testing.

import {
  FRAMES,
  WEAPONS,
  makeLoadout,
  fireRate,
  burstDamage,
  weaponRange,
  totalHeatRate,
  burstDps,
  sustainedDps,
  settleCycle,
  willOverheat,
} from './weapons.js';

const DEFAULT_WEAPON_IDS = ['vulcan', 'burst', 'plasma', 'missiles', 'shotgun', 'railgun'];

/** Human-readable delivery mode, so the card says *how* a gun works. */
const MODE_LABELS = {
  projectile: 'Direct fire',
  burst: 'Burst fire',
  charge: 'Charge-up',
  beam: 'Continuous beam',
  chain: 'Chain arc',
};

/** Power draw can be fractional; show "14" rather than "14.0". */
function fmt(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export class Hangar {
  /**
   * @param {HTMLElement} root
   * @param {(loadout: {frame: object, weapons: object[]}) => void} onDeploy
   */
  constructor(root, onDeploy) {
    this.root = root;
    this.onDeploy = onDeploy;

    this.frame = FRAMES[1]; // medium by default
    this.slots = new Array(this.frame.slots).fill(null).map((_, i) => DEFAULT_WEAPON_IDS[i] || null);
    this.selectedId = null;

    this.els = {
      frameCards: root.querySelector('#frame-cards'),
      hardpoints: root.querySelector('#hardpoints'),
      weaponCards: root.querySelector('#weapon-cards'),
      stats: root.querySelector('#frame-stats'),
      status: root.querySelector('#hangar-status'),
      deploy: root.querySelector('#deploy'),
      clear: root.querySelector('#clear-loadout'),
    };

    this.els.deploy.addEventListener('click', () => this.deploy());
    this.els.clear.addEventListener('click', () => this.clearAll());

    // Enter deploys while the hangar is open. This lives on `window` because
    // nothing inside the overlay is focused by default.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.isOpen) {
        e.preventDefault();
        this.deploy();
      }
    });

    this._buildFrameCards();
    this._buildWeaponCards();
    this.render();
  }

  open() {
    this.root.hidden = false;
    this.render();
  }

  close() {
    this.root.hidden = true;
  }

  get isOpen() {
    return !this.root.hidden;
  }

  /** @returns {{frame: object, weapons: object[]}} */
  get loadout() {
    return makeLoadout(this.frame.id, this.slots);
  }

  deploy() {
    if (!this.isOpen) return; // already deployed; ignore repeat input

    const armed = this.slots.filter(Boolean).length;
    if (armed === 0) {
      this._setStatus('Install at least one weapon before deploying.', true);
      return;
    }

    // Hand keyboard focus back to the page, otherwise a focused DEPLOY button
    // would keep swallowing Space (the jump key) during play.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    this.close();
    this.onDeploy(this.loadout);
  }

  clearAll() {
    this.slots = this.slots.map(() => null);
    this.render();
  }

  // --- state changes -------------------------------------------------------

  _selectFrame(frame) {
    if (frame === this.frame) return;
    this.frame = frame;
    // Keep whatever still fits, pad the rest with empty hardpoints.
    const next = this.slots.slice(0, frame.slots);
    while (next.length < frame.slots) next.push(null);
    this.slots = next;
    this.render();
  }

  _selectWeapon(weapon) {
    this.selectedId = this.selectedId === weapon.id ? null : weapon.id;
    this.render();
  }

  /**
   * Clicking a hardpoint installs the selected weapon, swaps in a different
   * one, or clears it. Clearing wins whenever the slot already holds the
   * selected weapon (or nothing is selected), so the "click to clear" hint is
   * always truthful — the old code installed the selection unconditionally,
   * which made filled hardpoints impossible to clear while a weapon was armed.
   */
  _place(index) {
    const current = this.slots[index];
    if (!current) {
      if (this.selectedId) this.slots[index] = this.selectedId;
    } else if (this.selectedId && this.selectedId !== current) {
      this.slots[index] = this.selectedId;
    } else {
      this.slots[index] = null;
    }
    this.render();
  }

  /** Clear one hardpoint. Backs the per-slot "×" control. */
  _clearSlot(index) {
    if (!this.slots[index]) return;
    this.slots[index] = null;
    this.render();
  }

  // --- rendering ----------------------------------------------------------

  _buildFrameCards() {
    this.els.frameCards.innerHTML = '';
    for (const frame of FRAMES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.dataset.frame = frame.id;
      card.innerHTML = `
        <span class="card__tag">${frame.slots} hardpoints</span>
        <h3 class="card__title">${frame.name}</h3>
        <p class="card__code">${frame.codename}</p>
        <dl class="stats stats--three">
          <div><dt>Hull</dt><dd>${frame.hull}</dd></div>
          <div><dt>Speed</dt><dd>${frame.speed}</dd></div>
          <div><dt>Jump</dt><dd>${frame.jump}</dd></div>
          <div><dt>Armor</dt><dd>${frame.armor}</dd></div>
          <div><dt>Heat sink</dt><dd>${frame.capacity}</dd></div>
          <div><dt>Agility</dt><dd>${frame.accel}</dd></div>
        </dl>
        <p class="card__blurb">${frame.blurb}</p>`;
      card.addEventListener('click', () => this._selectFrame(frame));
      this.els.frameCards.appendChild(card);
    }
  }

  _buildWeaponCards() {
    this.els.weaponCards.innerHTML = '';
    for (const weapon of WEAPONS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card card--weapon';
      card.dataset.weapon = weapon.id;
      const rateText =
        weapon.mode === 'beam' ? 'continuous' : `${fireRate(weapon).toFixed(1)}/s`;
      const ammoText = weapon.ammo
        ? `AMMO ${weapon.ammo.magazine}/mag · ${weapon.ammo.reserve} spare · ${weapon.ammo.reload}s reload`
        : 'NO AMMO — heat only';

      card.innerHTML = `
        <span class="card__tag">${weapon.klass} · ${MODE_LABELS[weapon.mode] || weapon.mode}</span>
        <h3 class="card__title">${weapon.name}</h3>
        <p class="card__code">${weapon.abbr} · ${Math.round(weaponRange(weapon))} px range</p>
        <dl class="stats stats--compact">
          <div><dt>Dmg</dt><dd>${burstDamage(weapon)}</dd></div>
          <div><dt>Rate</dt><dd>${rateText}</dd></div>
          <div><dt>Heat</dt><dd>${weapon.heat}/s</dd></div>
        </dl>
        <p class="card__ammo ${weapon.ammo ? '' : 'card__ammo--free'}">${ammoText}</p>
        <p class="card__blurb">${weapon.blurb}</p>`;
      card.addEventListener('click', () => this._selectWeapon(weapon));
      this.els.weaponCards.appendChild(card);
    }
  }

  _renderSlots() {
    this.els.hardpoints.innerHTML = '';
    for (let i = 0; i < this.frame.slots; i++) {
      const id = this.slots[i];
      const weapon = WEAPONS.find((w) => w.id === id) || null;
      // A <button> cannot legally contain another <button>, so the slot is a
      // div with button semantics and the clear control is a real button.
      const slot = document.createElement('div');
      slot.className = `slot ${weapon ? 'slot--filled' : 'slot--empty'}`;
      slot.setAttribute('role', 'button');
      slot.tabIndex = 0;

      let hint;
      if (weapon) {
        hint =
          this.selectedId && this.selectedId !== weapon.id ? 'click to replace' : 'click to clear';
      } else {
        hint = this.selectedId ? 'click to install' : 'select a weapon';
      }

      slot.innerHTML = weapon
        ? `<span class="slot__idx">HP-${i + 1}</span>
           <span class="slot__abbr" style="color:${weapon.color}">${weapon.abbr}</span>
           <span class="slot__name">${weapon.name}</span>
           <span class="slot__hint">${hint}</span>
           <button class="slot__clear" type="button" title="Clear HP-${i + 1}"
             aria-label="Clear HP-${i + 1} (${weapon.name})">&times;</button>`
        : `<span class="slot__idx">HP-${i + 1}</span>
           <span class="slot__abbr">--</span>
           <span class="slot__name">Empty</span>
           <span class="slot__hint">${hint}</span>`;

      slot.setAttribute(
        'aria-label',
        weapon ? `HP-${i + 1}: ${weapon.name}. ${hint}.` : `HP-${i + 1}: empty. ${hint}.`
      );

      slot.addEventListener('click', () => this._place(i));
      slot.addEventListener('keydown', (e) => {
        // Ignore keys aimed at the nested clear button.
        if (e.target !== slot) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._place(i);
        }
      });

      const clear = slot.querySelector('.slot__clear');
      if (clear) {
        clear.addEventListener('click', (e) => {
          e.stopPropagation();
          this._clearSlot(i);
        });
      }

      this.els.hardpoints.appendChild(slot);
    }
  }

  render() {
    for (const card of this.els.frameCards.children) {
      card.classList.toggle('is-active', card.dataset.frame === this.frame.id);
    }
    for (const card of this.els.weaponCards.children) {
      const active = card.dataset.weapon === this.selectedId;
      card.classList.toggle('is-active', active);
      // Dim weapons that are not selected while one is armed, to signal "pick a slot".
      card.classList.toggle('is-dimmed', this.selectedId !== null && !active);
    }

    this._renderSlots();

    const f = this.frame;
    const weapons = this.slots.map((id) => WEAPONS.find((w) => w.id === id) || null);
    const heat = totalHeatRate(weapons);
    const burst = burstDps(weapons);
    const sustain = sustainedDps(f, weapons);
    const ammoCount = weapons.filter((w) => w && w.ammo).length;

    let heatText;
    if (heat <= f.cooling) {
      heatText = 'runs cool — full rate, forever';
    } else if (willOverheat(f, weapons)) {
      heatText = 'saturates: expect a vent cycle';
    } else {
      heatText = `settles at ×${settleCycle(f, weapons).toFixed(2)} cooldown`;
    }

    this.els.stats.innerHTML =
      `${f.name} · ${f.slots} hardpoints · hull ${f.hull} · speed ${f.speed} · ` +
      `jump ${f.jump} · armor ${f.armor}<br>` +
      `<strong>HEAT ${fmt(heat)}/s vs cooling ${f.cooling}/s</strong> · ${heatText}<br>` +
      `burst <strong>${Math.round(burst)} dps</strong> · sustained ` +
      `<strong>${Math.round(sustain)} dps</strong> · ` +
      `${ammoCount}/${weapons.filter(Boolean).length || 0} hardpoints need ammo`;

    const armed = this.slots.filter(Boolean).length;
    const empty = f.slots - armed;
    if (armed === 0) {
      this._setStatus('No weapons installed — the machine would deploy unarmed.', true);
    } else if (empty > 0) {
      this._setStatus(`${armed}/${f.slots} hardpoints armed · ${empty} left empty.`, true);
    } else {
      this._setStatus(`${armed}/${f.slots} hardpoints armed · loadout complete.`, false);
    }

    this.els.deploy.disabled = armed === 0;
  }

  _setStatus(text, warn) {
    this.els.status.textContent = text;
    this.els.status.classList.toggle('is-warn', !!warn);
  }
}
