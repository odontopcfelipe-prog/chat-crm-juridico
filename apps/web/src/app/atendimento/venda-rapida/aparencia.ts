/**
 * Edição básica da Venda Rápida: a cor de cada uma das 4 partes da tela e o tamanho das fotos.
 * Vale por conta (GET/PUT /procedures/aparencia-venda). O padrão é o visual de sempre.
 *
 * Arquivo puro, sem import: o spec __guards__/venda-rapida-aparencia.spec.ts o carrega direto.
 */
export type TamanhoFoto = 'pequeno' | 'medio' | 'grande';

export interface Aparencia {
  cor_cabecalho: string;
  cor_produtos: string;
  cor_destaque: string;
  cor_rodape: string;
  tamanho_foto: TamanhoFoto;
}

export type CampoDeCor = Exclude<keyof Aparencia, 'tamanho_foto'>;

export const APARENCIA_PADRAO: Aparencia = {
  cor_cabecalho: '#ffe600',
  cor_produtos: '#ebebeb',
  cor_destaque: '#ffffff',
  cor_rodape: '#2d3277',
  tamanho_foto: 'medio',
};

/** As 4 partes, na ordem em que aparecem na tela. */
export const PARTES: ReadonlyArray<{ campo: CampoDeCor; rotulo: string; dica: string }> = [
  { campo: 'cor_cabecalho', rotulo: 'Cabeçalho', dica: 'A faixa do topo, com a busca.' },
  { campo: 'cor_produtos', rotulo: 'Produtos', dica: 'O fundo atrás da lista de produtos.' },
  { campo: 'cor_destaque', rotulo: 'Produtos em destaque', dica: 'A faixa do meio. Aparece quando há produto com a estrela marcada em Produtos.' },
  { campo: 'cor_rodape', rotulo: 'Rodapé', dica: 'A faixa do fim da tela.' },
];

/** Cores prontas de cada parte, para um clique. Inclui as 4 do padrão. Fora delas, vale o seletor livre. */
export const CORES_FIXAS: ReadonlyArray<{ cor: string; nome: string }> = [
  { cor: '#ffe600', nome: 'Amarelo' },
  { cor: '#ffffff', nome: 'Branco' },
  { cor: '#ebebeb', nome: 'Cinza' },
  { cor: '#111827', nome: 'Preto' },
  { cor: '#2d3277', nome: 'Marinho' },
  { cor: '#3483fa', nome: 'Azul' },
  { cor: '#00a650', nome: 'Verde' },
  { cor: '#7c3aed', nome: 'Roxo' },
  { cor: '#dc2626', nome: 'Vermelho' },
  { cor: '#ec4899', nome: 'Rosa' },
];

/**
 * Classes completas, para o Tailwind achar no código. "medio" é o tamanho de sempre.
 * Os outros dois medem o espaço que sobra, não a tela: com o menu aberto e o carrinho ao lado,
 * sobra pouco mesmo em tela larga, e o preço quebraria em linhas.
 */
export const TAMANHOS: Record<TamanhoFoto, { rotulo: string; grade: string; foto: string; icone: number }> = {
  pequeno: { rotulo: 'Pequeno', grade: 'grid-cols-[repeat(auto-fill,minmax(125px,1fr))]', foto: 'h-20', icone: 32 },
  medio: { rotulo: 'Médio', grade: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4', foto: 'h-28', icone: 44 },
  grande: { rotulo: 'Grande', grade: 'grid-cols-[repeat(auto-fill,minmax(240px,1fr))]', foto: 'h-48', icone: 64 },
};

const COR_VALIDA = /^#[0-9a-f]{6}$/i;
const TEXTO_ESCURO = 'rgba(0, 0, 0, 0.9)';
const TEXTO_CLARO = '#ffffff';
const MARINHO = '#2d3277';

/** O que veio do servidor ou do navegador: o que não vale fica no padrão. */
export function normalizarAparencia(bruto: unknown): Aparencia {
  const dados = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
  const cor = (campo: CampoDeCor) => {
    const valor = dados[campo];
    return typeof valor === 'string' && COR_VALIDA.test(valor) ? valor.toLowerCase() : APARENCIA_PADRAO[campo];
  };
  const tamanho = dados.tamanho_foto;
  return {
    cor_cabecalho: cor('cor_cabecalho'),
    cor_produtos: cor('cor_produtos'),
    cor_destaque: cor('cor_destaque'),
    cor_rodape: cor('cor_rodape'),
    tamanho_foto: tamanho === 'pequeno' || tamanho === 'medio' || tamanho === 'grande' ? tamanho : APARENCIA_PADRAO.tamanho_foto,
  };
}

/** Luminância relativa (WCAG) de uma cor #rrggbb. */
function luminancia(cor: string): number {
  const canal = (inicio: number) => {
    const c = parseInt(cor.slice(inicio, inicio + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5);
}

/** Texto que dá para ler sobre o fundo escolhido: fica com o de maior contraste. */
export function textoSobre(cor: string): string {
  const l = luminancia(cor);
  return 1.05 / (l + 0.05) > (l + 0.05) / 0.05 ? TEXTO_CLARO : TEXTO_ESCURO;
}

/** Variáveis do venda-skin.css. Só as faixas leem: os cartões continuam brancos com texto escuro. */
export function varsDaAparencia(a: Aparencia): Record<string, string> {
  const textoCabecalho = textoSobre(a.cor_cabecalho);
  const cabecalhoPadrao = a.cor_cabecalho === APARENCIA_PADRAO.cor_cabecalho;
  // A faixa se desfaz no fundo só no visual de sempre. Com cor escolhida, cada parte fica com a sua.
  const fundoDeSempre = cabecalhoPadrao && a.cor_produtos === APARENCIA_PADRAO.cor_produtos;
  return {
    '--vr-cor-cabecalho': a.cor_cabecalho,
    '--vr-texto-cabecalho': textoCabecalho,
    '--vr-contra-cabecalho': textoCabecalho === TEXTO_CLARO ? '#1a1a1a' : '#ffffff',
    '--vr-marca-cabecalho': cabecalhoPadrao ? MARINHO : textoCabecalho,
    '--vr-fundo-conteudo': fundoDeSempre
      ? `linear-gradient(180deg, ${a.cor_cabecalho} 0, ${a.cor_produtos} 170px)`
      : a.cor_produtos,
    '--vr-cor-destaque': a.cor_destaque,
    '--vr-texto-destaque': textoSobre(a.cor_destaque),
    '--vr-cor-rodape': a.cor_rodape,
    '--vr-texto-rodape': textoSobre(a.cor_rodape),
  };
}
