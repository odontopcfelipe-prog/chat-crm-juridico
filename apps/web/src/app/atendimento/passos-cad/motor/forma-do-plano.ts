/**
 * Passos CAD — do plano do dente à superfície externa. É a segunda forma de modelar, ao lado da
 * biblioteca, e existe por causa de três defeitos:
 *
 * - **Marca de mordida:** cortar no antagonista carimba o formato dele na coroa. Aqui cada cúspide
 *   assenta na altura certa e o que ainda sobra desce numa área larga e suave.
 * - **Pregas na parede:** cada meridiano descer sozinho até a margem cria estrias. Aqui o contorno é
 *   uma curva convexa em volta do dente, e o desenho irregular da margem some logo acima dela.
 * - **Relevo do preparo aparecendo:** colar a superfície na espessura mínima copia cada irregularidade
 *   do preparo. Aqui a espessura é uma camada lisa em volta dele, e o limite duro quase não trabalha.
 *
 * A forma é um campo: f(p) < 0 dentro do dente. A lateral é o raio máximo por altura; a oclusal é um
 * mapa de altura feito de cúspides e cristas, com os sulcos desenhados por cima.
 */
import { dot, mul, norma, passoSuave, soma, sub, type Bvh, type V3 } from './geo';
import type { PontoMargem, Preparo } from './margem';
import type { Crista, Cuspide, P2, PedidoDesenhoIa, PlanoDoDente } from './plano-do-dente';

export interface EntradaDaForma {
  prep: Preparo;
  margem: PontoMargem[];
  eixos: { mesial: V3; vestibular: V3 };
  antagonista: Bvh | null;
  /** Vizinhos e gengiva, sem o troquel. */
  ambiente: Bvh;
  folgaAntagonista: number;
  /** Espessura mínima na parede. */
  espessuraMinima: number;
  /** Espessura mínima na face oclusal. */
  espessuraOclusal: number;
  emergencia: number;
}

const GRAU = Math.PI / 180;
const limita = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

/** Vizinho mais baixo que isso, em relação ao topo do dente, é preparo ou falha do escaneamento (mm). */
const ALTURA_MINIMA_DA_CRISTA_VIZINHA = 3;
/** Até onde a crista marginal sobe ou desce para ficar na altura da do vizinho (mm). */
const MAIOR_ACERTO_DA_CRISTA = 0.8;
const RAIO_DO_ACERTO_DA_CRISTA = 1.4;
/** Onde fica a crista marginal, em relação ao contorno (u). */
const PONTO_DA_CRISTA = 0.82;
/** Até onde o contato vai buscar o vizinho; além disso é espaço aberto, não contato. */
const MAIOR_ALCANCE_DE_CONTATO = 3;
/** Quanto o contato pode alargar o dente além da largura natural. Espaço maior que isso fica aberto. */
const FOLGA_NA_LARGURA = 1.2;
/** Até onde, além do raio do preparo, o que o raio acerta ainda é a parede dele (mm). */
const DISTANCIA_DA_PROPRIA_PAREDE = 0.2;
const ABERTURA_DO_CONTATO = 32 * GRAU;
/** O contorno irregular da margem some nesta altura (mm). */
const ALTURA_DA_MARGEM_IRREGULAR = 1.1;
/** Arredonda a passagem da parede para a face oclusal. */
const ARREDONDA_OMBRO = 0.7;
const PASSO = 0.05;
const PASSO_DOS_LIMITES = 0.2;
const FOLGA_DO_MAPA = 1.5;
const PASSO_DO_RAIO = 0.06;
/** Quanto a camada de espessura se espalha em volta do ponto mais alto do preparo (mm). */
const ALCANCE_DA_CAMADA = 0.7;
const SUAVIZA_CAMADA = 0.6;
/** Largura da descida por causa do antagonista (mm). */
const LARGURA_DA_DESCIDA = 1.5;
/** Fica um pouco abaixo do antagonista: assim o corte seco no fim quase não trabalha (mm). */
const RESERVA_DO_CORTE = 0.02;
/** Até onde o desenho anda e gira para as fossas caírem sob as cúspides do antagonista. */
const DESLOCA_NO_ENCAIXE = [-0.8, -0.4, 0, 0.4, 0.8];
const GIROS_NO_ENCAIXE = [-14, -7, 0, 7, 14];
/** Espaço guardado acima da camada para o sulco ter onde entrar (mm). */
const FOLGA_DOS_SULCOS = 0.35;
/** Largura da transição onde a camada cede ao antagonista (mm). */
const SUAVIZA_CEDER = 0.4;
/** Quanto o piso dos sulcos se afasta de uma cúspide do antagonista (mm). */
const ALCANCE_DO_PISO = 1;
/** Onde não há antagonista, o teto fica este tanto acima da camada: longe o bastante para não contar (mm). */
const SEM_TETO = 5;
const LARGURA_PADRAO_DO_SULCO = 0.5;
/** Raio mínimo no fundo do sulco (mm): abaixo disso a fresa não entra. */
const RAIO_MINIMO_DO_SULCO = 0.15;

export interface FormaDoPlano {
  /** Raio de cada linha da grade de cada meridiano. */
  raios: Float64Array[];
  medidas: { md: number; vl: number; alturaUsada: number; maiorDescida: number };
}

interface Local {
  base: V3;
  m: V3;
  v: V3;
  a: V3;
}

const local = (l: Local, p: V3): [number, number, number] => {
  const d = sub(p, l.base);
  return [dot(d, l.m), dot(d, l.v), dot(d, l.a)];
};

const centroDaMargem = (margem: PontoMargem[]): V3 => {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of margem) {
    x += p.ponto[0];
    y += p.ponto[1];
    z += p.ponto[2];
  }
  return [x / margem.length, y / margem.length, z / margem.length];
};

/** Média móvel circular em várias passadas: tira o serrilhado sem achatar o formato do dente. */
function suavizarCircular(v: Float64Array, raio: number, passadas: number): Float64Array {
  const n = v.length;
  let atual = Float64Array.from(v);
  for (let p = 0; p < passadas; p++) {
    const novo = new Float64Array(n);
    let total = 0;
    for (let k = -raio; k <= raio; k++) total += atual[((k % n) + n) % n];
    for (let i = 0; i < n; i++) {
      novo[i] = total / (2 * raio + 1);
      total += atual[(i + raio + 1) % n] - atual[((i - raio) % n + n) % n];
    }
    atual = novo;
  }
  return atual;
}

/** O maior valor em volta de cada meridiano: o que empurra um ponto empurra também os vizinhos dele. */
function dilatarCircular(v: Float64Array, raio: number): Float64Array {
  const n = v.length;
  const novo = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let maior = -Infinity;
    for (let k = -raio; k <= raio; k++) maior = Math.max(maior, v[((i + k) % n + n) % n]);
    novo[i] = maior;
  }
  return novo;
}

