/**
 * Passos CAD — o caso aberto: arcos, preparo, margem, anatomia e coroa. É o que o worker
 * guarda entre um pedido e outro. Sem DOM: os testes usam a mesma classe.
 */
import { lerMalha, escreverStl } from './arquivos';
import { Bvh, centroide, cross, dot, norma, recortarCaixa, sub, unit, vert, type Malha, type V3 } from './geo';
import { acharPreparo, proporMargem, type PontoMargem, type Preparo } from './margem';
import {
  anatomiaNoLugar,
  arcoSemTroquel,
  construirCoroa,
  eixosDoDente,
  posicionarAutomatico,
  type Ajuste,
  type EntradaCoroa,
  type Eixos,
  type Parametros,
  type Relatorio,
  type ResultadoCoroa,
} from './coroa';

export interface ResumoDente {
  a: V3;
  O: V3;
  mesial: V3;
  vestibular: V3;
  margem: V3[];
}

export interface ResumoCoroa {
  malha: Malha;
  espessura: Float32Array;
  folgaAntagonista: Float32Array;
  folgaVizinho: Float32Array;
  externos: number;
  relatorio: Relatorio;
}

function normalDaRegiao(m: Malha, centro: V3, lado: V3): V3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let t = 0; t < m.tri.length; t += 3) {
    const A = vert(m, m.tri[t]);
    if (norma(sub(A, centro)) > 9) continue;
    const n = cross(sub(vert(m, m.tri[t + 1]), A), sub(vert(m, m.tri[t + 2]), A));
    if (dot(n, lado) > 0) {
      x += n[0];
      y += n[1];
      z += n[2];
    }
  }
  return norma([x, y, z]) > 0 ? unit([x, y, z]) : lado;
}

const RAIO_DO_CASO = 13;
const RAIO_DO_ANTAGONISTA = 20;

export class Sessao {
  /** Resolução da grade: os padrões do motor valem na tela; os testes usam uma menor. */
  constructor(private readonly grade: { meridianos?: number; linhas?: number } = {}) {}

  private arco: Malha | null = null;
  private arcoB: Bvh | null = null;
  private antagonista: Malha | null = null;
  private recorte: Malha | null = null;
  private recorteB: Bvh | null = null;
  private antB: Bvh | null = null;
  private ambiente: Bvh | null = null;
  private prep: Preparo | null = null;
  private margem: PontoMargem[] | null = null;
  private eixos: Eixos | null = null;
  private fdi = 0;
  private anatomia: Malha | null = null;
  private parametros: Parametros | null = null;
  private coroa: ResultadoCoroa | null = null;

  abrirArco(nome: string, buf: ArrayBuffer): Malha {
    this.arco = lerMalha(nome, buf);
    this.arcoB = new Bvh(this.arco);
    this.recorte = null;
    this.prep = null;
    this.margem = null;
    this.coroa = null;
    return this.arco;
  }

  abrirAntagonista(nome: string, buf: ArrayBuffer): Malha {
    this.antagonista = lerMalha(nome, buf);
    this.antB = null;
    return this.antagonista;
  }

  temAntagonista(): boolean {
    return this.antagonista !== null;
  }

  /** Ponto do arco sob o raio do clique. */
  apontar(o: V3, d: V3): { ponto: V3; normal: V3 } | null {
    const h = this.arcoB?.raio(o, d);
    return h ? { ponto: h.ponto, normal: h.normal } : null;
  }

  /** Clique no preparo: acha eixo, direções e propõe a margem. */
  abrirDente(fdi: number, clique: V3, normalDoClique: V3): ResumoDente {
    if (!this.arco) throw new Error('Abra a arcada primeiro.');
    this.fdi = fdi;
    this.recorte = recortarCaixa(this.arco, clique, RAIO_DO_CASO);
    this.recorteB = new Bvh(this.recorte);
    // Sem antagonista, a referência da arcada é a superfície em volta do clique.
    let lado = normalDaRegiao(this.recorte, clique, normalDoClique);
    if (this.antagonista) {
      const ant = recortarCaixa(this.antagonista, clique, RAIO_DO_ANTAGONISTA);
      this.antB = ant.tri.length ? new Bvh(ant) : null;
      if (this.antB) lado = unit(sub(centroide(ant.pos), clique));
    }
    this.prep = acharPreparo(this.recorteB, clique, lado);
    this.eixos = eixosDoDente(this.prep, fdi, this.recorte, centroide(this.arco.pos));
    return this.proporMargem([]);
  }

  proporMargem(fixos: V3[]): ResumoDente {
    if (!this.recorteB || !this.prep || !this.eixos || !this.recorte) throw new Error('Clique no preparo primeiro.');
    this.margem = proporMargem(this.recorteB, this.prep, { fixos, meridianos: this.grade.meridianos });
    this.ambiente = new Bvh(arcoSemTroquel(this.recorte, this.prep, this.margem));
    this.coroa = null;
    return {
      a: this.prep.a,
      O: this.prep.O,
      mesial: this.eixos.mesial,
      vestibular: this.eixos.vestibular,
      margem: this.margem.map((m) => m.ponto),
    };
  }

  private entrada(p: Parametros): EntradaCoroa {
    if (!this.recorteB || !this.prep || !this.margem || !this.eixos || !this.anatomia) throw new Error('Faltam o preparo, a margem ou a anatomia.');
    return {
      arco: this.recorteB,
      antagonista: this.antB,
      vizinhos: null,
      prep: this.prep,
      margem: this.margem,
      eixos: this.eixos,
      anatomia: this.anatomia,
      parametros: p,
    };
  }

  /** Abre o dente da biblioteca e calcula a posição automática. */
  abrirAnatomia(nome: string, buf: ArrayBuffer, p: Parametros): { ajuste: Ajuste; malha: Malha } {
    const anterior = this.anatomia;
    this.anatomia = lerMalha(nome, buf);
    try {
      const e = this.entrada(p);
      const ajuste = posicionarAutomatico(e, this.ambiente as Bvh);
      const malha = anatomiaNoLugar(e, ajuste);
      this.parametros = p;
      return { ajuste, malha };
    } catch (erro) {
      // A tela continua com o dente anterior: o motor também.
      this.anatomia = anterior;
      throw erro;
    }
  }

  reposicionar(p: Parametros): { ajuste: Ajuste; malha: Malha } {
    const e = this.entrada(p);
    const ajuste = posicionarAutomatico(e, this.ambiente as Bvh);
    return { ajuste, malha: anatomiaNoLugar(e, ajuste) };
  }

  moverAnatomia(aj: Ajuste, p: Parametros): Malha {
    return anatomiaNoLugar(this.entrada(p), aj);
  }

  construir(aj: Ajuste, p: Parametros): ResumoCoroa {
    this.parametros = p;
    this.coroa = construirCoroa(this.entrada(p), this.ambiente as Bvh, aj, this.grade.linhas);
    const c = this.coroa;
    return { malha: c.malha, espessura: c.espessura, folgaAntagonista: c.folgaAntagonista, folgaVizinho: c.folgaVizinho, externos: c.externos, relatorio: c.relatorio };
  }

  exportarStl(): ArrayBuffer {
    if (!this.coroa) throw new Error('Gere a coroa primeiro.');
    return escreverStl(this.coroa.malha, `coroa ${this.fdi}`);
  }
}
