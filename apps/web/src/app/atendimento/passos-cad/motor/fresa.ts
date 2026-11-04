/**
 * Passos CAD — compensação de fresa: o lado de dentro da coroa precisa caber a broca.
 *
 * A broca é uma bola. Numa quina viva do preparo ela não chega ao fundo: fica material ali, e a
 * coroa não assenta. Por isso, para cada ponto que a bola não alcança, acha o lugar mais perto
 * onde ela cabe sem cortar nada e avança só o que falta até o ponto: o que ela corta a mais sai da
 * coroa. É o mesmo que a broca faria na fresadora. Sulcos do preparo não precisam disso: ali a
 * bola cabe sobrando.
 */
import { Bvh, dot, malhaDaGrade, mul, norma, normaisDeVertice, passoSuave, soma, sub, unit, type Malha, type V3 } from './geo';
import type { PontoMargem, Preparo } from './margem';

export interface EntradaFresa {
  /** Lado de dentro: colunas × (J+1) pontos; linha 0 = polo, linha J = margem. */
  interna: V3[][];
  /** Distância até a margem, descendo pelo preparo, por coluna e linha. */
  arco: Float64Array[];
  margem: Pick<PontoMargem, 'ph'>[];
  prep: Pick<Preparo, 'O' | 'a' | 'e1' | 'e2'>;
  J: number;
  /** Diâmetro da menor broca que entra no lado de dentro (mm); 0 = sem compensação. */
  diametro: number;
}

export interface ResultadoFresa {
  interna: V3[][];
  /** Quanto a parede afina em cada ponto, medido na direção da espessura (o raio pode vir de lado). */
  corte: Float64Array[];
  /** Pontos onde a broca não alcançaria sem cortar a mais. */
  pontos: number;
  maiorCorte: number;
}

/** Maior broca que faz sentido no lado de dentro de uma coroa (mm). */
export const MAIOR_BROCA = 3;

/** Valor digitado: de 0 até a maior broca. Campo vazio ou texto não valem, e o valor anterior fica. */
export function normalizarBroca(texto: string): number | null {
  if (texto.trim() === '') return null;
  const v = Number(texto);
  return Number.isFinite(v) ? Math.min(MAIOR_BROCA, Math.max(0, v)) : null;
}

/** Abaixo disto é ruído do escaneamento, não uma quina. */
const FOLGA_DA_MEDIDA = 0.015;
/** Até aqui da margem nada muda; a partir daqui o corte vale inteiro. A linha da margem é sagrada. */
const MARGEM_INTACTA = 0.2;
const MARGEM_LIVRE = 0.6;
const EMPURROES = 8;
const PASSO_DAS_BOLAS = 0.015;

function malhaInterna(interna: V3[][], J: number): { malha: Malha; normal: (i: number, j: number) => V3 } {
  const malha = malhaDaGrade(interna, J);
  const n = normaisDeVertice(malha);
  const NT = interna.length;
  const id = (i: number, j: number) => (j === 0 ? 0 : 1 + i * J + (j - 1));
  // A normal numa região do tamanho de alguns pontos: numa quina, ela fica entre as duas faces.
  const normal = (i: number, j: number): V3 => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let di = -2; di <= 2; di++) {
      const c = (i + di + NT) % NT;
      for (let l = Math.max(0, j - 2); l <= Math.min(J, j + 2); l++) {
        const v = id(c, l);
        x += n[3 * v];
        y += n[3 * v + 1];
        z += n[3 * v + 2];
      }
    }
    return unit([x, y, z]);
  };
  return { malha, normal };
}

/**
 * Centro da bola que alcança o ponto cortando o mínimo, ou null se ela alcança sem cortar nada.
 * Parte da bola encostada no ponto e a empurra para longe do que ela fura, até caber.
 */
function bolaParaAlcancar(bvh: Bvh, x: V3, n: V3, raio: number): V3 | null {
  let c = sub(x, mul(n, raio));
  const encostada = c;
  let q = bvh.proximo(c, raio);
  if (!q || Math.abs(q.d) >= raio - FOLGA_DA_MEDIDA) return null;
  let coube = false;
  for (let it = 0; it < EMPURROES && !coube; it++) {
    // Do outro lado da superfície (preparo mais fino que a broca), a saída é pela normal dela.
    const saida = q.d < 0 && Math.abs(q.d) > 1e-9 ? unit(sub(c, q.ponto)) : mul(q.normal, -1);
    c = soma(q.ponto, mul(saida, raio));
    const novo = bvh.proximo(c, raio);
    if (!novo || Math.abs(novo.d) >= raio - FOLGA_DA_MEDIDA / 2) coube = true;
    else q = novo;
  }
  const ateX = sub(x, c);
  const d = norma(ateX);
  // A bola só alcança sem cortar se coube mesmo: preparo fino demais nunca cabe.
  if (coube && d <= raio + FOLGA_DA_MEDIDA) return null;
  return d > 1e-9 ? sub(x, mul(unit(ateX), raio)) : encostada;
}

