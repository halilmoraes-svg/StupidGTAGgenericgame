/**
 * lounge.js — O "Lounge" (hub inicial), o macaco (avatar) e o salvamento local
 * ===========================================================================
 *
 * Exporta:
 *   - TOTAL_LEVELS, MONKEY_COLORS, fmtTime
 *   - SaveData      progresso e cor salvos no localStorage
 *   - MonkeyAvatar  macaco de corpo inteiro (cabeça, tronco, braços elásticos e mãos)
 *                   que segue a cabeça e as mãos do jogador. A cor vale para o corpo todo.
 *   - Lounge        sala segura com: computador CRT + botões físicos 3D (cor / fase / iniciar),
 *                   espelho de corpo inteiro, paredes de treino (escalada e quique)
 *                   e o corredor/portal que leva direto à Fase 1.
 *
 * Mapa do Lounge (metros, Y para cima; o jogador nasce em z = +2 olhando para -Z):
 *
 *            Norte (z = -4)
 *        ┌───────────────────────┐
 *        │   [CRT + mesa]        │
 *   PORTAL◄── Oeste        Leste ─┤ ESPELHO (x = +5)
 *        │   (x = -5)            │
 *        │ [quique] [escalada]   │
 *        └───────────────────────┘
 *            Sul (z = +4)
 */

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { OBB, Trigger } from './physics.js';
import { ProceduralTextures, RetroScreen } from './audio.js';

export const TOTAL_LEVELS = 30;

export const MONKEY_COLORS = [
  { name: 'MARROM',   hex: 0x7a4a2a },
  { name: 'AZUL',     hex: 0x2f6fe0 },
  { name: 'VERDE',    hex: 0x2fb84a },
  { name: 'ROXO',     hex: 0x8a3fd0 },
  { name: 'VERMELHO', hex: 0xd83030 },
  { name: 'PRETO',    hex: 0x1f1f24 },
  { name: 'BRANCO',   hex: 0xf0f0f0 },
];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const hexStr = (n) => '#' + n.toString(16).padStart(6, '0');

/** 83.4 → "01:23.4" ; null → "--:--.-" */
export function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '--:--.-';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/* ===========================================================================
 * SaveData — localStorage (com proteção para navegadores que bloqueiam o storage)
 * ========================================================================= */
export class SaveData {
  constructor(key = 'gorillaLab.save.v1') {
    this.key = key;
    this.data = { unlocked: 1, color: 0, best: {} };
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) this.data = { ...this.data, ...JSON.parse(raw) };
    } catch (e) { /* storage indisponível: segue sem salvar */ }
    this.data.unlocked = clamp(parseInt(this.data.unlocked, 10) || 1, 1, TOTAL_LEVELS);
    this.data.color = clamp(parseInt(this.data.color, 10) || 0, 0, MONKEY_COLORS.length - 1);
    if (!this.data.best || typeof this.data.best !== 'object') this.data.best = {};
  }

  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch (e) { /* ignora */ }
  }

  get unlocked() { return this.data.unlocked; }
  get color() { return this.data.color; }
  bestTime(n) { return this.data.best[n] ?? null; }

  setColor(i) {
    this.data.color = clamp(i, 0, MONKEY_COLORS.length - 1);
    this.save();
  }

  /** Marca a fase como concluída, libera a próxima e guarda o melhor tempo. */
  completeLevel(n, seconds) {
    this.data.unlocked = Math.max(this.data.unlocked, Math.min(n + 1, TOTAL_LEVELS));
    const prev = this.data.best[n];
    if (prev == null || seconds < prev) this.data.best[n] = Math.round(seconds * 10) / 10;
    this.save();
  }

  /** Para testes: ?unlock=all na URL. */
  unlockAll() {
    this.data.unlocked = TOTAL_LEVELS;
    this.save();
  }
}

/* ===========================================================================
 * MonkeyAvatar — macaco sem pernas, de corpo inteiro
 * ========================================================================= */

const _fwd = new THREE.Vector3();
const _sh = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c1 = new THREE.Color();
const _cLight = new THREE.Color(0xffe3c4);

