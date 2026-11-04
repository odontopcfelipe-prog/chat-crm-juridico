/**
 * Passos CAD — desenho da coroa unitária.
 *
 * As duas superfícies são amostradas em leque a partir do ponto O dentro do troquel, por
 * meridiano θ e ângulo φ. Externa e interna usam a mesma grade e têm a mesma última linha, a
 * margem: por isso a coroa sai fechada por construção.
 *
 * A anatomia vem nos eixos das bibliotecas: x = mesial, y = vestibular, z = oclusal. Levar
 * esses eixos para (mesial, vestibular, oclusal) do caso já acerta o lado do arco: nos
 * quadrantes 2 e 4 essa troca espelha o dente, que é o correto.
 */
import { compensarFresa } from './fresa';
import { Bvh, centroide, conferirMalha, cross, dot, filtrarTriangulos, malhaDaGrade, mul, norma, normaisDeVertice, passoSuave, soma, sub, unit, vert, type Conferencia, type Malha, type V3 } from './geo';
import { direcao, type PontoMargem, type Preparo } from './margem';

const GRAU = Math.PI / 180;

export interface Parametros {
  /** Espaço de cimento (mm). */
  cimento: number;
  /** Distância da margem onde o cimento começa (mm). */
  inicioCimento: number;
  /** Espessura mínima do material até o lado de dentro (mm). */
  espessuraMinima: number;
  /** Folga até o antagonista (mm). */
  folgaAntagonista: number;
  /** Folga até o vizinho (mm); 0 = contato justo. */
  folgaVizinho: number;
  /** Inclinação da saída da margem, em relação ao eixo (graus). */
  emergencia: number;
  /** Diâmetro da menor broca que entra no lado de dentro (mm); 0 = sem compensação. */
  diametroBroca: number;
}

export const PARAMETROS_PADRAO: Parametros = Object.freeze({
  cimento: 0.08,
  inicioCimento: 1,
  espessuraMinima: 0.6,
  folgaAntagonista: 0.1,
  folgaVizinho: 0,
  emergencia: 12,
  diametroBroca: 1.2,
});

/** Posição da anatomia sobre o preparo. */
export interface Ajuste {
  escalaMD: number;
  escalaVL: number;
  escalaAltura: number;
  deslocMesial: number;
  deslocVestibular: number;
  deslocOclusal: number;
  giro: number;
}

export interface Eixos {
  mesial: V3;
  vestibular: V3;
}

/**
 * Mesial e vestibular a partir do número FDI e do centro do arco. Vestibular aponta para
 * fora do arco. Trio (mesial, vestibular, oclusal): destro nos quadrantes 1 e 3, canhoto nos
 * quadrantes 2 e 4 (conferido contra os eixos gravados por outro CAD num caso real).
 */
export function eixosDoDente(prep: Preparo, fdi: number, arco: Malha, centroDoArco: V3): Eixos {
  const q = Math.floor(fdi / 10);
  const fora = sub(prep.O, centroDoArco);
  // Tangente do arco: direção em que os dentes em volta se estendem (só o alto, sem o palato).
  const R = 11;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let v = 0; v < arco.pos.length / 3; v++) {
    const d = sub(vert(arco, v), prep.O);
    if (dot(d, prep.a) < -1.5) continue;
    const x = dot(d, prep.e1);
    const y = dot(d, prep.e2);
    if (x * x + y * y > R * R) continue;
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
  const tangente = soma(mul(prep.e1, Math.cos(ang)), mul(prep.e2, Math.sin(ang)));
  let vest = unit(cross(prep.a, tangente));
  if (dot(vest, fora) < 0) vest = mul(vest, -1);
  const s = q === 1 || q === 3 ? 1 : -1;
  return { mesial: mul(unit(cross(vest, prep.a)), s), vestibular: vest };
}

export interface EntradaCoroa {
  arco: Bvh;
  antagonista: Bvh | null;
  /** Coroas vizinhas já desenhadas, quando os vizinhos também estão preparados. */
  vizinhos: Bvh | null;
  prep: Preparo;
  margem: PontoMargem[];
  eixos: Eixos;
  anatomia: Malha;
  parametros: Parametros;
}

const ALTURA_MIN_CONTATO = 0.8;
const BORDA_DO_CILINDRO = 1.5;

/** Arco sem o troquel: o que sobra são vizinhos e gengiva. */
export function arcoSemTroquel(arco: Malha, prep: Preparo, margem: PontoMargem[]): Malha {
  const NT = margem.length;
  const alt = margem.map((m) => dot(sub(m.ponto, prep.O), prep.a));
  const raio = margem.map((m) => {
    const v = sub(m.ponto, prep.O);
    return norma(sub(v, mul(prep.a, dot(v, prep.a))));
  });
  return filtrarTriangulos(arco, (a, b, c) => {
    const cen = mul(soma(soma(a, b), c), 1 / 3);
    const v = sub(cen, prep.O);
    const h = dot(v, prep.a);
    const lado = sub(v, mul(prep.a, h));
    const th = (Math.atan2(dot(lado, prep.e2), dot(lado, prep.e1)) + 2 * Math.PI) % (2 * Math.PI);
    const i = Math.round((th / (2 * Math.PI)) * NT) % NT;
    if (!(h > alt[i] - 0.2 && norma(lado) < raio[i] + 0.25)) return true;
    // Dentro do cilindro da margem pode estar o vizinho que avança sobre ela. A parede do troquel
    // olha para fora de O; a do vizinho olha para O. Sem ela, a coroa entraria no dente ao lado.
    // Só na borda do cilindro: no meio dele, face que olha para O é fossa do próprio preparo.
    return h > alt[i] + ALTURA_MIN_CONTATO && norma(lado) > raio[i] - BORDA_DO_CILINDRO && dot(cross(sub(b, a), sub(c, a)), v) < 0;
  });
}

