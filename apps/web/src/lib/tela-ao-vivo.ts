/**
 * Tela ao vivo: o que o navegador da pessoa acompanhada e o do dono do sistema
 * combinam. O servidor confere de novo (apps/api/src/gateway/tela-ao-vivo.service.ts).
 */

/** Abaixo do limite do servidor, que fica abaixo de 1 MB por mensagem do socket. */
export const TAMANHO_DO_PEDACO = 150_000;
export const MAX_PEDACOS_POR_LOTE = 400;

export interface QuadroRecebido {
  aba: string;
  lote: number;
  parte: number;
  total: number;
  dados: string;
}

export function emPedacos(texto: string, tamanho = TAMANHO_DO_PEDACO): string[] {
  const pedacos: string[] = [];
  for (let i = 0; i < texto.length; i += tamanho) pedacos.push(texto.slice(i, i + tamanho));
  return pedacos;
}

/** A tela anterior de cada tela do Admin SaaS: o "Voltar" sobe um nível. */
export function telaAnteriorDoAdmin(caminho: string): string {
  const daTela = caminho.match(/^\/admin\/tenants\/([^/]+)\/usuarios\/[^/]+\/tela\/?$/);
  if (daTela) return `/admin/tenants/${daTela[1]}`;
  if (/^\/admin\/tenants\/[^/]+\/?$/.test(caminho)) return '/admin/tenants';
  if (caminho.startsWith('/admin/settings')) return '/admin/tenants';
  return '/atendimento';
}
