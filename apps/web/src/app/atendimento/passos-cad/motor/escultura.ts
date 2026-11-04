/**
 * Passos CAD — escultura à mão: pincel que adiciona, tira ou suaviza a superfície externa da coroa.
 *
 * Só os vértices da superfície externa se movem: a ligação entre os triângulos não muda, e a coroa
 * continua fechada. A linha de margem e o lado de dentro ficam parados, o pincel para na espessura
 * mínima e cada traço pode ser desfeito. Sem DOM: os testes usam a mesma classe.
 */
import { Bvh, cross, dot, mul, norma, passoSuave, soma, sub, unit, vert, type Malha, type V3 } from './geo';
import type { DadosDaEscultura, Relatorio, ResultadoCoroa } from './coroa';

export type ModoPincel = 'adicionar' | 'tirar' | 'suavizar';

export interface OpcoesPincel {
  modo: ModoPincel;
  /** Raio do pincel, em mm. */
  raio: number;
  /** De 0 a 1. */
  forca: number;
}

/** O que a tela precisa trocar na malha que está desenhando. */
export interface MudancaDaMalha {
  idx: Uint32Array;
  pos: Float32Array;
  nor: Float32Array;
}

export interface RespostaDoPincel {
  mudanca: MudancaDaMalha | null;
  /** Onde o pincel está sobre a coroa, para desenhar o anel. */
  centro: V3 | null;
  normal: V3 | null;
}

export interface FimDoTraco {
  /** Quantos traços ainda podem ser desfeitos. */
  tracos: number;
  noLimite: boolean;
}

export interface MedidasDaCoroa {
  espessura: Float32Array;
  folgaAntagonista: Float32Array;
  folgaVizinho: Float32Array;
  relatorio: Relatorio;
  entrouNoVizinho: boolean;
  entrouNoAntagonista: boolean;
}

/** Até aqui da margem nada se move; a partir daqui o pincel age por inteiro. */
const MARGEM_PARADA = 0.1;
const MARGEM_LIVRE = 0.8;
const MAX_DESFAZER = 30;
/** Quanto a superfície pode sair de onde a coroa nasceu: longe do preparo, nada mais a seguraria. */
const MUDANCA_MAXIMA = 3;
/** Distância entre um toque e o seguinte, em frações do raio: a quantidade não depende da velocidade. */
const ESPACO_ENTRE_TOQUES = 0.15;
const PASSO_MINIMO = 0.01;
const PASSO_POR_FORCA = 0.06;
/** Abaixo disto é o contato normal; a partir daqui, a coroa está mesmo entrando no outro dente. */
const ENTROU = -0.05;
/** Menos pontos que isto é ruído da medida, não invasão. */
const PONTOS_PARA_AVISAR = 20;

interface Traco {
  idx: Uint32Array;
  pos: Float64Array;
}

/** Lista por vértice em duas tabelas: em cada vértice, onde começa e onde termina. */
function tabela(n: number, contar: (somar: (v: number) => void) => void, preencher: (por: (v: number, x: number) => void) => void) {
  const ini = new Uint32Array(n + 1);
  contar((v) => {
    if (v < n) ini[v + 1]++;
  });
  for (let v = 0; v < n; v++) ini[v + 1] += ini[v];
  const lista = new Uint32Array(ini[n]);
  const cursor = ini.slice(0, n);
  preencher((v, x) => {
    if (v < n) lista[cursor[v]++] = x;
  });
  return { ini, lista };
}

export class Escultor {
  private readonly pos: Float64Array;
  private readonly externos: number;
  private readonly superficie: Malha;
  private readonly bvh: Bvh;
  private readonly dados: DadosDaEscultura;
  private readonly origem: Float64Array;
  private readonly mobilidade: Float32Array;
  /** Menor espessura que este vértice pode ter. */
  private readonly piso: Float32Array;
  /** Limite por baixo da espessura atual: só mede de novo quando pode ter passado do piso. */
  private readonly cota: Float32Array;
  private readonly triDe: { ini: Uint32Array; lista: Uint32Array };
  private readonly vizDe: { ini: Uint32Array; lista: Uint32Array };
  private readonly marca: Uint32Array;
  private carimbo = 0;
  private readonly noTraco: Uint8Array;
  /** Quem já parou na espessura neste traço: não precisa medir de novo a cada toque. */
  private readonly parado: Uint8Array;
  private readonly antes: Float64Array;
  private tocadosNoTraco: number[] = [];
  private readonly pilha: Traco[] = [];
  private readonly aMedir: Uint8Array;
  private pendentes: number[] = [];
  private ultimo: V3 | null = null;
  private bateuNoLimite = false;
  private readonly baseVizinho: number;
  private readonly baseAntagonista: number;