interface CaixaLocal {
  cx: number;
  cy: number;
  md: number;
  vl: number;
  zMin: number;
  zMax: number;
}

function caixaDaAnatomia(m: Malha): CaixaLocal {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pos.length; i++) {
    const e = i % 3;
    mn[e] = Math.min(mn[e], m.pos[i]);
    mx[e] = Math.max(mx[e], m.pos[i]);
  }
  return { cx: (mn[0] + mx[0]) / 2, cy: (mn[1] + mx[1]) / 2, md: mx[0] - mn[0], vl: mx[1] - mn[1], zMin: mn[2], zMax: mx[2] };
}

/** Anatomia no lugar: uma função pura de (ajuste) → ponto do caso. */
export function transformador(e: EntradaCoroa, aj: Ajuste): (x: number, y: number, z: number) => V3 {
  const cx = caixaDaAnatomia(e.anatomia);
  const base = centroide(e.margem.flatMap((m) => [...m.ponto]));
  const cos = Math.cos(aj.giro * GRAU);
  const sen = Math.sin(aj.giro * GRAU);
  const { mesial: m, vestibular: b } = e.eixos;
  const a = e.prep.a;
  return (x, y, z) => {
    const px = aj.escalaMD * (x - cx.cx);
    const py = aj.escalaVL * (y - cx.cy);
    const rx = cos * px - sen * py + aj.deslocMesial;
    const ry = sen * px + cos * py + aj.deslocVestibular;
    return soma(soma(soma(base, mul(m, rx)), mul(b, ry)), mul(a, aj.escalaAltura * z + aj.deslocOclusal));
  };
}

export function anatomiaNoLugar(e: EntradaCoroa, aj: Ajuste): Malha {
  const f = transformador(e, aj);
  const n = e.anatomia.pos.length / 3;
  const pos = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) pos.set(f(e.anatomia.pos[3 * v], e.anatomia.pos[3 * v + 1], e.anatomia.pos[3 * v + 2]), 3 * v);
  // Espelhou (quadrantes 2 e 4)? Inverte o sentido dos triângulos para as normais seguirem para fora.
  const mao = dot(cross(e.eixos.mesial, e.eixos.vestibular), e.prep.a);
  if (mao > 0) return { pos, tri: e.anatomia.tri };
  const tri = new Uint32Array(e.anatomia.tri.length);
  for (let t = 0; t < tri.length; t += 3) {
    tri[t] = e.anatomia.tri[t];
    tri[t + 1] = e.anatomia.tri[t + 2];
    tri[t + 2] = e.anatomia.tri[t + 1];
  }
  return { pos, tri };
}

/** Espaço livre até os vizinhos, medido do eixo do dente nos dois sentidos. */
function espacoEntreVizinhos(e: EntradaCoroa, ambiente: Bvh, base: V3, mdMargem: number): { mais: number; menos: number } | null {
  const { mesial: m, vestibular: b } = e.eixos;
  const a = e.prep.a;
  const topo = dot(sub(e.prep.topo, base), a);
  const limite = mdMargem * 1.1;
  let mais = Infinity;
  let menos = Infinity;
  for (const lateral of [-1.5, 0, 1.5]) {
    // Na altura do contato: mais baixo, o que está perto é a papila ou o colo do vizinho.
    for (let h = ALTURA_DO_CONTATO; h <= topo + 1.5; h += 0.5) {
      const o = soma(soma(base, mul(b, lateral)), mul(a, h));
      const f = ambiente.raio(o, m, limite);
      const t = ambiente.raio(o, mul(m, -1), limite);
      if (f) mais = Math.min(mais, f.t);
      if (t) menos = Math.min(menos, t.t);
    }
  }
  return mais < Infinity && menos < Infinity ? { mais, menos } : null;
}

/**
 * Posição automática: escala pelo espaço entre os vizinhos (ou pela margem, sem vizinhos),
 * depois a posição e o giro que dão mais contatos com o antagonista, e a altura.
 */
