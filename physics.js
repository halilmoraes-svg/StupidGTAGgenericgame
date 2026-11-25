/**
 * physics.js — Motor de física e locomoção estilo Gorilla Tag (WebXR + Three.js)
 * ===========================================================================
 *
 * Inspirado no sistema open-source "GorillaLocomotion". A ideia central:
 *
 *   1. O "rig" (THREE.Group que contém a câmera e os controles) é o corpo do macaco.
 *   2. Cada mão tem uma esfera de colisão. A cada frame varremos (sweep) a esfera
 *      da posição anterior até a posição rastreada atual.
 *   3. Se a mão bateria numa superfície, ela fica "presa" no ponto de contato e o
 *      rig é deslocado no sentido OPOSTO ao movimento da mão. Empurrar o chão para
 *      baixo move o corpo para cima; puxar uma parede move o corpo para a parede.
 *   4. Enquanto há contato, a velocidade do corpo é zerada (ele fica "apoiado" nas
 *      mãos). Ao soltar a superfície, a velocidade média dos últimos frames
 *      (x jumpMultiplier) vira o impulso do salto.
 *   5. Sem contato: gravidade + arrasto do ar.
 *
 * Recursos extras pedidos no projeto:
 *   - Quique (wall bounce): batida forte de mão numa parede rebate na hora (a menos
 *     que o grip esteja apertado); batida de cabeça/tronco também quica; soltar a mão
 *     logo após tocar devolve parte da velocidade (restituição por superfície).
 *   - Corrida na parede (wall run): a mão ADERE na parede (não escorre) e, ao soltar logo
 *     em seguida, o jogador mantém parte da velocidade ao longo da parede (`wallCarry`).
 *   - Atrito do corpo: tronco/cabeça no chão freiam o deslize (`bodyGroundFriction`).
 *   - Escalada por pinça (pinch climbing): segurando o grip perto de superfícies
 *     `climbable`, a mão fica ancorada num ponto do objeto.
 *   - Plataformas móveis/giratórias: o jogador é carregado por elas.
 *   - Gatilhos (triggers): ácido, botões do computador, plataforma final etc.
 *   - Modo desktop (WASD + mouse) usando as mesmas colisões.
 *
 * Convenções:
 *   - Unidades em metros e segundos. Y é para cima.
 *   - As mãos (leftHand/rightHand) DEVEM ser filhas diretas do `rig` — por exemplo
 *     `renderer.xr.getControllerGrip(i)` adicionado ao rig. A posição local delas
 *     (rig-space) é o dado rastreado pelo headset.
 *   - A câmera também deve ser filha do `rig` (dolly). O Three.js só atualiza a
 *     pose da câmera no render, então a cabeça usada para colisão tem 1 frame de
 *     atraso — imperceptível, pois só empurra o corpo para fora de paredes.
 *
 * Uso básico (resumo):
 *
 *   const world = new PhysicsWorld();
 *   world.addSolid({ position: [0, -0.25, 0], size: [10, 0.5, 10], surface: 'lab' });
 *   const loco = new GorillaLocomotion({ rig, camera, leftHand: gripL, rightHand: gripR, world });
 *   loco.on('impact', e => audio.playImpact(e.speed, e.collider.surface, e.point));
 *   renderer.setAnimationLoop(() => { loco.update(dt); renderer.render(scene, camera); });
 */

import * as THREE from 'three';

export const LEFT = 0;
export const RIGHT = 1;

/** Folga mínima entre a esfera e a superfície (evita jitter numérico). */
const SKIN = 0.002;

/** Fontes padrão que podem acionar um gatilho. */
const DEFAULT_SOURCES = ['left', 'right', 'head', 'torso', 'feet'];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Aceita [x,y,z] ou THREE.Vector3 e devolve um novo Vector3. */
function vec3(v, fallback = [0, 0, 0]) {
  if (v && v.isVector3) return v.clone();
  const a = v || fallback;
  return new THREE.Vector3(a[0], a[1], a[2]);
}

/* ---------------------------------------------------------------------------
 * OBB — caixa orientada (serve para chão, paredes, rampas, plataformas móveis…)
 * ------------------------------------------------------------------------- */

// Temporários da OBB (módulo-nível para não gerar lixo no GC a cada frame)
const _l = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _sa = [0, 0, 0];
const _da = [0, 0, 0];
const _ha = [0, 0, 0];

export class OBB {
  /**
   * @param {object} o
   * @param {number[]|THREE.Vector3} o.position  centro no mundo
   * @param {number[]|THREE.Vector3} o.size      tamanho total [x,y,z]
   * @param {number[]} [o.rotation]              Euler [x,y,z] em radianos (ordem YXZ)
   * @param {THREE.Quaternion} [o.quaternion]    alternativa ao Euler
   *
   * Propriedades de superfície (todas opcionais):
   * @param {number}  [o.slip=0.03]  0..1 fração do movimento tangencial que a mão
   *                                 desliza. 0 = gruda, 1 = escorrega livre.
   * @param {number}  [o.glide=0]    0 = ADERENTE (padrão; use também nas paredes de wall run).
   *                                 > 0 só para superfícies escorregadias (gelo): fração da
   *                                 velocidade tangencial mantida após 1 s encostado.
   * @param {number|null} [o.bounce=null] restituição do quique. null = automática pelo tipo
   *                                 de superfície (chão ≈ 0.1, parede ≈ 0.6, teto ≈ 0.4);
   *                                 0.9+ = mola/trampolim.
   * @param {boolean} [o.climbable=false] permite escalada por pinça (grip).
   * @param {string}  [o.surface='lab'] timbre do som: 'lab' | 'metal' | 'plastic'.
   * @param {boolean} [o.dynamic=false] true se o objeto se move (plataforma móvel).
   */
  constructor(o = {}) {
    this.name = o.name || '';
    this.center = vec3(o.position);
    this.half = vec3(o.size, [1, 1, 1]).multiplyScalar(0.5);

    this.quaternion = new THREE.Quaternion();
    if (o.quaternion) this.quaternion.copy(o.quaternion);
    else if (o.rotation) {
      this.quaternion.setFromEuler(new THREE.Euler(o.rotation[0], o.rotation[1], o.rotation[2], 'YXZ'));
    }
    this.invQuat = new THREE.Quaternion();
    this.aabbMin = new THREE.Vector3();
    this.aabbMax = new THREE.Vector3();

    this.enabled = o.enabled !== false;
    this.slip = o.slip ?? 0.03;
    this.glide = o.glide ?? 0;
    this.bounce = o.bounce ?? null;
    this.climbable = !!o.climbable;
    this.surface = o.surface || 'lab';
    this.dynamic = !!o.dynamic;
    this.userData = o.userData || {};

    /** Velocidade linear atual (m/s), atualizada por setTransform(…, dt). */
    this.velocity = new THREE.Vector3();

    this._refresh();
  }

