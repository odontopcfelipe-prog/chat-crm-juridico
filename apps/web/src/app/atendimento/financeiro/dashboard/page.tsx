/**
 * Visão Geral · Financeiro (Onda 17.2).
 *
 * Reexporta a dashboard rica completa (KPIs consolidados do
 * escritório, comparacoes, atendimentos encerrados, performance
 * da equipe, charts) que tambem mora em /atendimento/dashboard-completo.
 *
 * Mesma pagina, dois pontos de entrada:
 *  - /atendimento/dashboard-completo (link do "Menu inicial")
 *  - /atendimento/financeiro/dashboard (item Visão Geral do
 *    grupo Financeiro no sidebar)
 *
 * A intencao eh dar acesso direto ao dashboard rico dentro do
 * grupo Financeiro, sem ter que voltar pro Menu inicial e
 * clicar em "Dashboard completo".
 */
export { default } from '../../dashboard/_FullDashboard';