  constructor(private readonly coroa: ResultadoCoroa) {
    const { malha, externos, escultura } = coroa;
    this.dados = escultura;
    this.pos = malha.pos;
    this.externos = externos;
    this.origem = malha.pos.slice(0, externos * 3);
    // Só a superfície externa: a margem entra como borda parada.
    const tri: number[] = [];
    for (let t = 0; t < malha.tri.length; t += 3) {
      const a = malha.tri[t];
      const b = malha.tri[t + 1];
      const c = malha.tri[t + 2];
      if (Math.max(a, b, c) < escultura.fimDaSuperficie) tri.push(a, b, c);
    }
    this.superficie = { pos: malha.pos, tri: Uint32Array.from(tri) };
    this.bvh = new Bvh(this.superficie);

    this.mobilidade = new Float32Array(externos);
    this.piso = new Float32Array(externos);
    this.cota = new Float32Array(externos);
    for (let v = 0; v < externos; v++) {
      this.mobilidade[v] = passoSuave(MARGEM_PARADA, MARGEM_LIVRE, escultura.distanciaDaMargem[v]);
      const e = coroa.espessura[v];
      const atual = Number.isNaN(e) ? escultura.pedida[v] : e;
      // Onde a coroa já nasceu mais fina que o pedido, o pincel não engrossa sozinho.
      this.piso[v] = Math.min(escultura.pedida[v], atual);
      this.cota[v] = atual;
    }

    const t3 = this.superficie.tri;
    this.triDe = tabela(
      externos,
      (somar) => t3.forEach((v) => somar(v)),
      (por) => {
        for (let t = 0; t < t3.length; t += 3) for (let k = 0; k < 3; k++) por(t3[t + k], t);
      },
    );
    this.vizDe = tabela(
      externos,
      (somar) => t3.forEach((v) => {
        somar(v);
        somar(v);
      }),
      (por) => {
        for (let t = 0; t < t3.length; t += 3) {
          for (let k = 0; k < 3; k++) {
            por(t3[t + k], t3[t + ((k + 1) % 3)]);
            por(t3[t + k], t3[t + ((k + 2) % 3)]);
          }
        }
      },
    );
    this.marca = new Uint32Array(externos);
    this.noTraco = new Uint8Array(externos);
    this.parado = new Uint8Array(externos);
    this.aMedir = new Uint8Array(externos);
    this.antes = new Float64Array(externos * 3);
    this.baseVizinho = this.contarAbaixo(coroa.folgaVizinho);
    this.baseAntagonista = this.contarAbaixo(coroa.folgaAntagonista);
  }

  private contarAbaixo(campo: Float32Array): number {
    let q = 0;
    for (let v = 0; v < this.externos; v++) if (campo[v] < ENTROU) q++;
    return q;
  }

  /** Onde o raio toca a coroa, sem mexer em nada. */
  mira(o: V3, d: V3): { centro: V3; normal: V3 } | null {
    const h = this.bvh.raio(o, d);
    return h ? { centro: h.ponto, normal: h.normal } : null;
  }

  iniciar(): void {
    this.ultimo = null;
    this.bateuNoLimite = false;
  }

  /** Aplica o pincel em cada raio. O traço só acaba em `terminar`. */
  pincelar(raios: readonly (readonly [V3, V3])[], op: OpcoesPincel): RespostaDoPincel {
    const tocados: number[] = [];
    this.carimbo++;
    let centro: V3 | null = null;
    let normal: V3 | null = null;
    for (const [o, d] of raios) {
      const h = this.bvh.raio(o, d);
      if (!h) continue;
      centro = h.ponto;
      normal = h.normal;
      if (this.ultimo && norma(sub(h.ponto, this.ultimo)) < op.raio * ESPACO_ENTRE_TOQUES) continue;
      this.ultimo = h.ponto;
      this.aplicar(h.ponto, h.normal, op, tocados);
      // O próximo raio precisa achar a superfície onde ela está agora.
      this.bvh.ajustarCaixas();
    }
    if (!tocados.length) return { mudanca: null, centro, normal };
    return { mudanca: this.refazerNormais(tocados), centro, normal };
  }

