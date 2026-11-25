/**
 * audio.js — Áudio procedural (Web Audio API) + texturas procedurais (Canvas)
 * ===========================================================================
 * Nenhum arquivo .mp3/.wav/.png é carregado: tudo é gerado por código.
 *
 *   PARTE 1 — ProceduralAudio:  tapas/impactos, ácido (bolhas + chiado), bipes de
 *                               computador antigo, vitória/checkpoint, "whoosh".
 *   PARTE 2 — ProceduralTextures / AcidSurface / RetroScreen / createLabMaterials:
 *                               texturas pixeladas (NearestFilter) para o visual PS1/N64.
 *
 * (Se preferir, a PARTE 2 pode ser movida para um textures.js — as duas partes
 *  são independentes.)
 */

import * as THREE from 'three';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const rand = (a, b) => a + Math.random() * (b - a);

/* ===========================================================================
 * PARTE 1 — ÁUDIO PROCEDURAL
 * ========================================================================= */

export class ProceduralAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.acidLevel = 0;          // 0..1 — intensidade do borbulhar ambiente
    this.maxVoices = 40;
    this._voices = 0;
    this._bubbleAcc = 0;
    this._bed = null;            // camada contínua do ácido
    this._hum = null;            // zumbido do laboratório
  }

  /**
   * Cria/retoma o AudioContext. Os navegadores só permitem áudio após um gesto do
   * usuário — chame no clique do botão "Enter VR" / "Modo desktop".
   */
  unlock() {
    if (!this.ctx) this._create();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    if (this.master) this.master.gain.value = clamp(v, 0, 1);
  }

  mute(on) {
    this.enabled = !on;
    if (on) { this.setAcidLevel(0); this.stopHum(); }
  }

  _create() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

    // Cadeia master: ganho → compressor (evita clipping quando vários sons tocam juntos)
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // Buffers de ruído reutilizáveis (2 s): branco e "marrom" (graves, para borbulhar)
    const len = Math.floor(ctx.sampleRate * 2);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brownBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.noiseBuf.getChannelData(0);
    const b = this.brownBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      w[i] = white;
      last = (last + 0.02 * white) / 1.02;   // integração → ruído marrom
      b[i] = last * 3.5;
    }
  }

  _ready() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  /** Saída: direto no master ou via PannerNode (som posicional) se `pos` for dado. */
  _dest(pos) {
    if (!pos) return this.master;
    const ctx = this.ctx;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';   // barato; HRTF pesaria no Quest
    p.distanceModel = 'inverse';
    p.refDistance = 1.5;
    p.rolloffFactor = 1.2;
    p.maxDistance = 60;
    if (p.positionX) {
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(this.master);
    return p;
  }

  /** Atualiza o "ouvinte" (cabeça) e as bolhas ambientes. Chame todo frame. */
  update(dt, camera = null) {
    if (!this._ready()) return;
    if (camera) this._updateListener(camera);

    if (this.acidLevel > 0.02) {
      this._bubbleAcc += dt * this.acidLevel * 16;
      while (this._bubbleAcc >= 1) {
        this._bubbleAcc -= 1;
        this._bubble(this.acidLevel, null, this.ctx.currentTime);
      }
    }
  }

  _updateListener(camera) {
    const L = this.ctx.listener;
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    const fx = -e[8], fy = -e[9], fz = -e[10];   // câmera olha para -Z local
    const ux = e[4], uy = e[5], uz = e[6];
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /* ----------------------------- Blocos de síntese ----------------------------- */

  /** Oscilador com envelope (ataque rápido + decaimento exponencial). */
  _osc(type, f0, t0, dur, o = {}) {
    if (this._voices >= this.maxVoices) return null;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + dur);

    const g = ctx.createGain();
    const vol = Math.max(0.0002, o.vol ?? 0.3);
    const atk = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    g.connect(o.dest || this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    this._voices++;
    osc.onended = () => { this._voices--; };
    return osc;
  }

  /** Ruído filtrado com envelope. */
  _noise(t0, dur, o = {}) {
    if (this._voices >= this.maxVoices) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = o.brown ? this.brownBuf : this.noiseBuf;
    src.loop = true;

    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.f0 ?? 1000, t0);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + dur);

    const g = ctx.createGain();
    const vol = Math.max(0.0002, o.vol ?? 0.3);
    const atk = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(f);
    f.connect(g);
    g.connect(o.dest || this.master);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.02);
    this._voices++;
    src.onended = () => { this._voices--; };
    return src;
  }

  /* ----------------------------- Impactos / mãos ----------------------------- */

  /**
   * Tapa/impacto da mão numa superfície.
   * @param {number} speed    velocidade da mão (m/s) — define volume e timbre
   * @param {string} surface  'lab' | 'metal' | 'plastic'
   * @param {THREE.Vector3} [pos] posição do impacto (som posicional)
   */
  playImpact(speed, surface = 'lab', pos = null) {
    if (!this._ready()) return;
    const t = this.ctx.currentTime;
    const dest = this._dest(pos);
    const s = clamp(speed / 6, 0.08, 1);            // 0..1
    const vol = 0.10 + 0.55 * Math.pow(s, 1.2);      // mais rápido = mais alto
    const base = surface === 'metal' ? 330 : surface === 'plastic' ? 150 : 190;
    const f = base * rand(0.92, 1.08) * (1.15 - 0.3 * s);

    // "Tum" grave (corpo da batida)
    this._osc('sine', f, t, 0.09 + 0.08 * s, { f1: f * 0.45, vol: vol * 0.9, dest });
    // "Tapa" (estalo de ruído) — fica mais agudo/brilhante com a força
    this._noise(t, 0.05 + 0.04 * s, { type: 'bandpass', f0: 1400 + 1800 * s, f1: 600, q: 0.8, vol: vol * 0.7, dest });

    if (surface === 'metal') {
      // Parciais inarmônicos = "clang" metálico
      this._osc('sine', 880 * rand(0.95, 1.05), t, 0.22, { vol: vol * 0.16, dest });
      this._osc('sine', 1470 * rand(0.95, 1.05), t, 0.15, { vol: vol * 0.12, dest });
    } else if (surface === 'plastic') {
      this._osc('triangle', 420, t, 0.07, { f1: 300, vol: vol * 0.4, dest });
    }
  }

  /** Agarrar com a pinça (clique curto). */
  playGrab(pos = null) {
    if (!this._ready()) return;
    const t = this.ctx.currentTime;
    const dest = this._dest(pos);
    this._osc('square', 1200, t, 0.035, { f1: 700, vol: 0.12, dest });
    this._noise(t, 0.03, { type: 'highpass', f0: 3000, q: 0.7, vol: 0.1, dest });
  }

  /** Vento ao ser lançado em um salto. */
  playWhoosh(speed = 5) {
    if (!this._ready()) return;
    const t = this.ctx.currentTime;
    const s = clamp(speed / 8, 0.1, 1);
    this._noise(t, 0.28, { type: 'bandpass', f0: 350, f1: 1600, q: 0.9, vol: 0.07 + 0.2 * s, attack: 0.04 });
  }

  /* ----------------------------- Ácido ----------------------------- */

  /**
   * Intensidade do borbulhar contínuo (0 = silêncio, 1 = bem perto do ácido).
   * Faça o main.js calcular isso pela distância/altura do jogador até o tanque.
   */
  setAcidLevel(level) {
    this.acidLevel = clamp(level, 0, 1);
    if (!this._ready()) return;
    if (this.acidLevel > 0.02 && !this._bed) this._createAcidBed();
    if (this._bed) {
      const now = this.ctx.currentTime;
      this._bed.gain.gain.setTargetAtTime(this.acidLevel * 0.17, now, 0.15);
      this._bed.hiss.gain.setTargetAtTime(this.acidLevel * 0.025, now, 0.15);
    }
  }

  /** Camada contínua: "glub-glub" grave (ruído marrom) + chiado leve de fundo. */
  _createAcidBed() {
    const ctx = this.ctx;
    const mk = (buf, type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(f); f.connect(gain); gain.connect(this.master);
      src.start(0, Math.random() * 1.5);
      return { src, gain, filter: f };
    };
    const low = mk(this.brownBuf, 'lowpass', 420, 4);       // borbulhar abafado
    const hiss = mk(this.noiseBuf, 'highpass', 5200, 0.7);  // chiado do vapor

    // Modulação lenta do filtro deixa o borbulhar "vivo"
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 3.1;
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain);
    lfoGain.connect(low.filter.frequency);
    lfo.start();

    this._bed = { gain: low.gain, hiss: hiss.gain, nodes: [low.src, hiss.src, lfo] };
  }

  /** Uma bolha individual (sobe de tom rapidamente). */
  _bubble(level, dest, t) {
    const f = rand(160, 520);
    this._osc('sine', f, t, rand(0.04, 0.11), {
      f1: f * rand(1.7, 2.5),
      vol: 0.04 + 0.12 * level * Math.random(),
      attack: 0.004,
      dest: dest || this.master,
    });
  }

  /** Cair no ácido: chiado + bolhas + "splash" grave. */
  playAcidSizzle(pos = null) {
    if (!this._ready()) return;
    const t = this.ctx.currentTime;
    const dest = this._dest(pos);

    this._noise(t, 1.0, { type: 'highpass', f0: 2500, f1: 7000, q: 0.7, vol: 0.35, attack: 0.01, dest });
    this._noise(t, 0.7, { type: 'bandpass', f0: 900, f1: 300, q: 1.2, vol: 0.3, dest });
    this._osc('sine', 240, t, 0.4, { f1: 55, vol: 0.35, dest });
    for (let i = 0; i < 9; i++) this._bubble(1, dest, t + rand(0, 0.8));
    for (let i = 0; i < 10; i++) {   // estalinhos de ácido corroendo
      this._noise(t + rand(0, 0.7), 0.025, {
        type: 'bandpass', f0: rand(1500, 5000), q: 3, vol: 0.2, attack: 0.002, dest,
      });
    }
  }

  /* ----------------------------- Computador antigo ----------------------------- */

  /**
   * Bipes retrô (onda quadrada). Tipos: 'select' | 'ok' | 'back' | 'error' | 'key' | 'boot'
   */
  playBeep(kind = 'select') {
    if (!this._ready()) return;
    const t0 = this.ctx.currentTime + 0.005;
    const seq = {
      select: [[880, 0.06]],
      ok: [[660, 0.07], [990, 0.11]],
      back: [[440, 0.07], [330, 0.1]],
      error: [[160, 0.12], [110, 0.2]],
      key: [[1500, 0.02]],
      boot: [[400, 0.07], [600, 0.07], [800, 0.07], [1200, 0.12]],
    }[kind] || [[880, 0.06]];

    let at = t0;
    for (const [freq, dur] of seq) {
      this._osc(kind === 'error' ? 'sawtooth' : 'square', freq, at, dur, { vol: kind === 'key' ? 0.07 : 0.12, attack: 0.002 });
      at += dur;
    }
    if (kind === 'boot') this._noise(t0, 0.25, { type: 'bandpass', f0: 2400, q: 2, vol: 0.05 });
  }

  /* ----------------------------- Vitória / checkpoint ----------------------------- */

  /** Checkpoint: plataforma final alcançada (indicador vira verde). */
  playCheckpoint() {
    if (!this._ready()) return;
    const t = this.ctx.currentTime + 0.01;
    this._osc('square', 880, t, 0.09, { vol: 0.12 });
    this._osc('square', 1318.5, t + 0.09, 0.22, { vol: 0.12 });
    this._osc('sine', 2637, t + 0.09, 0.3, { vol: 0.05 });
  }

  /** Fanfarra 8-bit ao concluir uma fase (use também no escape final). */
  playVictory() {
    if (!this._ready()) return;
    const t = this.ctx.currentTime + 0.02;
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5]; // C5 E5 G5 C6 G5 C6
    const durs = [0.1, 0.1, 0.1, 0.16, 0.08, 0.5];
    let at = t;
    notes.forEach((f, i) => {
      this._osc('square', f, at, durs[i] * 1.1, { vol: 0.12 });
      this._osc('triangle', f / 2, at, durs[i] * 1.1, { vol: 0.12 });
      at += durs[i];
    });
    // Acorde final + brilho
    const tc = at - durs[5];
    [523.25, 659.25, 783.99, 1318.5].forEach((f) => this._osc('triangle', f, tc, 0.7, { vol: 0.09 }));
    this._osc('sine', 3136, tc, 0.5, { f1: 2093, vol: 0.04 });
    this._noise(tc, 0.35, { type: 'highpass', f0: 6000, q: 0.7, vol: 0.05 });
  }

  /* ----------------------------- Ambiente do laboratório ----------------------------- */

  /** Zumbido elétrico grave de fundo (liga no Lounge/fases). */
  startHum() {
    if (!this._ready() || this._hum) return;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);

    const oscs = [[50, 'sine', 0.05], [100.6, 'sine', 0.025], [150.4, 'triangle', 0.01]].map(([f, type, v]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type; o.frequency.value = f; g.gain.value = v;
      o.connect(g); g.connect(gain); o.start();
      return o;
    });
    gain.gain.setTargetAtTime(1, ctx.currentTime, 0.5);
    this._hum = { gain, oscs };
  }

  stopHum() {
    if (!this._hum) return;
    const { gain, oscs } = this._hum;
    gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    setTimeout(() => oscs.forEach((o) => o.stop()), 800);
    this._hum = null;
  }
}

