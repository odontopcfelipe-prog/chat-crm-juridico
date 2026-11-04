/**
 * Passos CAD — visor 3D (three.js). Só desenha: o cálculo está no worker. Um clique sem
 * arrastar devolve o raio para o worker apontar na malha.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface MalhaDoVisor {
  pos: Float32Array;
  tri: Uint32Array;
  cores?: Float32Array;
}

export type V3 = readonly [number, number, number];

export interface OpcoesDaMalha {
  cor?: number;
  opacidade?: number;
  brilho?: number;
}

export class Visor3D {
  private readonly cena = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly render: THREE.WebGLRenderer;
  private readonly controle: OrbitControls;
  private readonly objetos = new Map<string, THREE.Object3D>();
  private readonly obs: ResizeObserver;
  private quadro = 0;
  private inicio: { x: number; y: number } | null = null;
  aoClicar: ((o: V3, d: V3) => void) | null = null;

  constructor(private readonly caixa: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
    this.render = new THREE.WebGLRenderer({ antialias: true });
    this.render.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.render.setClearColor(0x20252b);
    caixa.appendChild(this.render.domElement);
    this.controle = new OrbitControls(this.camera, this.render.domElement);
    this.controle.enableDamping = true;
    this.controle.dampingFactor = 0.15;
    this.cena.add(new THREE.HemisphereLight(0xffffff, 0x555560, 1.1));
    // Luz presa à câmera: o relevo aparece igual de qualquer ângulo.
    const luz = new THREE.DirectionalLight(0xffffff, 1.5);
    luz.position.set(-0.4, 0.6, 1);
    this.camera.add(luz);
    this.camera.add(luz.target);
    luz.target.position.set(0, 0, -1);
    this.cena.add(this.camera);
    this.camera.position.set(0, 0, 150);

    const tela = this.render.domElement;
    tela.addEventListener('pointerdown', (e) => {
      this.inicio = { x: e.clientX, y: e.clientY };
    });
    tela.addEventListener('pointerup', (e) => {
      if (!this.inicio || Math.hypot(e.clientX - this.inicio.x, e.clientY - this.inicio.y) > 4) return;
      this.inicio = null;
      if (!this.aoClicar) return;
      const r = tela.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const raio = new THREE.Raycaster();
      raio.setFromCamera(ndc, this.camera);
      this.aoClicar(raio.ray.origin.toArray() as unknown as V3, raio.ray.direction.toArray() as unknown as V3);
    });
    this.obs = new ResizeObserver(() => this.ajustarTamanho());
    this.obs.observe(caixa);
    this.ajustarTamanho();
    const laco = () => {
      this.quadro = requestAnimationFrame(laco);
      this.controle.update();
      this.render.render(this.cena, this.camera);
    };
    laco();
  }

  private ajustarTamanho(): void {
    const w = Math.max(this.caixa.clientWidth, 10);
    const h = Math.max(this.caixa.clientHeight, 10);
    this.render.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private trocar(nome: string, novo: THREE.Object3D | null): void {
    const velho = this.objetos.get(nome);
    if (velho) {
      this.cena.remove(velho);
      velho.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | undefined;
        mat?.dispose?.();
      });
      this.objetos.delete(nome);
    }
    if (novo) {
      this.cena.add(novo);
      this.objetos.set(nome, novo);
    }
  }

  definirMalha(nome: string, m: MalhaDoVisor | null, o: OpcoesDaMalha = {}): void {
    if (!m) {
      this.trocar(nome, null);
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setIndex(new THREE.BufferAttribute(m.tri, 1));
    g.computeVertexNormals();
    if (m.cores) g.setAttribute('color', new THREE.BufferAttribute(m.cores, 3));
    const opacidade = o.opacidade ?? 1;
    const mat = new THREE.MeshStandardMaterial({
      color: m.cores ? 0xffffff : o.cor ?? 0xd9cdb8,
      vertexColors: Boolean(m.cores),
      roughness: 0.55,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: opacidade < 1,
      opacity: opacidade,
      depthWrite: opacidade >= 1,
    });
    this.trocar(nome, new THREE.Mesh(g, mat));
  }

  /** Para onde a superfície olha, em média: num escaneamento, o lado dos dentes. */
  direcaoMedia(m: MalhaDoVisor): V3 {
    const p = m.pos;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let t = 0; t < m.tri.length; t += 3) {
      const a = m.tri[t] * 3;
      const b = m.tri[t + 1] * 3;
      const c = m.tri[t + 2] * 3;
      const ux = p[b] - p[a];
      const uy = p[b + 1] - p[a + 1];
      const uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a];
      const vy = p[c + 1] - p[a + 1];
      const vz = p[c + 2] - p[a + 2];
      x += uy * vz - uz * vy;
      y += uz * vx - ux * vz;
      z += ux * vy - uy * vx;
    }
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }

  /** Só troca as cores (mapa) sem refazer a malha. */
  definirCores(nome: string, cores: Float32Array | null, corBase: number): void {
    const o = this.objetos.get(nome) as THREE.Mesh | undefined;
    if (!o) return;
    const mat = o.material as THREE.MeshStandardMaterial;
    if (cores) {
      o.geometry.setAttribute('color', new THREE.BufferAttribute(cores, 3));
      mat.vertexColors = true;
      mat.color.set(0xffffff);
    } else {
      o.geometry.deleteAttribute('color');
      mat.vertexColors = false;
      mat.color.set(corBase);
    }
    mat.needsUpdate = true;
  }

  definirVisivel(nome: string, visivel: boolean): void {
    const o = this.objetos.get(nome);
    if (o) o.visible = visivel;
  }

  definirLinha(nome: string, pontos: V3[] | null, cor: number, fechada = true): void {
    if (!pontos || pontos.length < 2) {
      this.trocar(nome, null);
      return;
    }
    const g = new THREE.BufferGeometry().setFromPoints(pontos.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    const mat = new THREE.LineBasicMaterial({ color: cor, depthTest: false, transparent: true });
    const linha = fechada ? new THREE.LineLoop(g, mat) : new THREE.Line(g, mat);
    linha.renderOrder = 5;
    this.trocar(nome, linha);
  }

  definirPontos(nome: string, pontos: V3[] | null, cor: number, tamanho = 0.25): void {
    if (!pontos || !pontos.length) {
      this.trocar(nome, null);
      return;
    }
    const grupo = new THREE.Group();
    for (const p of pontos) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(tamanho, 16, 12), new THREE.MeshBasicMaterial({ color: cor, depthTest: false, transparent: true }));
      m.position.set(p[0], p[1], p[2]);
      m.renderOrder = 6;
      grupo.add(m);
    }
    this.trocar(nome, grupo);
  }

  /** Enquadra a malha ou uma região, olhando de `olhar` (direção da câmera até o alvo: oposta). */
  enquadrar(nome: string | null, centro?: V3, raio?: number, olhar?: V3, cima?: V3): void {
    let c = new THREE.Vector3();
    let r = 20;
    if (centro) {
      c = new THREE.Vector3(centro[0], centro[1], centro[2]);
      r = raio ?? r;
    } else if (nome) {
      const o = this.objetos.get(nome);
      if (!o) return;
      const caixa = new THREE.Box3().setFromObject(o);
      const esfera = caixa.getBoundingSphere(new THREE.Sphere());
      c = esfera.center;
      r = esfera.radius;
    }
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.1;
    const dir = olhar ? new THREE.Vector3(olhar[0], olhar[1], olhar[2]).normalize() : new THREE.Vector3(0, 0, 1);
    this.camera.up.copy(cima ? new THREE.Vector3(cima[0], cima[1], cima[2]) : new THREE.Vector3(0, 1, 0));
    this.camera.position.copy(c.clone().add(dir.multiplyScalar(dist)));
    this.camera.near = Math.max(dist / 100, 0.1);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controle.target.copy(c);
    this.controle.update();
  }

  encerrar(): void {
    cancelAnimationFrame(this.quadro);
    this.obs.disconnect();
    for (const nome of [...this.objetos.keys()]) this.trocar(nome, null);
    this.controle.dispose();
    // Sem isto o navegador só libera o contexto bem depois: entrar e sair da tela acumula.
    this.render.forceContextLoss();
    this.render.dispose();
    this.render.domElement.remove();
  }
}