  private guardar(v: number): void {
    if (this.noTraco[v]) return;
    this.noTraco[v] = 1;
    for (let k = 0; k < 3; k++) this.antes[3 * v + k] = this.pos[3 * v + k];
    this.tocadosNoTraco.push(v);
  }

  private aplicar(c: V3, nC: V3, op: OpcoesPincel, tocados: number[]): void {
    const p = this.pos;
    const nrm = this.bvh.normais;
    const r2 = op.raio * op.raio;
    const sel: number[] = [];
    const peso: number[] = [];
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let v = 0; v < this.externos; v++) {
      const dx = p[3 * v] - c[0];
      if (dx > op.raio || dx < -op.raio) continue;
      const dy = p[3 * v + 1] - c[1];
      const dz = p[3 * v + 2] - c[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      // A outra face de uma cúspide fina está perto, mas não é a que o técnico está tocando.
      // O efeito some aos poucos: um corte seco deixaria um degrau na crista.
      const voltada = nrm[3 * v] * nC[0] + nrm[3 * v + 1] * nC[1] + nrm[3 * v + 2] * nC[2];
      if (voltada <= 0) continue;
      const q = 1 - d2 / r2;
      const f = q * q * passoSuave(0, 0.35, voltada);
      nx += f * nrm[3 * v];
      ny += f * nrm[3 * v + 1];
      nz += f * nrm[3 * v + 2];
      const w = f * this.mobilidade[v];
      if (w <= 0) continue;
      sel.push(v);
      peso.push(w);
    }
    if (!sel.length) return;
    for (const v of sel) {
      this.guardar(v);
      if (this.marca[v] !== this.carimbo) {
        this.marca[v] = this.carimbo;
        tocados.push(v);
      }
    }
    if (op.modo === 'suavizar') {
      this.suavizar(sel, peso, op.forca);
      return;
    }
    const direcao = unit([nx, ny, nz]);
    const tirando = op.modo === 'tirar';
    const passo = (tirando ? -1 : 1) * (PASSO_MINIMO + PASSO_POR_FORCA * op.forca);
    for (let k = 0; k < sel.length; k++) {
      const v = sel[k];
      if (tirando && this.parado[v]) continue;
      const s = passo * peso[k];
      const x0 = p[3 * v];
      const y0 = p[3 * v + 1];
      const z0 = p[3 * v + 2];
      p[3 * v] = x0 + s * direcao[0];
      p[3 * v + 1] = y0 + s * direcao[1];
      p[3 * v + 2] = z0 + s * direcao[2];
      this.cota[v] -= Math.abs(s);
      // Adicionar afasta do preparo: só tirar pode passar da espessura.
      if (tirando) this.pararNaEspessura(v, x0, y0, z0);
      this.pararNaMudancaMaxima(v);
    }
  }

