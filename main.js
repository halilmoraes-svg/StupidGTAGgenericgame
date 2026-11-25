/**
 * main.js — Ponto de entrada: renderer, WebXR, rig do jogador, entrada (VR/desktop),
 * HUD e fluxo do jogo (Lounge ↔ fases).
 * ===========================================================================
 *
 * Parâmetros opcionais na URL:
 *   ?hz=90          taxa de quadros alvo no Quest (padrão 120; usa a maior suportada ≤ valor)
 *   ?scale=0.9      escala da resolução do framebuffer VR (padrão 1.0; menor = mais FPS)
 *   ?unlock=all     libera as 30 fases (útil para testar)
 *
 * Controles VR (Quest):
 *   - Mãos/controles empurram chão e paredes (física Gorilla Tag)
 *   - Grip (lateral) perto de superfícies "escaláveis" = escalada por pinça
 *   - Botão B / Y: volta ao checkpoint · B + Y segurados ~1 s: volta ao Lounge
 *
 * Controles desktop: WASD, mouse, Espaço, R (checkpoint), L (Lounge),
 *   botão esquerdo/direito = mão direita/esquerda "toca" o que está na mira, roda = alcance.
 *
 * ---------------------------------------------------------------------------
 * CONTRATO esperado de levels.js (Parte 3). Exporte `LevelManager`:
 *
 *   new LevelManager({ scene, world, materials, audio, lights, events })
 *       events.onAcid()  → chame quando o jogador tocar o ácido (Trigger da fase)
 *       events.onGoal()  → chame UMA vez ao alcançar a plataforma final
 *       lights           → { hemi, points:[3 PointLight] }: reposicione/ajuste (NÃO crie luzes novas,
 *                          para não recompilar shaders)
 *   build(n)       → cria geometria + world.addSolid/addTrigger; retorna { spawn: THREE.Vector3 }
 *                    (spawn = origem do rig, "chão" sob o jogador; ele cai ~1 m até as mãos tocarem)
 *   unload()       → remove/descarta tudo que build() criou (malhas, colisores, gatilhos)
 *   update(dt, t)  → anima plataformas móveis/giratórias e materials.acid já é animado aqui
 *   checkpoint     → (opcional) THREE.Vector3 do checkpoint atual; senão usa o spawn
 *   getAcidLevel?(headPos) → (opcional) 0..1 para o volume do borbulhar
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { PhysicsWorld, GorillaLocomotion, LEFT, RIGHT } from './physics.js';
import { ProceduralAudio, createLabMaterials } from './audio.js';
import { Lounge, MonkeyAvatar, SaveData, MONKEY_COLORS, TOTAL_LEVELS, fmtTime } from './lounge.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/* ===========================================================================
 * Renderer / cena
 * ========================================================================= */
const renderer = new THREE.WebGLRenderer({
  antialias: true,                      // MSAA: importante em VR (bordas serrilhadas incomodam)
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));   // no VR o Three usa a resolução do headset
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');               // y = 0 é o chão real
renderer.xr.setFramebufferScaleFactor(parseFloat(params.get('scale')) || 1.0);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x040807);
scene.fog = new THREE.Fog(0x040807, 14, 70);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 120);

// Luzes globais com quantidade FIXA (mudar o nº de luzes recompila shaders = engasgo).
// Lounge e fases só mudam posição/cor/intensidade delas. Sem sombras dinâmicas.
const lights = {
  hemi: new THREE.HemisphereLight(0xd8ecff, 0x2a3a30, 1.6),
  points: [0, 1, 2].map(() => new THREE.PointLight(0xffffff, 0, 0, 2)),
};
scene.add(lights.hemi, ...lights.points);

/* ===========================================================================
 * Sistemas: materiais, áudio, física, save, avatar
 * ========================================================================= */
const materials = createLabMaterials();
const audio = new ProceduralAudio();
const world = new PhysicsWorld();
const save = new SaveData();
if (params.get('unlock') === 'all') save.unlockAll();

// Rig (dolly): corpo do macaco. Câmera e controles são filhos dele.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

const grips = [renderer.xr.getControllerGrip(0), renderer.xr.getControllerGrip(1)];
grips.forEach((g) => rig.add(g));

// Mãos virtuais do modo desktop (filhas do rig, como os grips do VR)
const deskHands = [new THREE.Object3D(), new THREE.Object3D()];
deskHands.forEach((h) => rig.add(h));

const loco = new GorillaLocomotion({
  rig, camera, leftHand: grips[0], rightHand: grips[1], world,
});
loco.setHandActive(LEFT, false);
loco.setHandActive(RIGHT, false);