export function posicionarAutomatico(e: EntradaCoroa, ambiente: Bvh): Ajuste {
  const cx = caixaDaAnatomia(e.anatomia);
  const { mesial: m, vestibular: b } = e.eixos;
  const a = e.prep.a;
  const base = centroide(e.margem.flatMap((p) => [...p.ponto]));
  const projM = e.margem.map((p) => dot(sub(p.ponto, base), m));
  const projB = e.margem.map((p) => dot(sub(p.ponto, base), b));
  const mdMargem = Math.max(...projM) - Math.min(...projM);
  const vlMargem = Math.max(...projB) - Math.min(...projB);
  const centroB = (Math.max(...projB) + Math.min(...projB)) / 2;
  const centroM = (Math.max(...projM) + Math.min(...projM)) / 2;
  const espaco = espacoEntreVizinhos(e, e.vizinhos ?? ambiente, base, mdMargem);
  const limitar = (s: number) => Math.min(1.5, Math.max(0.6, s));
  let escala: number;
  let deslocMesial = centroM;
  if (espaco) {
    escala = limitar((espaco.mais + espaco.menos + 0.1) / cx.md);
    deslocMesial = (espaco.mais - espaco.menos) / 2;
  } else {
    escala = limitar((mdMargem * 1.18) / cx.md);
  }
  const escalaVL = limitar(Math.max(escala, (vlMargem + 0.8) / cx.vl));
  const inicial: Ajuste = {
    escalaMD: escala,
    escalaVL,
    escalaAltura: escala,
    deslocMesial,
    deslocVestibular: centroB,
    deslocOclusal: 0,
    giro: 0,
  };
  const percentil = (v: number[], p: number) => [...v].sort((x, y) => x - y)[Math.floor(p * (v.length - 1))];

  // Amostra da face oclusal da anatomia.
  const n = e.anatomia.pos.length / 3;
  const passo = Math.max(1, Math.floor(n / 6000));
  const amostra: number[] = [];
  const paraCima = normaisDeVertice(e.anatomia);
  // Só a face oclusal: com as paredes na conta, o percentil deixaria a cúspide do antagonista afundar mais.
  for (let v = 0; v < n; v += passo) if (e.anatomia.pos[3 * v + 2] > cx.zMax - 3.5 && paraCima[3 * v + 2] > 0.5) amostra.push(v);
  // A espessura vem primeiro: mesmo com o antagonista perto, o dente não entra no preparo.
  // Percentil, porque o fundo dos sulcos e as paredes são corrigidos ponto a ponto depois.
  const pisoEspessura = (aj: Ajuste): number => {
    const alturas = amostraFolgaDoPreparo(e, aj, amostra);
    return alturas.length ? e.parametros.espessuraMinima - percentil(alturas, 0.1) : -Infinity;
  };
  if (!e.antagonista) {
    // Sem antagonista: a oclusal 2 mm acima do topo do preparo, ou o que a espessura pedir.
    const topo = dot(sub(e.prep.topo, base), a);
    return { ...inicial, deslocOclusal: Math.max(topo + 2 - inicial.escalaAltura * cx.zMax, pisoEspessura(inicial)) };
  }
  const ant = e.antagonista;
  const antes = 4;
  const nota = (aj: Ajuste): { nota: number; lift: number } => {
    const f = transformador(e, aj);
    const folgas: { g: number; x: number; y: number }[] = [];
    for (const v of amostra) {
      const x = e.anatomia.pos[3 * v];
      const y = e.anatomia.pos[3 * v + 1];
      const p = f(x, y, e.anatomia.pos[3 * v + 2]);
      const h = ant.raio(sub(p, mul(a, antes)), a, antes + 8);
      if (h) folgas.push({ g: h.t - antes, x: x - cx.cx, y: y - cx.cy });
    }
    if (folgas.length < 10) return { nota: -1e9, lift: 0 };
    // Percentil, não o mínimo: uma cúspide isolada do antagonista é cortada depois, não afunda o dente.
    const min = percentil(folgas.map((k) => k.g), 0.03);
    const quadrantes = new Set<string>();
    let perto = 0;
    for (const k of folgas) {
      if (k.g - min < 0.3) {
        perto++;
        quadrantes.add(`${k.x > 0}${k.y > 0}`);
      }
    }
    // Vários contatos espalhados valem mais; afastar muito do centro da margem vale menos.
    const fora = Math.hypot(aj.deslocMesial - inicial.deslocMesial, aj.deslocVestibular - inicial.deslocVestibular);
    // A parte da oclusal perto do antagonista (0 a 100), para o peso não depender do tamanho da malha.
    const parte = (100 * perto) / folgas.length;
    return { nota: parte * (1 + 0.5 * quadrantes.size) - 30 * fora - 1.5 * Math.abs(aj.giro), lift: min };
  };

  let melhor = inicial;
  let melhorNota = -Infinity;
  const testar = (dm: number, db: number, giro: number) => {
    const aj = { ...inicial, deslocMesial: inicial.deslocMesial + dm, deslocVestibular: inicial.deslocVestibular + db, giro };
    const r = nota(aj);
    if (r.nota > melhorNota) {
      melhorNota = r.nota;
      melhor = aj;
    }
  };
  for (const giro of [-12, -6, 0, 6, 12]) for (const dm of [-0.8, -0.4, 0, 0.4, 0.8]) for (const db of [-0.8, -0.4, 0, 0.4, 0.8]) testar(dm, db, giro);
  const c = melhor;
  for (const giro of [-3, 0, 3]) {
    for (const dm of [-0.2, 0, 0.2]) {
      for (const db of [-0.2, 0, 0.2]) {
        testar(c.deslocMesial - inicial.deslocMesial + dm, c.deslocVestibular - inicial.deslocVestibular + db, c.giro + giro);
      }
    }
  }
  // Sobe até invadir um pouco: o corte contra o antagonista transforma isso em contatos.
  const INVADIR = 0.2;
  return { ...melhor, deslocOclusal: Math.max(nota(melhor).lift + INVADIR, pisoEspessura(melhor)) };
}

