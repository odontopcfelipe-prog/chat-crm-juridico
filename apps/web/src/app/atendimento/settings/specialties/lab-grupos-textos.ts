/**
 * Paridade do laboratório — textos da tela de grupos de serviço (Configurações →
 * Comercial). Mesma tela das especialidades da clínica, com os nomes do laboratório.
 *
 * Só texto do LABORATÓRIO. Este arquivo só tem a const LAB_*: fica sob as travas
 * de scripts/ci/check-pick-literals.mjs, e nenhum texto fora dela pode entrar aqui.
 */
export const LAB_GRUPOS = Object.freeze({
  titulo: 'Grupos de serviço',
  descricao: 'Grupos para organizar a tabela de serviços do laboratório (ex: Cerâmica, Sobre implante, Removível, Provisório).',
  novo: 'Novo grupo',
  vazio: 'Nenhum grupo cadastrado.',
  criarPrimeiro: 'Criar primeiro',
  servicos: (n: number) => `${n} serviço(s)`,
  confirmarRemover: (nome: string) => `Remover o grupo "${nome}"? Os serviços dele continuam cadastrados; só o grupo deixa de aparecer nas listas.`,
  removido: 'Grupo removido',
  editarModal: 'Editar grupo',
  novoModal: 'Novo grupo',
  exemploNome: 'Ex: Cerâmica, Sobre implante, Removível',
  descricaoPlaceholder: 'O que esse grupo abrange',
  ativo: 'Grupo ativo',
  atualizado: 'Grupo atualizado',
  criado: 'Grupo criado',
});
