/**
 * levels.js — Gerador modular das 30 fases de parkour do laboratório
 * ===========================================================================
 *
 * Exporta `LevelManager` (contrato descrito no cabeçalho do main.js):
 *   build(n) → { spawn }   unload()   update(dt, t)   getAcidLevel(headPos)   checkpoint
 *
 * COMO FUNCIONA
 * -------------
 * Cada fase é uma LISTA DE SEGMENTOS (veja PLANS no fim do arquivo). O jogador
 * avança sempre para -Z. Cada segmento parte da "plataforma atual" (this.cur) e
 * cria geometria nova, deixando a nova plataforma final em this.cur:
 *
 *   ['hop', gap, dy, size, dx]        salto simples entre plataformas quadradas
 *   ['ramp', len, rise, width, end]   rampa inclinada (sobe/desce) + plataforma
 *   ['push']                          cunha elástica na ponta da plataforma (impulso)
 *   ['pillars', n, gap, size, jit, dyJit]  pilares estreitos (posições levemente aleatórias)
 *   ['precision', n, size, gap, zig]  pads minúsculos em zigue-zague
 *   ['climb', rise]                   parede de grade escalável (pinça com o grip)
 *   ['wall', len, 'L'|'R'|'LR', {width, angle, lean, dy}]
 *                                      parede lisa (wall run / wall bounce) sobre tanque
 *                                      de ácido. angle = convergência, lean = inclinação
 *                                      para fora (mais difícil)
 *   ['mover', 'x'|'y'|'z', gap, size, amp, period]  plataforma móvel (lateral/vertical/vaivém)
 *   ['spinner', len, width, speed]    plataforma longa com barras giratórias
 *   ['carousel', gap1, length, speed, gap2]  plataforma giratória para "pegar carona"
 *   ['check']                         plataforma de checkpoint intermediário
 *   ['goal', gap]                     plataforma final com indicador vermelho → verde
 *   ['final', gap]                    sala final "Escape do Laboratório" (fase 30)
 *
 * DIFICULDADE
 *   Fases  1-10  fundamentos: plataformas fixas, saltos crescentes, rampas, cunhas elásticas, pilares
 *   Fases 11-20  paredes lisas/anguladas (wall run + wall bounce) sobre ácido, pilares estreitos
 *   Fases 21-30  plataformas móveis, obstáculos giratórios, wall runs longos sem chão,
 *                paredes inclinadas para fora e saltos de precisão
 *
 * O ÁCIDO cobre todo o fundo (y = menor plataforma − 3,5 m). Tocar nele (mãos,
 * cabeça ou tronco) chama events.onAcid() → main.js toca o chiado e teleporta
 * o jogador ao checkpoint.
 *
 * Desempenho: toda geometria estática é MESCLADA por material (≈ 6-8 draw calls
 * por fase) e só as plataformas móveis são malhas separadas. As luzes são as
 * mesmas 3 PointLights globais, que aqui apenas seguem o jogador.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OBB, Trigger } from './physics.js';
import { ProceduralTextures } from './audio.js';

const TOTAL = 30;
const _Y = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** PRNG determinístico: a mesma fase sai igual para todos. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paredes de wall run: ADERENTES (glide 0 = a mão não escorre) e elásticas
 * (bounce 0.6 = batida forte rebate). O momento ao longo da parede é mantido pela física.
 */
const WALL_PROPS = { glide: 0, slip: 0.02, bounce: 0.6, surface: 'metal' };

export class LevelManager {
  /**
   * @param {object} cfg
   * @param {THREE.Scene} cfg.scene
   * @param {import('./physics.js').PhysicsWorld} cfg.world
   * @param {object} cfg.materials  createLabMaterials()
   * @param {import('./audio.js').ProceduralAudio} cfg.audio
   * @param {{hemi:THREE.HemisphereLight, points:THREE.PointLight[]}} cfg.lights
   * @param {{onAcid:Function,onGoal:Function}} cfg.events
   */
  constructor({ scene, world, materials, audio, lights, events }) {
    this.scene = scene;
    this.world = world;
    this.M = materials;
    this.audio = audio;
    this.lights = lights;
    this.events = events;

    this.count = TOTAL;
    this.checkpoint = new THREE.Vector3();
    this.group = null;
    this.number = 0;
    this._head = new THREE.Vector3();
    this._reset();
  }

  /* ========================================================================
   * API pública
   * ====================================================================== */