/** Dente natural é convexo: troca o raio de cada meridiano pelo do fecho convexo do contorno. */
function raioConvexo(r: Float64Array, cos: Float64Array, sen: Float64Array): Float64Array {
  const n = r.length;
  const pts = Array.from({ length: n }, (_, i) => [r[i] * cos[i], r[i] * sen[i]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cruz = (o: readonly number[], a: readonly number[], b: readonly number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const baixo: (readonly [number, number])[] = [];
  for (const p of pts) {
    while (baixo.length >= 2 && cruz(baixo[baixo.length - 2], baixo[baixo.length - 1], p) <= 0) baixo.pop();
    baixo.push(p);
  }
  const alto: (readonly [number, number])[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const p = pts[k];
    while (alto.length >= 2 && cruz(alto[alto.length - 2], alto[alto.length - 1], p) <= 0) alto.pop();
    alto.push(p);
  }
  const fecho = [...baixo.slice(0, -1), ...alto.slice(0, -1)];
  const novo = Float64Array.from(r);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < fecho.length; k++) {
      const a = fecho[k];
      const b = fecho[(k + 1) % fecho.length];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const det = cos[i] * ey - sen[i] * ex;
      if (Math.abs(det) < 1e-9) continue;
      const t = (a[0] * ey - a[1] * ex) / det;
      const s = (a[0] * sen[i] - a[1] * cos[i]) / det;
      if (t > 0 && s >= -1e-6 && s <= 1 + 1e-6) {
        novo[i] = Math.max(novo[i], t);
        break;
      }
    }
  }
  return novo;
}

/**
 * Até onde o dente deve subir: o natural, ou menos se o antagonista estiver perto. Conta um pouco acima
 * do meio dele, porque cúspide alta dele não abaixa o dente todo: desce só onde encosta.
 */
function alturaProvavel(e: EntradaDaForma, l: Local, natural: number, minima: number): number {
  if (!e.antagonista) return natural;
  const pontos = e.margem.map((p) => local(l, p.ponto));
  const ms = pontos.map((p) => p[0]);
  const vs = pontos.map((p) => p[1]);
  const alturas: number[] = [];
  const baixo = -2;
  for (let a = 0; a <= 6; a++) {
    for (let b = 0; b <= 6; b++) {
      const m = Math.min(...ms) + ((Math.max(...ms) - Math.min(...ms)) * a) / 6;
      const v = Math.min(...vs) + ((Math.max(...vs) - Math.min(...vs)) * b) / 6;
      const h = e.antagonista.raio(soma(soma(soma(l.base, mul(l.m, m)), mul(l.v, v)), mul(l.a, baixo)), l.a, 40);
      if (h) alturas.push(baixo + h.t);
    }
  }
  if (!alturas.length) return natural;
  alturas.sort((x, y) => x - y);
  return limita(alturas[Math.floor(alturas.length * 0.6)] - e.folgaAntagonista, minima, natural);
}

/**
 * Do centro até o vizinho, nos dois sentidos, só na altura em que os dentes se tocam. O vizinho pode
 * estar inclinado por cima do preparo: o que importa é onde ele está nessa altura, não mais acima.
 */
function medirVizinhos(e: EntradaDaForma, l: Local, topo: number, plano: PlanoDoDente): { mesial: number | null; distal: number | null } {
  const medir = (lado: number): number | null => {
    const fracao = lado > 0 ? plano.contatoMesial : plano.contatoDistal;
    let menor = Infinity;
    for (const lateral of [-1.5, 0, 1.5]) {
      for (let h = Math.max(1.5, topo * (fracao - 0.15)); h <= Math.max(2, topo * (fracao + 0.08)); h += 0.25) {
        const o = soma(soma(l.base, mul(l.v, lateral)), mul(l.a, h));
        const t = e.ambiente.raio(o, mul(l.m, lado), 14);
        if (t) menor = Math.min(menor, t.t);
      }
    }
    return menor === Infinity ? null : menor;
  };
  return { mesial: medir(1), distal: medir(-1) };
}

/** Bojo natural de cada lado (mm): passar disso é sobrecontorno, e a largura VL se ajusta dentro dele. */
const BOJO_VESTIBULAR = { menor: 0.2, maior: 0.7 };
const BOJO_LINGUAL = { menor: 0.3, maior: 1 };
const TOLERANCIA_NA_VL = 0.1;

/** Bojo que deixa a largura VL perto da natural, começando do que o plano pediu. */
function bojosDoCaso(plano: PlanoDoDente, vlDaMargem: number): { vestibular: number; lingual: number } {
  const v = plano.bojoVestibular;
  const l = plano.bojoLingual;
  const total = vlDaMargem + v + l;
  const maior = plano.vlMm * (1 + TOLERANCIA_NA_VL);
  const menor = plano.vlMm * (1 - TOLERANCIA_NA_VL);
  if (total > maior) {
    const sobraV = Math.max(0, v - BOJO_VESTIBULAR.menor);
    const sobraL = Math.max(0, l - BOJO_LINGUAL.menor);
    const parte = Math.min(1, (total - maior) / (sobraV + sobraL || 1));
    return { vestibular: v - sobraV * parte, lingual: l - sobraL * parte };
  }
  if (total < menor) {
    const cabeV = Math.max(0, BOJO_VESTIBULAR.maior - v);
    const cabeL = Math.max(0, BOJO_LINGUAL.maior - l);
    const parte = Math.min(1, (menor - total) / (cabeV + cabeL || 1));
    return { vestibular: v + cabeV * parte, lingual: l + cabeL * parte };
  }
  return { vestibular: v, lingual: l };
}

const LADO_DO_MAPA = 11;
const duasCasas = (x: number) => Math.round(x * 100) / 100;

/** As medidas que a IA recebe: tamanho do dente, espaço em volta e os dois mapas de altura. */
export function quadroDoCaso(e: EntradaDaForma, arco: Bvh, plano: PlanoDoDente, fdi: number): PedidoDesenhoIa {
  const { prep, margem } = e;
  const l: Local = { base: centroDaMargem(margem), m: e.eixos.mesial, v: e.eixos.vestibular, a: prep.a };
  const O = local(l, prep.O);
  const topo = local(l, prep.topo)[2];
  const pontos = margem.map((p) => local(l, p.ponto));
  const ms = pontos.map((p) => p[0]);
  const vs = pontos.map((p) => p[1]);
  const viz = medirVizinhos(e, l, alturaProvavel(e, l, Math.max(plano.alturaMm, topo + e.espessuraOclusal + 0.9), topo + e.espessuraOclusal + 0.3), plano);
  // O mesmo tamanho do contorno: até o vizinho, quando ele está perto; senão, a margem com o bojo.
  let aindaCabe = Math.max(0, plano.larguraMm * FOLGA_NA_LARGURA - (Math.max(...ms) - Math.min(...ms) + 1));
  const alcance = (lado: number, margemNoLado: number, dist: number | null) => {
    const semContato = margemNoLado + 0.5;
    if (dist === null || dist - margemNoLado > MAIOR_ALCANCE_DE_CONTATO) return semContato * lado;
    if (dist <= semContato) return dist * lado;
    const passo = Math.min(dist - semContato, aindaCabe);
    aindaCabe -= passo;
    return (semContato + passo) * lado;
  };
  const mais = alcance(1, Math.max(...ms), viz.mesial);
  const menos = alcance(-1, -Math.min(...ms), viz.distal);
  const md = mais - menos;
  const bojos = bojosDoCaso(plano, Math.max(...vs) - Math.min(...vs));
  const vMais = Math.max(...vs) + bojos.vestibular;
  const vMenos = Math.min(...vs) - bojos.lingual;
  const vl = vMais - vMenos;
  const cm = (mais + menos) / 2;
  const cv = (vMais + vMenos) / 2;
  const ponto = (m: number, v: number, z: number) => soma(soma(soma(l.base, mul(l.m, m)), mul(l.v, v)), mul(l.a, z));
  // Dentro da margem? Pelo meridiano mais perto: fora dela o raio de cima pegaria o vizinho.
  const dentroDaMargem = (m: number, v: number) => {
    const ang = Math.atan2(v - O[1], m - O[0]);
    let melhor = Infinity;
    let raio = 0;
    for (const p of pontos) {
      const d = Math.abs(((Math.atan2(p[1] - O[1], p[0] - O[0]) - ang + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      if (d < melhor) {
        melhor = d;
        raio = Math.hypot(p[0] - O[0], p[1] - O[1]);
      }
    }
    return Math.hypot(m - O[0], v - O[1]) < raio;
  };
  const mapaAntagonista: (number | null)[][] = [];
  const mapaPreparo: (number | null)[][] = [];
  for (let linha = 0; linha < LADO_DO_MAPA; linha++) {
    const w = 1 - (2 * linha) / (LADO_DO_MAPA - 1);
    const a: (number | null)[] = [];
    const b: (number | null)[] = [];
    for (let coluna = 0; coluna < LADO_DO_MAPA; coluna++) {
      const u = -1 + (2 * coluna) / (LADO_DO_MAPA - 1);
      const m = cm + (u * md) / 2;
      const v = cv + (w * vl) / 2;
      const baixo = -2;
      const hA = e.antagonista?.raio(ponto(m, v, baixo), l.a, 40);
      a.push(hA ? duasCasas(baixo + hA.t) : null);
      const cima = topo + 4;
      const hP = dentroDaMargem(m, v) ? arco.raio(ponto(m, v, cima), mul(l.a, -1), 16) : null;
      // Acima do topo não é preparo: é o vizinho inclinado por cima da margem, onde o raio bate antes.
      const alturaP = hP ? cima - hP.t : null;
      b.push(alturaP !== null && alturaP <= topo + 0.5 ? duasCasas(alturaP) : null);
    }
    mapaAntagonista.push(a);
    mapaPreparo.push(b);
  }
  return {
    fdi,
    medidas: {
      mdMm: duasCasas(md),
      vlMm: duasCasas(vl),
      topoDoPreparoMm: duasCasas(topo),
      folgaAntagonistaMm: e.folgaAntagonista,
      espessuraOclusalMm: e.espessuraOclusal,
      espessuraAxialMm: e.espessuraMinima,
      vizinhoMesialMm: viz.mesial === null ? null : duasCasas(viz.mesial),
      vizinhoDistalMm: viz.distal === null ? null : duasCasas(viz.distal),
    },
    mapaAntagonista,
    mapaPreparo,
    planoInicial: plano,
  };
}

/** Curva de Catmull-Rom: sem ela, o sombreado mostra a grade do mapa como um xadrez. */
function interpolar(g: Float64Array, nx: number, ny: number, fx: number, fy: number): number {
  const x = limita(Math.floor(fx), 1, nx - 3);
  const y = limita(Math.floor(fy), 1, ny - 3);
  const tx = fx - x;
  const ty = fy - y;
  const peso = (t: number): [number, number, number, number] => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [0.5 * (-t3 + 2 * t2 - t), 0.5 * (3 * t3 - 5 * t2 + 2), 0.5 * (-3 * t3 + 4 * t2 + t), 0.5 * (t3 - t2)];
  };
  const wx = peso(tx);
  const wy = peso(ty);
  let v = 0;
  for (let b = 0; b < 4; b++) {
    const k = x - 1 + (y - 1 + b) * nx;
    v += wy[b] * (wx[0] * g[k] + wx[1] * g[k + 1] + wx[2] * g[k + 2] + wx[3] * g[k + 3]);
  }
  return v;
}

/** Borra em duas direções: o mesmo que uma gaussiana, em bem menos contas. */
function borrar(g: Float64Array, nx: number, ny: number, sigma: number): Float64Array {
  const r = Math.ceil(sigma * 2.5);
  const nucleo = new Float64Array(2 * r + 1);
  let s = 0;
  for (let k = -r; k <= r; k++) {
    nucleo[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
    s += nucleo[k + r];
  }
  for (let k = 0; k < nucleo.length; k++) nucleo[k] /= s;
  const tmp = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) v += nucleo[k + r] * g[limita(x + k, 0, nx - 1) + y * nx];
      tmp[x + y * nx] = v;
    }
  }
  const out = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) v += nucleo[k + r] * tmp[x + limita(y + k, 0, ny - 1) * nx];
      out[x + y * nx] = v;
    }
  }
  return out;
}

