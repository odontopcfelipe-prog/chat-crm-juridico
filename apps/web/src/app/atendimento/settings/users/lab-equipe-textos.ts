/**
 * F5 do laboratório — textos da tela de equipe (Configurações → Usuários & Perfis)
 * na conta de laboratório.
 *
 * Só texto. A tela escolhe `lab ? LAB_EQUIPE.x : 'texto de sempre'`, então a
 * clínica continua vendo a tela de hoje. O arquivo só tem esta const LAB_* e fica
 * sob as travas de scripts/ci/check-pick-literals.mjs.
 *
 * `permissoes` traz o nome e a descrição de cada permissão que a conta de
 * laboratório ajusta nesta tela. Permissão sem texto aqui é de tela que o
 * laboratório não abre (prontuário e anotações clínicas) e não aparece na
 * lista do laboratório; o que já está gravado no usuário não muda.
 */
import type { Permission } from '@crm/shared';

/** Pontuação do jogo no cadastro do protético (só as regras que valem no laboratório). */
export const LAB_PONTUACAO = Object.freeze({
  pontos: Object.freeze({
    procedimento: Object.freeze({ label: 'Serviço executado', desc: 'Cada item do trabalho que ele marca como feito' }),
    avaliacao: Object.freeze({ label: 'Orçamento montado', desc: 'Cada orçamento de trabalho que ele monta' }),
    conversao: Object.freeze({ label: 'Orçamento que virou trabalho', desc: 'Cada orçamento dele aceito pelo cliente' }),
    missao: Object.freeze({ label: 'Missão da semana cumprida', desc: 'Cada missão batida na semana' }),
  }),
});

export const LAB_EQUIPE: Readonly<{
  ajudaSetor: string;
  tambemProtetico: string;
  tambemProteticoDesc: string;
  tambemAdmin: string;
  tambemAdminDesc: string;
  remuneracaoAjuda: string;
  grupos: Readonly<Record<string, string>>;
  permissoes: Readonly<Partial<Record<Permission, Readonly<{ label: string; description: string }>>>>;
}> = Object.freeze({
  ajudaSetor:
    'Escolha o setor — é a única escolha de cadastro. Ele define o perfil de acesso, os atalhos do Início e as permissões que já vêm marcadas. O menu completo é só do Administrador. Você pode ajustar permissões individualmente abaixo. Protético que também é administrador? Escolha um dos dois e marque a opção que aparece abaixo dos cards.',
  tambemProtetico: '🦷 Também produz como Protético',
  tambemProteticoDesc: 'Aparece como protético responsável nos trabalhos, mantendo o acesso total de administrador.',
  tambemAdmin: '👑 Também é Administrador(a)',
  tambemAdminDesc:
    'Ganha acesso total (menu completo e todas as permissões) sem deixar de produzir como protético. O setor passa a ser Administrador.',
  remuneracaoAjuda: 'A diária vira despesa no caixa quando paga. Deixe vazio se não houver.',
  grupos: Object.freeze({
    paciente: '👤 Dentistas',
    agenda: '📅 Agenda',
    chat: '💬 Chat / WhatsApp',
    clinico: '🛠 Orçamento e produção',
    financeiro: '💰 Financeiro',
    marketing: '📢 Comercial e marketing',
    sistema: '⚙ Sistema',
  }),
  permissoes: Object.freeze({
    view_patients: Object.freeze({ label: 'Ver dentistas', description: 'Lista de clientes e ficha básica' }),
    edit_patients: Object.freeze({
      label: 'Cadastrar e editar dentistas',
      description: 'Criar ficha, alterar dados e adicionar etiquetas',
    }),
    view_all_patients: Object.freeze({
      label: 'Ver todos os dentistas',
      description: 'Sem isso, vê só os clientes dele (protético responsável ou com trabalho dele)',
    }),
    view_patient_contact: Object.freeze({
      label: 'Ver contato do dentista',
      description: 'Telefone/WhatsApp, e-mail e endereço',
    }),
    view_agenda: Object.freeze({ label: 'Ver agenda', description: 'Coletas, provas e entregas marcadas' }),
    manage_agenda: Object.freeze({
      label: 'Gerenciar agenda',
      description: 'Marcar, remarcar e cancelar coletas, provas e entregas',
    }),
    create_evaluation: Object.freeze({
      label: 'Montar orçamento',
      description: 'Montar orçamentos de trabalho e usar o Passos CAD',
    }),
    view_chat: Object.freeze({ label: 'WhatsApp', description: 'Conversas, leads e atendimento' }),
    view_financial: Object.freeze({ label: 'Ver financeiro', description: 'Boletos, parcelas e recebimentos' }),
    manage_financial: Object.freeze({
      label: 'Gerenciar cobranças',
      description: 'Emitir, cancelar e reverter cobranças',
    }),
    view_proposals: Object.freeze({
      label: 'Ver vendas (só leitura)',
      description: 'Acompanhar as vendas dos clientes sem editar nem encaminhar',
    }),
    manage_proposals: Object.freeze({
      label: 'Venda rápida',
      description: 'Registrar venda de balcão (sem orçamento)',
    }),
    override_price: Object.freeze({
      label: 'Alterar preço na venda',
      description: 'Dar desconto (preço abaixo da tabela) na Venda Rápida',
    }),
    view_values: Object.freeze({
      label: 'Ver valores',
      description: 'Preços, totais das vendas e débitos do cliente',
    }),
    view_reports: Object.freeze({
      label: 'Ver relatórios',
      description: 'Painéis e relatórios do laboratório',
    }),
    view_marketing: Object.freeze({
      label: 'Comercial e marketing',
      description: 'Funil comercial, afiliados, indicação e influenciadores',
    }),
    manage_inventory: Object.freeze({
      label: 'Gerenciar estoque',
      description: 'Dar entrada, saída e ajuste de saldo no estoque',
    }),
    operate_cash: Object.freeze({
      label: 'Operar caixa',
      description: 'Lançar entradas/saídas e fechar o caixa do dia (sem mexer em cobranças)',
    }),
    manage_payables: Object.freeze({
      label: 'Contas a pagar',
      description: 'Cadastrar/pagar contas fixas, parceladas e gastos do dia (só adm/gerente)',
    }),
    manage_users: Object.freeze({
      label: 'Gerenciar usuários',
      description: 'Criar e editar usuários do laboratório',
    }),
    view_settings: Object.freeze({ label: 'Ver configurações', description: 'Visualizar abas de Configurações' }),
    manage_settings: Object.freeze({
      label: 'Editar configurações',
      description: 'Mudar identidade do laboratório, integrações, etc',
    }),
  }),
});