const avatar = new MonkeyAvatar();
avatar.setColor(MONKEY_COLORS[save.color].hex);
scene.add(avatar.root);

/* ===========================================================================
 * HUD: DOM no desktop, plano 3D preso à cabeça no VR
 * ========================================================================= */
class Hud {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512; this.canvas.height = 128;
    this.g = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.225),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false })
    );
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.local = new THREE.Matrix4().makeTranslation(0, -0.4, -1.3);
    // O Three só atualiza a pose da câmera XR no render; alinhamos o HUD à câmera
    // exatamente nesse momento para não "tremer" em relação à cabeça.
    this.mesh.onBeforeRender = () => {
      this.mesh.matrixWorld.copy(camera.matrixWorld).multiply(this.local);
    };
    scene.add(this.mesh);

    this.info = '';
    this.timer = '';
    this.text = '';
    this.textT = 0;
    this._drawn = '';
    this.vr = false;
  }

  setInfo(level, timer) {
    this.info = level;
    this.timer = timer;
    this._sync();
  }

  message(text, seconds = 2.5) {
    this.text = text;
    this.textT = seconds;
    this._sync();
  }

  setVR(on) {
    this.vr = on;
    this.mesh.visible = on;
    $('hud').hidden = on;
    this._sync(true);
  }

  update(dt) {
    if (this.textT > 0) {
      this.textT -= dt;
      if (this.textT <= 0) { this.text = ''; this._sync(); }
    }
  }

  _sync(force = false) {
    $('hud-level').textContent = this.info;
    $('hud-timer').textContent = this.timer;
    $('hud-msg').textContent = this.text;
    if (!this.vr) return;
    const key = this.text + '|' + this.info + '|' + this.timer;
    if (!force && key === this._drawn) return;
    this._drawn = key;
    const g = this.g;
    g.clearRect(0, 0, 512, 128);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 24px "Courier New", monospace';
    if (this.text) {
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 10, 512, 48);
      g.fillStyle = '#ffd23a'; g.fillText(this.text, 256, 34);
    }
    g.font = 'bold 20px "Courier New", monospace';
    g.fillStyle = '#38ff6a';
    g.fillText((this.info + '   ' + this.timer).trim(), 256, 96);
    this.texture.needsUpdate = true;
  }
}
const hud = new Hud();

/* ===========================================================================
 * Haptics (vibração dos controles)
 * ========================================================================= */
const xrHands = [null, null];     // por mão: { grip, source }

function haptic(hand, intensity = 0.5, ms = 40) {
  const gp = xrHands[hand] && xrHands[hand].source.gamepad;
  if (!gp) return;
  try {
    const act = gp.hapticActuators && gp.hapticActuators[0];
    if (act && act.pulse) act.pulse(clamp(intensity, 0, 1), ms);
    else if (gp.vibrationActuator && gp.vibrationActuator.playEffect) {
      gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity });
    }
  } catch (e) { /* alguns navegadores bloqueiam; ignora */ }
}

/* ===========================================================================
 * Lounge e fases
 * ========================================================================= */
const lounge = new Lounge({
  scene, world, materials, audio, save, avatar, lights,
  callbacks: {
    onStartLevel: (n) => startLevel(n),
    haptic,
  },
  mirrorHide: [hud.mesh],
});

/** levels.js é carregado dinamicamente: sem ele (Parte 3 pendente) o Lounge continua funcionando. */
let levels = null;
async function loadLevels() {
  try {
    const mod = await import('./levels.js');
    levels = new mod.LevelManager({
      scene, world, materials, audio, lights,
      events: { onAcid: () => onAcid(), onGoal: () => onGoal() },
    });
    lounge.levelsReady = true;
  } catch (err) {
    console.warn('[main] levels.js não carregado (Parte 3 pendente?):', err);
    levels = null;
    lounge.levelsReady = false;
  }
  lounge.refresh();
}

/* ------------------------------ Estado do jogo ------------------------------ */
let mode = 'lounge';              // 'lounge' | 'level'
let level = 0;
let levelDone = false;
let levelTime = 0;
let time = 0;
let lastAcid = -10;
let pending = null;               // { at, fn } — ação agendada (avançar de fase etc.)
const spawn = new THREE.Vector3();

function checkpointPos() {
  return (levels && levels.checkpoint) ? levels.checkpoint : spawn;
}