/* ===========================================================================
 * PARTE 2 — TEXTURAS PROCEDURAIS (Canvas → THREE.CanvasTexture, pixeladas)
 * ========================================================================= */

/** PRNG determinístico (mulberry32): a mesma textura sai igual em toda execução. */
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}

/**
 * Canvas → textura pixelada. magFilter = NearestFilter (pixels "quadrados" de perto).
 * Com `mipmaps` (padrão) o filtro de minificação também é "nearest", mas escolhe o
 * mipmap certo — mantém o visual retrô sem o cintilar de pixels à distância (que
 * incomoda bastante em VR).
 */
function toTexture(canvas, { mipmaps = true, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = mipmaps ? THREE.NearestMipmapNearestFilter : THREE.NearestFilter;
  t.generateMipmaps = mipmaps;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 1;
  return t;
}

/** Granulado: pixels aleatoriamente mais claros/escuros. */
function speckle(g, w, h, R, density, amp) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = R();
      if (r < density) {
        g.fillStyle = R() < 0.5 ? `rgba(0,0,0,${amp})` : `rgba(255,255,255,${amp})`;
        g.fillRect(x, y, 1, 1);
      }
    }
  }
}

const _cache = new Map();
function cached(key, make) {
  if (!_cache.has(key)) _cache.set(key, make());
  return _cache.get(key);
}