  /** Recalcula quaternion inverso e AABB do mundo. Chame após mudar center/quaternion. */
  _refresh() {
    this.invQuat.copy(this.quaternion).invert();
    _m4.makeRotationFromQuaternion(this.quaternion);
    const e = _m4.elements; // coluna-principal: R[i][j] = e[i + 4*j]
    const hx = this.half.x, hy = this.half.y, hz = this.half.z;
    const ex = Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
    const ey = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
    const ez = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;
    this.aabbMin.set(this.center.x - ex, this.center.y - ey, this.center.z - ez);
    this.aabbMax.set(this.center.x + ex, this.center.y + ey, this.center.z + ez);
  }

  /**
   * Move/rotaciona o colisor (plataformas móveis e giratórias).
   * Passe `dt` para que a velocidade linear seja calculada.
   */
  setTransform(position, quaternion = null, dt = 0) {
    if (dt > 0) this.velocity.subVectors(position, this.center).divideScalar(dt);
    this.center.copy(position);
    if (quaternion) this.quaternion.copy(quaternion);
    this._refresh();
  }

  worldToLocal(p, out) {
    return out.copy(p).sub(this.center).applyQuaternion(this.invQuat);
  }

  localToWorld(p, out) {
    return out.copy(p).applyQuaternion(this.quaternion).add(this.center);
  }

  /** Ponto da caixa mais próximo de `p` (ou o próprio `p` se estiver dentro). */
  closestPoint(p, out) {
    const l = this.worldToLocal(p, _l);
    const h = this.half;
    out.set(clamp(l.x, -h.x, h.x), clamp(l.y, -h.y, h.y), clamp(l.z, -h.z, h.z));
    return this.localToWorld(out, out);
  }

  /**
   * Teste esfera x caixa.
   * @returns {number} profundidade de penetração (> 0) ou 0 se não há contato.
   *                   `outN` recebe a normal (mundo) apontando para fora da caixa.
   */
  overlapSphere(p, r, outN, outPoint = null) {
    const l = this.worldToLocal(p, _l);
    const h = this.half;
    const cx = clamp(l.x, -h.x, h.x);
    const cy = clamp(l.y, -h.y, h.y);
    const cz = clamp(l.z, -h.z, h.z);
    const dx = l.x - cx, dy = l.y - cy, dz = l.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r * r) return 0;

    let depth;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      depth = r - d;
      outN.set(dx / d, dy / d, dz / d);
    } else {
      // Centro da esfera dentro da caixa: sai pela face mais próxima.
      const px = h.x - Math.abs(l.x), py = h.y - Math.abs(l.y), pz = h.z - Math.abs(l.z);
      if (px <= py && px <= pz) { outN.set(Math.sign(l.x) || 1, 0, 0); depth = r + px; }
      else if (py <= pz)        { outN.set(0, Math.sign(l.y) || 1, 0); depth = r + py; }
      else                      { outN.set(0, 0, Math.sign(l.z) || 1); depth = r + pz; }
    }
    outN.applyQuaternion(this.quaternion);
    if (outPoint) outPoint.set(cx, cy, cz).applyQuaternion(this.quaternion).add(this.center);
    return depth;
  }

  /**
   * Varredura de esfera (swept sphere) de `from` até `to`.
   * Implementada como segmento x caixa inflada pelo raio (slab test). Os cantos
   * ficam "quadrados" em vez de arredondados — diferença de poucos milímetros.
   * @returns {number} tempo de impacto t em [0,1] ou -1 se não colide.
   *                   Começar já dentro da caixa NÃO conta (use overlapSphere).
   */
  sweepSphere(from, to, r, outNormal) {
    this.worldToLocal(from, _s);
    this.worldToLocal(to, _e);
    _d.subVectors(_e, _s);
    _sa[0] = _s.x; _sa[1] = _s.y; _sa[2] = _s.z;
    _da[0] = _d.x; _da[1] = _d.y; _da[2] = _d.z;
    _ha[0] = this.half.x + r; _ha[1] = this.half.y + r; _ha[2] = this.half.z + r;

    let tmin = 0, tmax = 1, axis = -1, sign = 0;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(_da[i]) < 1e-9) {
        if (Math.abs(_sa[i]) > _ha[i]) return -1; // paralelo e fora da laje
        continue;
      }
      let t1 = (-_ha[i] - _sa[i]) / _da[i];
      let t2 = (_ha[i] - _sa[i]) / _da[i];
      let sg = -1; // entrando pela face negativa
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sg = 1; }
      if (t1 > tmin - 1e-7) { tmin = Math.max(tmin, t1); axis = i; sign = sg; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (axis < 0) return -1;

    outNormal.set(0, 0, 0);
    outNormal.setComponent(axis, sign);
    outNormal.applyQuaternion(this.quaternion);
    return tmin;
  }
}

