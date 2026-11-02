/**
 * F8 do laboratório — textos da ficha técnica na tabela de serviços
 * (settings/procedures): coluna Prazo da lista e bloco "Ficha técnica" do modal.
 *
 * Só texto do LABORATÓRIO. A clínica nunca vê nada daqui: a página monta os
 * componentes de LabFichaServico.tsx só atrás de `lab && …`. Este arquivo só tem a
 * const LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum
 * texto fora dela pode entrar aqui.
 *
 * Regra das palavras: serviço, elemento, cor e prova.
 */

export const LAB_SERVICOS_FICHA = Object.freeze({
  // ─── Coluna da lista ───
  colunaPrazo: 'Prazo',
  prazoDias: (n: number) => (n === 1 ? '1 dia' : `${n} dias`),
  semPrazo: '—',
  semPrazoDica: 'Sem ficha técnica: abra o serviço para informar o prazo',
  unidades: Object.freeze({
    ELEMENTO: 'Elemento',
    ARCADA: 'Arcada',
    PECA: 'Peça',
  }),
  pedeCorCurto: 'cor',
  temProvaCurto: 'prova',
  garantiaCurta: (n: number) => `garantia ${n} d`,
  separador: ' · ',

  // ─── Bloco do modal ───
  fichaTitulo: 'Ficha técnica',
  fichaDica: 'O prazo, em dias corridos, sugere a entrega prometida no orçamento de trabalho e na venda rápida.',
  prazo: 'Prazo de produção (dias) *',
  prazoPlaceholder: 'Ex: 7',
  garantia: 'Garantia (dias)',
  garantiaPlaceholder: 'opcional',
  unidade: 'Unidade',
  materialPadrao: 'Material padrão (opcional)',
  materialPadraoPlaceholder: 'Ex: Zircônia',
  pedeCor: 'Pede a cor',
  temProva: 'Tem prova',

  // ─── Erros ───
  erros: Object.freeze({
    prazo: (max: number) => `Informe o prazo de produção em dias (de 0 a ${max}).`,
    garantia: (max: number) => `Garantia: um número de dias de 0 a ${max}, ou deixe em branco.`,
    salvar: 'O serviço foi salvo, mas a ficha técnica não. Abra o serviço e salve de novo.',
    carregar: 'Não foi possível carregar as fichas técnicas dos serviços.',
    carregarUma: 'Não foi possível carregar a ficha técnica deste serviço. O serviço pode ser salvo e a ficha fica como está.',
  }),
  fichaCarregando: 'Carregando a ficha técnica…',
});
