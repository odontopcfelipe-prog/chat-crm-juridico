/**
 * Paridade do laboratório — exportação do funil (LeadsService.exportCsv).
 *
 * Clínica: o CSV de sempre (com especialidade e dentista). Laboratório: as mesmas
 * linhas, sem as duas colunas que só existem na clínica. Sem banco: o Prisma é um
 * fake que devolve contatos de exemplo.
 */
import { __limparCacheLabTenants } from '@crm/shared';
import { LeadsService } from './leads.service';

const CLINICA = 'tenant-clinica-exemplo';
const LAB = 'tenant-lab-exemplo';

function montar(labs: string[]) {
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
    lead: {
      findMany: jest.fn(async () => [
        {
          name: 'Contato Exemplo',
          phone: '5582900000001',
          email: null,
          stage: 'QUALIFICANDO',
          tags: ['a', 'b'],
          stage_entered_at: new Date(Date.now() - 2 * 86400000),
          created_at: new Date('2026-10-01T12:00:00.000Z'),
          conversations: [{ specialty: 'Implante', assigned_dentist: { name: 'Dra. Exemplo' } }],
        },
      ]),
    },
  };
  const svc = new LeadsService(prisma, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma };
}

beforeEach(() => __limparCacheLabTenants());

describe('LeadsService.exportCsv', () => {
  it('clínica: cabeçalho e colunas de sempre, com especialidade e dentista', async () => {
    const { svc } = montar([LAB]);
    const [cabecalho, linha] = (await svc.exportCsv(CLINICA)).split('\n');
    expect(cabecalho).toBe('Nome,Telefone,Email,Estágio,Especialidade,Dentista,Tags,Dias no Estágio,Criado em');
    expect(linha.split(',')).toHaveLength(9);
    expect(linha).toContain('Implante');
    expect(linha).toContain('Dra. Exemplo');
  });

  it('clínica sem nenhum laboratório cadastrado: o mesmo CSV', async () => {
    const { svc } = montar([]);
    const [cabecalho] = (await svc.exportCsv(CLINICA)).split('\n');
    expect(cabecalho).toBe('Nome,Telefone,Email,Estágio,Especialidade,Dentista,Tags,Dias no Estágio,Criado em');
  });

  it('laboratório: sem as colunas de especialidade e dentista', async () => {
    const { svc } = montar([LAB]);
    const [cabecalho, linha] = (await svc.exportCsv(LAB)).split('\n');
    expect(cabecalho).toBe('Nome,Telefone,Email,Etapa,Tags,Dias na etapa,Criado em');
    expect(linha.split(',')).toHaveLength(7);
    expect(linha).not.toContain('Implante');
    expect(linha).not.toContain('Dra. Exemplo');
  });
});