  /** Várias passadas curtas: a malha é fina, e uma só quase não mudaria o relevo. */
  private suavizar(sel: number[], peso: number[], forca: number): void {
    const p = this.pos;
    const { ini, lista } = this.vizDe;
    const inicio = new Float64Array(sel.length * 3);
    sel.forEach((v, k) => {
      for (let e = 0; e < 3; e++) inicio[3 * k + e] = p[3 * v + e];
    });
    const novo = new Float64Array(sel.length * 3);
    const passadas = Math.round(4 + 36 * forca);
    for (let it = 0; it < passadas; it++) {
      for (let k = 0; k < sel.length; k++) {
        const v = sel[k];
        let x = 0;
        let y = 0;
        let z = 0;
        for (let i = ini[v]; i < ini[v + 1]; i++) {
          const q = lista[i];
          x += p[3 * q];
          y += p[3 * q + 1];
          z += p[3 * q + 2];
        }
        const n = ini[v + 1] - ini[v] || 1;
        const w = 0.5 * peso[k];
        novo[3 * k] = p[3 * v] + w * (x / n - p[3 * v]);
        novo[3 * k + 1] = p[3 * v + 1] + w * (y / n - p[3 * v + 1]);
        novo[3 * k + 2] = p[3 * v + 2] + w * (z / n - p[3 * v + 2]);
      }
      for (let k = 0; k < sel.length; k++) for (let e = 0; e < 3; e++) p[3 * sel[k] + e] = novo[3 * k + e];
    }
    for (let k = 0; k < sel.length; k++) {
      const v = sel[k];
      const x0 = inicio[3 * k];
      const y0 = inicio[3 * k + 1];
      const z0 = inicio[3 * k + 2];
      this.cota[v] -= Math.hypot(p[3 * v] - x0, p[3 * v + 1] - y0, p[3 * v + 2] - z0);
      // Saindo para fora, a espessura só aumenta.
      const nrm = this.bvh.normais;
      const saindo = (p[3 * v] - x0) * nrm[3 * v] + (p[3 * v + 1] - y0) * nrm[3 * v + 1] + (p[3 * v + 2] - z0) * nrm[3 * v + 2] >= 0;
      if (!saindo && this.parado[v]) {
        // Já parou na espessura neste traço: não precisa medir de novo a cada toque.
        p[3 * v] = x0;
        p[3 * v + 1] = y0;
        p[3 * v + 2] = z0;
      } else if (!saindo) {
        this.pararNaEspessura(v, x0, y0, z0);
      }
      this.pararNaMudancaMaxima(v);
    }
  }

  /**
   * Mede só quem pode ter passado do piso. Quem passou volta pelo próprio caminho, nunca além de
   * onde estava: puxar para o ponto mais perto do preparo empilharia vértices no mesmo lugar.
   */
  private pararNaEspessura(v: number, x0: number, y0: number, z0: number): void {
    if (this.cota[v] >= this.piso[v]) return;
    const q = vert(this.superficie, v);
    const c = this.dados.troquel.proximo(q, 2);
    if (!c) {
      this.cota[v] = 2;
      return;
    }
    if (c.d >= this.piso[v]) {
      this.cota[v] = c.d;
      return;
    }
    const mov: V3 = [q[0] - x0, q[1] - y0, q[2] - z0];
    const tamanho = norma(mov);
    this.cota[v] = this.piso[v];
    this.parado[v] = 1;
    this.bateuNoLimite = true;
    if (tamanho < 1e-9) return;
    const reta = Math.max(0.3, Math.abs(dot(mov, c.normal)) / tamanho);
    const volta = Math.min(1, (this.piso[v] - c.d) / reta / tamanho);
    for (let e = 0; e < 3; e++) this.pos[3 * v + e] = q[e] - volta * mov[e];
    // Perto de uma quina do preparo a conta acima é só uma estimativa: se ainda passou, nem sai do lugar.
    const depois = this.dados.troquel.proximo(vert(this.superficie, v), 2);
    if (depois && depois.d < this.piso[v] - 0.005) {
      this.pos[3 * v] = x0;
      this.pos[3 * v + 1] = y0;
      this.pos[3 * v + 2] = z0;
    }
  }

  private pararNaMudancaMaxima(v: number): void {
    const dx = this.pos[3 * v] - this.origem[3 * v];
    const dy = this.pos[3 * v + 1] - this.origem[3 * v + 1];
    const dz = this.pos[3 * v + 2] - this.origem[3 * v + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d <= MUDANCA_MAXIMA) return;
    const f = MUDANCA_MAXIMA / d;
    this.pos[3 * v] = this.origem[3 * v] + f * dx;
    this.pos[3 * v + 1] = this.origem[3 * v + 1] + f * dy;
    this.pos[3 * v + 2] = this.origem[3 * v + 2] + f * dz;
    this.bateuNoLimite = true;
  }