function enterLounge() {
  mode = 'lounge';
  pending = null;
  if (levels) levels.unload();
  world.clear();
  lounge.activate();
  loco.teleportTo(lounge.spawn);
  audio.setAcidLevel(0);
  hud.setInfo('LOUNGE', '');
  hud.message('BEM-VINDO AO LOUNGE', 2.5);
}

function startLevel(n) {
  if (!levels) {
    audio.playBeep('error');
    lounge.notify('ERRO: levels.js AUSENTE', 3);
    hud.message('FASES AINDA NAO INSTALADAS (levels.js)', 3);
    return;
  }
  n = clamp(Math.round(n), 1, TOTAL_LEVELS);
  pending = null;
  lounge.deactivate();
  levels.unload();
  world.clear();
  const info = levels.build(n);
  spawn.copy(info.spawn);
  mode = 'level';
  level = n;
  levelDone = false;
  levelTime = 0;
  loco.teleportTo(checkpointPos());
  hud.setInfo(`FASE ${String(n).padStart(2, '0')}/${TOTAL_LEVELS}`, fmtTime(0));
  hud.message(`FASE ${n}`, 2);
}

function respawn(withSizzle = false) {
  if (mode !== 'level') return;
  if (withSizzle) audio.playAcidSizzle(loco.headPos);
  loco.teleportTo(checkpointPos());
}

/** Tocou no ácido: chiado, vibração e volta ao checkpoint da fase atual. */
function onAcid() {
  if (mode !== 'level' || time - lastAcid < 0.5) return;
  lastAcid = time;
  haptic(LEFT, 1, 200);
  haptic(RIGHT, 1, 200);
  hud.message('ACIDO! VOLTANDO AO CHECKPOINT', 1.5);
  respawn(true);
}

/** Plataforma final alcançada: som, progresso salvo e avanço automático. */
function onGoal() {
  if (mode !== 'level' || levelDone) return;
  levelDone = true;
  save.completeLevel(level, levelTime);
  lounge.refresh();
  audio.playCheckpoint();
  setTimeout(() => audio.playVictory(), 300);
  haptic(LEFT, 0.8, 150);
  haptic(RIGHT, 0.8, 150);

  const last = level >= TOTAL_LEVELS;
  hud.message(last ? 'ESCAPE DO LABORATORIO CONCLUIDO!' : `FASE ${level} COMPLETA! ${fmtTime(levelTime)}`, last ? 6 : 3);
  pending = {
    at: time + (last ? 7 : 3.2),
    fn: last ? enterLounge : () => startLevel(level + 1),
  };
}

/* ------------------------------ Eventos da física ------------------------------ */
loco.on('impact', (e) => {
  audio.playImpact(e.speed, e.collider.surface, e.point);
  haptic(e.hand, clamp(e.speed / 8, 0.1, 1), 40);
});
loco.on('grab', (e) => { audio.playGrab(); haptic(e.hand, 0.4, 30); });
loco.on('launch', (e) => audio.playWhoosh(e.speed));
loco.on('bounce', (e) => {                // batida forte rebateu: vibra e faz o "whoosh"
  haptic(LEFT, 0.8, 80);
  haptic(RIGHT, 0.8, 80);
  audio.playWhoosh(e.speed);
});

/* ===========================================================================
 * VR: botão, sessão e controles
 * ========================================================================= */
let running = false;              // só simula/renderiza depois do "Enter VR"/"Desktop"
let humStarted = false;

async function setupVRButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'ENTRAR EM VR';
  let supported = false;
  try { supported = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')); } catch (e) { /* sem WebXR */ }
  if (!supported) { btn.disabled = true; btn.textContent = 'VR INDISPONIVEL'; }

  btn.addEventListener('click', async () => {
    audio.unlock();                                   // gesto do usuário: libera o áudio
    try {
      const session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor'],
      });
      await renderer.xr.setSession(session);
    } catch (err) {
      $('status').textContent = 'Falha ao entrar em VR: ' + err.message;
    }
  });
  $('vr-slot').appendChild(btn);
}

// Mapeia cada controle (slot do Three) para esquerda/direita quando conectar
grips.forEach((grip) => {
  grip.addEventListener('connected', (e) => {
    if (!e.data || !e.data.gamepad) return;            // ignora "mãos" sem controle físico
    const hand = e.data.handedness === 'left' ? LEFT : RIGHT;
    xrHands[hand] = { grip, source: e.data };
    loco.hands[hand].obj = grip;
    if (renderer.xr.isPresenting) loco.setHandActive(hand, true);
  });
  grip.addEventListener('disconnected', () => {
    for (let h = 0; h < 2; h++) {
      if (xrHands[h] && xrHands[h].grip === grip) {
        xrHands[h] = null;
        loco.setHandActive(h, false);
      }
    }
  });
});