/* ---------------------------------------------------------------------------
 * Trigger — volume que não bloqueia, só dispara eventos
 * (ácido, botões do computador, plataforma final, checkpoints…)
 * ------------------------------------------------------------------------- */
export class Trigger extends OBB {
  /**
   * @param {object} o  (mesmas opções de posição/tamanho da OBB, mais:)
   * @param {string[]} [o.sources] quais partes do corpo acionam:
   *                    'left' | 'right' | 'head' | 'torso' | 'feet' (padrão: todas)
   * @param {Function} [o.onEnter] ({trigger, source, hand, speed}) => void
   * @param {Function} [o.onStay]
   * @param {Function} [o.onExit]
   */
  constructor(o = {}) {
    super(o);
    this.sources = new Set(o.sources || DEFAULT_SOURCES);
    this.onEnter = o.onEnter || null;
    this.onStay = o.onStay || null;
    this.onExit = o.onExit || null;
    this.inside = new Set();
  }
}

/* ---------------------------------------------------------------------------
 * PhysicsWorld — coleção de colisores sólidos e gatilhos
 * ------------------------------------------------------------------------- */

const _n = new THREE.Vector3();
const _bn = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _bp = new THREE.Vector3();

export class PhysicsWorld {
  constructor() {
    /** @type {OBB[]} */ this.solids = [];
    /** @type {Trigger[]} */ this.triggers = [];
  }

  addSolid(o) {
    const c = o instanceof OBB ? o : new OBB(o);
    this.solids.push(c);
    return c;
  }

  addTrigger(o) {
    const t = o instanceof Trigger ? o : new Trigger(o);
    this.triggers.push(t);
    return t;
  }

  remove(c) {
    let i = this.solids.indexOf(c);
    if (i >= 0) this.solids.splice(i, 1);
    i = this.triggers.indexOf(c);
    if (i >= 0) this.triggers.splice(i, 1);
  }

  /** Remove tudo (ao trocar de fase). */
  clear() {
    this.solids.length = 0;
    this.triggers.length = 0;
  }

  /**
   * Varre uma esfera e devolve o primeiro impacto em `hit` {t, collider, normal}.
   * @returns {boolean}
   */
  sweep(from, to, r, hit) {
    const minX = Math.min(from.x, to.x) - r, maxX = Math.max(from.x, to.x) + r;
    const minY = Math.min(from.y, to.y) - r, maxY = Math.max(from.y, to.y) + r;
    const minZ = Math.min(from.z, to.z) - r, maxZ = Math.max(from.z, to.z) + r;
    let best = Infinity, bc = null;
    for (const c of this.solids) {
      if (!c.enabled) continue;
      if (maxX < c.aabbMin.x || minX > c.aabbMax.x ||
          maxY < c.aabbMin.y || minY > c.aabbMax.y ||
          maxZ < c.aabbMin.z || minZ > c.aabbMax.z) continue;
      const t = c.sweepSphere(from, to, r, _n);
      if (t >= 0 && t < best) { best = t; bc = c; _bn.copy(_n); }
    }
    if (!bc) return false;
    hit.t = best;
    hit.collider = bc;
    hit.normal.copy(_bn);
    return true;
  }

  /** Maior penetração de uma esfera parada. Preenche {depth, collider, normal, point}. */
  overlap(p, r, hit) {
    let best = 0, bc = null;
    for (const c of this.solids) {
      if (!c.enabled) continue;
      if (p.x + r < c.aabbMin.x || p.x - r > c.aabbMax.x ||
          p.y + r < c.aabbMin.y || p.y - r > c.aabbMax.y ||
          p.z + r < c.aabbMin.z || p.z - r > c.aabbMax.z) continue;
      const depth = c.overlapSphere(p, r, _n, _pt);
      if (depth > best) { best = depth; bc = c; _bn.copy(_n); _bp.copy(_pt); }
    }
    if (!bc) return false;
    hit.depth = best;
    hit.collider = bc;
    hit.normal.copy(_bn);
    hit.point.copy(_bp);
    return true;
  }

  /**
   * Empurra a esfera `p` (MUTA o vetor) para fora de todos os sólidos.
   * `cb(normal, distanciaEmpurrada, colisor)` é chamado a cada empurrão — a normal
   * é um temporário compartilhado: use-a na hora, não guarde a referência.
   * @returns {number} quantidade de colisores que empurraram.
   */
  pushOut(p, r, cb = null) {
    let count = 0;
    for (const c of this.solids) {
      if (!c.enabled) continue;
      if (p.x + r < c.aabbMin.x || p.x - r > c.aabbMax.x ||
          p.y + r < c.aabbMin.y || p.y - r > c.aabbMax.y ||
          p.z + r < c.aabbMin.z || p.z - r > c.aabbMax.z) continue;
      const depth = c.overlapSphere(p, r, _n);
      if (depth > 0) {
        const push = depth + SKIN;
        p.addScaledVector(_n, push);
        count++;
        if (cb) cb(_n, push, c);
      }
    }
    return count;
  }

  /** Colisor `climbable` mais próximo de `p` dentro de `reach`. */
  findGrabbable(p, reach, out) {
    let best = reach, bc = null;
    for (const c of this.solids) {
      if (!c.enabled || !c.climbable) continue;
      if (p.x + reach < c.aabbMin.x || p.x - reach > c.aabbMax.x ||
          p.y + reach < c.aabbMin.y || p.y - reach > c.aabbMax.y ||
          p.z + reach < c.aabbMin.z || p.z - reach > c.aabbMax.z) continue;
      c.closestPoint(p, _pt);
      const d = p.distanceTo(_pt);
      if (d <= best) { best = d; bc = c; _bp.copy(_pt); }
    }
    if (!bc) return null;
    out.collider = bc;
    out.point.copy(_bp);
    out.normal.subVectors(p, _bp);
    if (out.normal.lengthSq() < 1e-8) out.normal.set(0, 1, 0);
    else out.normal.normalize();
    return out;
  }
}

