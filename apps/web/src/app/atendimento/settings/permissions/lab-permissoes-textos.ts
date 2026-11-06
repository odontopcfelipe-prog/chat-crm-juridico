/**
 * Paridade do laboratório — textos da tela de Permissões (matriz de acesso por
 * perfil). O nome dos perfis vem de LAB_ROLE_LABELS (@crm/shared); aqui ficam só
 * as linhas da matriz que o laboratório tem aberto.
 *
 * Só texto do LABORATÓRIO. Este arquivo só tem a const LAB_*: fica sob as travas
 * de scripts/ci/check-pick-literals.mjs, e nenhum texto fora dela pode entrar aqui.
 */

type Nivel = 'full' | 'partial' | 'none';

export const LAB_PERMISSOES_MATRIZ: ReadonlyArray<Readonly<{
  label: string;
  description: string;
  permissions: Readonly<Record<'ADMIN' | 'DENTIST' | 'OPERADOR' | 'ASSISTANT', Nivel>>;
}>> = Object.freeze([
  {
    label: 'Painel',
    description: 'Painel com métricas e visão geral do laboratório',
    permissions: { ADMIN: 'full', DENTIST: 'full', OPERADOR: 'none', ASSISTANT: 'none' },
  },
  {
    label: 'Conversas — Prospecção',
    description: 'Conversas com dentistas e clínicas que ainda não são clientes',
    permissions: { ADMIN: 'full', DENTIST: 'none', OPERADOR: 'partial', ASSISTANT: 'partial' },
  },
  {
    label: 'Conversas — Clientes',
    description: 'Conversas com dentistas e clínicas que já enviam trabalhos',
    permissions: { ADMIN: 'full', DENTIST: 'partial', OPERADOR: 'partial', ASSISTANT: 'none' },
  },
  {
    label: 'Contatos',
    description: 'Lista de todos os contatos',
    permissions: { ADMIN: 'full', DENTIST: 'partial', OPERADOR: 'partial', ASSISTANT: 'none' },
  },
  {
    label: 'Agenda',
    description: 'Coletas, provas e entregas dos trabalhos',
    permissions: { ADMIN: 'full', DENTIST: 'partial', OPERADOR: 'none', ASSISTANT: 'partial' },
  },
  {
    label: 'Funil comercial',
    description: 'Gestão do funil de captação de dentistas e consultórios',
    permissions: { ADMIN: 'full', DENTIST: 'partial', OPERADOR: 'partial', ASSISTANT: 'none' },
  },
  {
    label: 'Tarefas',
    description: 'Gerenciamento de tarefas',
    permissions: { ADMIN: 'full', DENTIST: 'partial', OPERADOR: 'partial', ASSISTANT: 'partial' },
  },
  {
    label: 'Relatórios e painéis',
    description: 'Relatórios e métricas do laboratório',
    permissions: { ADMIN: 'full', DENTIST: 'none', OPERADOR: 'none', ASSISTANT: 'none' },
  },
  {
    label: 'Sequências, campanhas e automações',
    description: 'Mensagens e regras automáticas do laboratório',
    permissions: { ADMIN: 'full', DENTIST: 'none', OPERADOR: 'none', ASSISTANT: 'none' },
  },
  {
    label: 'Configurações',
    description: 'Ajustes gerais do laboratório',
    permissions: { ADMIN: 'full', DENTIST: 'none', OPERADOR: 'none', ASSISTANT: 'none' },
  },
  {
    label: 'Usuários & Perfis',
    description: 'Criar e editar a equipe do laboratório',
    permissions: { ADMIN: 'full', DENTIST: 'none', OPERADOR: 'none', ASSISTANT: 'none' },
  },
]);