renderer.xr.addEventListener('sessionstart', () => {
  setFrameRate(renderer.xr.getSession());
  $('overlay').classList.add('hidden');
  startGame('vr');
});

renderer.xr.addEventListener('sessionend', () => {
  running = false;
  hud.setVR(false);
  for (let h = 0; h < 2; h++) loco.setHandActive(h, false);
  $('overlay').classList.remove('hidden');
});

/** Pede 120 Hz (ou o mais próximo suportado ≤ ?hz=) ao Quest. */
function setFrameRate(session) {
  try {
    if (!session || !session.updateTargetFrameRate || !session.supportedFrameRates) return;
    const rates = Array.from(session.supportedFrameRates);
    const want = parseInt(params.get('hz'), 10) || 120;
    const best = rates.filter((r) => r <= want).sort((a, b) => b - a)[0] || Math.max(...rates);
    session.updateTargetFrameRate(best);
  } catch (e) { /* recurso opcional */ }
}

const btnPrev = [false, false];
let bothHold = 0;

function pollXR(dt) {
  const pressed = [false, false];
  for (let h = 0; h < 2; h++) {
    const x = xrHands[h];
    if (!x) continue;
    const gp = x.source.gamepad;
    if (!gp) continue;
    loco.setGrip(h, !!(gp.buttons[1] && gp.buttons[1].pressed));    // grip → pinça
    const b = !!(gp.buttons[5] && gp.buttons[5].pressed);           // B (direita) / Y (esquerda)
    pressed[h] = b;
    if (b && !btnPrev[h]) respawn(false);
    btnPrev[h] = b;
  }
  if (pressed[0] && pressed[1]) {
    bothHold += dt;
    if (bothHold > 1.0 && mode !== 'lounge') { enterLounge(); bothHold = -10; }
  } else {
    bothHold = 0;
  }
}

/* ===========================================================================
 * Desktop: mouse + WASD
 * ========================================================================= */
const desk = { yaw: 0, pitch: 0, reach: 0.7, pulse: [0, 0], pulseReach: [0.7, 0.7], locked: false };
const deskIn = { x: 0, z: 0, jump: false, yaw: 0 };
const keys = new Set();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _to = new THREE.Vector3();
const _n = new THREE.Vector3();
const _hit = { t: 0, collider: null, normal: new THREE.Vector3() };

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
  if (!running || renderer.xr.isPresenting) return;
  if (e.code === 'KeyR') respawn(false);
  if (e.code === 'KeyL' && mode !== 'lounge') enterLounge();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