/* ---------------------------------------------------------------------------
 * GorillaLocomotion
 * ------------------------------------------------------------------------- */

const DEFAULTS = {
  gravity: 9.81,            // m/s²
  handRadius: 0.07,         // esfera de colisão de cada mão
  headRadius: 0.15,         // esfera da cabeça (empurra o corpo para fora de paredes)
  torsoRadius: 0.16,        // esfera do tronco (impede o corpo de atravessar o chão)
  torsoOffset: 0.36,        // distância cabeça → tronco (para baixo)

  // --- Parâmetros de salto (valores do Gorilla Tag original como ponto de partida) ---
  jumpMultiplier: 1.1,      // amplifica a velocidade das mãos ao soltar
  maxJumpSpeed: 8.0,        // limite do impulso (m/s). Aumente para saltos mais longos
  velocityLimit: 0.3,       // abaixo disso o "empurrão" não vira salto
  velocityHistorySize: 6,   // nº de frames usados na média (≈ 65 ms a 90 Hz)

  airDrag: 0.12,            // arrasto no ar (1/s) — maior = menos "planar"
  maxSpeed: 25,             // velocidade terminal de segurança
  maxLaunchSpeed: 11,       // teto do impulso total (empurrão + quique + momento da parede)

  // --- Atrito do corpo (cabeça/tronco encostando) ---
  bodyGroundFriction: 12,   // 1/s: freia o deslize quando o tronco/cabeça está no chão
  bodyWallFriction: 6,      // 1/s: freia o deslize quando o corpo roça numa parede
  bodyStopSpeed: 0.6,       // m/s: abaixo disso, parado no chão = para de vez

  // --- Quique ---
  floorBounce: 0.1,         // restituição automática: chão
  wallBounce: 0.6,          //                         parede
  ceilBounce: 0.4,          //                         teto
  slamSpeed: 4.5,           // m/s: batida de mão acima disso rebate na hora (sem grip)
  bodyBounce: 0.5,          // restituição de cabeça/tronco em paredes
  bodyBounceMinSpeed: 2.0,  // m/s mínimos para a batida do corpo quicar
  wallCarry: 0.7,           // fração da velocidade ao longo da parede mantida no wall run

  // --- Aderência da mão (essencial para parede/teto: a gravidade age PARALELA à parede) ---
  stickProbe: 0.02,         // m: sensor que "afunda" na superfície p/ manter o contato mesmo parado
  stickReleaseSpeed: 0.35,  // m/s: a mão só solta se se afastar da superfície mais rápido que isso

  grabReach: 0.06,          // alcance extra (além do raio) para agarrar com o grip
  bounceWindow: 0.30,       // s após o impacto em que soltar a mão gera quique/momento
  minImpactSpeed: 0.6,      // abaixo disso o 'impact' não emite som
  impactCooldown: 0.05,     // s mínimos entre 'impact' da mesma mão

  // --- Modo desktop (WASD) ---
  walkSpeed: 4.0,
  walkJump: 5.2,
  walkSpheres: [[0.3, 0.3], [0.9, 0.3], [1.5, 0.28]], // [altura, raio] acima do rig
};