export class ProceduralTextures {
  /** Parede de laboratório: painéis metálicos claros com parafusos e manchas. */
  static labWall(tint = '#9fb0bd') {
    return cached('labWall:' + tint, () => {
      const [c, g] = makeCanvas(64, 64);
      const R = rng(11);
      g.fillStyle = tint; g.fillRect(0, 0, 64, 64);
      speckle(g, 64, 64, R, 0.22, 0.07);

      // Escorrimentos verticais (sujeira)
      for (let i = 0; i < 6; i++) {
        const x = Math.floor(R() * 64), y = Math.floor(R() * 40), len = 6 + Math.floor(R() * 18);
        g.fillStyle = 'rgba(30,50,30,0.14)';
        g.fillRect(x, y, 1, len);
      }
      // Divisões de painel (2x2 painéis de 32px) com bisel claro/escuro
      g.fillStyle = 'rgba(0,0,0,0.38)';
      g.fillRect(0, 0, 64, 1); g.fillRect(0, 32, 64, 1);
      g.fillRect(0, 0, 1, 64); g.fillRect(32, 0, 1, 64);
      g.fillStyle = 'rgba(255,255,255,0.28)';
      g.fillRect(0, 1, 64, 1); g.fillRect(0, 33, 64, 1);
      g.fillRect(1, 0, 1, 64); g.fillRect(33, 0, 1, 64);
      // Parafusos
      for (const [x, y] of [[4, 4], [27, 4], [4, 27], [27, 27], [36, 4], [59, 4], [36, 27], [59, 27],
                            [4, 36], [27, 36], [4, 59], [27, 59], [36, 36], [59, 36], [36, 59], [59, 59]]) {
        g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x, y, 2, 2);
        g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(x, y, 1, 1);
      }
      // Faixa azul-petróleo na base do painel inferior
      g.fillStyle = 'rgba(30,70,95,0.55)'; g.fillRect(1, 44, 62, 3);
      return toTexture(c);
    });
  }

  /** Piso/teto de azulejos 2x2 com rejunte. */
  static floorTiles(a = '#59656e', b = '#4a555d') {
    return cached(`floor:${a}:${b}`, () => {
      const [c, g] = makeCanvas(64, 64);
      const R = rng(23);
      for (let ty = 0; ty < 2; ty++) {
        for (let tx = 0; tx < 2; tx++) {
          g.fillStyle = (tx + ty) % 2 ? a : b;
          g.fillRect(tx * 32, ty * 32, 32, 32);
        }
      }
      speckle(g, 64, 64, R, 0.3, 0.08);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, 0, 64, 1); g.fillRect(0, 32, 64, 1); g.fillRect(0, 0, 1, 64); g.fillRect(32, 0, 1, 64);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(0, 1, 64, 1); g.fillRect(1, 0, 1, 64);
      return toTexture(c);
    });
  }

  /** Grade metálica: barras claras com furos escuros em malha de 4px. */
  static metalGrate() {
    return cached('grate', () => {
      const [c, g] = makeCanvas(64, 64);
      const R = rng(37);
      g.fillStyle = '#6d7680'; g.fillRect(0, 0, 64, 64);
      for (let y = 0; y < 64; y += 4) {
        for (let x = 0; x < 64; x += 4) {
          g.fillStyle = '#0b0e11'; g.fillRect(x + 1, y + 1, 3, 3);           // furo
          g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x, y, 4, 1);    // brilho da barra
        }
      }
      speckle(g, 64, 64, R, 0.12, 0.1);
      g.fillStyle = '#3c434a';                                                // moldura
      g.fillRect(0, 0, 64, 2); g.fillRect(0, 62, 64, 2); g.fillRect(0, 0, 2, 64); g.fillRect(62, 0, 2, 64);
      return toTexture(c);
    });
  }

  /** Plástico fosco com granulado leve. Cor em hex (ex.: '#7a4a2a'). */
  static plastic(color = '#cccccc') {
    return cached('plastic:' + color, () => {
      const [c, g] = makeCanvas(16, 16);
      const R = rng(5);
      g.fillStyle = color; g.fillRect(0, 0, 16, 16);
      speckle(g, 16, 16, R, 0.35, 0.07);
      return toTexture(c);
    });
  }

  /** Listras diagonais amarelas e pretas (bordas de plataforma, perigo). */
  static hazardStripes() {
    return cached('hazard', () => {
      const [c, g] = makeCanvas(32, 32);
      const R = rng(7);
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          g.fillStyle = ((x + y) >> 3) % 2 ? '#1a1a1a' : '#e8c21a';
          g.fillRect(x, y, 1, 1);
        }
      }
      speckle(g, 32, 32, R, 0.2, 0.1);
      return toTexture(c);
    });
  }

  /**
   * Ajusta os UVs de uma BoxGeometry para que cada face repita a textura a cada
   * `metersPerTile` metros. Mantém a densidade de pixels constante em todas as
   * caixas (essencial para o visual PS1/N64 consistente).
   * Ordem das faces da BoxGeometry: +x, -x, +y, -y, +z, -z (4 vértices cada).
   */
  static applyBoxUVs(geometry, w, h, d, metersPerTile = 2) {
    const uv = geometry.attributes.uv;
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const su = dims[f][0] / metersPerTile, sv = dims[f][1] / metersPerTile;
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
      }
    }
    uv.needsUpdate = true;
    return geometry;
  }

  /** Libera as texturas em cache (raramente necessário). */
  static disposeAll() {
    for (const t of _cache.values()) t.dispose();
    _cache.clear();
  }
}

