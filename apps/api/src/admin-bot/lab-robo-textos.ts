/**
 * Robô de comando dos ADMs na conta de LABORATÓRIO: prompt e ferramentas. Só os ADMs da
 * própria conta, pelo chip dela. Regras do arquivo (scripts/ci/check-pick-literals.mjs):
 * só consts LAB_.
 */
import { TIPOS_SO_DO_LABORATORIO } from '@crm/shared';

export const LAB_ROBO = Object.freeze({
  prompt: (hoje: string, hora: string) => `Você é o assistente administrativo do laboratório de prótese, acessível pelo WhatsApp pelo administrador da conta.

Hoje: ${hoje} às ${hora} (horário de Brasília)

O QUE VOCÊ PODE FAZER:
- Criar tarefas
- Marcar coleta, prova ou entrega na agenda
- Listar as tarefas pendentes do usuário
- Buscar clientes (dentistas e consultórios)
- Resumo financeiro (receitas, despesas, saldo, atrasados)
- Cadastrar despesas e receitas avulsas

COMO RESPONDER:
- Português brasileiro, direto, mensagens curtas.
- Uma pergunta por vez. Listas numeradas para o usuário escolher.
- Confirme ações feitas com ✅. Para cancelar, o usuário digita "cancelar".

DATAS (fuso de Maceió):
- "amanhã às 14h" é o próximo dia, 14:00. "sexta" é a próxima sexta-feira. "15/04" é 15 de abril.
- Tarefa: vencimento em ISO 8601 com fuso -03:00.
- Agenda: início no formato AAAA-MM-DDTHH:MM:00, hora de Maceió, sem fuso.

CRIAR TAREFA: busque o cliente (search_leads), confirme título e vencimento, crie (create_task) e confirme.
MARCAR VISITA: identifique coleta, prova ou entrega, busque o cliente, pergunte dia e hora, crie (create_calendar_event) e confirme.
REGISTRAR DESPESA: pergunte descrição, valor e categoria, crie (create_expense) e confirme.
RESUMO FINANCEIRO: pergunte o período se não veio, consulte (financial_summary) e apresente os números.

Só existe a própria conta: nunca fale de outro laboratório.`,
  responsavelFora: 'Responsável não encontrado neste laboratório.',
  clienteFora: 'Cliente não encontrado neste laboratório.',
  ferramentaFechada: 'Esta função não está disponível para o laboratório.',
  semCliente: 'Nenhum cliente encontrado com esse nome.',
});

/** Ferramentas oferecidas ao modelo na conta de laboratório. */
export const LAB_ROBO_FERRAMENTAS: any[] = [
  {
    type: 'function',
    function: {
      name: 'search_leads',
      description: 'Busca clientes (dentistas e consultórios) pelo nome. Use para achar o ID do cliente.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Nome ou parte do nome' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_users',
      description: 'Lista os usuários do laboratório para atribuição.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Cria uma tarefa. Use somente depois de ter todas as informações.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título claro e objetivo' },
          description: { type: 'string', description: 'Detalhes (opcional)' },
          lead_id: { type: 'string', description: 'ID do cliente (opcional)' },
          assigned_user_id: { type: 'string', description: 'ID do responsável (opcional; padrão: o usuário atual)' },
          due_at: { type: 'string', description: 'Vencimento em ISO 8601 com fuso -03:00' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Marca uma coleta, prova, entrega, tarefa ou outro compromisso na agenda do laboratório.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título do evento' },
          type: { type: 'string', enum: [...TIPOS_SO_DO_LABORATORIO, 'TAREFA', 'OUTRO'], description: 'Tipo do evento' },
          start_at: { type: 'string', description: 'Início no formato AAAA-MM-DDTHH:MM:00, hora de Maceió, sem fuso' },
          lead_id: { type: 'string', description: 'ID do cliente (opcional)' },
          assigned_user_id: { type: 'string', description: 'ID do responsável (opcional)' },
        },
        required: ['title', 'type', 'start_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_my_tasks',
      description: 'Lista as tarefas pendentes do usuário atual.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Máximo de tarefas (padrão: 10)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'financial_summary',
      description: 'Resumo financeiro do laboratório: receitas, despesas, saldo e atrasados.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['hoje', 'semana', 'mes', 'trimestre', 'ano'], description: 'Período (padrão: mes)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_expense',
      description: 'Cadastra uma despesa do laboratório.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Descrição da despesa' },
          amount: { type: 'number', description: 'Valor em reais' },
          category: {
            type: 'string',
            enum: ['Aluguel', 'Materiais e insumos', 'Serviços terceirizados', 'Folha de Pagamento', 'Contas (agua/luz/internet)', 'Equipamentos e manutenção', 'Entrega e transporte', 'Outros'],
            description: 'Categoria',
          },
          date: { type: 'string', description: 'Data ISO 8601 (opcional; padrão: hoje)' },
        },
        required: ['description', 'amount', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_revenue',
      description: 'Registra uma receita avulsa do laboratório.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Descrição da receita' },
          amount: { type: 'number', description: 'Valor em reais' },
          category: { type: 'string', enum: ['Serviços de prótese', 'Consertos e ajustes', 'Outros'], description: 'Categoria' },
          date: { type: 'string', description: 'Data ISO 8601 (opcional; padrão: hoje)' },
          lead_id: { type: 'string', description: 'ID do cliente (opcional)' },
        },
        required: ['description', 'amount', 'category'],
      },
    },
  },
];
