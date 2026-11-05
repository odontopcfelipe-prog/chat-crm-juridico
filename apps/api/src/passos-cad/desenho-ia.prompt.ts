/**
 * Passos CAD — o pedido à IA. Ela não mexe em malha: devolve um plano (onde ficam as cúspides, as
 * cristas e os sulcos) e o motor, no navegador do técnico, transforma isso em superfície.
 *
 * Tudo que vai no texto passa por `limparPedido`: só números e nomes de uma lista fixa. Assim não há
 * como um campo a mais levar dado do caso, nem um texto vindo da tela virar instrução para a IA.
 */

const LADO_DO_MAPA = 11;
const CAMPOS_DAS_MEDIDAS = ['mdMm', 'vlMm', 'topoDoPreparoMm', 'folgaAntagonistaMm', 'espessuraOclusalMm', 'espessuraAxialMm', 'vizinhoMesialMm', 'vizinhoDistalMm'] as const;
/** Só os nomes que o motor usa. Texto livre aqui viraria instrução para a IA. */
const NOMES_DE_CUSPIDE = new Set([
  'vestibular', 'palatina', 'lingual', 'distal', 'ponta', 'cingulo',
  'mesio-vestibular', 'disto-vestibular', 'mesio-palatina', 'disto-palatina', 'mesio-lingual', 'disto-lingual',
  'borda incisal mesial', 'borda incisal central', 'borda incisal distal',
]);
const LADOS_DE_CRISTA = new Set(['mesial', 'distal']);
/** Só os campos de um plano: qualquer outro não vai. */
const CHAVES_DO_PLANO = new Set([
  'cuspides', 'cristas', 'sulcos', 'centro', 'alturaMm', 'larguraMm', 'vlMm', 'bojoVestibular', 'bojoLingual', 'contornoVestibular', 'contornoLingual', 'contatoMesial', 'contatoDistal', 'mesa',
  'nome', 'u', 'w', 'h', 'de', 'ate', 'hDe', 'hMeio', 'hAte', 'largura', 'lado', 'pontos',
]);
const MAIOR_PLANO_EM_TEXTO = 12_000;

const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

function limparMapa(mapa: unknown[]): (number | null)[][] {
  const linhas: (number | null)[][] = [];
  for (const linha of mapa.slice(0, LADO_DO_MAPA)) {
    linhas.push(Array.isArray(linha) ? linha.slice(0, LADO_DO_MAPA).map(numero) : []);
  }
  return linhas;
}

/** Copia só número, lista e objeto com chaves simples. Texto, só o nome da cúspide. */
function limparPlano(v: unknown, chave = '', profundidade = 0): unknown {
  if (profundidade > 6) return null;
  if (typeof v === 'number') return numero(v);
  if (typeof v === 'string') return (chave === 'nome' && NOMES_DE_CUSPIDE.has(v)) || (chave === 'lado' && LADOS_DE_CRISTA.has(v)) ? v : null;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => limparPlano(x, chave, profundidade + 1));
  if (typeof v === 'object' && v !== null) {
    const saida: Record<string, unknown> = {};
    for (const [k, valor] of Object.entries(v)) {
      if (CHAVES_DO_PLANO.has(k)) saida[k] = limparPlano(valor, k, profundidade + 1);
    }
    return saida;
  }
  return null;
}

export interface PedidoLimpo {
  fdi: number;
  medidas: Record<string, number | null>;
  mapaAntagonista: (number | null)[][];
  mapaPreparo: (number | null)[][];
  planoInicial: unknown;
}

export function limparPedido(p: { fdi: number; medidas: Record<string, unknown>; mapaAntagonista: unknown[]; mapaPreparo: unknown[]; planoInicial: Record<string, unknown> }): PedidoLimpo {
  const medidas: Record<string, number | null> = {};
  for (const campo of CAMPOS_DAS_MEDIDAS) medidas[campo] = numero(p.medidas?.[campo]);
  const planoInicial = limparPlano(p.planoInicial);
  return {
    fdi: p.fdi,
    medidas,
    mapaAntagonista: limparMapa(p.mapaAntagonista),
    mapaPreparo: limparMapa(p.mapaPreparo),
    planoInicial: JSON.stringify(planoInicial).length > MAIOR_PLANO_EM_TEXTO ? null : planoInicial,
  };
}