export class GorillaLocomotion {
  /**
   * @param {object} cfg
   * @param {THREE.Object3D} cfg.rig       grupo que contém a câmera e as mãos
   * @param {THREE.Camera}   cfg.camera    filha do rig
   * @param {THREE.Object3D} cfg.leftHand  filha do rig (grip do controle esquerdo)
   * @param {THREE.Object3D} cfg.rightHand filha do rig (grip do controle direito)
   * @param {PhysicsWorld}   cfg.world
   * @param {object} [cfg.options]         sobrescreve DEFAULTS
   */
  constructor({ rig, camera, leftHand, rightHand, world, options = {} }) {
    this.rig = rig;
    this.camera = camera;
    this.world = world;
    this.opt = { ...DEFAULTS, ...options };

    this.enabled = true;
    this.desktopMode = false;
    this.grounded = false;     // só usado no modo desktop
    this.time = 0;
    this.velocity = new THREE.Vector3();

    this.hands = [this._makeHand(leftHand, 'left', LEFT), this._makeHand(rightHand, 'right', RIGHT)];

    // Pontos do corpo (mundo) — usados em colisões e gatilhos
    this.headPos = new THREE.Vector3();
    this.torsoPos = new THREE.Vector3();
    this.feetPos = new THREE.Vector3();

    // Histórico circular de velocidades (calculadas enquanto há contato)
    this._hist = Array.from({ length: this.opt.velocityHistorySize }, () => new THREE.Vector3());
    this._histIdx = 0;
    this._histCount = 0;

    this._impact = { time: -10, bounce: 0, normal: new THREE.Vector3(0, 1, 0), carry: new THREE.Vector3() };
    this._dt = 1 / 90;
    this._fricDone = false;
    this._glide = 0;
    this._needsInit = true;
    this._bodyPushed = false;
    this._ev = {};

    // Temporários
    this._off = [new THREE.Vector3(), new THREE.Vector3()];
    this._vIn = new THREE.Vector3();
    this._start = new THREE.Vector3();
    this._net = new THREE.Vector3();
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._gn = new THREE.Vector3();
    this._launchV = new THREE.Vector3();
    this._sweepHit = { t: 0, collider: null, normal: new THREE.Vector3(), depth: 0, point: new THREE.Vector3() };
    this._grabHit = { collider: null, point: new THREE.Vector3(), normal: new THREE.Vector3() };
    this._rs0 = new THREE.Vector3();
    this._rs1 = new THREE.Vector3();
    this._rs2 = new THREE.Vector3();
    this._rs3 = new THREE.Vector3();

    // Colisão do corpo contra sólidos: arrow function para poder passar como callback
    this._onBodyPush = (n, push, c) => {
      const v = this.velocity, o = this.opt;
      this.rig.position.addScaledVector(n, push);
      const vn = v.dot(n);
      if (vn < 0) {
        // Batida de cabeça/tronco: quica (parede/teto) — só no VR; no chão não quica
        let e = 0;
        if (!this.desktopMode && -vn > o.bodyBounceMinSpeed) {
          e = c.bounce !== null ? c.bounce : (n.y > 0.6 ? 0 : (n.y < -0.6 ? o.bodyBounce * 0.8 : o.bodyBounce));
        }
        v.addScaledVector(n, -vn * (1 + e));
      }
      if (n.y > 0.5) this.grounded = true;

      // Atrito do corpo (uma vez por frame): chão e paredes freiam o deslize
      if (!this.desktopMode && !this._fricDone) {
        this._fricDone = true;
        if (n.y > 0.5) {
          const f = Math.exp(-o.bodyGroundFriction * this._dt);
          v.x *= f; v.z *= f;
          if (Math.hypot(v.x, v.z) < o.bodyStopSpeed) { v.x = 0; v.z = 0; }
        } else {
          const vn2 = v.dot(n);
          const f = Math.exp(-o.bodyWallFriction * this._dt);
          v.x = v.x * f + n.x * vn2 * (1 - f);
          v.y = v.y * f + n.y * vn2 * (1 - f);
          v.z = v.z * f + n.z * vn2 * (1 - f);
        }
      }
      this._bodyPushed = true;
    };

    const H = this.hands, o = this.opt;
    this._srcVR = [
      { key: 'left', p: H[0].pos, r: o.handRadius, hand: LEFT },
      { key: 'right', p: H[1].pos, r: o.handRadius, hand: RIGHT },
      { key: 'head', p: this.headPos, r: o.headRadius, hand: -1 },
      { key: 'torso', p: this.torsoPos, r: o.torsoRadius, hand: -1 },
    ];
    this._srcDesk = [
      { key: 'left', p: H[0].pos, r: o.handRadius, hand: LEFT },
      { key: 'right', p: H[1].pos, r: o.handRadius, hand: RIGHT },
      { key: 'head', p: this.headPos, r: o.headRadius, hand: -1 },
      { key: 'torso', p: this.torsoPos, r: 0.3, hand: -1 },
      { key: 'feet', p: this.feetPos, r: 0.3, hand: -1 },
    ];
  }

  /* ------------------------------ API pública ------------------------------ */

  /** Registra um ouvinte. Eventos: 'impact', 'grab', 'release', 'launch', 'trigger'. */
  on(name, fn) {
    (this._ev[name] || (this._ev[name] = [])).push(fn);
    return this;
  }

  emit(name, data) {
    const list = this._ev[name];
    if (list) for (const fn of list) fn(data);
  }

  /** Liga/desliga uma mão (ex.: controle ainda não conectado). */
  setHandActive(index, active) {
    const h = this.hands[index];
    h.active = !!active;
    if (!active) { this._endGrab(h, false); h.touching = false; }
    this._needsInit = true;
  }

  /** Estado do botão de agarrar (grip/squeeze) de cada mão — escalada por pinça. */
  setGrip(index, pressed) {
    this.hands[index].input.grip = !!pressed;
  }

  /** Posição (mundo) da mão já resolvida contra colisões — use para desenhar a mão do macaco. */
  getHandPosition(index, out = new THREE.Vector3()) {
    return out.copy(this.hands[index].pos);
  }

  /** A mão está encostada/agarrada em algo? */
  isHandTouching(index) {
    return this.hands[index].touching;
  }

  get speed() {
    return this.velocity.length();
  }

  /**
   * Teleporta o rig (checkpoint/respawn). `position` é a posição do ORIGEM do rig
   * (o "chão" sob o jogador); o corpo cai até as mãos encontrarem uma superfície.
   */
  teleportTo(position) {
    this.rig.position.copy(position);
    this.resetState();
  }

  /** Zera velocidade, contatos e estado de gatilhos (use ao trocar de fase). */
  resetState() {
    this.velocity.set(0, 0, 0);
    for (const h of this.hands) {
      this._endGrab(h, false);
      h.touching = false; h.was = false; h.colliding = false;
      h.ride.collider = null; h.collider = null;
    }
    this._histCount = 0;
    this._histIdx = 0;
    this._glide = 0;
    this.grounded = false;
    this._needsInit = true;
    for (const t of this.world.triggers) t.inside.clear();
  }

  /**
   * Passo da simulação. Chame uma vez por frame, ANTES de renderizar.
   * @param {number} dt segundos desde o último frame
   * @param {object} [desktopInput] só no modo desktop: { x, z, jump, yaw }
   *        x: strafe (+1 direita), z: frente (+1), jump: boolean, yaw: rad da câmera
   */
  update(dt, desktopInput = null) {
    if (!this.enabled) return;
    dt = clamp(dt, 1 / 240, 1 / 30);
    this.time += dt;
    if (this.desktopMode) this._updateDesktop(dt, desktopInput || {});
    else this._updateVR(dt);
  }

  /* ------------------------------ Núcleo VR ------------------------------ */

