/**
 * Termos de uso e política de privacidade — formato comum dos dois documentos
 * e os dados da empresa que aparecem neles.
 *
 * Os textos ficam em termos-de-uso.ts e politica-de-privacidade.ts; a página
 * que mostra os dois é o PaginaLegal.tsx. Para mudar um texto, mude só o
 * arquivo do documento e a versão (data) dele em packages/shared/src/documentos-legais.ts:
 * é a data que a página mostra e a que o aceite do cadastro grava.
 */

/** Parágrafo simples ou lista de itens. */
export type BlocoLegal = string | { readonly lista: readonly string[] };

export interface SecaoLegal {
  /** Âncora da seção (vai no endereço: /termos#conta). */
  readonly id: string;
  readonly titulo: string;
  readonly blocos: readonly BlocoLegal[];
}

export interface DocumentoLegal {
  readonly titulo: string;
  /** Data da versão em vigor, por extenso. */
  readonly atualizadoEm: string;
  /** "Em resumo": pontos principais, em linguagem simples. */
  readonly resumo: readonly string[];
  readonly secoes: readonly SecaoLegal[];
}

/**
 * Dados de quem mantém a plataforma. Razão social, CNPJ e endereço só aparecem
 * nas páginas quando preenchidos.
 */
export const EMPRESA_DA_PLATAFORMA = Object.freeze({
  marca: 'Odonto System',
  razaoSocial: '',
  cnpj: '',
  endereco: '',
  email: 'suporte@odontosystem.com.br',
});

/** Linha de identificação da empresa (vazia enquanto não houver razão social). */
export function identificacaoDaEmpresa(): string {
  const e = EMPRESA_DA_PLATAFORMA;
  if (!e.razaoSocial) return '';
  const partes = [e.razaoSocial, e.cnpj && `CNPJ ${e.cnpj}`, e.endereco].filter(Boolean);
  return `${e.marca} é mantido por ${partes.join(', ')}.`;
}