/* ---------------------------------------------------------------------------
 * AcidSurface — líquido verde brilhante ANIMADO (plasma pixelado, 64x64)
 * ------------------------------------------------------------------------- */
export class AcidSurface {
  /** @param {number} fps taxa de atualização da animação (12 = visual "travadinho" retrô) */
  constructor(fps = 12) {
    this.size = 64;
    [this.canvas, this.g] = makeCanvas(this.size, this.size);
    this.image = this.g.createImageData(this.size, this.size);
    this.texture = toTexture(this.canvas, { mipmaps: false });
    // MeshBasicMaterial: ignora luzes → o ácido "brilha" sozinho e custa quase nada
    this.material = new THREE.MeshBasicMaterial({ map: this.texture });
    this._interval = 1 / fps;
    this._last = -1;
    this.update(0);
  }

  /** Chame todo frame com o tempo total (s). Só redesenha na taxa configurada. */
  update(time) {
    if (time - this._last < this._interval) return;
    this._last = time;

    const N = this.size, K = (2 * Math.PI) / N, d = this.image.data;
    const t = time;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        // Frequências inteiras → a textura é perfeitamente "tileável"
        const v = Math.sin(K * 3 * x + t * 1.1) + Math.sin(K * 2 * y - t * 0.9)
                + Math.sin(K * 2 * (x + y) + t * 0.7) + Math.sin(K * 4 * (x - y) - t * 1.3);
        let n = (v + 4) / 8;
        n = Math.floor(n * 6) / 6;           // posteriza em 6 níveis → pixel art
        const i = (y * N + x) * 4;
        if (n > 0.8) { d[i] = 216; d[i + 1] = 255; d[i + 2] = 106; }          // espuma clara
        else { d[i] = 18 + n * 90; d[i + 1] = 150 + n * 105; d[i + 2] = 18 + n * 40; }
        d[i + 3] = 255;
      }
    }
    // Bolhas subindo (pixels brilhantes 2x2)
    for (let b = 0; b < 7; b++) {
      const bx = (b * 29 + 11) % N;
      const by = Math.floor(N - ((t * (6 + b * 2.3) + b * 17) % N));
      for (let oy = 0; oy < 2; oy++) {
        for (let ox = 0; ox < 2; ox++) {
          const i = (((by + oy) % N) * N + ((bx + ox) % N)) * 4;
          d[i] = 235; d[i + 1] = 255; d[i + 2] = 170;
        }
      }
    }
    this.g.putImageData(this.image, 0, 0);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
  }
}