export class MonkeyAvatar {
  constructor() {
    this.root = new THREE.Group();   // filhos ficam em coordenadas de MUNDO (root na origem)
    this.yaw = 0;

    // Materiais: a mesma textura de plástico granulado, tingida pela cor escolhida
    const tex = ProceduralTextures.plastic('#ffffff');
    this.fur = new THREE.MeshLambertMaterial({ map: tex, color: MONKEY_COLORS[0].hex });
    this.skin = new THREE.MeshLambertMaterial({ map: tex, color: 0xd9a77a });   // focinho/barriga/orelhas
    const dark = new THREE.MeshLambertMaterial({ color: 0x0c0c0c });

    const mk = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;   // escala/posição mudam todo frame
      return m;
    };

    /* ---- Cabeça: origem = posição da câmera (olhos); o macaco olha para -Z ---- */
    this.head = new THREE.Group();
    const skull = mk(new THREE.SphereGeometry(0.14, 8, 6), this.fur);
    skull.position.set(0, 0, 0.06);
    const muzzle = mk(new THREE.SphereGeometry(0.075, 8, 6), this.skin);
    muzzle.scale.set(1, 0.8, 0.85);
    muzzle.position.set(0, -0.045, -0.085);
    const nose = mk(new THREE.SphereGeometry(0.018, 6, 4), dark);
    nose.position.set(0, -0.03, -0.155);
    this.head.add(skull, muzzle, nose);
    for (const s of [-1, 1]) {
      const eye = mk(new THREE.SphereGeometry(0.022, 6, 4), dark);
      eye.position.set(s * 0.05, 0.03, -0.07);
      const ear = mk(new THREE.SphereGeometry(0.055, 6, 5), this.fur);
      ear.position.set(s * 0.145, 0.02, 0.06);
      const earIn = mk(new THREE.SphereGeometry(0.032, 6, 4), this.skin);
      earIn.position.set(s * 0.168, 0.02, 0.055);
      this.head.add(eye, ear, earIn);
    }
    this.head.visible = false;   // em 1ª pessoa a cabeça some; só aparece no espelho
    this.root.add(this.head);

    /* ---- Tronco (cápsula) com barriga clara ---- */
    this.torso = new THREE.Group();
    this.torso.add(mk(new THREE.CapsuleGeometry(0.15, 0.24, 3, 8), this.fur));
    const belly = mk(new THREE.SphereGeometry(0.11, 8, 6), this.skin);
    belly.scale.set(1, 1.35, 0.5);
    belly.position.set(0, -0.02, -0.11);
    this.torso.add(belly);
    this.root.add(this.torso);

    /* ---- Ombros, braços elásticos e mãos (punhos) ---- */
    const armGeo = new THREE.CylinderGeometry(0.032, 0.04, 1, 6, 1);
    armGeo.translate(0, 0.5, 0);   // base na origem; estica ao longo de +Y
    this.shoulders = [];
    this.arms = [];
    this.fists = [];
    for (let i = 0; i < 2; i++) {
      const shoulder = mk(new THREE.SphereGeometry(0.05, 6, 5), this.fur);
      const arm = mk(armGeo, this.fur);
      const fist = mk(new THREE.SphereGeometry(0.065, 7, 5), this.fur);
      fist.scale.set(1, 0.9, 1.15);
      this.shoulders.push(shoulder);
      this.arms.push(arm);
      this.fists.push(fist);
      this.root.add(shoulder, arm, fist);
    }
    this.colorHex = MONKEY_COLORS[0].hex;
  }

  /** Aplica a cor ao corpo todo (cabeça, tronco, braços, mãos). O focinho/barriga ficam mais claros. */
  setColor(hex) {
    this.colorHex = hex;
    this.fur.color.setHex(hex);
    this.skin.color.copy(_c1.setHex(hex).lerp(_cLight, 0.55));
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} headPos      posição da cabeça (mundo)
   * @param {THREE.Quaternion} headQuat  orientação da cabeça (mundo)
   * @param {{active:boolean,pos:THREE.Vector3,quat:THREE.Quaternion}[]} hands  [esquerda, direita]
   */
  update(dt, headPos, headQuat, hands) {
    // Cabeça segue exatamente a pose rastreada
    this.head.position.copy(headPos);
    this.head.quaternion.copy(headQuat);

    // Tronco: gira (suavizado) para onde a cabeça olha, só no eixo Y
    _fwd.set(0, 0, -1).applyQuaternion(headQuat);
    if (Math.hypot(_fwd.x, _fwd.z) > 0.25) {
      const target = Math.atan2(-_fwd.x, -_fwd.z);
      let diff = target - this.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));      // menor caminho angular
      this.yaw += diff * (1 - Math.exp(-8 * dt));
    }
    this.torso.position.set(headPos.x, headPos.y - 0.46, headPos.z);
    this.torso.rotation.y = this.yaw;

    // Braços: do ombro até a mão (esticam livremente, como no Gorilla Tag)
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const hand = hands[i];
      const sx = side * 0.19;
      // Ombro = tronco + (sx, 0.19, 0) rotacionado pelo yaw
      _sh.set(
        this.torso.position.x + sx * cos,
        this.torso.position.y + 0.19,
        this.torso.position.z - sx * sin
      );
      this.shoulders[i].position.copy(_sh);

      const visible = !!hand && hand.active;
      this.arms[i].visible = visible;
      this.fists[i].visible = visible;
      if (!visible) continue;

      _dir.subVectors(hand.pos, _sh);
      const len = _dir.length();
      if (len > 0.02) {
        this.arms[i].position.copy(_sh);
        this.arms[i].quaternion.setFromUnitVectors(_up, _dir.multiplyScalar(1 / len));
        this.arms[i].scale.set(1, len, 1);
      }
      this.fists[i].position.copy(hand.pos);
      this.fists[i].quaternion.copy(hand.quat);
    }
  }
}