export const INSTRUCOES = `Você é técnico de prótese dentária e desenha a anatomia de uma coroa unitária.

Você não gera malha. Devolve um plano de cúspides, cristas e sulcos, e um motor geométrico constrói a superfície, o lado de dentro, a margem e a espessura mínima.

COORDENADAS DO PLANO
- u vai de -1 (distal) a 1 (mesial); w vai de -1 (lingual ou palatina) a 1 (vestibular). Os valores são relativos ao contorno do dente.
- h vai de 0 (margem) a 1 (altura natural do dente, em "alturaMm").
- A profundidade de um sulco ("prof") é em mm abaixo do relevo em volta.
- A "largura" de um sulco é em mm: cerca de 0,5 nos principais, 0,3 nos secundários e 0,85 nas fossas rasas. A "largura" de uma crista é relativa (1 = normal).
- "lado" de uma crista: "mesial" ou "distal" na crista marginal daquele lado, e "nenhum" nas outras. O motor põe a crista marginal na altura da do vizinho. Dentes anteriores não têm crista marginal.
- "larguraMm" e "vlMm" são as larguras naturais do dente; "contatoMesial" e "contatoDistal", a altura do contato com cada vizinho (0 = margem, 1 = topo).

MAPAS RECEBIDOS
Cada mapa tem 11 linhas e 11 colunas. A primeira linha é w = 1 (vestibular) e a última w = -1. A primeira coluna é u = -1 (distal) e a última u = 1 (mesial). Os passos são de 0,2. Os valores são alturas em mm acima da margem, e null significa sem dado naquele ponto.
- mapaAntagonista: altura da superfície do dente oposto. Quanto menor o número, mais perto ele está: é uma cúspide dele. Número maior é uma fossa dele.
- mapaPreparo: altura do preparo.

COMO DESENHAR
1. Comece do planoInicial, que já tem a anatomia correta para este dente, e mude só o que o caso pedir.
2. Coloque as pontas das nossas cúspides onde o antagonista está mais alto (a fossa dele) e as nossas fossas e sulcos onde ele está mais baixo (a cúspide dele). Nunca ponta contra ponta.
3. A ponta da cúspide (h × alturaMm) não pode passar da altura do antagonista naquele ponto menos a folgaAntagonistaMm. O motor abaixa o que passar, mas o desenho fica melhor se você já respeitar isso.
4. Toda a face oclusal precisa ficar acima do preparo somado à espessuraOclusalMm (nas paredes vale a espessuraAxialMm). Onde o espaço for pequeno, use relevo mais baixo e sulcos mais rasos.
5. Mantenha a anatomia daquele dente: número de cúspides, proporção entre elas e caminho dos sulcos. Sulcos ligam as fossas e terminam antes da borda.
6. Faça mudanças suaves: é um dente natural, sem pontas agudas, simetria perfeita ou exageros.

Responda só com o JSON pedido.`;

export function textoDoPedido(p: PedidoLimpo): string {
  return `Dente ${p.fdi} (numeração FDI).

Medidas do caso, em mm:
${JSON.stringify(p.medidas)}

mapaAntagonista:
${JSON.stringify(p.mapaAntagonista)}

mapaPreparo:
${JSON.stringify(p.mapaPreparo)}

planoInicial:
${JSON.stringify(p.planoInicial)}`;
}

const numeroJson = { type: 'number' } as const;
const PONTO = { type: 'object', properties: { u: numeroJson, w: numeroJson }, required: ['u', 'w'], additionalProperties: false } as const;

/** Formato da resposta: a API da OpenAI só devolve o que estiver neste esquema. */
export const ESQUEMA_DO_PLANO = {
  type: 'object',
  properties: {
    cuspides: {
      type: 'array',
      items: {
        type: 'object',
        properties: { nome: { type: 'string' }, u: numeroJson, w: numeroJson, h: numeroJson },
        required: ['nome', 'u', 'w', 'h'],
        additionalProperties: false,
      },
    },
    cristas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { de: PONTO, ate: PONTO, hDe: numeroJson, hMeio: numeroJson, hAte: numeroJson, largura: numeroJson, lado: { type: 'string', enum: ['mesial', 'distal', 'nenhum'] } },
        required: ['de', 'ate', 'hDe', 'hMeio', 'hAte', 'largura', 'lado'],
        additionalProperties: false,
      },
    },
    sulcos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          largura: numeroJson,
          pontos: {
            type: 'array',
            items: {
              type: 'object',
              properties: { u: numeroJson, w: numeroJson, prof: numeroJson },
              required: ['u', 'w', 'prof'],
              additionalProperties: false,
            },
          },
        },
        required: ['largura', 'pontos'],
        additionalProperties: false,
      },
    },
    centro: PONTO,
    alturaMm: numeroJson,
    larguraMm: numeroJson,
    vlMm: numeroJson,
    bojoVestibular: numeroJson,
    bojoLingual: numeroJson,
    contornoVestibular: numeroJson,
    contornoLingual: numeroJson,
    contatoMesial: numeroJson,
    contatoDistal: numeroJson,
    mesa: numeroJson,
  },
  required: ['cuspides', 'cristas', 'sulcos', 'centro', 'alturaMm', 'larguraMm', 'vlMm', 'bojoVestibular', 'bojoLingual', 'contornoVestibular', 'contornoLingual', 'contatoMesial', 'contatoDistal', 'mesa'],
  additionalProperties: false,
} as const;