/* ---------------------------------------------------------------------------
 * RetroScreen — monitor CRT: texto verde fosforescente dinâmico (CanvasTexture)
 * ------------------------------------------------------------------------- */
export class RetroScreen {
  /**
   * @param {object} [o]
   * @param {number} [o.width=256]  resolução da tela (baixa de propósito)
   * @param {number} [o.height=192]
   */
  constructor({ width = 256, height = 192 } = {}) {
    this.width = width;
    this.height = height;
    [this.canvas, this.g] = makeCanvas(width, height);
    this.texture = toTexture(this.canvas, { mipmaps: false, repeat: false });
    this.material = new THREE.MeshBasicMaterial({ map: this.texture });
    this.lines = [];
    this.fg = '#33ff66';
    this.lineHeight = 15;
    this.font = '12px "Courier New", Courier, monospace';
    this._acc = 0;
    this._cursorOn = true;
    this._dirty = true;
    this._draw();
  }

  /**
   * Define o conteúdo. Cada linha é uma string ou { text, inverse?, dim? }.
   * `inverse` desenha texto escuro sobre fundo verde (item de menu selecionado).
   */
  setLines(lines) {
    this.lines = lines;
    this._dirty = true;
  }

  /** Chame todo frame: faz o cursor piscar e só redesenha quando algo mudou. */
  update(dt) {
    this._acc += dt;
    if (this._acc >= 0.45) {
      this._acc = 0;
      this._cursorOn = !this._cursorOn;
      this._dirty = true;
    }
    if (this._dirty) this._draw();
  }