  /** Constrói a fase `n` (1..30). Retorna { spawn, title }. */
  build(n) {
    this.unload();
    n = clamp(Math.round(n), 1, TOTAL);
    this.number = n;
    this.rng = mulberry32(n * 7919 + 13);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.t = 0;

    // Indicador de meta (vermelho → verde): um único material compartilhado
    this.goalMat = new THREE.MeshBasicMaterial({ color: 0xff3030 });
    this.own.push(this.goalMat);

    // Plataforma inicial; o jogador nasce perto da borda de trás, olhando para -Z
    const S = n <= 3 ? 5 : 4;
    this.cur = this._plat(0, 0, 0, S, S, { mat: '#1f6f3a' });
    this.spawn = new THREE.Vector3(0, 0, S / 2 - 1.2);
    this.checkpoint.copy(this.spawn);

    for (const seg of PLANS[n - 1]) {
      const fn = this['_' + seg[0]];
      if (!fn) throw new Error('Segmento desconhecido: ' + seg[0]);
      fn.apply(this, seg.slice(1));
    }

    this._finish();
    this._setupLights();
    this._applyMovers(0, 0);

    if (this.scene.fog) { this.scene.fog.near = 18; this.scene.fog.far = 90; }
    return { spawn: this.spawn.clone(), title: `FASE ${n}` };
  }

