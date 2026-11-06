/**
 * Paridade do laboratório — textos do bloco "Materiais" do serviço na tabela de
 * serviços (insumos do estoque que a Venda rápida baixa a cada venda).
 *
 * Só texto do LABORATÓRIO. A clínica vê os textos de sempre de
 * MateriaisProcedimento.tsx. Este arquivo só tem a const LAB_*: fica sob as travas
 * de scripts/ci/check-pick-literals.mjs, e nenhum texto fora dela pode entrar aqui.
 */
export const LAB_MATERIAIS = Object.freeze({
  explicacao: 'Cada vez que este serviço é vendido na Venda rápida, estes materiais saem do estoque. Com elementos marcados, conta uma vez por elemento.',
  nenhum: 'Nenhum material ligado: a venda rápida não baixa nada do estoque para este serviço.',
  ligado: (nome: string) => `${nome} ligado ao serviço`,
  soQuemGerencia: 'Só quem gerencia o estoque pode mudar os materiais deste serviço.',
});