/* ===========================================================================
 * Utilitário: textura de texto pixelada (placas e rótulos dos botões)
 * ========================================================================= */
function makeLabelTexture(text, { w = 64, h = 64, fg = '#ffffff', bg = null, size = 20 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.fillStyle = fg;
  g.font = `bold ${size}px "Courier New", Courier, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = text.split('\n');
  lines.forEach((ln, i) => g.fillText(ln, w / 2, h / 2 + (i - (lines.length - 1) / 2) * (size + 2)));
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ===========================================================================
 * Lounge
 * ========================================================================= */
export class Lounge {
  /**
   * @param {object} cfg
   * @param {THREE.Scene} cfg.scene
   * @param {import('./physics.js').PhysicsWorld} cfg.world
   * @param {object} cfg.materials   resultado de createLabMaterials()
   * @param {import('./audio.js').ProceduralAudio} cfg.audio
   * @param {SaveData} cfg.save
   * @param {MonkeyAvatar} cfg.avatar
   * @param {{hemi:THREE.HemisphereLight, points:THREE.PointLight[]}} cfg.lights  luzes globais (nº fixo)
   * @param {object} [cfg.callbacks]  { onStartLevel(n), haptic(hand, intensidade, ms) }
   * @param {THREE.Object3D[]} [cfg.mirrorHide]  objetos que NÃO devem aparecer no espelho (HUD)
   */
  constructor({ scene, world, materials, audio, save, avatar, lights, callbacks = {}, mirrorHide = [] }) {
    this.scene = scene;
    this.world = world;
    this.mat = materials;
    this.audio = audio;
    this.save = save;
    this.avatar = avatar;
    this.lights = lights;
    this.cb = callbacks;
    this.mirrorHide = mirrorHide;

    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.active = false;
    this.solids = [];
    this.triggers = [];
    this.buttons = [];
    this.spawn = new THREE.Vector3(0, 0, 2.0);

    this.sel = clamp(save.unlocked, 1, TOTAL_LEVELS);   // fase selecionada no computador
    this.levelsReady = false;                           // main.js liga quando levels.js carrega
    this.msg = '';
    this.msgT = 0;

    this.screen = new RetroScreen();
    this._build();
    this.refresh();
  }

  /* ------------------------------ Ciclo de vida ------------------------------ */

  /** Mostra o Lounge, registra colisores/gatilhos e ajusta as luzes globais. */
  activate() {
    this.active = true;
    this.group.visible = true;
    for (const s of this.solids) this.world.addSolid(s);
    for (const t of this.triggers) { t.inside.clear(); this.world.addTrigger(t); }

    const L = this.lights;
    L.hemi.intensity = 1.7;
    L.hemi.color.set(0xd8ecff);
    L.hemi.groundColor.set(0x2a3a30);
    const cfg = [
      [[0, 3.4, 0], 0xfff1dc, 18],       // luz do teto
      [[0, 1.9, -3.0], 0x33ff66, 5],     // brilho do monitor CRT
      [[-8, 2.6, 0], 0xffc080, 12],      // corredor do portal
    ];
    L.points.forEach((p, i) => {
      const c = cfg[i];
      if (c) { p.position.set(...c[0]); p.color.setHex(c[1]); p.intensity = c[2]; p.distance = 0; }
      else p.intensity = 0;
    });
    this.refresh();
  }

  /** Esconde o Lounge e remove seus colisores do mundo (o espelho deixa de ser renderizado). */
  deactivate() {
    this.active = false;
    this.group.visible = false;
    for (const s of this.solids) this.world.remove(s);
    for (const t of this.triggers) { this.world.remove(t); t.inside.clear(); }
  }

  /** Chamado todo frame (só faz algo se ativo). */
  update(dt, time) {
    if (!this.active) return;
    this.screen.update(dt);

    if (this.msgT > 0) {
      this.msgT -= dt;
      if (this.msgT <= 0) { this.msg = ''; this.refresh(); }
    }
    for (const b of this.buttons) {
      if (b.pressT > 0) {
        b.pressT -= dt;
        const k = Math.max(0, b.pressT) / 0.18;
        b.cap.position.y = b.restY - 0.022 * k;       // tecla afunda e volta
      }
    }
    this.portalDisc.rotation.z += dt * 0.9;
    this.portalRing.rotation.z -= dt * 0.4;
  }

  /** Mostra uma mensagem temporária na tela do CRT. */
  notify(text, seconds = 2.5) {
    this.msg = text;
    this.msgT = seconds;
    this.refresh();
  }

  /** Redesenha o texto do monitor. */
  refresh() {
    const unlocked = this.save.unlocked;
    this.sel = clamp(this.sel, 1, unlocked);
    const colorName = MONKEY_COLORS[this.save.color].name;
    const best = this.save.bestTime(this.sel);
    const lines = [
      'GORILLA LAB TERMINAL v1.0',
      '-------------------------',
      `COR DO MACACO: ${colorName}`,
      `FASES LIBERADAS: ${String(unlocked).padStart(2, '0')}/${TOTAL_LEVELS}`,
      '',
      { text: ` FASE SELECIONADA: ${String(this.sel).padStart(2, '0')} `, inverse: true },
      { text: `MELHOR TEMPO: ${fmtTime(best)}`, dim: true },
      '',
      { text: '[<][>] ESCOLHER  [GO] INICIAR', dim: true },
    ];
    if (!this.levelsReady) lines.push({ text: '! levels.js NAO ENCONTRADO', dim: true });
    if (this.msg) lines.push('', '> ' + this.msg);
    this.screen.setLines(lines);
  }

  /* ------------------------------ Construção ------------------------------ */

  /** Cria malha + (opcionalmente) colisor sólido para uma caixa. */
  _box({ size, pos, mat, rot = null, solid = true, tile = 2, props = {} }) {
    const [w, h, d] = size;
    const geo = new THREE.BoxGeometry(w, h, d);
    ProceduralTextures.applyBoxUVs(geo, w, h, d, tile);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    this.group.add(m);
    if (solid) this.solids.push(new OBB({ position: pos, size, rotation: rot, ...props }));
    return m;
  }

  /** Placa de texto (plano com textura pixelada). */
  _sign(text, { pos, rotY = 0, w = 1.6, h = 0.4, px = 128, py = 32, fg = '#33ff66', bg = '#06140a', size = 16 }) {
    const tex = makeLabelTexture(text, { w: px, h: py, fg, bg, size });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.y = rotY;
    this.group.add(m);
    return m;
  }

  _build() {
    const M = this.mat;
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff3d6 });

    /* ---------- Casca da sala: x∈[-5,5], z∈[-4,4], y∈[0,4] ---------- */
    this._box({ size: [10.8, 0.5, 8.8], pos: [0, -0.25, 0], mat: M.floor });                 // piso
    this._box({ size: [10.8, 0.5, 8.8], pos: [0, 4.25, 0], mat: M.floor });                  // teto
    this._box({ size: [10.8, 4, 0.4], pos: [0, 2, -4.2], mat: M.wall });                     // norte
    this._box({ size: [10.8, 4, 0.4], pos: [0, 2, 4.2], mat: M.wall });                      // sul
    this._box({ size: [0.4, 4, 8.8], pos: [5.2, 2, 0], mat: M.wall });                       // leste
    this._box({ size: [0.4, 4, 2.8], pos: [-5.2, 2, -2.6], mat: M.wall });                   // oeste (esq. da porta)
    this._box({ size: [0.4, 4, 2.8], pos: [-5.2, 2, 2.6], mat: M.wall });                    // oeste (dir. da porta)
    this._box({ size: [0.4, 1, 2.4], pos: [-5.2, 3.5, 0], mat: M.wall });                    // verga da porta
    this._box({ size: [0.1, 0.2, 2.6], pos: [-4.95, 2.88, 0], mat: M.hazard, solid: false, tile: 0.5 });

    // Luminárias do teto (só visual; a iluminação real vem das PointLights globais)
    this._box({ size: [1.6, 0.08, 0.5], pos: [-2.2, 3.96, 0], mat: lampMat, solid: false });
    this._box({ size: [1.6, 0.08, 0.5], pos: [2.2, 3.96, 0], mat: lampMat, solid: false });
    // Rodapé de perigo ao redor do piso
    this._box({ size: [10, 0.16, 0.04], pos: [0, 0.08, -3.98], mat: M.hazard, solid: false, tile: 0.5 });
    this._box({ size: [10, 0.16, 0.04], pos: [0, 0.08, 3.98], mat: M.hazard, solid: false, tile: 0.5 });

    /* ---------- Mesa + monitor CRT ---------- */
    const deskMat = M.plastic('#3a4650');
    const beige = M.plastic('#c9c2a8');
    const darkPlate = M.plastic('#20262b');
    this._box({ size: [3.0, 0.08, 1.4], pos: [0, 0.91, -3.25], mat: deskMat, props: { surface: 'plastic' } });  // tampo (topo y=0.95)
    this._box({ size: [0.1, 0.87, 1.2], pos: [-1.4, 0.435, -3.25], mat: deskMat, props: { surface: 'plastic' } });
    this._box({ size: [0.1, 0.87, 1.2], pos: [1.4, 0.435, -3.25], mat: deskMat, props: { surface: 'plastic' } });
    this._box({ size: [1.9, 0.03, 0.5], pos: [0, 0.965, -2.78], mat: darkPlate, props: { surface: 'plastic' } }); // placa do teclado (topo y=0.98)
    this._box({ size: [0.95, 0.78, 0.7], pos: [0, 1.34, -3.5], mat: beige, props: { surface: 'plastic' } });    // corpo do CRT

    const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.76, 0.57), this.screen.material);
    screenMesh.position.set(0, 1.38, -3.148);
    this.group.add(screenMesh);

    /* ---------- Botões físicos ---------- */
    const baseY = 0.98;
    const rowA = -2.65;   // cores (mais perto do jogador)
    const rowB = -2.93;   // fase / iniciar

    MONKEY_COLORS.forEach((c, i) => {
      this._addButton({
        x: (i - 3) * 0.24, z: rowA, baseY, color: hexStr(c.hex), label: null,
        onPress: () => {
          this.save.setColor(i);
          this.avatar.setColor(c.hex);
          this.audio.playBeep('select');
          this.notify('COR: ' + c.name, 2);
        },
      });
    });
    this._addButton({
      x: -0.48, z: rowB, baseY, color: '#d8a820', label: '<',
      onPress: () => {
        const u = this.save.unlocked;
        this.sel = this.sel > 1 ? this.sel - 1 : u;
        this.audio.playBeep('select');
        this.refresh();
      },
    });
    this._addButton({
      x: 0, z: rowB, baseY, color: '#2fb84a', label: 'GO',
      onPress: () => {
        this.audio.playBeep('ok');
        if (this.cb.onStartLevel) this.cb.onStartLevel(this.sel);
      },
    });
    this._addButton({
      x: 0.48, z: rowB, baseY, color: '#d8a820', label: '>',
      onPress: () => {
        const u = this.save.unlocked;
        this.sel = this.sel < u ? this.sel + 1 : 1;
        this.audio.playBeep('select');
        this.refresh();
      },
    });

    /* ---------- Espelho de corpo inteiro (parede leste) ---------- */
    this._buildMirror();

    /* ---------- Paredes de treino (sul) ---------- */
    // Escalada por pinça: segure o grip perto do painel de grade
    this._box({ size: [3.0, 3.0, 0.3], pos: [2.2, 1.6, 3.85], mat: M.grate, tile: 1,
                props: { climbable: true, surface: 'metal' } });
    this._sign('ESCALADA\nSEGURE O GRIP', { pos: [2.2, 3.5, 3.69], rotY: Math.PI, w: 2.4, h: 0.5, px: 192, py: 48, size: 16 });
    // Parede elástica: bata e solte rápido para quicar
    this._box({ size: [2.2, 2.4, 0.3], pos: [-2.4, 1.3, 3.85], mat: M.plastic('#2d8f4e'),
                props: { bounce: 0.95, surface: 'plastic' } });
    this._sign('PAREDE ELASTICA\nBATA E SOLTE', { pos: [-2.4, 3.0, 3.69], rotY: Math.PI, w: 2.4, h: 0.5, px: 192, py: 48, size: 16 });

    /* ---------- Corredor + portal (oeste) ---------- */
    this._buildPortal();
  }

  /** Botão 3D: tecla que afunda ao ser tocada + gatilho para as mãos. */
  _addButton({ x, z, baseY, color, label, onPress }) {
    const M = this.mat;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.03, 0.15), M.plastic('#101417'));
    housing.position.set(x, baseY + 0.015, z);
    this.group.add(housing);

    const cap = new THREE.Group();
    const keyMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.12), M.plastic(color));
    cap.add(keyMesh);
    if (label) {
      const tex = makeLabelTexture(label, { w: 32, h: 32, fg: '#101010', size: label.length > 1 ? 12 : 22 });
      const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      lab.rotation.x = -Math.PI / 2;
      lab.position.y = 0.0265;
      cap.add(lab);
    }
    const restY = baseY + 0.055;
    cap.position.set(x, restY, z);
    this.group.add(cap);

    const btn = { cap, restY, pressT: 0, lastPress: -10, onPress };
    // Gatilho estreito: com espaçamento de 0.24 m, uma mão (raio 0.07) não aciona duas teclas
    const trig = new Trigger({
      position: [x, baseY + 0.07, z],
      size: [0.09, 0.14, 0.09],
      sources: ['left', 'right'],
      userData: { pressable: true, button: btn },
      onEnter: (info) => {
        const now = performance.now() / 1000;
        if (now - btn.lastPress < 0.35) return;     // anti-repique
        btn.lastPress = now;
        btn.pressT = 0.18;
        if (this.cb.haptic && info.hand >= 0) this.cb.haptic(info.hand, 0.5, 40);
        btn.onPress(info);
      },
    });
    this.triggers.push(trig);
    this.buttons.push(btn);
  }

  /**
   * Espelho funcional (THREE.Reflector) em resolução baixa. Só é renderizado quando:
   *   - o Lounge está visível (deactivate() esconde o grupo → custo zero nas fases), e
   *   - o espelho está dentro do campo de visão (frustum culling do Three.js).
   * A cabeça do macaco fica invisível em 1ª pessoa e só aparece DURANTE a renderização
   * do espelho; assim o jogador vê o macaco inteiro sem ter a própria cabeça na câmera.
   */
  _buildMirror() {
    const M = this.mat;
    const mirror = new Reflector(new THREE.PlaneGeometry(1.6, 2.4), {
      textureWidth: 256,
      textureHeight: 384,
      color: 0xc4ccd0,
      clipBias: 0.003,
      multisample: 0,
    });
    mirror.position.set(4.99, 1.3, 0);
    mirror.rotation.y = -Math.PI / 2;     // normal apontando para -X (para dentro da sala)
    this.group.add(mirror);
    this.mirror = mirror;

    // Moldura
    const frame = M.plastic('#15191d');
    this._box({ size: [0.1, 0.1, 1.8], pos: [4.95, 0.05, 0], mat: frame, solid: false, tile: 0.5 });
    this._box({ size: [0.1, 0.1, 1.8], pos: [4.95, 2.55, 0], mat: frame, solid: false, tile: 0.5 });
    this._box({ size: [0.1, 2.6, 0.1], pos: [4.95, 1.3, -0.85], mat: frame, solid: false, tile: 0.5 });
    this._box({ size: [0.1, 2.6, 0.1], pos: [4.95, 1.3, 0.85], mat: frame, solid: false, tile: 0.5 });

    // Gancho: mostra a cabeça (e esconde o HUD) apenas durante o render do espelho
    const original = mirror.onBeforeRender;
    const self = this;
    mirror.onBeforeRender = function (renderer, scene, camera, ...rest) {
      const prev = self.mirrorHide.map((o) => o.visible);
      self.avatar.head.visible = true;
      self.mirrorHide.forEach((o) => { o.visible = false; });
      original.call(mirror, renderer, scene, camera, ...rest);
      self.avatar.head.visible = false;
      self.mirrorHide.forEach((o, i) => { o.visible = prev[i]; });
    };
  }

  /** Corredor a oeste, terminando num portal que leva direto à Fase 1. */
  _buildPortal() {
    const M = this.mat;
    // Estrutura do corredor: x∈[-11,-5], z∈[-1.2,1.2], y∈[0,3.2]
    this._box({ size: [6.4, 0.5, 2.4], pos: [-8.2, -0.25, 0], mat: M.floor });
    this._box({ size: [6.4, 0.5, 2.4], pos: [-8.2, 3.45, 0], mat: M.floor });
    this._box({ size: [6.4, 3.7, 0.4], pos: [-8.2, 1.6, -1.4], mat: M.wall });
    this._box({ size: [6.4, 3.7, 0.4], pos: [-8.2, 1.6, 1.4], mat: M.wall });
    this._box({ size: [0.4, 3.7, 3.2], pos: [-11.2, 1.6, 0], mat: M.wall });

    // Faixas de perigo no piso guiando até o portal (só visual)
    this._box({ size: [5.6, 0.02, 0.2], pos: [-8.0, 0.01, -0.95], mat: M.hazard, solid: false, tile: 0.5 });
    this._box({ size: [5.6, 0.02, 0.2], pos: [-8.0, 0.01, 0.95], mat: M.hazard, solid: false, tile: 0.5 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
    this._box({ size: [0.5, 0.08, 1.0], pos: [-7, 3.16, 0], mat: lampMat, solid: false });
    this._box({ size: [0.5, 0.08, 1.0], pos: [-9.5, 3.16, 0], mat: lampMat, solid: false });

    // Portal: anel + disco animado (reaproveita a textura do ácido)
    const px = -10.45;
    this.portalRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.05, 0.09, 6, 12),
      new THREE.MeshBasicMaterial({ color: 0x33ff66 })
    );
    this.portalRing.position.set(px, 1.5, 0);
    this.portalRing.rotation.y = Math.PI / 2;
    this.group.add(this.portalRing);

    this.portalDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 12),
      new THREE.MeshBasicMaterial({
        map: M.acid.texture, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
      })
    );
    this.portalDisc.position.set(px - 0.05, 1.5, 0);
    this.portalDisc.rotation.y = Math.PI / 2;
    this.group.add(this.portalDisc);

    // Placas: uma sobre a porta (dentro do Lounge) e outra no fundo do corredor
    this._sign('FASE 1  >>', { pos: [-4.98, 3.5, 0], rotY: Math.PI / 2, w: 2.0, h: 0.4, px: 160, py: 32, size: 18 });
    this._sign('ESCAPE DO LABORATORIO\nFASE 1', { pos: [-10.98, 2.75, 0], rotY: Math.PI / 2, w: 2.2, h: 0.5, px: 192, py: 48, size: 15 });

    // Gatilho: qualquer parte do corpo no portal inicia a Fase 1
    this.triggers.push(new Trigger({
      position: [px, 1.5, 0],
      size: [0.3, 3.0, 2.4],
      sources: ['head', 'torso', 'left', 'right'],
      onEnter: () => {
        this.audio.playBeep('boot');
        if (this.cb.onStartLevel) this.cb.onStartLevel(1);
      },
    }));
  }
}