/**
 * Altura de cada ponto da anatomia sobre o preparo, medida pelo eixo. Só os pontos que estão
 * mesmo sobre o preparo: fora da margem o raio de cima pegaria o dente vizinho, mais alto.
 */
function amostraFolgaDoPreparo(e: EntradaCoroa, aj: Ajuste, amostra: number[]): number[] {
  const f = transformador(e, aj);
  const { a, O, e1, e2 } = e.prep;
  const baixo = mul(a, -1);
  const NT = e.margem.length;
  const raios = e.margem.map((m) => {
    const v = sub(m.ponto, O);
    return norma(sub(v, mul(a, dot(v, a))));
  });
  const r: number[] = [];
  for (const v of amostra) {
    const p = f(e.anatomia.pos[3 * v], e.anatomia.pos[3 * v + 1], e.anatomia.pos[3 * v + 2]);
    const d = sub(p, O);
    const lado = sub(d, mul(a, dot(d, a)));
    const th = (Math.atan2(dot(lado, e2), dot(lado, e1)) + 2 * Math.PI) % (2 * Math.PI);
    if (norma(lado) > raios[Math.round((th / (2 * Math.PI)) * NT) % NT] - 0.3) continue;
    const h = e.arco.raio(soma(p, mul(a, 10)), baixo, 25);
    if (h) r.push(dot(sub(p, h.ponto), a));
  }
  return r;
}

/** O que o pincel precisa para mexer na superfície e medir de novo. */
export interface DadosDaEscultura {
  /** O lado de dentro, já com a compensação de fresa: daqui se mede a espessura. */
  dentro: Bvh;
  /** Vértices da superfície externa mais os da linha de margem, que vêm logo depois. */
  fimDaSuperficie: number;
  /** Por vértice externo: a espessura que o pincel não pode tirar. */
  pedida: Float32Array;
  /** Por vértice externo: quanto falta até a margem, descendo pela superfície. */
  distanciaDaMargem: Float32Array;
  /** Mede de novo espessura e folgas de um vértice. */
  medir: (v: number) => void;
  relatorio: (normais: Float64Array) => Relatorio;
}

export interface ResultadoCoroa {
  malha: Malha;
  /** Por vértice: até o preparo, até o antagonista, até o vizinho (NaN = sem dado). */
  espessura: Float32Array;
  folgaAntagonista: Float32Array;
  folgaVizinho: Float32Array;
  /** Por vértice: quanto a broca corta a mais no lado de dentro (0 no resto). */
  corteFresa: Float32Array;
  /** Quantos vértices são da superfície externa (os primeiros da malha). */
  externos: number;
  relatorio: Relatorio;
  escultura: DadosDaEscultura;
}

export interface Relatorio {
  malha: Conferencia;
  mdMm: number;
  vlMm: number;
  alturaMm: number;
  espessuraOclusal: { minimo: number; p5: number; mediana: number } | null;
  espessuraAxial: { minimo: number; p5: number; mediana: number } | null;
  regioesContatoAntagonista: number;
  regioesContatoVizinho: number;
  /** Pontos onde a espessura mínima e a folga do antagonista não cabem juntas. */
  conflitosEspessura: number;
  /** Pontos do preparo com retenção, preenchidos pelo lado de dentro. */
  retencoesPreenchidas: number;
  fresa: { diametro: number; pontos: number; maiorCorte: number };
}

function resumo(v: number[]): { minimo: number; p5: number; mediana: number } | null {
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 100) / 100;
  return { minimo: r(v[0]), p5: r(v[Math.floor(0.05 * v.length)]), mediana: r(v[v.length >> 1]) };
}

