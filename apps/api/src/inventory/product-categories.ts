/**
 * Categorias de produto do estoque, por conta. Antes era uma lista FIXA de
 * códigos (odonto + estética facial) e a API recusava qualquer outra.
 *
 * Product.category guarda o NOME da categoria. Os códigos antigos viram nome
 * na primeira leitura das categorias da conta, e a clínica ganha a lista antiga
 * como sugestão inicial. Laboratório não ganha a lista de clínica: só as que os
 * produtos dele já usavam.
 */
export const CATEGORIAS_ANTIGAS: Readonly<Record<string, string>> = Object.freeze({
  ANESTESICO: 'Anestésico',
  RESINA: 'Resina',
  BRACKETS: 'Brackets',
  EQUIPAMENTO: 'Equipamento',
  DESCARTAVEL: 'Descartável',
  TOXINA_BOTULINICA: 'Toxina botulínica',
  ACIDO_HIALURONICO: 'Ácido hialurônico',
  BIOESTIMULADOR: 'Bioestimulador',
  FIO_PDO: 'Fio PDO',
  FIO_PLLA: 'Fio PLLA',
  ENZIMA: 'Enzima',
  PEELING_QUIMICO: 'Peeling químico',
  SKINBOOSTER: 'Skinbooster',
  ANESTESICO_TOPICO: 'Anestésico tópico',
  COSMETICO: 'Cosmético',
  OUTRO: 'Outro',
});

export const NOME_CATEGORIA_MAX = 60;

/** Espaços aparados/colapsados. Código antigo (tela velha em cache) vira o nome. Vazio → null. */
export function normalizarCategoria(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  const limpo = String(valor).trim().replace(/\s+/g, ' ');
  if (!limpo) return null;
  return CATEGORIAS_ANTIGAS[limpo] ?? limpo;
}