/**
 * Até onde o relevo pode descer ao abrir um sulco: a camada de espessura mais uma folga, sem passar do
 * antagonista. Liso, porque seguir o teto cru copiaria a cúspide dele, que é a marca de mordida.
 */
export function pisoDosSulcos(teto: Float64Array, camada: Float64Array, nx: number, ny: number): Float64Array {
  const liso = tetoLiso(teto, camada, nx, ny);
  const piso = new Float64Array(nx * ny);
  for (let k = 0; k < piso.length; k++) piso[k] = Math.max(camada[k], Math.min(camada[k] + FOLGA_DOS_SULCOS, liso[k]));
  return piso;
}

/**
 * Versão lisa de um teto, sempre abaixo dele. Pega o menor valor em volta e borra só até esse alcance: é
 * uma média de valores já abaixo do teto do ponto. Prender depois de borrar também garantiria isso, mas
 * devolve a borda seca, que na coroa vira um anel.
 */
function tetoLiso(teto: Float64Array, referencia: Float64Array, nx: number, ny: number): Float64Array {
  const negativo = new Float64Array(nx * ny);
  for (let k = 0; k < negativo.length; k++) negativo[k] = -(teto[k] === Infinity ? referencia[k] + SEM_TETO : teto[k]);
  const raio = Math.ceil(ALCANCE_DO_PISO / PASSO_DOS_LIMITES);
  const liso = borrar(dilatar(negativo, nx, ny, raio), nx, ny, raio / 2.5);
  for (let k = 0; k < liso.length; k++) liso[k] = -liso[k];
  return liso;
}