export function construirCoroa(e: EntradaCoroa, ambiente: Bvh, aj: Ajuste, J = 170): ResultadoCoroa {
  const { prep, margem, parametros: P } = e;
  const NT = margem.length;
  const a = prep.a;
  const O = prep.O;
  const ant = e.antagonista;
  const vizinhoExtra = e.vizinhos;
  const anat = new Bvh(anatomiaNoLugar(e, aj));
  const base = centroide(margem.flatMap((m) => [...m.ponto]));
  const relevo = (v: V3): [number, number] => {
    const h = dot(v, a);
    return [norma(sub(v, mul(a, h))), h];
  };

  // ---------- interna: preparo, sem retenções, com cimento a partir de inicioCimento ----------
  const dirs: V3[][] = [];
  const internaSemFresa: V3[][] = [];
  const normalDie: V3[][] = [];
  const arco: Float64Array[] = [];
  let retencoes = 0;
  for (let i = 0; i < NT; i++) {
    const dc: V3[] = [];
    const pc: V3[] = [];
    const nc: V3[] = [];
    for (let j = 0; j <= J; j++) {
      const d = direcao(prep, margem[i].th, (margem[i].ph * j) / J);
      dc.push(d);
      const h = j === J ? { ponto: margem[i].ponto, normal: margem[i].normal } : e.arco.raio(O, d, 14);
      const p = h ? h.ponto : pc[j - 1] ?? prep.topo;
      const n = h ? h.normal : nc[j - 1] ?? a;
      pc.push(p);
      nc.push(dot(n, d) < 0 ? mul(n, -1) : n);
    }
    const s = new Float64Array(J + 1);
    for (let j = J - 1; j >= 0; j--) s[j] = s[j + 1] + norma(sub(pc[j], pc[j + 1]));
    // Retenção: o preparo estreita descendo pelo eixo. Mantém o raio e a coroa assenta.
    let raioMax = 0;
    const qc = pc.map((p, j) => {
      const v = sub(p, O);
      const [rho] = relevo(v);
      if (j > J * 0.2 && j < J - 2 && rho < raioMax - 0.01) {
        retencoes++;
        return soma(p, mul(unit(sub(v, mul(a, dot(v, a)))), raioMax - rho));
      }
      raioMax = Math.max(raioMax, rho);
      return p;
    });
    dirs.push(dc);
    normalDie.push(nc);
    arco.push(s);
    internaSemFresa.push(qc.map((p, j) => soma(p, mul(nc[j], P.cimento * passoSuave(P.inicioCimento, P.inicioCimento + 0.3, s[j])))));
  }
  // A coroa precisa caber a broca: daqui em diante, o lado de dentro é o que a fresadora faz.
  const fresa = compensarFresa({ interna: internaSemFresa, arco, margem, prep, J, diametro: P.diametroBroca });
  const interna = fresa.interna;
  const dentroB = new Bvh(malhaDaGrade(interna, J));

  // ---------- externa: anatomia até a altura de contorno, depois a saída até a margem ----------
  const R: Float64Array[] = [];
  for (let i = 0; i < NT; i++) {
    const Ra = new Float64Array(J + 1).fill(NaN);
    for (let j = 0; j < J; j++) {
      const h = anat.raio(O, dirs[i][j], 20);
      if (h && !(dot(h.normal, a) < -0.85 && dot(sub(h.ponto, base), a) < 1.5)) Ra[j] = h.t;
    }
    let jh = -1;
    let maior = -1;
    for (let j = Math.floor(J * 0.35); j < J; j++) {
      if (Number.isNaN(Ra[j])) continue;
      const [rho] = relevo(mul(dirs[i][j], Ra[j]));
      if (rho > maior) {
        maior = rho;
        jh = j;
      }
    }
    const rm = norma(sub(margem[i].ponto, O));
    const linha = new Float64Array(J + 1);
    if (jh < 0) {
      // Meridiano que a anatomia não cobre: mantém a menor espessura e os vizinhos fecham na suavização.
      for (let j = 0; j <= J; j++) linha[j] = norma(sub(interna[i][j], O)) + P.espessuraMinima;
      linha[J] = rm;
      R.push(linha);
      continue;
    }
    const [r0, h0] = relevo(sub(margem[i].ponto, O));
    const [r1, h1] = relevo(mul(dirs[i][jh], Ra[jh]));
    const L = Math.hypot(r1 - r0, h1 - h0);
    const ang = P.emergencia * GRAU;
    const curva: { ph: number; r: number }[] = [];
    for (let k = 0; k <= 300; k++) {
      const s = k / 300;
      const s2 = s * s;
      const s3 = s2 * s;
      const H = [2 * s3 - 3 * s2 + 1, s3 - 2 * s2 + s, -2 * s3 + 3 * s2, s3 - s2];
      const x = H[0] * r0 + H[1] * L * Math.sin(ang) + H[2] * r1;
      const y = H[0] * h0 + H[1] * L * Math.cos(ang) + H[2] * h1 + H[3] * L;
      curva.push({ ph: Math.atan2(x, y), r: Math.hypot(x, y) });
    }
    for (let j = 0; j <= J; j++) {
      if (j === J) {
        linha[j] = rm;
      } else if (j <= jh) {
        linha[j] = Number.isNaN(Ra[j]) ? Ra[jh] : Ra[j];
      } else {
        const ph = (margem[i].ph * j) / J;
        let r = NaN;
        for (let k = 0; k < 300; k++) {
          const c0 = curva[k];
          const c1 = curva[k + 1];
          if ((c0.ph - ph) * (c1.ph - ph) <= 0) {
            r = c0.r + ((ph - c0.ph) / (c1.ph - c0.ph || 1)) * (c1.r - c0.r);
            break;
          }
        }
        linha[j] = Number.isNaN(r) ? Ra[jh] + ((rm - Ra[jh]) * (j - jh)) / (J - jh) : r;
      }
    }
    R.push(linha);
  }

  // ---------- limites: vizinhos e antagonista por cima, espessura por baixo ----------
  const teto = R.map(() => new Float64Array(J + 1).fill(Infinity));
  // Só os vizinhos: o antagonista perto da borda não pode parecer contato já fechado.
  const tetoVizinho = R.map(() => new Float64Array(J + 1).fill(Infinity));
  const piso = R.map(() => new Float64Array(J + 1));
  const altMargem = margem.map((m) => dot(sub(m.ponto, O), a));
  const pedida = (s: number) => (s < 0.2 ? 0.02 : 0.2 + (P.espessuraMinima - 0.2) * passoSuave(0.2, 1.5, s));
  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < J; j++) {
      const d = dirs[i][j];
      const dentro = norma(sub(interna[i][j], O));
      piso[i][j] = dentro + pedida(arco[i][j]) / Math.max(0.5, Math.abs(dot(d, normalDie[i][j])));
      for (const viz of vizinhoExtra ? [ambiente, vizinhoExtra] : [ambiente]) {
        const h = viz.raio(soma(O, mul(d, dentro)), d, 25);
        if (h && dot(sub(h.ponto, O), a) > altMargem[i] + ALTURA_MIN_CONTATO) {
          tetoVizinho[i][j] = Math.min(tetoVizinho[i][j], dentro + h.t - P.folgaVizinho);
          teto[i][j] = Math.min(teto[i][j], tetoVizinho[i][j]);
        }
      }
      if (ant) {
        const h = ant.raio(O, d, 30);
        if (h) teto[i][j] = Math.min(teto[i][j], h.t - P.folgaAntagonista / Math.max(0.4, Math.abs(dot(d, h.normal))));
      }
    }
  }
  const limitar = () => {
    for (let i = 0; i < NT; i++) for (let j = 0; j < J; j++) R[i][j] = Math.max(piso[i][j], Math.min(R[i][j], teto[i][j]));
  };
  limitar();
  fecharContatos(R, teto, tetoVizinho, dirs, O, e.eixos.mesial, a, altMargem, J);
  limitar();
  for (let it = 0; it < 4; it++) {
    const novo = R.map((r) => Float64Array.from(r));
    for (let i = 0; i < NT; i++) {
      const e0 = (i + NT - 1) % NT;
      const e1 = (i + 1) % NT;
      for (let j = 1; j < J - 2; j++) novo[i][j] = 0.6 * R[i][j] + 0.1 * (R[e0][j] + R[e1][j] + R[i][j - 1] + R[i][j + 1]);
    }
    for (let i = 0; i < NT; i++) for (let j = 1; j < J - 2; j++) R[i][j] = novo[i][j];
    limitar();
  }
  // A suavização afasta um pouco o que encostou: fecha de novo, agora só o que sobrou.
  fecharContatos(R, teto, tetoVizinho, dirs, O, e.eixos.mesial, a, altMargem, J);
  limitar();
  let conflitos = 0;
  for (let i = 0; i < NT; i++) for (let j = 0; j < J; j++) if (piso[i][j] > teto[i][j]) conflitos++;
  // Folgas de verdade (ponto mais próximo), não só ao longo do raio: o vizinho e o antagonista
  // podem estar mais perto em outra direção. Só olha quem está perto do limite.
  const vizinhosDoCaso = vizinhoExtra ? [ambiente, vizinhoExtra] : [ambiente];
  for (let it = 0; it < 3; it++) {
    let mudou = false;
    for (let i = 0; i < NT; i++) {
      for (let j = 1; j < J - 2; j++) {
        if (teto[i][j] === Infinity || teto[i][j] - R[i][j] > 0.5) continue;
        const d = dirs[i][j];
        const p = soma(O, mul(d, R[i][j]));
        const alto = dot(sub(p, O), a) > altMargem[i] + ALTURA_MIN_CONTATO;
        let recuo = 0;
        if (alto) {
          for (const viz of vizinhosDoCaso) {
            const q = viz.proximo(p, 0.3);
            if (q && q.d < P.folgaVizinho) recuo = Math.max(recuo, (P.folgaVizinho - q.d) / Math.max(0.4, Math.abs(dot(d, q.normal))));
          }
        }
        const q = ant?.proximo(p, 0.4);
        if (q && q.d < P.folgaAntagonista) recuo = Math.max(recuo, (P.folgaAntagonista - q.d) / Math.max(0.4, Math.abs(dot(d, q.normal))));
        if (recuo > 0.003) {
          R[i][j] = Math.max(piso[i][j], R[i][j] - recuo);
          mudou = true;
        }
      }
    }
    if (!mudou) break;
  }
  // Espessura de verdade (ponto mais próximo do lado de dentro), não só ao longo do raio.
  for (let it = 0; it < 4; it++) {
    let mudou = false;
    for (let i = 0; i < NT; i++) {
      for (let j = 0; j < J - 1; j++) {
        const req = arco[i][j] < 0.2 ? 0 : pedida(arco[i][j]);
        const c = dentroB.proximo(soma(O, mul(dirs[i][j], R[i][j])), 2);
        if (c && Math.abs(c.d) < req - 0.005) {
          R[i][j] += (req - Math.abs(c.d)) / Math.max(0.5, Math.abs(dot(dirs[i][j], c.normal))) + 0.01;
          mudou = true;
        }
      }
    }
    if (!mudou) break;
  }

  // ---------- malha: externa primeiro, depois a margem compartilhada, depois a interna ----------
  const externa: V3[][] = R.map((r, i) => {
    const col: V3[] = [];
    for (let j = 0; j <= J; j++) col.push(j === J ? margem[i].ponto : soma(O, mul(dirs[i][j], r[j])));
    return col;
  });
  const malha = malhaFechada(externa, interna, J);
  const externos = 1 + NT * (J - 1);
  const orient = conferirMalha(malha);
  if (orient.volume < 0) {
    for (let t = 0; t < malha.tri.length; t += 3) {
      const x = malha.tri[t + 1];
      malha.tri[t + 1] = malha.tri[t + 2];
      malha.tri[t + 2] = x;
    }
  }

  // ---------- campos para os mapas e relatório ----------
  const n = malha.pos.length / 3;
  const espessura = new Float32Array(n).fill(NaN);
  const folgaA = new Float32Array(n).fill(NaN);
  const folgaV = new Float32Array(n).fill(NaN);
  const ambienteViz = vizinhoExtra ? [ambiente, vizinhoExtra] : [ambiente];
  const medir = (v: number): void => {
    const p = vert(malha, v);
    const c = dentroB.proximo(p, 6);
    espessura[v] = c ? Math.abs(c.d) : NaN;
    if (ant) {
      const q = ant.proximo(p, 2);
      folgaA[v] = q ? q.d : 2;
    }
    let melhorV = Infinity;
    if (dot(sub(p, O), a) > altMargem[Math.round(((Math.atan2(dot(sub(p, O), prep.e2), dot(sub(p, O), prep.e1)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * NT) % NT] + ALTURA_MIN_CONTATO) {
      for (const b of ambienteViz) {
        const q = b.proximo(p, 1);
        if (q) melhorV = Math.min(melhorV, q.d);
      }
    }
    folgaV[v] = melhorV === Infinity ? 1 : melhorV;
  };
  for (let v = 0; v < externos; v++) medir(v);
  // Coroa muito maior que qualquer dente: a margem ou o eixo estão errados.
  let raioMax = 0;
  for (let v = 0; v < externos; v++) raioMax = Math.max(raioMax, relevo(sub(vert(malha, v), O))[0]);
  if (raioMax > 12) throw new Error('A coroa ficou fora do tamanho de um dente. Confira a margem e o ponto clicado no preparo.');
  const proj = (e0: V3) => {
    let mn = Infinity;
    let mx = -Infinity;
    for (let v = 0; v < externos; v++) {
      const x = dot(vert(malha, v), e0);
      mn = Math.min(mn, x);
      mx = Math.max(mx, x);
    }
    return mx - mn;
  };
  const relatorioAtual = (normais: Float64Array): Relatorio => {
    const ocl: number[] = [];
    const axi: number[] = [];
    let alt = -Infinity;
    for (let v = 0; v < externos; v++) {
      alt = Math.max(alt, dot(sub(vert(malha, v), base), a));
      if (espessura[v] > 0.05) {
        const nz = normais[3 * v] * a[0] + normais[3 * v + 1] * a[1] + normais[3 * v + 2] * a[2];
        if (nz > 0.6) ocl.push(espessura[v]);
        else if (Math.abs(nz) < 0.45) axi.push(espessura[v]);
      }
    }
    return {
      malha: conferirMalha(malha),
      mdMm: arred(proj(e.eixos.mesial)),
      vlMm: arred(proj(e.eixos.vestibular)),
      alturaMm: arred(alt),
      espessuraOclusal: resumo(ocl),
      espessuraAxial: resumo(axi),
      regioesContatoAntagonista: contarRegioes(malha, folgaA, externos, P.folgaAntagonista + 0.1),
      regioesContatoVizinho: contarRegioes(malha, folgaV, externos, P.folgaVizinho + 0.05),
      conflitosEspessura: conflitos,
      retencoesPreenchidas: retencoes,
      fresa: { diametro: P.diametroBroca, pontos: fresa.pontos, maiorCorte: arred(fresa.maiorCorte) },
    };
  };
  const corteFresa = new Float32Array(n);
  for (let i = 0; i < NT; i++) {
    corteFresa[externos + NT] = Math.max(corteFresa[externos + NT], fresa.corte[i][0]);
    for (let j = 1; j < J; j++) corteFresa[externos + NT + 1 + i * (J - 1) + (j - 1)] = fresa.corte[i][j];
  }
  const pedidaPorVertice = new Float32Array(externos);
  const distanciaDaMargem = new Float32Array(externos);
  for (let i = 0; i < NT; i++) {
    let falta = 0;
    for (let j = J - 1; j >= 0; j--) {
      falta += norma(sub(externa[i][j], externa[i][j + 1]));
      const v = j === 0 ? 0 : 1 + i * (J - 1) + (j - 1);
      pedidaPorVertice[v] = arco[i][j] < 0.2 ? 0 : pedida(arco[i][j]);
      distanciaDaMargem[v] = Math.max(distanciaDaMargem[v], falta);
    }
  }
  return {
    malha,
    espessura,
    folgaAntagonista: folgaA,
    folgaVizinho: folgaV,
    corteFresa,
    externos,
    relatorio: relatorioAtual(normaisDeVertice(malha)),
    escultura: {
      dentro: dentroB,
      fimDaSuperficie: externos + NT,
      pedida: pedidaPorVertice,
      distanciaDaMargem,
      medir,
      relatorio: relatorioAtual,
    },
  };
}

const MAIOR_ESPACO_A_FECHAR = 1.2;
const RAIO_DO_CONTATO = 1.8;
/** O contato fica no terço alto do dente; perto da margem o que está perto é a gengiva. */
const ALTURA_DO_CONTATO = 1.5;

/**
 * Fecha o contato com cada vizinho: acha o ponto da superfície mais perto dele e leva a região
 * em volta até encostar, numa transição suave. Espaço grande demais não é contato: fica como está.
 */
function fecharContatos(R: Float64Array[], teto: Float64Array[], tetoVizinho: Float64Array[], dirs: V3[][], O: V3, mesial: V3, a: V3, altMargem: number[], J: number): void {
  const NT = R.length;
  for (const lado of [1, -1]) {
    let gi = -1;
    let gj = -1;
    let menor = Infinity;
    for (let i = 0; i < NT; i++) {
      for (let j = 1; j < J - 2; j++) {
        if (tetoVizinho[i][j] === Infinity || lado * dot(dirs[i][j], mesial) < 0.6) continue;
        if (R[i][j] * dot(dirs[i][j], a) - altMargem[i] < ALTURA_DO_CONTATO) continue;
        // Onde o antagonista segura antes de chegar ao vizinho, não há como encostar.
        if (teto[i][j] < tetoVizinho[i][j] - 0.01) continue;
        const g = tetoVizinho[i][j] - R[i][j];
        if (g < menor) {
          menor = g;
          gi = i;
          gj = j;
        }
      }
    }
    if (gi < 0 || menor <= 0.01 || menor > MAIOR_ESPACO_A_FECHAR) continue;
    const alvo = soma(O, mul(dirs[gi][gj], R[gi][gj]));
    for (let i = 0; i < NT; i++) {
      for (let j = 1; j < J - 2; j++) {
        const noLado = lado * dot(dirs[i][j], mesial);
        if (noLado < 0.2) continue;
        const d = norma(sub(soma(O, mul(dirs[i][j], R[i][j])), alvo));
        // Some aos poucos na saída do lado: cortar de uma vez deixaria um vinco na coroa.
        R[i][j] += menor * Math.exp(-((d / RAIO_DO_CONTATO) ** 2)) * passoSuave(0.2, 0.5, noLado);
      }
    }
  }
}

const arred = (x: number) => Math.round(x * 100) / 100;

/** Externa + interna com a linha J compartilhada: fechada por construção. */
function malhaFechada(externa: V3[][], interna: V3[][], J: number): Malha {
  const NT = externa.length;
  const nOut = 1 + NT * (J - 1);
  const total = nOut + NT + 1 + NT * (J - 1);
  const pos = new Float64Array(total * 3);
  pos.set(externa[0][0], 0);
  const idO = (i: number, j: number) => (j === 0 ? 0 : j === J ? nOut + i : 1 + i * (J - 1) + (j - 1));
  const idI = (i: number, j: number) => (j === J ? nOut + i : j === 0 ? nOut + NT : nOut + NT + 1 + i * (J - 1) + (j - 1));
  for (let i = 0; i < NT; i++) {
    for (let j = 1; j < J; j++) pos.set(externa[i][j], 3 * idO(i, j));
    pos.set(externa[i][J], 3 * idO(i, J));
    for (let j = 1; j < J; j++) pos.set(interna[i][j], 3 * idI(i, j));
  }
  pos.set(interna[0][0], 3 * idI(0, 0));
  const tri = new Uint32Array((NT * 2 + NT * (J - 1) * 4) * 3);
  let o = 0;
  const put = (a: number, b: number, c: number) => {
    tri[o++] = a;
    tri[o++] = b;
    tri[o++] = c;
  };
  for (let i = 0; i < NT; i++) {
    const k = (i + 1) % NT;
    put(idO(0, 0), idO(k, 1), idO(i, 1));
    put(idI(0, 0), idI(i, 1), idI(k, 1));
    for (let j = 1; j < J; j++) {
      put(idO(i, j), idO(k, j), idO(k, j + 1));
      put(idO(i, j), idO(k, j + 1), idO(i, j + 1));
      put(idI(i, j), idI(k, j + 1), idI(k, j));
      put(idI(i, j), idI(i, j + 1), idI(k, j + 1));
    }
  }
  return { pos, tri };
}

/** Quantas regiões separadas da superfície externa estão abaixo do limite. */
function contarRegioes(m: Malha, campo: Float32Array, externos: number, limite: number): number {
  const pai = new Int32Array(externos).map((_, i) => i);
  const achar = (x: number): number => {
    let r = x;
    while (pai[r] !== r) r = pai[r];
    while (pai[x] !== r) {
      const y = pai[x];
      pai[x] = r;
      x = y;
    }
    return r;
  };
  const ok = (v: number) => v < externos && campo[v] < limite;
  for (let t = 0; t < m.tri.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = m.tri[t + k];
      const b = m.tri[t + ((k + 1) % 3)];
      if (ok(a) && ok(b)) pai[achar(a)] = achar(b);
    }
  }
  const raizes = new Map<number, number>();
  for (let v = 0; v < externos; v++) if (ok(v)) raizes.set(achar(v), (raizes.get(achar(v)) ?? 0) + 1);
  // Mancha de poucos vértices é ruído, não contato.
  return [...raizes.values()].filter((q) => q >= 12).length;
}