  /** Remove tudo o que a fase criou (malhas, geometrias, materiais próprios, colisores). */
  unload() {
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.group = null;
    }
    for (const c of this.colliders) this.world.remove(c);
    for (const t of this.triggers) this.world.remove(t);
    for (const m of this.own) m.dispose();
    this._reset();
  }

  _reset() {
    this.colliders = [];
    this.triggers = [];
    this.movers = [];
    this.own = [];                 // materiais criados por esta fase (descartados no unload)
    this.statics = new Map();      // chave de material → geometrias a mesclar
    this.plastics = new Map();     // cache de plásticos coloridos
    this.bounds = new THREE.Box3();
    this.minTop = 0;
    this.maxTop = 0;
    this.goalReached = false;
    this.goalPos = new THREE.Vector3();
    this.acidY = -4;
    this.cur = null;
  }

  /** Anima plataformas móveis/giratórias e faz as luzes seguirem o jogador. */
  update(dt, _globalTime) {
    if (!this.group) return;
    this.t += dt;
    this._applyMovers(this.t, dt);

    const L = this.lights.points;
    const h = this._head;
    const k = 1 - Math.exp(-6 * dt);
    L[0].position.lerp(this._tmp.set(h.x, h.y + 2.5, h.z), k);                       // luz branca acima do jogador
    L[2].position.lerp(this._tmp.set(h.x, this.acidY + 1.2, h.z), k);                // brilho do ácido por baixo
  }

  /** Volume do borbulhar (0..1): mais alto quanto mais perto do ácido. */
  getAcidLevel(headPos) {
    this._head.copy(headPos);
    return clamp(1 - (headPos.y - this.acidY) / 10, 0.15, 0.9);
  }

  /* ========================================================================
   * Primitivas de construção
   * ====================================================================== */

  get _tmp() { return (this.__tmp ||= new THREE.Vector3()); }

  /** Material por chave: 'wall' | 'floor' | 'grate' | 'hazard' | '#rrggbb' (plástico). */
  _matObj(key) {
    if (this.M[key] && typeof this.M[key] !== 'function') return this.M[key];
    if (!this.plastics.has(key)) {
      const m = this.M.plastic(key);
      this.plastics.set(key, m);
      this.own.push(m);
    }
    return this.plastics.get(key);
  }

  /**
   * Caixa estática: geometria entra no lote do material (mesclado no fim) e,
   * se `solid`, vira colisor OBB. Rotação em Euler ordem YXZ (igual à física).
   */
  _box({ pos, size, rot = null, mat = 'floor', solid = true, tile = 2, props = {} }) {
    const [w, h, d] = size;
    const geo = new THREE.BoxGeometry(w, h, d);
    ProceduralTextures.applyBoxUVs(geo, w, h, d, tile);
    const q = new THREE.Quaternion();
    if (rot) q.setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'YXZ'));
    geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(pos[0], pos[1], pos[2]), q, new THREE.Vector3(1, 1, 1)));
    if (!this.statics.has(mat)) this.statics.set(mat, []);
    this.statics.get(mat).push(geo);

    if (solid) {
      const c = new OBB({ position: pos, size, rotation: rot, ...props });
      this.colliders.push(c);
      this.world.addSolid(c);
      this.bounds.expandByPoint(c.aabbMin);
      this.bounds.expandByPoint(c.aabbMax);
      return c;
    }
    return null;
  }

  /**
   * Plataforma: (x, y, z) = CENTRO DO TOPO. `t` = espessura (pilares usam valor alto).
   * A faixa de perigo sob a borda deixa o contorno visível contra o ácido.
   */
  _plat(x, y, z, w, d, { t = 0.6, mat = 'floor', rim = true, props = {} } = {}) {
    this._box({ pos: [x, y - t / 2, z], size: [w, t, d], mat, props: { surface: 'lab', ...props } });
    if (rim) this._box({ pos: [x, y - 0.17, z], size: [w + 0.12, 0.14, d + 0.12], mat: 'hazard', solid: false, tile: 0.5 });
    this.minTop = Math.min(this.minTop, y);
    this.maxTop = Math.max(this.maxTop, y);
    return { x, y, z, w, d };
  }

  /** Próxima plataforma à frente (-Z): `gap` é a distância borda-a-borda. */
  _next(gap, w, d, dy = 0, dx = 0, opts = {}) {
    const c = this.cur;
    return this._plat(c.x + dx, c.y + dy, c.z - c.d / 2 - gap - d / 2, w, d, opts);
  }

  /**
   * Plataforma/obstáculo móvel (malha própria + OBB dinâmico).
   * kind 'osc': oscila ao longo de `axis` com amplitude `amp`;  'spin': gira em torno de Y.
   */
  _mover({ kind, size, mat = 'hazard', center, axis = [1, 0, 0], amp = 0, period = 4, phase = 0, speed = 1, props = {} }) {
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    ProceduralTextures.applyBoxUVs(geo, size[0], size[1], size[2], 1.5);
    const mesh = new THREE.Mesh(geo, this._matObj(mat));
    this.group.add(mesh);

    const obb = new OBB({ position: center, size, dynamic: true, surface: 'metal', ...props });
    this.colliders.push(obb);
    this.world.addSolid(obb);

    // A área varrida entra nos limites da fase (para o tamanho do ácido/paredes)
    const reach = Math.max(size[0], size[2]) + Math.abs(amp);
    this.bounds.expandByPoint(this._tmp.set(center[0] - reach, center[1] - size[1], center[2] - reach));
    this.bounds.expandByPoint(this._tmp.set(center[0] + reach, center[1] + size[1] + Math.abs(amp), center[2] + reach));

    this.movers.push({
      kind, mesh, obb, amp, period, phase, speed,
      center: new THREE.Vector3(center[0], center[1], center[2]),
      axis: new THREE.Vector3(axis[0], axis[1], axis[2]),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
    });
  }

  _applyMovers(t, dt) {
    for (const m of this.movers) {
      if (m.kind === 'osc') {
        const off = m.amp * Math.sin((2 * Math.PI * t) / m.period + m.phase);
        m.pos.copy(m.center).addScaledVector(m.axis, off);
      } else {
        m.pos.copy(m.center);
        m.quat.setFromAxisAngle(_Y, m.speed * t + m.phase);
      }
      m.mesh.position.copy(m.pos);
      m.mesh.quaternion.copy(m.quat);
      m.obb.setTransform(m.pos, m.quat, dt);
    }
  }

  /** Gatilho (ácido, checkpoint, meta). */
  _trigger(opts) {
    const t = new Trigger(opts);
    this.triggers.push(t);
    this.world.addTrigger(t);
    return t;
  }

  /** Placa de texto pixelada (usada na sala final). */
  _sign(text, pos, rotY, w, h) {
    const c = document.createElement('canvas');
    c.width = 192; c.height = 48;
    const g = c.getContext('2d');
    g.fillStyle = '#06140a'; g.fillRect(0, 0, 192, 48);
    g.fillStyle = '#33ff66'; g.font = 'bold 16px "Courier New", monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = text.split('\n');
    lines.forEach((ln, i) => g.fillText(ln, 96, 24 + (i - (lines.length - 1) / 2) * 18));
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    this.own.push(mat, tex);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.y = rotY;
    this.group.add(m);
  }

  /* ========================================================================
   * Segmentos (cada um é chamado via PLANS: seg[0] → this['_' + seg[0]])
   * ====================================================================== */

  /** Salto simples: dy = diferença de altura, dx = deslocamento lateral. */
  _hop(gap, dy = 0, size = 3, dx = 0) {
    this.cur = this._next(gap, size, size, dy, dx);
  }

  /** Rampa (rise > 0 sobe, < 0 desce) seguida de plataforma nivelada. */
  _ramp(len, rise, width = 3, endSize = 3) {
    const c = this.cur;
    const zA = c.z - c.d / 2, yA = c.y;
    const zB = zA - len, yB = yA + rise;
    const th = Math.atan2(rise, len);
    const L = Math.hypot(len, rise);
    // Normal da rampa = (0, cosθ, sinθ); o centro fica 0,15 m abaixo da linha da superfície
    const cy = (yA + yB) / 2 - 0.15 * Math.cos(th);
    const cz = (zA + zB) / 2 - 0.15 * Math.sin(th);
    this._box({ pos: [c.x, cy, cz], size: [width, 0.3, L], rot: [th, 0, 0], mat: 'floor', props: { surface: 'lab' } });
    this.cur = this._plat(c.x, yB, zB - endSize / 2, endSize, endSize);
  }

  /**
   * Cunha elástica no fim da plataforma: inclinada para a frente com bounce alto.
   * Bata/empurre nela para ganhar impulso (parede de impulso).
   */
  _push() {
    const c = this.cur;
    const w = Math.max(1.2, Math.min(c.w, 3) - 0.4);
    this._box({
      pos: [c.x, c.y + 0.32, c.z - c.d / 2 + 0.55],
      size: [w, 0.3, 1.5], rot: [-0.5, 0, 0], mat: '#2d8f4e', tile: 1,
      props: { bounce: 0.9, surface: 'plastic' },
    });
  }

  /** Sequência de pilares estreitos; `jit` = variação lateral máxima. */
  _pillars(n, gap, size = 1.6, jit = 0.6, dyJit = 0.3, zig = false) {
    const baseX = this.cur.x, baseY = this.cur.y;
    for (let i = 0; i < n; i++) {
      const off = zig ? (i % 2 ? 1 : -1) * jit : (this.rng() * 2 - 1) * jit;
      const dy = clamp(baseY + (this.rng() * 2 - 1) * dyJit, baseY - 0.8, baseY + 0.8) - this.cur.y;
      this.cur = this._next(gap, size, size, dy, baseX + off - this.cur.x, { t: 4, rim: false });
    }
  }

  /** Saltos de precisão: pads pequenos em zigue-zague (zig = deslocamento lateral). */
  _precision(n, size, gap, zig) {
    this._pillars(n, gap, size, zig, 0, true);
  }

  /** Parede de grade escalável (segure o grip). O topo é rente à plataforma seguinte. */
  _climb(rise) {
    const c = this.cur;
    const wz = c.z - c.d / 2 - 0.15;
    const yLo = c.y - 0.6, yHi = c.y + rise;
    this._box({
      pos: [c.x, (yLo + yHi) / 2, wz], size: [3.2, yHi - yLo, 0.3], mat: 'grate', tile: 1,
      props: { climbable: true, surface: 'metal' },
    });
    this.cur = this._plat(c.x, yHi, wz - 0.15 - 1.5, 3, 3);
  }

  /**
   * Parede(s) lisa(s) ao longo de um tanque de ácido de comprimento `len`.
   *   mode 'L' | 'R' → uma parede (wall run);  'LR' → duas paredes (corredor de wall bounce)
   *   o.width  distância entre as paredes no modo 'LR'
   *   o.angle  >0 afasta as paredes, <0 estreita o corredor
   *   o.lean   inclinação (rad) para FORA — a superfície empurra o jogador para baixo
   *   o.dy     diferença de altura entre as plataformas de início e fim
   */
  _wall(len, mode = 'R', o = {}) {
    const c = this.cur;
    const width = o.width || 3.4, lean = o.lean || 0, angle = o.angle || 0, dy = o.dy || 0;
    const sizeB = mode === 'LR' ? Math.min(3, width - 0.4) : 3;
    const B = this._next(len, sizeB, sizeB, dy, 0);

    const yLo = Math.min(c.y, B.y) - 0.6, yHi = Math.max(c.y, B.y) + 3.6;
    const h = yHi - yLo, cy = (yLo + yHi) / 2;
    const zMid = c.z - c.d / 2 - len / 2;
    const sides = mode === 'LR' ? [-1, 1] : [mode === 'L' ? -1 : 1];

    for (const s of sides) {
      const off = mode === 'LR' ? width / 2 + 0.15 : 1.65;
      // Compensa a inclinação para a face da parede, na altura do piso, ficar no lugar certo
      const shift = (cy - c.y) * Math.tan(lean);
      this._box({
        pos: [c.x + s * (off + shift), cy, zMid],
        size: [0.3, h, len + 2], rot: [0, -s * angle, -s * lean],
        mat: 'wall', tile: 3, props: { ...WALL_PROPS },
      });
    }
    this.cur = B;
  }

  /**
   * Plataforma móvel entre a plataforma atual e a próxima. `gap` = vão total.
   *   'x'  oscila lateralmente (amp = amplitude)
   *   'y'  sobe/desce `amp` metros (elevador); a próxima plataforma fica `amp` mais alta
   *   'z'  vaivém entre as duas plataformas (ponte móvel)
   */
  _moving(kind, gap, size, amp, period) {
    const c = this.cur;
    const midZ = c.z - c.d / 2 - gap / 2;
    const base = { size: [size, 0.4, size], mat: 'hazard', period, kind: 'osc' };

    if (kind === 'x') {
      this._mover({ ...base, center: [c.x, c.y - 0.2, midZ], axis: [1, 0, 0], amp });
      this.cur = this._next(gap, 3, 3, 0, 0);
    } else if (kind === 'y') {
      this._mover({ ...base, center: [c.x, c.y + amp / 2 - 0.2, midZ], axis: [0, 1, 0], amp: amp / 2 });
      this.cur = this._next(gap, 3, 3, amp, 0);
    } else {
      // 'z': a ponte nunca encosta nas plataformas (folga de 0,35 m)
      const a = Math.max(0.5, (gap - size) / 2 - 0.35);
      this._mover({ ...base, center: [c.x, c.y - 0.2, midZ], axis: [0, 0, 1], amp: a });
      this.cur = this._next(gap, 3, 3, 0, 0);
    }
  }

  /** Plataforma longa com barras giratórias (passe na janela de tempo certa). */
  _spinner(len, width, speed) {
    this.cur = this._next(3, width, len, 0, 0);
    const c = this.cur;
    const bars = Math.max(1, Math.floor(len / 6));
    for (let i = 0; i < bars; i++) {
      const z = c.z + c.d / 2 - (c.d / bars) * (i + 0.5);
      this._mover({
        kind: 'spin', size: [width + 0.8, 1.2, 0.35], mat: 'hazard',
        center: [c.x, c.y + 0.6, z], speed: speed * (i % 2 ? -1 : 1), phase: i * 1.1,
      });
    }
  }

  /** Plataforma giratória (gangorra horizontal): suba, espere, salte para a próxima. */
  _carousel(gap1, length, speed, gap2) {
    const c = this.cur;
    const cz = c.z - c.d / 2 - gap1 - length / 2;
    this._mover({ kind: 'spin', size: [length, 0.4, 1.8], mat: 'grate', center: [c.x, c.y - 0.2, cz], speed });
    this.cur = this._plat(c.x, c.y, cz - length / 2 - gap2 - 1.5, 3, 3);
  }

  /** Checkpoint intermediário: nova plataforma com pad âmbar → verde ao ser tocada. */
  _check() {
    this.cur = this._next(3.5, 3.5, 3.5, 0, 0);
    const c = this.cur;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb020 });
    this.own.push(mat);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 1.0), mat);
    pad.position.set(c.x, c.y + 0.03, c.z);
    this.group.add(pad);

    let done = false;
    this._trigger({
      position: [c.x, c.y + 1.1, c.z], size: [c.w, 2.2, c.d],
      sources: ['head', 'torso', 'left', 'right'],
      onEnter: () => {
        if (done) return;
        done = true;
        mat.color.setHex(0x33ff66);
        this.checkpoint.set(c.x, c.y, c.z);
        this.audio.playBeep('ok');
      },
    });
  }

  /** Plataforma final com indicador (pad + coluna) que muda de vermelho para verde. */
  _goal(gap) {
    this.cur = this._next(gap, 4.5, 4.5, 0, 0);
    const c = this.cur;
    this._goalMarker(c, c.x, c.z);
  }

  _goalMarker(c, px, pz) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 1.6), this.goalMat);
    pad.position.set(px, c.y + 0.04, pz);
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.2, 0.3), this.goalMat);
    col.position.set(px, c.y + 1.6, pz - 1.4);
    this.group.add(pad, col);
    this.goalPos.set(px, c.y, pz);

    this._trigger({
      position: [px, c.y + 1.25, pz], size: [Math.min(c.w, 3.8), 2.5, Math.min(c.d, 3.8)],
      sources: ['head', 'torso', 'left', 'right'],
      onEnter: () => {
        if (this.goalReached) return;
        this.goalReached = true;
        this.goalMat.color.setHex(0x33ff66);   // indicador fica verde
        this.events.onGoal();                  // main.js: som, salvar progresso, próxima fase
      },
    });
  }

  /** Fase 30: sala final "Escape do Laboratório" com portão de saída. */
  _final(gap) {
    this.cur = this._next(gap, 12, 12, 0, 0);
    const c = this.cur;
    const zBack = c.z - c.d / 2;            // lado do portão (fundo)
    const H = 7;
    // Paredes laterais e do fundo (sólidas)
    this._box({ pos: [c.x - c.w / 2 - 0.25, c.y + H / 2, c.z], size: [0.5, H, c.d + 1], mat: 'wall', tile: 3 });
    this._box({ pos: [c.x + c.w / 2 + 0.25, c.y + H / 2, c.z], size: [0.5, H, c.d + 1], mat: 'wall', tile: 3 });
    this._box({ pos: [c.x, c.y + H / 2, zBack - 0.25], size: [c.w + 1, H, 0.5], mat: 'wall', tile: 3 });
    this._box({ pos: [c.x, c.y + H + 0.25, c.z], size: [c.w + 1, 0.5, c.d + 1], mat: 'floor' });
    // Moldura do portão (grade) + painel luminoso animado (reaproveita a textura do ácido)
    this._box({ pos: [c.x - 2.2, c.y + 2.6, zBack + 0.2], size: [0.8, 5.2, 0.5], mat: 'grate', tile: 1, solid: false });
    this._box({ pos: [c.x + 2.2, c.y + 2.6, zBack + 0.2], size: [0.8, 5.2, 0.5], mat: 'grate', tile: 1, solid: false });
    this._box({ pos: [c.x, c.y + 5.4, zBack + 0.2], size: [5.2, 0.8, 0.5], mat: 'hazard', tile: 1, solid: false });
    const gate = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 5.0),
      new THREE.MeshBasicMaterial({ map: this.M.acid.texture, transparent: true, opacity: 0.85 })
    );
    gate.position.set(c.x, c.y + 2.5, zBack + 0.45);
    this.group.add(gate);
    this.own.push(gate.material);
    this._sign('ESCAPE DO\nLABORATORIO', [c.x, c.y + 6.1, zBack + 0.48], 0, 4.0, 1.0);
    // Meta: pad em frente ao portão
    this._goalMarker(c, c.x, zBack + 2.6);
  }

  /* ========================================================================
   * Finalização: casca fechada do laboratório, ácido, mesclagem e luzes
   * ====================================================================== */
  _finish() {
    this.acidY = this.minTop - 3.5;
    const M = 14;                                   // folga entre o percurso e as paredes da sala
    const b = this.bounds;
    const x0 = b.min.x - M, x1 = b.max.x + M;
    const z0 = b.min.z - M, z1 = b.max.z + M;
    const W = x1 - x0, D = z1 - z0;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;

    // Casca (sólida): piso sob o ácido, 4 paredes e teto
    const floorTop = this.acidY - 3.6;
    const ceilY = Math.max(this.maxTop, 0) + 14;
    const H = ceilY - floorTop;
    const cy = (ceilY + floorTop) / 2;
    this._box({ pos: [cx, floorTop - 0.5, cz], size: [W + 2, 1, D + 2], mat: 'floor', tile: 4 });
    this._box({ pos: [cx, ceilY + 0.5, cz], size: [W + 2, 1, D + 2], mat: 'floor', tile: 4 });
    this._box({ pos: [x0 - 0.5, cy, cz], size: [1, H, D + 2], mat: 'wall', tile: 4 });
    this._box({ pos: [x1 + 0.5, cy, cz], size: [1, H, D + 2], mat: 'wall', tile: 4 });
    this._box({ pos: [cx, cy, z0 - 0.5], size: [W + 2, H, 1], mat: 'wall', tile: 4 });
    this._box({ pos: [cx, cy, z1 + 0.5], size: [W + 2, H, 1], mat: 'wall', tile: 4 });

    // Mescla toda a geometria estática por material → poucos draw calls
    for (const [key, geos] of this.statics) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      const mesh = new THREE.Mesh(merged, this._matObj(key));
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.statics.clear();

    // Ácido: plano animado cobrindo todo o fundo (UV repete a cada 4 m)
    const acidGeo = new THREE.PlaneGeometry(W, D);
    const uv = acidGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (W / 4), uv.getY(i) * (D / 4));
    const acid = new THREE.Mesh(acidGeo, this.M.acid.material);
    acid.rotation.x = -Math.PI / 2;
    acid.position.set(cx, this.acidY, cz);
    this.group.add(acid);

    // Gatilho do ácido: volume espesso (3,5 m) para não ser atravessado em queda rápida
    this._trigger({
      position: [cx, this.acidY - 1.7, cz], size: [W, 3.5, D],
      onEnter: () => this.events.onAcid(),
    });
  }

  _setupLights() {
    const L = this.lights;
    L.hemi.intensity = 1.5;
    L.hemi.color.set(0xbfe8d0);
    L.hemi.groundColor.set(0x14301c);
    const cfg = [
      [0xfff1dc, 9],     // acima do jogador (segue a cabeça)
      [0x33ff66, 14],    // sobre a meta
      [0x66ff66, 22],    // brilho do ácido por baixo (segue o jogador)
    ];
    L.points.forEach((p, i) => {
      p.color.setHex(cfg[i][0]);
      p.intensity = cfg[i][1];
      p.distance = 0;
    });
    L.points[0].position.set(this.spawn.x, this.spawn.y + 3, this.spawn.z);
    L.points[1].position.set(this.goalPos.x, this.goalPos.y + 3.5, this.goalPos.z);
    L.points[2].position.set(this.spawn.x, this.acidY + 1.2, this.spawn.z);
    this._head.set(this.spawn.x, this.spawn.y + 1, this.spawn.z);
  }
}