/** Pontos que a broca não alcança sem cortar a mais, com a bola que resolve cada um. */
function pontosSemAlcance(entrada: Pick<EntradaFresa, 'interna' | 'arco' | 'J'>, raio: number, malha: Malha, normal: (i: number, j: number) => V3): { i: number; j: number; centro: V3 }[] {
  const { interna, arco, J } = entrada;
  const bvh = new Bvh(malha);
  const saida: { i: number; j: number; centro: V3 }[] = [];
  const NT = interna.length;
  const visto = new Uint8Array(NT * (J + 1));
  const testar = (i: number, j: number) => {
    if (j < 0 || j >= J || (j === 0 && i !== 0) || visto[i * (J + 1) + j]) return;
    visto[i * (J + 1) + j] = 1;
    if (arco[i][j] < MARGEM_INTACTA) return;
    const centro = bolaParaAlcancar(bvh, interna[i][j], normal(i, j), raio);
    if (centro) saida.push({ i, j, centro });
  };
  // A bola é bem maior que o passo da grade: um ponto a cada dois acha toda quina. Em volta do que
  // não coube, testa todos. Assim a maior parte da superfície, que é lisa, não custa nada.
  for (let i = 0; i < NT; i += 2) for (let j = 0; j < J; j += 2) testar(i, j);
  const achados = saida.length;
  for (let k = 0; k < achados; k++) {
    const { i, j } = saida[k];
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) testar((i + di + NT) % NT, j + dj);
  }
  return saida;
}

/** Conferência: quantos pontos a broca ainda não alcança nesta superfície. */
export function contarSemAlcance(interna: V3[][], arco: Float64Array[], J: number, diametro: number): number {
  const { malha, normal } = malhaInterna(interna, J);
  return pontosSemAlcance({ interna, arco, J }, diametro / 2, malha, normal).length;
}

export function compensarFresa(e: EntradaFresa): ResultadoFresa {
  const { interna, arco, margem, prep, J, diametro } = e;
  const NT = interna.length;
  const corte = interna.map(() => new Float64Array(J + 1));
  if (!(diametro > 0)) return { interna, corte, pontos: 0, maiorCorte: 0 };
  const raio = diametro / 2;
  const { malha, normal } = malhaInterna(interna, J);
  const bolas = pontosSemAlcance(e, raio, malha, normal);
  if (!bolas.length) return { interna, corte, pontos: 0, maiorCorte: 0 };

  const { O, a, e1, e2 } = prep;
  const direcao = interna.map((col) => col.map((p) => unit(sub(p, O))));
  const dentro = interna.map((col) => Float64Array.from(col, (p) => norma(sub(p, O))));
  const novo = dentro.map((r) => r.slice());
  const passoTheta = (2 * Math.PI) / NT;

  // Preparo mais fino que a broca junta muitas bolas quase no mesmo lugar: uma basta.
  const jaFeitas = new Set<string>();
  for (const { centro } of bolas) {
    const lugar = `${Math.round(centro[0] / PASSO_DAS_BOLAS)},${Math.round(centro[1] / PASSO_DAS_BOLAS)},${Math.round(centro[2] / PASSO_DAS_BOLAS)}`;
    if (jaFeitas.has(lugar)) continue;
    jaFeitas.add(lugar);
    const v = sub(centro, O);
    const dist = norma(v);
    const contemO = dist <= raio;
    // Só os pontos cujo raio pode cruzar a bola: a conta inteira seria cara demais.
    const abertura = contemO ? Math.PI : Math.asin(raio / dist);
    const phi = contemO ? 0 : Math.acos(Math.min(1, Math.max(-1, dot(v, a) / dist)));
    // Perto do polo, ou com bola grande demais, todas as colunas podem cruzar a bola.
    const senoMenor = Math.min(Math.sin(phi - abertura), Math.sin(phi + abertura));
    const largura = contemO || phi - abertura < 0.02 || senoMenor < 0.02 ? NT : Math.ceil(abertura / senoMenor / passoTheta) + 1;
    const todas = 2 * largura + 1 >= NT;
    const i0 = Math.round((Math.atan2(dot(v, e2), dot(v, e1)) + 2 * Math.PI) / passoTheta);
    const quantas = todas ? NT : 2 * largura + 1;
    for (let q = 0; q < quantas; q++) {
      const i = todas ? q : (i0 - largura + q + NT) % NT;
      const passoPhi = margem[i].ph / J;
      // Folga: o cimento e o preenchimento de retenção tiram o ponto um pouco da sua linha.
      const jMin = Math.max(0, Math.floor((phi - abertura) / passoPhi) - 3);
      const jMax = Math.min(J - 1, Math.ceil((phi + abertura) / passoPhi) + 3);
      for (let j = jMin; j <= jMax; j++) {
        const d = direcao[i][j];
        const b = d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
        const disc = b * b - (dist * dist - raio * raio);
        if (disc <= 0) continue;
        // Até a saída da bola, mesmo se ela começa um pouco além do ponto: a superfície tem um
        // só valor por raio, e na borda do corte não dá para deixar material solto entre os dois.
        const t = b + Math.sqrt(disc);
        if (t > novo[i][j]) novo[i][j] = t;
      }
    }
  }

  // O polo é um ponto só, mesmo aparecendo em todas as colunas.
  let polo = 0;
  for (let i = 0; i < NT; i++) polo = Math.max(polo, novo[i][0]);
  for (let i = 0; i < NT; i++) novo[i][0] = polo;

  let maiorCorte = 0;
  const saida = interna.map((col, i) =>
    col.map((p, j) => {
      if (j === J) return p;
      const c = (novo[i][j] - dentro[i][j]) * passoSuave(MARGEM_INTACTA, MARGEM_LIVRE, arco[i][j]);
      if (c <= 0) return p;
      corte[i][j] = c * Math.abs(dot(direcao[i][j], normal(i, j)));
      maiorCorte = Math.max(maiorCorte, corte[i][j]);
      return soma(p, mul(direcao[i][j], c));
    }),
  );
  return { interna: saida, corte, pontos: bolas.length, maiorCorte };
}
