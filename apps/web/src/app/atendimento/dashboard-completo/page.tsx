/**
 * Dashboard COMPLETO — preservado em rota separada quando a Onda 17
 * promoveu o menu de atalhos pra rota /atendimento/dashboard.
 *
 * Aqui mora a dashboard rica original (KPIs, charts, performance,
 * pipeline, etc.) acessivel via /atendimento/dashboard-completo.
 * O codigo continua em ../dashboard/_FullDashboard.tsx — esse arquivo
 * eh so um re-export pra Next.js reconhecer como rota.
 */
export { default } from '../dashboard/_FullDashboard';