  /** Normais dos vértices mexidos e dos vizinhos deles, e o que a tela precisa redesenhar. */
  private refazerNormais(tocados: ArrayLike<number>): MudancaDaMalha {
    this.carimbo++;
    const afetados: number[] = [];
    const incluir = (v: number) => {
      if (v < this.externos && this.marca[v] !== this.carimbo) {
        this.marca[v] = this.carimbo;
        afetados.push(v);
      }
    };
    const { ini, lista } = this.vizDe;
    for (let t = 0; t < tocados.length; t++) {
      const v = tocados[t];
      incluir(v);
      for (let i = ini[v]; i < ini[v + 1]; i++) incluir(lista[i]);
    }
    const t3 = this.superficie.tri;
    const nrm = this.bvh.normais;
    const { ini: iniT, lista: listaT } = this.triDe;
    const idx = new Uint32Array(afetados.length);
    const pos = new Float32Array(afetados.length * 3);
    const nor = new Float32Array(afetados.length * 3);
    afetados.forEach((v, k) => {
      let n: V3 = [0, 0, 0];
      for (let i = iniT[v]; i < iniT[v + 1]; i++) {
        const t = listaT[i];
        const a = vert(this.superficie, t3[t]);
        const b = vert(this.superficie, t3[t + 1]);
        const c = vert(this.superficie, t3[t + 2]);
        n = soma(n, cross(sub(b, a), sub(c, a)));
      }
      const u = norma(n) > 0 ? unit(n) : mul([nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]], 1);
      for (let e = 0; e < 3; e++) {
        nrm[3 * v + e] = u[e];
        nor[3 * k + e] = u[e];
        pos[3 * k + e] = this.pos[3 * v + e];
      }
      idx[k] = v;
    });
    return { idx, pos, nor };
  }

  private marcarParaMedir(vertices: ArrayLike<number>): void {
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      if (!this.aMedir[v]) {
        this.aMedir[v] = 1;
        this.pendentes.push(v);
      }
    }
  }

  /** Fecha o traço: guarda para desfazer. Medir fica para a pausa. Null se o pincel não tocou em nada. */
  terminar(): FimDoTraco | null {
    const tocados = this.tocadosNoTraco;
    this.tocadosNoTraco = [];
    this.ultimo = null;
    if (!tocados.length) return null;
    const pos = new Float64Array(tocados.length * 3);
    tocados.forEach((v, k) => {
      this.noTraco[v] = 0;
      this.parado[v] = 0;
      for (let e = 0; e < 3; e++) pos[3 * k + e] = this.antes[3 * v + e];
    });
    this.pilha.push({ idx: Uint32Array.from(tocados), pos });
    if (this.pilha.length > MAX_DESFAZER) this.pilha.shift();
    this.marcarParaMedir(tocados);
    this.bvh.ajustarCaixas();
    return { tracos: this.pilha.length, noLimite: this.bateuNoLimite };
  }

  /** Volta o último traço, exatamente como estava. */
  desfazer(): { mudanca: MudancaDaMalha; tracos: number } | null {
    // Com traço aberto, o que há para guardar ainda não está fechado.
    if (this.tocadosNoTraco.length) return null;
    const t = this.pilha.pop();
    if (!t) return null;
    t.idx.forEach((v, k) => {
      for (let e = 0; e < 3; e++) this.pos[3 * v + e] = t.pos[3 * k + e];
      // A espessura real volta a ser medida antes de confiar na cota.
      this.cota[v] = -Infinity;
    });
    this.bvh.ajustarCaixas();
    this.marcarParaMedir(t.idx);
    return { mudanca: this.refazerNormais(t.idx), tracos: this.pilha.length };
  }

  /**
   * Mede de novo por no máximo `tempoMs` e volta, para o próximo traço não ficar esperando.
   * Devolve null enquanto houver ponto para medir; no fim, as medidas e o relatório.
   */
  medirUmPouco(tempoMs = 80): MedidasDaCoroa | null {
    const fim = Date.now() + tempoMs;
    while (this.pendentes.length) {
      for (let i = 0; i < 200 && this.pendentes.length; i++) {
        const v = this.pendentes.pop() as number;
        this.aMedir[v] = 0;
        this.dados.medir(v);
      }
      if (Date.now() >= fim && this.pendentes.length) return null;
    }
    const { coroa } = this;
    return {
      espessura: coroa.espessura.slice(),
      folgaAntagonista: coroa.folgaAntagonista.slice(),
      folgaVizinho: coroa.folgaVizinho.slice(),
      relatorio: this.dados.relatorio(this.bvh.normais),
      entrouNoVizinho: this.contarAbaixo(coroa.folgaVizinho) >= this.baseVizinho + PONTOS_PARA_AVISAR,
      entrouNoAntagonista: this.contarAbaixo(coroa.folgaAntagonista) >= this.baseAntagonista + PONTOS_PARA_AVISAR,
    };
  }

  get tracos(): number {
    return this.pilha.length;
  }
}