document.addEventListener('pointerlockchange', () => {
  desk.locked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', (e) => {
  if (!desk.locked) return;
  desk.yaw -= e.movementX * 0.0022;
  desk.pitch = clamp(desk.pitch - e.movementY * 0.0022, -1.5, 1.5);
});
renderer.domElement.addEventListener('click', () => {
  if (running && !renderer.xr.isPresenting && !desk.locked) renderer.domElement.requestPointerLock();
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('wheel', (e) => {
  desk.reach = clamp(desk.reach - e.deltaY * 0.001, 0.3, 2.0);
});
renderer.domElement.addEventListener('mousedown', (e) => {
  if (!desk.locked || renderer.xr.isPresenting) return;
  const hand = e.button === 2 ? LEFT : RIGHT;     // botão direito = mão esquerda
  _v2.set(0, 0, -1).applyQuaternion(camera.quaternion).applyQuaternion(rig.quaternion);
  desk.pulseReach[hand] = clamp(rayReach(loco.headPos, _v2, 2.5), 0.3, 2.6);
  desk.pulse[hand] = 0.2;
});

/**
 * Distância até o primeiro sólido ou botão na mira (para a mão virtual "tocar" o alvo).
 * Botões ganham +5 cm para a esfera da mão entrar de fato no gatilho.
 */
function rayReach(origin, dir, maxLen) {
  _to.copy(origin).addScaledVector(dir, maxLen);
  let best = 1, extra = 0;
  if (world.sweep(origin, _to, 0.04, _hit)) best = _hit.t;
  for (const t of world.triggers) {
    if (!t.enabled || !t.userData.pressable) continue;
    const tt = t.sweepSphere(origin, _to, 0.03, _n);
    if (tt >= 0 && tt < best) { best = tt; extra = 0.05; }
  }
  return best * maxLen + extra;
}

function updateDesktopInput(dt) {
  rig.rotation.y = desk.yaw;
  camera.rotation.set(desk.pitch, 0, 0);
  camera.position.set(0, 1.6, 0);

  deskIn.x = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  deskIn.z = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  deskIn.jump = keys.has('Space');
  deskIn.yaw = desk.yaw;

  _v1.set(0, 0, -1).applyQuaternion(camera.quaternion);
  for (let h = 0; h < 2; h++) {
    const hand = deskHands[h];
    if (desk.pulse[h] > 0) {
      desk.pulse[h] -= dt;
      hand.position.copy(camera.position).addScaledVector(_v1, desk.pulseReach[h]);
    } else {
      hand.position.set(h === LEFT ? -0.25 : 0.25, -0.22, -desk.reach)
        .applyQuaternion(camera.quaternion).add(camera.position);
    }
    hand.quaternion.copy(camera.quaternion);
  }
  return deskIn;
}

/* ===========================================================================
 * Início do jogo
 * ========================================================================= */
function startGame(kind) {
  audio.unlock();
  const vr = kind === 'vr';
  loco.desktopMode = !vr;
  hud.setVR(vr);

  if (vr) {
    for (let h = 0; h < 2; h++) {
      if (xrHands[h]) { loco.hands[h].obj = xrHands[h].grip; loco.setHandActive(h, true); }
      else loco.setHandActive(h, false);
    }
    rig.rotation.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
  } else {
    for (let h = 0; h < 2; h++) { loco.hands[h].obj = deskHands[h]; loco.setHandActive(h, true); }
    desk.yaw = 0; desk.pitch = 0;
  }
  enterLounge();
  running = true;
}

$('btn-desktop').addEventListener('click', () => {
  $('overlay').classList.add('hidden');
  startGame('desktop');
  renderer.domElement.requestPointerLock();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (!renderer.xr.isPresenting) renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ===========================================================================
 * Loop principal
 * ========================================================================= */
const clock = new THREE.Clock();
const _hq = new THREE.Quaternion();
const handData = [
  { active: false, pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
  { active: false, pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
];
let lastAcidLevel = -1;
let lastTimerText = '';

function updateAvatar(dt) {
  _hq.copy(rig.quaternion).multiply(camera.quaternion);          // orientação da cabeça no mundo
  for (let h = 0; h < 2; h++) {
    const hs = loco.hands[h];
    handData[h].active = hs.active;
    handData[h].pos.copy(hs.pos);                                 // já resolvida contra colisões
    handData[h].quat.copy(rig.quaternion).multiply(hs.obj.quaternion);
  }
  avatar.update(dt, loco.headPos, _hq, handData);
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!running) return;
  time += dt;

  const presenting = renderer.xr.isPresenting;
  let input = null;
  if (presenting) pollXR(dt);
  else input = updateDesktopInput(dt);

  loco.update(dt, input);
  updateAvatar(dt);

  // Zumbido do laboratório: o AudioContext só fica "running" após o gesto do usuário
  if (!humStarted && audio.ctx && audio.ctx.state === 'running') { audio.startHum(); humStarted = true; }

  // Mundo ativo
  materials.acid.update(time);                                    // ácido animado (12 fps)
  if (mode === 'lounge') {
    lounge.update(dt, time);
  } else if (levels) {
    levels.update(dt, time);
    if (!levelDone) {
      levelTime += dt;
      const txt = fmtTime(levelTime);
      if (txt !== lastTimerText) { lastTimerText = txt; hud.setInfo(`FASE ${String(level).padStart(2, '0')}/${TOTAL_LEVELS}`, txt); }
    }
    // Borbulhar do ácido: a fase pode informar; senão, mais alto quanto mais baixo o jogador
    const a = levels.getAcidLevel ? levels.getAcidLevel(loco.headPos) : clamp(0.9 - loco.headPos.y * 0.12, 0.15, 0.9);
    if (Math.abs(a - lastAcidLevel) > 0.03) { lastAcidLevel = a; audio.setAcidLevel(a); }
  }

  if (pending && time >= pending.at) { const fn = pending.fn; pending = null; fn(); }

  hud.update(dt);
  audio.update(dt, camera);
  renderer.render(scene, camera);
});

/* ===========================================================================
 * Inicialização
 * ========================================================================= */
setupVRButton();
loadLevels().then(() => {
  $('status').textContent = levels
    ? 'Pronto. Entre em VR ou use o modo desktop.'
    : 'Lounge pronto. levels.js ainda não encontrado (fases chegam na Parte 3).';
});