/**
 * A camada é mais grossa que o mínimo, porque foi dilatada e alisada. Onde o antagonista chega abaixo
 * dela, ela cede até a espessura de verdade. Sem isso, quem resolve é o corte no fim, ponto a ponto, e a
 * oclusal copia o escaneamento dele: fica áspera, ou com um anel em volta de cada cúspide.
 */
export function camadaSobOAntagonista(camada: Float64Array, piso: Float64Array, zAnt: Float64Array, folga: number, nx: number, ny: number): void {
  const teto = new Float64Array(nx * ny);
  for (let k = 0; k < teto.length; k++) teto[k] = zAnt[k] === Infinity ? Infinity : zAnt[k] - folga;
  const liso = tetoLiso(teto, camada, nx, ny);
  for (let k = 0; k < camada.length; k++) camada[k] = Math.max(piso[k], -smax(-camada[k], -liso[k], SUAVIZA_CEDER));
}

function dilatar(g: Float64Array, nx: number, ny: number, r: number): Float64Array {
  const tmp = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let v = -Infinity;
      for (let k = -r; k <= r; k++) v = Math.max(v, g[limita(x + k, 0, nx - 1) + y * nx]);
      tmp[x + y * nx] = v;
    }
  }
  const out = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let v = -Infinity;
      for (let k = -r; k <= r; k++) v = Math.max(v, tmp[x + limita(y + k, 0, ny - 1) * nx]);
      out[x + y * nx] = v;
    }
  }
  return out;
}

/** Cúspides e cristas do plano, em mm no caso. */
function relevoDoPlano(plano: PlanoDoDente, cm: number, cv: number, md: number, vl: number, alturaDeCada: (c: Cuspide) => number, alturaH: number, cristaDoVizinho: { mesial: number | null; distal: number | null }) {
  const emMm = (u: number, w: number): [number, number] => [cm + (u * md) / 2, cv + (w * vl) / 2];
  const escala = (md + vl) / 21;
  const [fm, fv] = emMm(plano.centro[0], plano.centro[1]);
  const cones = plano.cuspides.map((c) => {
    const [m, v] = emMm(c.u, c.w);
    const dx = fm - m;
    const dy = fv - v;
    const L = Math.hypot(dx, dy) || 1;
    return { m, v, t: alturaDeCada(c), natural: c.h * alturaH, em: dx / L, ev: dy / L };
  });
  const AIN = 1.45 * escala;
  const AOUT = 1.05 * escala;
  const ALADO = 1.15 * escala;
  const cone = (c: (typeof cones)[number], m: number, v: number) => {
    const dm = m - c.m;
    const dv = v - c.v;
    const din = dm * c.em + dv * c.ev;
    const lado = -dm * c.ev + dv * c.em;
    const x = Math.sqrt((din / (AOUT + (AIN - AOUT) * passoSuave(-0.7, 0.7, din))) ** 2 + 1e-4);
    const y = Math.sqrt((lado / ALADO) ** 2 + 1e-4);
    // Expoente 2: menos que isso faz um vinco reto passando pela ponta da cúspide.
    const D = Math.hypot(x, y);
    return c.t - (1.2 * D * D) / (D + 1.2);
  };
  // A cúspide que assentou mais baixo ou mais alto leva junto a crista que sai dela.
  const ajusteEm = (m: number, v: number) => {
    let total = 0;
    let pesos = 0;
    for (const c of cones) {
      const d2 = (m - c.m) ** 2 + (v - c.v) ** 2;
      const p = 1 / (d2 + 0.25);
      total += p * (c.t - c.natural);
      pesos += p;
    }
    return pesos ? total / pesos : 0;
  };
  const pontaMaisAlta = Math.max(...cones.map((c) => c.t));
  const cristas = plano.cristas.map((c: Crista) => {
    const p0 = emMm(c.de[0], c.de[1]);
    const p1 = emMm(c.ate[0], c.ate[1]);
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const meio: [number, number] = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    return {
      p0,
      dx,
      dy,
      L2: dx * dx + dy * dy || 1,
      h0: c.hDe * alturaH + ajusteEm(p0[0], p0[1]),
      hm: c.hMeio * alturaH + ajusteEm(meio[0], meio[1]),
      h1: c.hAte * alturaH + ajusteEm(p1[0], p1[1]),
      w: 0.65 * c.largura * escala,
    };
  });
  const crista = (c: (typeof cristas)[number], m: number, v: number) => {
    const t = limita(((m - c.p0[0]) * c.dx + (v - c.p0[1]) * c.dy) / c.L2, 0, 1);
    const d = Math.hypot(m - (c.p0[0] + t * c.dx), v - (c.p0[1] + t * c.dy));
    const hc = (1 - t) * (1 - 2 * t) * c.h0 + 4 * t * (1 - t) * c.hm + t * (2 * t - 1) * c.h1;
    return hc - (1.05 * d * d) / (d + c.w);
  };
  const semAcerto = (m: number, v: number) => {
    let H = -Infinity;
    for (const c of cones) H = H === -Infinity ? cone(c, m, v) : smax(H, cone(c, m, v), 0.4);
    for (const c of cristas) H = smax(H, crista(c, m, v), 0.32);
    return H;
  };
  // Crista marginal desnivelada em relação ao vizinho prende comida. Sobe ou desce só a borda do dente
  // desse lado, numa curva suave. Só nos posteriores: quem tem crista marginal marcada no plano.
  const acertos = (['mesial', 'distal'] as const).flatMap((lado) => {
    const alvo = cristaDoVizinho[lado];
    if (alvo === null || !plano.cristas.some((c) => c.lado === lado)) return [];
    const [m, v] = emMm(lado === 'mesial' ? PONTO_DA_CRISTA : -PONTO_DA_CRISTA, 0);
    const agora = semAcerto(m, v);
    const passo = limita(Math.min(alvo, pontaMaisAlta - 0.15) - agora, -MAIOR_ACERTO_DA_CRISTA, MAIOR_ACERTO_DA_CRISTA);
    return Math.abs(passo) < 0.05 ? [] : [{ m, v, passo }];
  });
  const raioM = RAIO_DO_ACERTO_DA_CRISTA * escala;
  const raioV = 0.5 * vl;
  const acertoEm = (m: number, v: number) => {
    let total = 0;
    for (const a of acertos) total += a.passo * Math.exp(-(((m - a.m) / raioM) ** 2 + ((v - a.v) / raioV) ** 2));
    return total;
  };
  return (m: number, v: number) => semAcerto(m, v) + acertoEm(m, v);
}