  _draw() {
    const g = this.g, W = this.width, H = this.height;
    g.fillStyle = '#021402';
    g.fillRect(0, 0, W, H);

    g.font = this.font;
    g.textBaseline = 'top';
    g.shadowColor = this.fg;
    g.shadowBlur = 3;

    let y = 8;
    for (const item of this.lines) {
      const line = typeof item === 'string' ? { text: item } : item;
      if (line.inverse) {
        g.shadowBlur = 0;
        g.fillStyle = this.fg;
        g.fillRect(6, y - 1, W - 12, this.lineHeight);
        g.fillStyle = '#021402';
        g.fillText(line.text, 10, y);
        g.shadowBlur = 3;
      } else {
        g.fillStyle = line.dim ? '#1f9d3f' : this.fg;
        g.fillText(line.text, 10, y);
      }
      y += this.lineHeight;
    }
    // Cursor piscante no fim
    if (this._cursorOn) {
      g.fillStyle = this.fg;
      g.fillRect(10, y + 1, 7, this.lineHeight - 4);
    }

    // Efeito CRT: linhas de varredura + vinheta + cintilação leve
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (let sy = 0; sy < H; sy += 2) g.fillRect(0, sy, W, 1);
    const vg = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = `rgba(51,255,102,${(Math.random() * 0.03).toFixed(3)})`;
    g.fillRect(0, 0, W, H);

    this.texture.needsUpdate = true;
    this._dirty = false;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
  }
}

/* ---------------------------------------------------------------------------
 * Materiais prontos para levels.js e lounge.js
 * ------------------------------------------------------------------------- */

/**
 * Cria o conjunto padrão de materiais do laboratório.
 * Usa MeshLambertMaterial (iluminação por vértice) — barato para o Quest.
 *
 * @returns {{wall, floor, grate, hazard, plastic: (hex:string)=>THREE.Material,
 *            acid: AcidSurface}}
 */
export function createLabMaterials() {
  const lambert = (map) => new THREE.MeshLambertMaterial({ map });
  return {
    wall: lambert(ProceduralTextures.labWall()),
    floor: lambert(ProceduralTextures.floorTiles()),
    grate: lambert(ProceduralTextures.metalGrate()),
    hazard: lambert(ProceduralTextures.hazardStripes()),
    plastic: (hex) => lambert(ProceduralTextures.plastic(hex)),
    /** Chame acid.update(tempo) a cada frame; use acid.material nas malhas de ácido. */
    acid: new AcidSurface(12),
  };
}