  _updateVR(dt) {
    const o = this.opt, rig = this.rig, v = this.velocity, H = this.hands;
    if (this._needsInit) this._initHands();
    this._dt = dt;
    this._fricDone = false;

    const startPos = this._start.copy(rig.position);
    const anyPrev = H[0].touching || H[1].touching;

    // 1) Gravidade, arrasto e integração -------------------------------------
    if (!anyPrev) {
      v.y -= o.gravity * dt;
      v.multiplyScalar(1 / (1 + o.airDrag * dt));
    } else if (this._glide > 0) {
      v.y -= o.gravity * dt;                    // deslizando numa parede: gravidade age
    } else {
      rig.position.y -= o.gravity * dt * dt;    // "âncora": afunda um pouco p/ manter o contato
    }
    if (v.lengthSq() > o.maxSpeed * o.maxSpeed) v.setLength(o.maxSpeed);
    rig.position.addScaledVector(v, dt);
    const vIn = this._vIn.copy(v);              // velocidade de chegada (para o quique)

    // 2) Mãos presas em plataformas móveis acompanham a plataforma ------------
    for (const h of H) {
      if (h.touching && !h.grabbing && h.ride.collider && h.ride.collider.dynamic) {
        h.ride.collider.localToWorld(h.ride.local, h.pos);
      }
    }

    // 3) Resolve cada mão -----------------------------------------------------
    for (let i = 0; i < 2; i++) {
      const h = H[i];
      const off = this._off[i].set(0, 0, 0);
      h.was = h.touching;
      h.colliding = false;
      if (!h.active) { h.touching = false; continue; }

      this._toWorld(h.obj.position, h.cur);
      h.armSpeed = this._tmpA.subVectors(h.cur, h.pos).length() / dt;
      this._updateGrab(h);

      if (h.grabbing) {
        // Pinça: mão ancorada num ponto do colisor
        h.grab.collider.localToWorld(h.grab.local, this._tmpA);
        off.subVectors(this._tmpA, h.cur);
        h.colliding = true;
        h.collider = h.grab.collider;
        h.normal.copy(h.grab.normal);
      } else if (this._resolveHand(h.pos, this._handTarget(h), this._tmpA, h.info)) {
        off.subVectors(this._tmpA, h.cur);      // desloca o corpo no sentido oposto à mão
        h.colliding = true;
        h.collider = h.info.collider;
        h.normal.copy(h.info.normal);
        h.contact.copy(this._tmpA);

        if (!h.was && h.armSpeed > o.minImpactSpeed && this.time - h.lastImpact > o.impactCooldown) {
          h.lastImpact = this.time;
          this.emit('impact', {
            hand: i,
            speed: Math.min(h.armSpeed, 15),
            collider: h.collider,
            point: h.contact.clone(),
            normal: h.normal.clone(),
          });
        }
      }
    }

    // 4) Combina os deslocamentos (igual ao GorillaLocomotion original) -------
    const c0 = H[0].colliding, c1 = H[1].colliding;
    const offset = this._tmpB.addVectors(this._off[0], this._off[1]);
    if ((c0 || H[0].was) && (c1 || H[1].was)) offset.multiplyScalar(0.5);
    rig.position.add(offset);

    // 5) Corpo (cabeça/tronco) não atravessa sólidos --------------------------
    this._resolveBody();

    // 6) Velocidade: contato, aderência, quique e salto -----------------------
    let touching = c0 || c1;
    const net = this._net.subVectors(rig.position, startPos).divideScalar(dt);

    if (touching) {
      if (!anyPrev) {
        // Frame de impacto: guarda dados do quique/momento e reinicia o histórico
        this._histCount = 0;
        this._histIdx = 0;
        // Mão mais "de frente" para a superfície (menor vn). Correr PARALELO à parede dá vn ≈ 0,
        // e mesmo assim precisa guardar o momento (wall run), então não exigimos vn < 0.
        let bestVn = Infinity, bestHand = null;
        for (const h of H) {
          if (!h.colliding || h.grabbing) continue;
          const vn = vIn.dot(h.normal);
          if (vn < bestVn) { bestVn = vn; bestHand = h; }
        }
        if (bestVn > 0) bestVn = 0;
        this._impact.time = this.time;
        this._impact.bounce = 0;
        this._impact.carry.set(0, 0, 0);
        this._impact.normal.set(0, 1, 0);

        if (bestHand) {
          const n = bestHand.normal;
          const e = this._surfaceBounce(bestHand.collider, n);
          const wallLike = Math.abs(n.y) < 0.6;
          this._impact.normal.copy(n);
          this._impact.bounce = -bestVn * e;

          // Momento ao longo da parede (wall run): mantém parte da velocidade tangencial
          if (Math.abs(n.y) < 0.5) {
            const tan = this._tmpC.copy(vIn).addScaledVector(n, -vIn.dot(n));
            if (tan.y < 0) tan.y = 0;                       // não "herda" a queda
            this._impact.carry.copy(tan).multiplyScalar(o.wallCarry);
          }

          // Batida forte: rebate NA HORA (segurar o grip = agarrar em vez de quicar)
          const gripHeld = H[0].input.grip || H[1].input.grip;
          const allowed = bestHand.collider.bounce !== null || wallLike;
          if (-bestVn >= o.slamSpeed && !gripHeld && allowed && e > 0.05) {
            v.copy(vIn).addScaledVector(n, -(1 + e) * bestVn);   // reflete com restituição e
            for (const h of H) h.colliding = false;              // solta as mãos
            touching = false;
            this._glide = 0;
            this._impact.bounce = 0;
            this._impact.carry.set(0, 0, 0);
            this.emit('bounce', { speed: -bestVn * (1 + e), normal: n.clone(), hand: bestHand.index });
          }
        }
      } else {
        this._pushHistory(net);
      }

      if (touching) {
        // Aderência: qualquer mão com glide 0 (ou em pinça) "ancora" o corpo (v = 0).
        // glide > 0 só existe para superfícies escorregadias (gelo).
        let glide = Infinity;
        for (const h of H) {
          if (!h.colliding) continue;
          const g = h.grabbing ? 0 : h.collider.glide;
          if (g < glide) { glide = g; this._gn.copy(h.normal); }
        }
        this._glide = glide === Infinity ? 0 : glide;
        if (this._glide <= 0) {
          v.set(0, 0, 0);
        } else {
          const vn = v.dot(this._gn);
          if (vn < 0) v.addScaledVector(this._gn, -vn);
          v.multiplyScalar(Math.pow(this._glide, dt));
        }
      }
    } else if (anyPrev) {
      this._glide = 0;
      this._launch();
    }

    // 7) Posição visual das mãos (sem entrar nas superfícies) -----------------
    for (const h of H) {
      h.touching = h.colliding;
      if (!h.active) continue;
      if (h.grabbing) {
        h.grab.collider.localToWorld(h.grab.local, h.pos);
      } else {
        this._toWorld(h.obj.position, h.pos);
        this.world.pushOut(h.pos, o.handRadius, null);
      }
      if (h.colliding && h.collider) {
        h.ride.collider = h.collider;
        h.collider.worldToLocal(h.pos, h.ride.local);
      }
    }

    // 8) Gatilhos (ácido, botões, plataforma final…) --------------------------
    this._updateBodyPoints();
    this._updateTriggers(this._srcVR);
  }