/* ===========================================================================
 * PLANOS DAS 30 FASES
 * Distâncias em metros (vão = borda a borda). Salto confortável ≈ 4-6 m.
 * ========================================================================= */
const PLANS = [
  /* ---------------- FASES 1-10: FUNDAMENTOS ---------------- */
  /*  1 */ [['hop', 1.5, 0, 4], ['hop', 2, 0, 4], ['hop', 2.5, 0, 3.5], ['goal', 2.5]],
  /*  2 */ [['hop', 2, 0, 3.5], ['hop', 2.5, 0, 3], ['hop', 3, 0, 3], ['hop', 3, 0, 3], ['goal', 3]],
  /*  3 */ [['hop', 2.5, 0.5, 3], ['hop', 3, 0, 3], ['hop', 3, -0.5, 3], ['hop', 3.5, 0.5, 2.5], ['goal', 3]],
  /*  4 */ [['ramp', 5, 1.2], ['hop', 3.5, 0, 3], ['ramp', 5, -1.2], ['hop', 3, 0, 3], ['goal', 3.5]],
  /*  5 */ [['push'], ['hop', 4.5, 0.5, 3], ['hop', 3.5, 0, 2.8, 1.2], ['push'], ['hop', 4.5, 0, 2.8, -1.2], ['goal', 3.5]],
  /*  6 */ [['hop', 3, 0, 3], ['pillars', 4, 3, 1.8, 0.5, 0.3], ['hop', 3.5, 0, 3], ['pillars', 3, 3.5, 1.6, 0.7, 0.3], ['goal', 3.5]],
  /*  7 */ [['ramp', 6, 1.5], ['push'], ['hop', 5, 0.5, 2.5], ['pillars', 3, 3.5, 1.6, 0.7, 0.3], ['hop', 4, -0.5, 3], ['goal', 3.5]],
  /*  8 */ [['push'], ['hop', 5.5, 0, 2.5, 1.2], ['pillars', 5, 3.2, 1.5, 0.7, 0.3], ['push'], ['hop', 5, 0.5, 2.2, -1.2], ['goal', 4]],
  /*  9 */ [['hop', 3, 0, 3], ['climb', 3], ['hop', 4, 0, 2.5], ['push'], ['hop', 4.5, 0, 2.5], ['pillars', 3, 3.6, 1.4, 0.8, 0.3], ['goal', 3.5]],
  /* 10 */ [['ramp', 6, 2], ['check'], ['push'], ['hop', 6, 0, 3], ['pillars', 4, 3.6, 1.3, 0.8, 0.3], ['hop', 5, 0.5, 2.2], ['goal', 4]],

  /* ---------------- FASES 11-20: INTERMEDIÁRIO (paredes) ---------------- */
  /* 11 */ [['hop', 2.5, 0, 3], ['wall', 8, 'R'], ['hop', 3, 0, 3], ['goal', 3]],
  /* 12 */ [['wall', 10, 'L'], ['hop', 3.5, 0, 2.5], ['wall', 8, 'R'], ['goal', 3]],
  /* 13 */ [['wall', 12, 'LR', { width: 3.4 }], ['pillars', 3, 3.4, 1.2, 0.6, 0.3], ['goal', 3]],
  /* 14 */ [['wall', 12, 'R', { angle: -0.08 }], ['check'], ['wall', 12, 'L', { angle: -0.08 }], ['goal', 3]],
  /* 15 */ [['ramp', 6, 1.5], ['wall', 14, 'LR', { width: 3.2 }], ['hop', 4, 0, 2], ['pillars', 4, 3.6, 1, 0.7, 0.3], ['goal', 3]],
  /* 16 */ [['wall', 14, 'R', { dy: 1.5 }], ['hop', 4.5, 0, 2], ['wall', 14, 'L', { dy: -1 }], ['check'], ['pillars', 5, 3.5, 1, 0.8, 0.3], ['goal', 3]],
  /* 17 */ [['wall', 16, 'LR', { width: 3, angle: -0.06 }], ['check'], ['wall', 14, 'R', { lean: 0.12 }], ['hop', 5, 0, 2], ['goal', 3.5]],
  /* 18 */ [['pillars', 5, 3.6, 0.9, 0.9, 0.3], ['check'], ['wall', 16, 'L', { lean: 0.15 }], ['wall', 10, 'R', { lean: 0.15 }], ['goal', 3.5]],
  /* 19 */ [['climb', 3.2], ['wall', 18, 'LR', { width: 3.2 }], ['check'], ['wall', 14, 'R', { angle: 0.1, lean: 0.12 }], ['pillars', 4, 3.8, 0.9, 0.9, 0.3], ['goal', 3.5]],
  /* 20 */ [['wall', 18, 'R', { lean: 0.15, dy: 1 }], ['check'], ['wall', 18, 'L', { lean: 0.15 }], ['pillars', 5, 4, 0.8, 1, 0.3], ['check'], ['wall', 16, 'LR', { width: 3, angle: -0.08 }], ['goal', 4]],

  /* ---------------- FASES 21-30: AVANÇADO / EXTREMO ---------------- */
  /* 21 */ [['moving', 'z', 8, 3, 0, 5], ['hop', 3.5, 0, 3], ['moving', 'x', 7, 2.5, 3, 4.5], ['goal', 3.5]],
  /* 22 */ [['moving', 'y', 7, 3, 3, 5], ['spinner', 8, 3, 1.2], ['goal', 3.5]],
  /* 23 */ [['carousel', 3, 6, 0.8, 3], ['moving', 'z', 9, 3, 0, 5], ['check'], ['moving', 'x', 8, 2.5, 3.5, 4], ['goal', 3.5]],
  /* 24 */ [['climb', 3.5], ['spinner', 10, 3, 1.6], ['check'], ['wall', 18, 'LR', { width: 3, lean: 0.12 }], ['moving', 'y', 7, 3, 3, 4.5], ['goal', 3.5]],
  /* 25 */ [['moving', 'x', 8, 2.2, 4, 4], ['moving', 'z', 10, 2.5, 0, 4.5], ['check'], ['precision', 5, 1.0, 4.2, 1.2], ['goal', 4]],
  /* 26 */ [['wall', 22, 'R', { lean: 0.18, angle: 0.08 }], ['check'], ['carousel', 3, 6, 1.1, 3], ['spinner', 10, 2.6, 1.8], ['check'], ['goal', 4]],
  /* 27 */ [['precision', 6, 0.9, 4.5, 1.5], ['check'], ['moving', 'y', 8, 2.5, 4, 4], ['wall', 20, 'LR', { width: 2.8, lean: 0.15 }], ['moving', 'z', 11, 2.5, 0, 4], ['goal', 4]],
  /* 28 */ [['climb', 3.5], ['wall', 24, 'L', { lean: 0.2 }], ['check'], ['moving', 'x', 9, 2, 4.5, 3.6], ['spinner', 12, 2.4, 2.2], ['check'], ['precision', 5, 0.9, 4.8, 1.6], ['goal', 4]],
  /* 29 */ [['wall', 26, 'LR', { width: 2.8, lean: 0.18, angle: 0.1 }], ['check'], ['carousel', 3.5, 6.5, 1.4, 3.5], ['moving', 'y', 9, 2.4, 4, 3.8], ['check'], ['precision', 6, 0.8, 5, 1.8], ['moving', 'z', 12, 2.2, 0, 3.6], ['goal', 4]],
  /* 30 */ [['wall', 24, 'LR', { width: 2.8, lean: 0.15, angle: -0.08 }], ['check'], ['moving', 'x', 9, 2, 4.5, 3.4], ['spinner', 12, 2.4, 2.4], ['check'],
            ['precision', 6, 0.8, 5, 1.8], ['wall', 28, 'R', { lean: 0.2 }], ['check'], ['moving', 'z', 12, 2.2, 0, 3.4], ['final', 5]],
];
