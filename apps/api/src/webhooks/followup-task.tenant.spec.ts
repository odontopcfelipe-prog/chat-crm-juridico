/**
 * Tarefa criada quando o lead responde ao follow-up (checkFollowupResponse) nasce
 * com a clínica do lead. Antes nascia sem tenant_id: órfã, e a migração de
 * tarefas a transformava num evento visível na agenda de TODAS as clínicas.
 * Só muda o dado gravado; nada é enviado ao paciente aqui.
 */
import { EvolutionService } from './evolution.service';

function montar(intencao: string, leadTenant: string | null, requerHumano = false) {
  const prisma: any = {
    followupEnrollment: {
      findFirst: jest.fn(async () => ({
        id: 'enr-1',
        lead_id: 'lead-1',
        sequence: { name: 'Sequência exemplo', category: 'GERAL', steps: [] },
        lead: { id: 'lead-1', name: 'Paciente Exemplo', phone: '5582900000000', stage: 'NOVO', tenant_id: leadTenant },
      })),
      update: jest.fn(async () => ({})),
    },
    task: { create: jest.fn(async ({ data }: any) => ({ id: 'task-1', ...data })) },
  };
  const followupSvc = {
    analyzeResponse: jest.fn(async () => ({
      intencao,
      sentimento: 'neutro',
      resumo: 'resumo de teste',
      proxima_acao: 'ligar',
      requer_humano: requerHumano,
    })),
  };
  const moduleRef: any = { get: jest.fn(() => followupSvc) };
  const evo = new EvolutionService(
    prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, moduleRef, {} as any, {} as any, {} as any,
  );
  (evo as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { evo, prisma };
}

describe('checkFollowupResponse — tarefa nasce com a clínica do lead', () => {
  it('lead quente (quer_contratar): Task com tenant_id do lead', async () => {
    const { evo, prisma } = montar('quer_contratar', 'clinica-A');
    await (evo as any).checkFollowupResponse('lead-1', 'quero fechar sim');
    expect(prisma.task.create).toHaveBeenCalledTimes(1);
    expect(prisma.task.create.mock.calls[0][0].data).toMatchObject({
      lead_id: 'lead-1',
      tenant_id: 'clinica-A',
      assigned_user_id: null,
      status: 'A_FAZER',
    });
  });

  it('escalado para humano: Task com tenant_id do lead', async () => {
    const { evo, prisma } = montar('duvida', 'clinica-B', true);
    await (evo as any).checkFollowupResponse('lead-1', 'tenho uma dúvida');
    expect(prisma.task.create).toHaveBeenCalledTimes(1);
    expect(prisma.task.create.mock.calls[0][0].data).toMatchObject({ lead_id: 'lead-1', tenant_id: 'clinica-B' });
  });

  it('lead sem clínica: grava null (igual hoje), sem inventar clínica', async () => {
    const { evo, prisma } = montar('quer_contratar', null);
    await (evo as any).checkFollowupResponse('lead-1', 'quero fechar sim');
    expect(prisma.task.create.mock.calls[0][0].data.tenant_id).toBeNull();
  });
});