  /**
   * Alvo da varredura da mão. Se a mão JÁ estava encostada e não está se afastando da
   * superfície, o alvo "afunda" um pouco (stickProbe) na superfície: assim o contato
   * persiste mesmo que o movimento seja paralelo à parede (gravidade numa parede vertical)
   * — é isso que dá aderência. Se a mão se afasta (> stickReleaseSpeed), solta normalmente.
   */
  _handTarget(h) {
    if (h.was && h.collider && h.collider.enabled) {
      const away = this._tmpB.subVectors(h.cur, h.pos).dot(h.normal) / this._dt;   // m/s
      if (away < this.opt.stickReleaseSpeed) {
        return this._probe.copy(h.cur).addScaledVector(h.normal, -this.opt.stickProbe);
      }
    }
    return h.cur;
  }

  /** Varre a esfera da mão de `from` até `to`, com deslize tangencial na superfície. */
  _resolveHand(from, to, out, info) {
    const r = this.opt.handRadius, world = this.world, hit = this._sweepHit;
    const start = this._rs0.copy(from);
    const remaining = this._rs1;
    const dest = this._rs2;
    const rem = this._rs3;
    let touched = false;
    info.collider = null;

    // Mão já começa penetrando (ex.: plataforma móvel avançou sobre ela)
    if (world.overlap(start, r, hit)) {
      start.addScaledVector(hit.normal, hit.depth + SKIN);
      info.collider = hit.collider;
      info.normal.copy(hit.normal);
      touched = true;
    }

    remaining.subVectors(to, start);
    for (let iter = 0; iter < 3; iter++) {
      if (remaining.lengthSq() < 1e-10) break;
      dest.copy(start).add(remaining);
      if (!world.sweep(start, dest, r, hit)) {
        start.copy(dest);
        remaining.set(0, 0, 0);
        break;
      }
      touched = true;
      info.collider = hit.collider;
      info.normal.copy(hit.normal);

      // Avança até o contato (+ pele) e desliza o restante pela superfície
      const t = hit.t;
      rem.copy(remaining).multiplyScalar(1 - t);
      start.addScaledVector(remaining, t).addScaledVector(hit.normal, SKIN);
      rem.addScaledVector(hit.normal, -rem.dot(hit.normal));
      remaining.copy(rem).multiplyScalar(hit.collider.slip);
    }
    out.copy(start);
    return touched;
  }

  /** Pinça: segurar o grip perto de um colisor `climbable` prende a mão nele. */
  _updateGrab(h) {
    const o = this.opt;
    if (h.grabbing) {
      if (!h.input.grip || !h.grab.collider || !h.grab.collider.enabled) this._endGrab(h, true);
      return;
    }
    if (!h.input.grip) return;
    const found = this.world.findGrabbable(h.cur, o.handRadius + o.grabReach, this._grabHit);
    if (!found) return;
    h.grabbing = true;
    h.grab.collider = found.collider;
    h.grab.normal.copy(found.normal);
    found.collider.worldToLocal(h.touching ? h.pos : h.cur, h.grab.local);
    this.emit('grab', { hand: h.index, collider: found.collider });
  }

  _endGrab(h, notify) {
    if (!h.grabbing) return;
    h.grabbing = false;
    h.grab.collider = null;
    if (notify) this.emit('release', { hand: h.index });
  }

  /**
   * Salto ao soltar: média da velocidade do corpo durante o contato × jumpMultiplier,
   * mais (se soltou logo após bater) o quique e o momento ao longo da parede.
   */
  _launch() {
    const o = this.opt;
    const L = this._launchV.set(0, 0, 0);

    if (this._histCount > 0) {
      const avg = this._tmpC.set(0, 0, 0);
      for (let i = 0; i < this._histCount; i++) avg.add(this._hist[i]);
      avg.divideScalar(this._histCount);
      if (avg.length() > o.velocityLimit) {
        L.copy(avg).multiplyScalar(o.jumpMultiplier);
        if (L.length() > o.maxJumpSpeed) L.setLength(o.maxJumpSpeed);
      }
    }

    if (this.time - this._impact.time < o.bounceWindow) {
      if (this._impact.bounce > 0.5) L.addScaledVector(this._impact.normal, this._impact.bounce);
      L.add(this._impact.carry);
    }
    this._impact.time = -10;                       // quique/momento valem uma vez só

    if (L.length() > o.maxLaunchSpeed) L.setLength(o.maxLaunchSpeed);
    this.velocity.copy(L);
    this._histCount = 0;
    this._histIdx = 0;
    if (L.length() > 1) this.emit('launch', { speed: L.length(), velocity: L.clone() });
  }