/** Quanto cada sulco desce em cada ponto: entra por último, sempre acima da camada de espessura. */
function profundidadeDosSulcos(plano: PlanoDoDente, cm: number, cv: number, md: number, vl: number) {
  const emMm = (u: number, w: number): [number, number] => [cm + (u * md) / 2, cv + (w * vl) / 2];
  const trechos = plano.sulcos.flatMap((s) =>
    s.pontos.slice(0, -1).map((a, i) => {
      const b = s.pontos[i + 1];
      // Fundo fechado demais não dá para fresar e lasca: a largura cresce com a profundidade.
      const w = Math.max(s.largura ?? LARGURA_PADRAO_DO_SULCO, Math.sqrt(2 * Math.max(a[2], b[2]) * RAIO_MINIMO_DO_SULCO));
      return { a: emMm(a[0], a[1]), b: emMm(b[0], b[1]), pa: a[2], pb: b[2], w };
    }),
  );
  return (m: number, v: number) => {
    let maior = 0;
    for (const s of trechos) {
      const dx = s.b[0] - s.a[0];
      const dy = s.b[1] - s.a[1];
      const t = limita(((m - s.a[0]) * dx + (v - s.a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      const d = Math.hypot(m - (s.a[0] + t * dx), v - (s.a[1] + t * dy));
      const p = s.pa + t * (s.pb - s.pa);
      // Curva de sino: sem borda dura e com o fundo aberto, que é o que uma broca consegue fresar.
      const q = p * Math.exp(-((d / s.w) ** 2));
      if (q > maior) maior = q;
    }
    return maior;
  };
}

/**
 * Desce a oclusal até caber sob o antagonista, sem carimbar: mede a sobra, espalha numa área larga e
 * baixa tudo junto. Nunca abaixo da camada de espessura: nesse caso quem manda é o preparo.
 */
function descerSobOAntagonista(H: Float64Array, teto: Float64Array, nx: number, ny: number, passo: number): Float64Array {
  const descida = new Float64Array(nx * ny);
  const sigma = LARGURA_DA_DESCIDA / passo;
  for (let it = 0; it < 10; it++) {
    const sobra = new Float64Array(nx * ny);
    let maior = 0;
    for (let k = 0; k < sobra.length; k++) {
      sobra[k] = Math.max(0, H[k] - descida[k] - teto[k]);
      maior = Math.max(maior, sobra[k]);
    }
    if (maior < 0.015) break;
    const b = borrar(sobra, nx, ny, sigma);
    let f = 1;
    for (let k = 0; k < sobra.length; k++) if (sobra[k] > 0.01 && b[k] > 1e-4) f = Math.max(f, sobra[k] / b[k]);
    const ganho = Math.min(f, 4);
    for (let k = 0; k < sobra.length; k++) descida[k] += b[k] * ganho;
  }
  return descida;
}

/** O mesmo plano, andado e girado em volta da fossa (em mm no caso, convertidos pelo tamanho do dente). */
function moverPlano(p: PlanoDoDente, du: number, dw: number, grau: number, razao: number): PlanoDoDente {
  const c = Math.cos(grau * GRAU);
  const s = Math.sin(grau * GRAU);
  // Gira em mm: em u, w o dente é esticado, e girar direto deformaria o desenho.
  const mover = (u: number, w: number): P2 => {
    const x = (u - p.centro[0]) * razao;
    const y = w - p.centro[1];
    return [limita(p.centro[0] + du + (c * x - s * y) / razao, -0.98, 0.98), limita(p.centro[1] + dw + s * x + c * y, -0.98, 0.98)];
  };
  return {
    ...p,
    centro: mover(p.centro[0], p.centro[1]),
    cuspides: p.cuspides.map((k) => {
      const [u, w] = mover(k.u, k.w);
      return { ...k, u, w };
    }),
    cristas: p.cristas.map((k) => ({ ...k, de: mover(k.de[0], k.de[1]), ate: mover(k.ate[0], k.ate[1]) })),
    sulcos: p.sulcos.map((k) => ({
      ...k,
      pontos: k.pontos.map(([u, w, f]) => {
        const [a, b] = mover(u, w);
        return [a, b, f] as [number, number, number];
      }),
    })),
  };
}

export function construirForma(e: EntradaDaForma, planoPedido: PlanoDoDente, dirs: V3[][], interna: V3[][], J: number): FormaDoPlano {
  const { prep, margem } = e;
  let plano = planoPedido;
  const NT = margem.length;
  const l: Local = { base: centroDaMargem(margem), m: e.eixos.mesial, v: e.eixos.vestibular, a: prep.a };
  const O = local(l, prep.O);
  const topoPrep = local(l, prep.topo)[2];
  const maisAltaDoPlano = Math.max(...plano.cuspides.map((c) => c.h));
  // h × altura é a conta que a IA recebe. O preparo alto pede dente mais alto, sem mudar a proporção.
  const alturaH = Math.max(plano.alturaMm, topoPrep + e.espessuraOclusal + 0.9);
  const topoEstimado = alturaProvavel(e, l, alturaH * maisAltaDoPlano, topoPrep + e.espessuraOclusal + 0.3);

  // ---------- margem em volta do eixo ----------
  const rm = new Float64Array(NT);
  const zm = new Float64Array(NT);
  const cosT = new Float64Array(NT);
  const senT = new Float64Array(NT);
  for (let i = 0; i < NT; i++) {
    const [pm, pv, pz] = local(l, margem[i].ponto);
    rm[i] = Math.hypot(pm - O[0], pv - O[1]);
    zm[i] = pz;
    const d = dirs[i][Math.floor(J / 2)];
    const hm = dot(d, l.m);
    const hv = dot(d, l.v);
    const q = Math.hypot(hm, hv) || 1;
    cosT[i] = hm / q;
    senT[i] = hv / q;
  }
  const raioSuave = Math.max(2, Math.round(NT / 40));
  const rms = suavizarCircular(rm, raioSuave, 3);
  const zms = suavizarCircular(zm, raioSuave, 3);

  // ---------- altura do ponto mais largo em cada lado ----------
  const fracaoDoContorno = (i: number) => {
    const vest = Math.max(0, senT[i]);
    const ling = Math.max(0, -senT[i]);
    return plano.contornoVestibular * vest * vest + plano.contornoLingual * ling * ling + (cosT[i] > 0 ? plano.contatoMesial : plano.contatoDistal) * cosT[i] * cosT[i];
  };
  const tanEmergencia = Math.tan(e.emergencia * GRAU);
  let topoDoPerfil = topoEstimado;
  let contorno: Float64Array = new Float64Array(NT);
  {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < NT; i++) {
      const v = rms[i] * senT[i];
      mn = Math.min(mn, v);
      mx = Math.max(mx, v);
    }
    const bojos = bojosDoCaso(plano, mx - mn);
    for (let i = 0; i < NT; i++) {
      const vest = Math.max(0, senT[i]);
      const ling = Math.max(0, -senT[i]);
      contorno[i] = rms[i] + bojos.vestibular * vest * vest + bojos.lingual * ling * ling + 0.5 * cosT[i] * cosT[i];
    }
  }
  const alturaZc = (i: number, topo: number) => Math.max(zms[i] + 0.6, zms[i] + Math.max(0.8, topo - zms[i]) * fracaoDoContorno(i));
  /** Quanto o contorno vale em cada altura: 0 na margem, 1 no ponto mais largo. */
  const pesoDoContorno = (i: number, z: number, topo: number) => {
    const zb = zms[i];
    const zc = alturaZc(i, topo);
    if (z <= zb) return 0;
    if (z >= zc) return 1;
    const s = (z - zb) / (zc - zb);
    return -2 * s * s * s + 3 * s * s;
  };
  const perfilCom = (r: Float64Array, i: number, z: number, topo: number): number => {
    const zb = zms[i];
    const zc = alturaZc(i, topo);
    let v: number;
    if (z <= zb) {
      v = rms[i];
    } else if (z <= zc) {
      const s = (z - zb) / (zc - zb);
      const s2 = s * s;
      const s3 = s2 * s;
      v = (2 * s3 - 3 * s2 + 1) * rms[i] + (s3 - 2 * s2 + s) * (zc - zb) * tanEmergencia + (-2 * s3 + 3 * s2) * r[i];
    } else {
      const s = (z - zc) / Math.max(0.5, topo - zc);
      v = r[i] - (1 - plano.mesa) * r[i] * s * s;
    }
    // O desenho irregular da margem vale só perto dela: mais acima viraria prega.
    return v + (rm[i] - rms[i]) * (1 - passoSuave(0, ALTURA_DA_MARGEM_IRREGULAR, z - zb));
  };

  // Preparo mais largo em cima que na margem: a parte larga fica fora do cilindro da margem e parece
  // vizinho. Nada que esteja nesta distância é vizinho: é a própria parede.
  const raioDoPreparo = new Float64Array(NT);
  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < J; j++) {
      const [pm, pv] = local(l, interna[i][j]);
      raioDoPreparo[i] = Math.max(raioDoPreparo[i], Math.hypot(pm - O[0], pv - O[1]));
    }
  }
  const ePropriaParede = (i: number, distancia: number) => distancia <= raioDoPreparo[i] + DISTANCIA_DA_PROPRIA_PAREDE;

  // ---------- a parede passa por fora do preparo com a espessura, sem copiar o relevo dele ----------
  for (let passada = 0; passada < 3; passada++) {
    const falta = new Float64Array(NT);
    for (let i = 0; i < NT; i++) {
      for (let j = Math.floor(J * 0.2); j < J; j++) {
        const [pm, pv, pz] = local(l, interna[i][j]);
        const dz = pz - zms[i];
        if (dz < 0.5) continue;
        // Perto da margem a espessura vai diminuindo até a lâmina, como no limite do motor.
        // Na parede vale a espessura axial; o topo é da camada oclusal.
        const pedida = dz < 0.2 ? 0.05 : 0.23 + Math.max(0, e.espessuraMinima - 0.2) * passoSuave(0.2, 1.5, dz);
        const precisa = Math.hypot(pm - O[0], pv - O[1]) + pedida;
        const tem = perfilCom(contorno, i, pz, topoEstimado);
        if (precisa <= tem) continue;
        falta[i] = Math.max(falta[i], (precisa - tem) / Math.max(0.6, pesoDoContorno(i, pz, topoEstimado)));
      }
    }
    let maior = 0;
    for (let i = 0; i < NT; i++) {
      falta[i] = Math.min(falta[i], 0.8);
      maior = Math.max(maior, falta[i]);
    }
    if (maior < 0.02) break;
    const espalhada = suavizarCircular(dilatarCircular(falta, Math.round(NT / 30)), Math.round(NT / 30), 2);
    for (let i = 0; i < NT; i++) contorno[i] += espalhada[i];
  }
  contorno = raioConvexo(contorno, cosT, senT);

  // Mesial e distal vão até o vizinho, numa curva larga: sem isso o contato vira um bico.
  const viz = medirVizinhos(e, l, topoEstimado, plano);
  const larguraAgora = () => {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < NT; i++) {
      const m = contorno[i] * cosT[i];
      mn = Math.min(mn, m);
      mx = Math.max(mx, m);
    }
    return mx - mn;
  };
  // Vizinho longe não estica o dente: é o que faria um incisivo virar uma cabeça em cima de um colo fino.
  let aindaCabe = Math.max(0, plano.larguraMm * FOLGA_NA_LARGURA - larguraAgora());
  for (const [lado, dist] of [[1, viz.mesial], [-1, viz.distal]] as const) {
    if (dist === null) continue;
    let melhor = 0;
    let maiorCos = -Infinity;
    for (let i = 0; i < NT; i++) {
      if (lado * cosT[i] > maiorCos) {
        maiorCos = lado * cosT[i];
        melhor = i;
      }
    }
    // A distância é do centro da margem; o contorno é medido do eixo de O.
    const distDoEixo = dist - lado * O[0];
    if (ePropriaParede(melhor, distDoEixo)) continue;
    const falta = distDoEixo - contorno[melhor];
    if (falta > MAIOR_ALCANCE_DE_CONTATO) continue;
    const passo = falta > 0 ? Math.min(falta, aindaCabe) : falta;
    if (passo > 0) aindaCabe -= passo;
    for (let i = 0; i < NT; i++) {
      const ang = Math.acos(limita(lado * cosT[i], -1, 1));
      contorno[i] += passo * Math.exp(-((ang / ABERTURA_DO_CONTATO) ** 2));
    }
  }
  for (let passada = 0; passada < 3; passada++) {
    const sobra = new Float64Array(NT);
    for (let i = 0; i < NT; i++) {
      const lado = soma(mul(l.m, cosT[i]), mul(l.v, senT[i]));
      for (let z = zms[i] + 1.5; z <= topoEstimado; z += 0.5) {
        const inicio = soma(soma(soma(l.base, mul(l.m, O[0])), mul(l.v, O[1])), mul(l.a, z));
        const h = e.ambiente.raio(inicio, lado, contorno[i] + 1);
        if (!h || ePropriaParede(i, h.t)) continue;
        const tem = perfilCom(contorno, i, z, topoEstimado);
        if (tem > h.t) sobra[i] = Math.max(sobra[i], (tem - h.t) / Math.max(0.4, pesoDoContorno(i, z, topoEstimado)));
      }
    }
    let maior = 0;
    for (let i = 0; i < NT; i++) maior = Math.max(maior, sobra[i]);
    if (maior < 0.02) break;
    const espalhada = suavizarCircular(dilatarCircular(sobra, Math.round(NT / 36)), Math.round(NT / 36), 2);
    for (let i = 0; i < NT; i++) contorno[i] -= Math.min(espalhada[i], 2);
  }
  const contornoSuave = suavizarCircular(contorno, raioSuave, 3);

  // ---------- centro e tamanho vêm do contorno ----------
  let mnM = Infinity;
  let mxM = -Infinity;
  let mnV = Infinity;
  let mxV = -Infinity;
  for (let i = 0; i < NT; i++) {
    const m = O[0] + contornoSuave[i] * cosT[i];
    const v = O[1] + contornoSuave[i] * senT[i];
    mnM = Math.min(mnM, m);
    mxM = Math.max(mxM, m);
    mnV = Math.min(mnV, v);
    mxV = Math.max(mxV, v);
  }
  const md = mxM - mnM;
  const vl = mxV - mnV;
  const cm = (mxM + mnM) / 2;
  const cv = (mxV + mnV) / 2;

  // ---------- limites em cada ponto da face oclusal ----------
  const m0 = cm - md / 2 - FOLGA_DO_MAPA;
  const v0 = cv - vl / 2 - FOLGA_DO_MAPA;
  const largura = md + 2 * FOLGA_DO_MAPA;
  const fundo = vl + 2 * FOLGA_DO_MAPA;
  const lx = Math.ceil(largura / PASSO_DOS_LIMITES) + 1;
  const ly = Math.ceil(fundo / PASSO_DOS_LIMITES) + 1;
  const pontoDaGrade = (m: number, v: number, z: number) => soma(soma(soma(l.base, mul(l.m, m)), mul(l.v, v)), mul(l.a, z));
  const zAnt = new Float64Array(lx * ly).fill(Infinity);
  if (e.antagonista) {
    const baixo = -2;
    for (let y = 0; y < ly; y++) {
      for (let x = 0; x < lx; x++) {
        const h = e.antagonista.raio(pontoDaGrade(m0 + x * PASSO_DOS_LIMITES, v0 + y * PASSO_DOS_LIMITES, baixo), l.a, 40);
        if (h) zAnt[x + y * lx] = baixo + h.t;
      }
    }
  }
  // O lado de dentro já tem o cimento e a broca. Ele dá a camada de espessura.
  const SEM_PREPARO = topoPrep - 6;
  const piso = new Float64Array(lx * ly).fill(SEM_PREPARO);
  const zPrepExiste = new Uint8Array(lx * ly);
  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < J; j++) {
      const [pm, pv, pz] = local(l, interna[i][j]);
      const x = Math.round((pm - m0) / PASSO_DOS_LIMITES);
      const y = Math.round((pv - v0) / PASSO_DOS_LIMITES);
      if (x >= 0 && y >= 0 && x < lx && y < ly) {
        piso[x + y * lx] = Math.max(piso[x + y * lx], pz + e.espessuraOclusal);
        zPrepExiste[x + y * lx] = 1;
      }
    }
  }
  const camada = borrar(dilatar(piso, lx, ly, Math.ceil(ALCANCE_DA_CAMADA / PASSO_DOS_LIMITES)), lx, ly, SUAVIZA_CAMADA / PASSO_DOS_LIMITES);
  if (e.antagonista) camadaSobOAntagonista(camada, piso, zAnt, e.folgaAntagonista + RESERVA_DO_CORTE, lx, ly);

  // ---------- cada cúspide assenta: encosta no antagonista, sem passar da altura de um dente ----------
  const camadaEm = (m: number, v: number) => interpolar(camada, lx, ly, (m - m0) / PASSO_DOS_LIMITES, (v - v0) / PASSO_DOS_LIMITES);
  const antNoPonto = (m: number, v: number) => {
    let menor = Infinity;
    for (const [dm, dv] of [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
      const x = Math.round((m + dm - m0) / PASSO_DOS_LIMITES);
      const y = Math.round((v + dv - v0) / PASSO_DOS_LIMITES);
      if (x >= 0 && y >= 0 && x < lx && y < ly) menor = Math.min(menor, zAnt[x + y * lx]);
    }
    return menor;
  };
  const alturaDeCada = (c: Cuspide) => {
    const natural = c.h * alturaH;
    const m = cm + (c.u * md) / 2;
    const v = cv + (c.w * vl) / 2;
    const limite = antNoPonto(m, v) - e.folgaAntagonista - RESERVA_DO_CORTE;
    const minima = camadaEm(m, v) + 0.1;
    if (limite === Infinity) return Math.max(natural, minima);
    // Mais baixo, encosta. Mais alto até 1,2 mm: sobe para encostar. Além disso, não é contato.
    const alvo = limite < natural ? limite : limite - natural < 1.2 ? limite : natural;
    return Math.max(alvo, minima);
  };
  // A crista do vizinho, um pouco além do nosso contorno. Vizinho muito baixo é preparo ou falha: não vale.
  const medirCristaDoVizinho = (lado: number): number | null => {
    const cima = topoEstimado + 8;
    const alturas: number[] = [];
    for (const d of [0.5, 0.9, 1.3]) {
      for (const dv of [-0.22 * vl, 0, 0.22 * vl]) {
        const h = e.ambiente.raio(pontoDaGrade(cm + lado * (md / 2 + d), cv + dv, cima), mul(l.a, -1), 16);
        if (h) alturas.push(cima - h.t);
      }
    }
    if (alturas.length < 5) return null;
    // Mediana: a crista do vizinho, e não a ponta de uma cúspide dele que caiu na amostra.
    alturas.sort((a, b) => a - b);
    const crista = alturas[Math.floor(alturas.length / 2)];
    return crista >= topoEstimado - ALTURA_MINIMA_DA_CRISTA_VIZINHA ? crista : null;
  };
  const cristaDoVizinho = { mesial: medirCristaDoVizinho(1), distal: medirCristaDoVizinho(-1) };

  // Sem antagonista não há o que encaixar. Com ele, escolhe a posição em que menos precisa descer.
  // Só vale andar se ajudar de verdade: o desenho no meio do dente também conta ponto.
  if (e.antagonista) {
    const razao = md / vl;
    let melhorNota = Infinity;
    let melhor = plano;
    for (const dm of DESLOCA_NO_ENCAIXE) {
      for (const dv of DESLOCA_NO_ENCAIXE) {
        for (const giro of GIROS_NO_ENCAIXE) {
          const movido = moverPlano(planoPedido, (2 * dm) / md, (2 * dv) / vl, giro, razao);
          const r = relevoDoPlano(movido, cm, cv, md, vl, alturaDeCada, alturaH, cristaDoVizinho);
          let sobra = 0;
          for (let y = 0; y < ly; y += 2) {
            for (let x = 0; x < lx; x += 2) {
              const k = x + y * lx;
              if (zAnt[k] === Infinity) continue;
              const dentro = zPrepExiste[k];
              if (!dentro) continue;
              const d = r(m0 + x * PASSO_DOS_LIMITES, v0 + y * PASSO_DOS_LIMITES) - (zAnt[k] - e.folgaAntagonista);
              if (d > 0) sobra += d * d;
            }
          }
          const nota = sobra + 1.2 * Math.hypot(dm, dv) + 0.03 * Math.abs(giro);
          if (nota < melhorNota) {
            melhorNota = nota;
            melhor = movido;
          }
        }
      }
    }
    plano = melhor;
  }
  const relevo = relevoDoPlano(plano, cm, cv, md, vl, alturaDeCada, alturaH, cristaDoVizinho);
  const sulcos = profundidadeDosSulcos(plano, cm, cv, md, vl);

  // A ponta de uma cúspide dele cai entre as células da grade: sem esta margem, quem pega é o corte
  // seco no fim, e sobra uma marca com borda.
  const zAntSeguro = new Float64Array(lx * ly);
  for (let y = 0; y < ly; y++) {
    for (let x = 0; x < lx; x++) {
      let menor = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) menor = Math.min(menor, zAnt[limita(x + dx, 0, lx - 1) + limita(y + dy, 0, ly - 1) * lx]);
      }
      zAntSeguro[x + y * lx] = menor;
    }
  }
  const grossa = new Float64Array(lx * ly);
  const teto = new Float64Array(lx * ly);
  for (let y = 0; y < ly; y++) {
    for (let x = 0; x < lx; x++) {
      const k = x + y * lx;
      grossa[k] = relevo(m0 + x * PASSO_DOS_LIMITES, v0 + y * PASSO_DOS_LIMITES);
      // Onde não há espaço para os dois, quem manda é a espessura.
      teto[k] = zAntSeguro[k] === Infinity ? Infinity : Math.max(zAntSeguro[k] - e.folgaAntagonista - RESERVA_DO_CORTE, camada[k]);
    }
  }
  const descida = descerSobOAntagonista(grossa, teto, lx, ly, PASSO_DOS_LIMITES);
  // Espaço guardado para os sulcos, sem passar do antagonista. Só o teto dele é alisado: se a superfície
  // seguisse o teto cru, copiaria a cúspide dele, que é a marca de mordida de novo. A camada fica de
  // fora: alisá-la junto consome a folga onde ela é curva, e o sulco fica sem onde entrar.
  const pisoLiso = pisoDosSulcos(teto, camada, lx, ly);
  let maiorDescida = 0;
  for (let k = 0; k < descida.length; k++) maiorDescida = Math.max(maiorDescida, descida[k]);

  // ---------- mapa fino: relevo, descida, camada e, por último, os sulcos ----------
  const nx = Math.ceil(largura / PASSO) + 1;
  const ny = Math.ceil(fundo / PASSO) + 1;
  const mapa = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const m = m0 + x * PASSO;
      const v = v0 + y * PASSO;
      const fx = (m - m0) / PASSO_DOS_LIMITES;
      const fy = (v - v0) / PASSO_DOS_LIMITES;
      const c = interpolar(camada, lx, ly, fx, fy);
      const baseH = smax(relevo(m, v) - interpolar(descida, lx, ly, fx, fy), interpolar(pisoLiso, lx, ly, fx, fy), 0.6);
      // Quanto menos espaço acima da camada, mais raso o sulco: um limite seco deixaria uma plaquinha.
      const espaco = Math.max(0.001, baseH - c);
      mapa[x + y * nx] = baseH - espaco * (1 - Math.exp(-sulcos(m, v) / espaco));
    }
  }
  const alturaEm = (m: number, v: number) => interpolar(mapa, nx, ny, (m - m0) / PASSO, (v - v0) / PASSO);

  // ---------- onde cada raio sai do dente ----------
  const topo = Math.max(...plano.cuspides.map(alturaDeCada));
  topoDoPerfil = topo;
  const raios: Float64Array[] = [];
  for (let i = 0; i < NT; i++) {
    const linha = new Float64Array(J + 1);
    for (let j = 0; j < J; j++) {
      const d = dirs[i][j];
      const dm = dot(d, l.m);
      const dv = dot(d, l.v);
      const dz = dot(d, l.a);
      const campo = (t: number) => {
        const m = O[0] + dm * t;
        const v = O[1] + dv * t;
        const z = O[2] + dz * t;
        return smax(Math.hypot(m - O[0], v - O[1]) - perfilCom(contornoSuave, i, z, topoDoPerfil), z - alturaEm(m, v), ARREDONDA_OMBRO);
      };
      let t0 = norma(sub(interna[i][j], prep.O));
      if (campo(t0) >= 0) {
        linha[j] = t0;
        continue;
      }
      let achou = false;
      for (let k = 0; k < 500; k++) {
        const t1 = t0 + PASSO_DO_RAIO;
        if (campo(t1) >= 0) {
          let a = t0;
          let b = t1;
          for (let n = 0; n < 6; n++) {
            const c = (a + b) / 2;
            if (campo(c) >= 0) b = c;
            else a = c;
          }
          linha[j] = (a + b) / 2;
          achou = true;
          break;
        }
        t0 = t1;
      }
      if (!achou) linha[j] = t0;
    }
    linha[J] = norma(sub(margem[i].ponto, prep.O));
    raios.push(linha);
  }
  return { raios, medidas: { md, vl, alturaUsada: topo, maiorDescida } };
}