  /** Restituição: explícita no colisor, ou automática pelo tipo de superfície (normal). */
  _surfaceBounce(c, n) {
    if (c.bounce !== null && c.bounce !== undefined) return c.bounce;
    const o = this.opt;
    if (n.y > 0.6) return o.floorBounce;
    if (n.y < -0.6) return o.ceilBounce;
    return o.wallBounce;
  }

  _pushHistory(vec) {
    this._hist[this._histIdx].copy(vec);
    this._histIdx = (this._histIdx + 1) % this._hist.length;
    if (this._histCount < this._hist.length) this._histCount++;
  }

  /** Cabeça e tronco empurram o rig para fora de paredes/chão. */
  _resolveBody() {
    const o = this.opt;
    for (let pass = 0; pass < 3; pass++) {
      this._bodyPushed = false;
      this._updateBodyPoints();
      this.world.pushOut(this.headPos, o.headRadius, this._onBodyPush);
      this._updateBodyPoints();
      this.world.pushOut(this.torsoPos, o.torsoRadius, this._onBodyPush);
      if (!this._bodyPushed) break;
    }
  }

  _initHands() {
    for (const h of this.hands) {
      this._toWorld(h.obj.position, h.pos);
      h.cur.copy(h.pos);
      h.touching = false;
      h.was = false;
    }
    this._needsInit = false;
  }

  /** Posição local (espaço do rig) → mundo. Assume rig com escala 1. */
  _toWorld(local, out) {
    return out.copy(local).applyQuaternion(this.rig.quaternion).add(this.rig.position);
  }

  _updateBodyPoints() {
    const rig = this.rig;
    if (this.desktopMode) {
      this._toWorld(this.camera.position, this.headPos);
      this.torsoPos.set(rig.position.x, rig.position.y + 0.9, rig.position.z);
      this.feetPos.set(rig.position.x, rig.position.y + 0.3, rig.position.z);
    } else {
      this._toWorld(this.camera.position, this.headPos);
      this.torsoPos.copy(this.headPos);
      this.torsoPos.y -= this.opt.torsoOffset;
    }
  }

  _makeHand(obj, name, index) {
    return {
      obj, name, index,
      active: true,
      pos: new THREE.Vector3(),       // posição resolvida (mundo)
      cur: new THREE.Vector3(),       // posição rastreada neste frame (mundo)
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      collider: null,
      info: { collider: null, normal: new THREE.Vector3(0, 1, 0) },
      touching: false, was: false, colliding: false,
      armSpeed: 0, lastImpact: -10,
      input: { grip: false },
      grabbing: false,
      grab: { collider: null, local: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) },
      ride: { collider: null, local: new THREE.Vector3() },
    };
  }

  /* ------------------------------ Gatilhos ------------------------------ */

  _updateTriggers(sources) {
    for (const t of this.world.triggers) {
      if (!t.enabled) continue;
      for (const s of sources) {
        if (!t.sources.has(s.key)) continue;
        const inside = t.overlapSphere(s.p, s.r, _n) > 0;
        const was = t.inside.has(s.key);
        if (inside && !was) {
          t.inside.add(s.key);
          const info = { trigger: t, source: s.key, hand: s.hand, speed: s.hand >= 0 ? this.hands[s.hand].armSpeed : 0 };
          if (t.onEnter) t.onEnter(info);
          this.emit('trigger', info);
        } else if (!inside && was) {
          t.inside.delete(s.key);
          if (t.onExit) t.onExit({ trigger: t, source: s.key, hand: s.hand });
        } else if (inside && t.onStay) {
          t.onStay({ trigger: t, source: s.key, hand: s.hand });
        }
      }
    }
  }

  /* ------------------------------ Modo desktop ------------------------------ */

  /**
   * Controlador simples de caminhada (WASD) para testar no PC. As mãos virtuais
   * (posicionadas pelo main.js) continuam acionando gatilhos como os botões do Lounge.
   */
  _updateDesktop(dt, input) {
    const o = this.opt, rig = this.rig, v = this.velocity;
    const yaw = input.yaw || 0;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const ix = input.x || 0, iz = input.z || 0;

    // Direção desejada no plano XZ (câmera olha para -Z quando yaw = 0)
    let wx = -sin * iz + cos * ix;
    let wz = -cos * iz - sin * ix;
    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }

    const k = 1 - Math.exp(-(this.grounded ? 14 : 3) * dt);
    v.x += (wx * o.walkSpeed - v.x) * k;
    v.z += (wz * o.walkSpeed - v.z) * k;
    v.y -= o.gravity * dt;
    if (this.grounded && input.jump) { v.y = o.walkJump; this.grounded = false; }

    rig.position.addScaledVector(v, dt);

    // Colisão com 3 esferas empilhadas (pés, tronco, cabeça)
    this.grounded = false;
    for (let pass = 0; pass < 3; pass++) {
      this._bodyPushed = false;
      for (const [h, r] of o.walkSpheres) {
        const p = this._tmpA.set(rig.position.x, rig.position.y + h, rig.position.z);
        this.world.pushOut(p, r, this._onBodyPush);
      }
      if (!this._bodyPushed) break;
    }

    // Mãos virtuais: apenas acompanham o rig (sem colisão sólida)
    for (const h of this.hands) {
      h.armSpeed = this._tmpA.copy(h.pos).distanceTo(this._toWorld(h.obj.position, h.cur)) / dt;
      h.pos.copy(h.cur);
    }
    this._updateBodyPoints();
    this._updateTriggers(this._srcDesk);
  }
}
