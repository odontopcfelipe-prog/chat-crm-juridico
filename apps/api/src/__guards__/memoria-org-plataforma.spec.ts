/**
 * Base de Conhecimento — modelo e prompts da consolidação do "resumo da clínica"
 * (MEMORY_ORG_MODEL, MEMORY_ORG_INCREMENTAL_PROMPT, MEMORY_ORG_REBUILD_PROMPT):
 * uma configuração só, lida sem conta pelo worker, que vale para todas as
 * clínicas. Por isso:
 *
 *  - gravar (PUT /memories/organization/settings): só o SUPER_ADMIN (o dono tem
 *    ADMIN + SUPER_ADMIN); o ADMIN de clínica recebe 403 PERMISSION_DENIED e
 *    nada é gravado;
 *  - ler (GET /memories/organization/settings): o ADMIN segue lendo, no mesmo
 *    formato (nenhuma tela ganha 403 ao carregar);
 *  - rotas de manutenção sem tela (reescrever skills, enfileirar perfis de
 *    todas as contas): só o SUPER_ADMIN;
 *  - front: "Configurações Avançadas" só para o SUPER_ADMIN.
 *
 * (Não há valor por clínica nem herança de conta legada aqui: é configuração da
 * plataforma, e o resumo de cada clínica continua sendo dela.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { ForbiddenException, Logger } from '@nestjs/common';
import { MemoriesController } from '../memories/memories.controller';
import { MemoriesService } from '../memories/memories.service';

const A = 'conta-a';
const LAB = 'conta-lab';
const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const ADMIN_LAB = { id: 'u-l', roles: ['ADMIN'], tenant_id: LAB };
const ADMIN_SEM_CONTA = { id: 'u-x', roles: ['ADMIN'], tenant_id: null };
const DENTISTA_A = { id: 'u-d', roles: ['DENTIST'], tenant_id: A };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN'], tenant_id: null };

const NAO_PLATAFORMA = [ADMIN_A, ADMIN_LAB, ADMIN_SEM_CONTA, DENTISTA_A];
const PLATAFORMA = [DONO, SUPER_SEM_CONTA];

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});

/** Controller com o serviço de verdade e um banco falso (só a GlobalSetting). */
function montar() {
  const banco = new Map<string, string>();
  const prisma: any = {
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (banco.has(where.key) ? { key: where.key, value: banco.get(where.key) } : null)),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        banco.set(where.key, banco.has(where.key) ? update.value : create.value);
        return {};
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        banco.delete(where.key);
        return { count: 1 };
      }),
    },
  };
  const queue: any = { add: jest.fn(async () => ({})) };
  const service = new MemoriesService(prisma, {} as any, queue);
  const manutencao = {
    migrateSkillsToMemoryVars: jest.spyOn(service, 'migrateSkillsToMemoryVars').mockResolvedValue({ ok: true } as any),
    migrateLegacyLeadsToProfile: jest.spyOn(service, 'migrateLegacyLeadsToProfile').mockResolvedValue({ ok: true } as any),
    cleanSkillHardcodedOrgInfo: jest.spyOn(service, 'cleanSkillHardcodedOrgInfo').mockResolvedValue({ ok: true } as any),
  };
  const ctl = new MemoriesController(service, queue);
  return { ctl, service, prisma, banco, queue, manutencao };
}

const req = (user: any) => ({ user });
const negado = (e: unknown) => {
  expect(e).toBeInstanceOf(ForbiddenException);
  expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
};

const PROMPT = 'Prompt de consolidação do resumo da clínica. '.repeat(4); // > 100 caracteres
/** O que a tela manda (só os campos que mudaram). */
const PAYLOAD_DA_TELA = { model: 'gpt-4.1-mini', incremental_prompt: PROMPT };

/** Chamadas de manutenção: [nome, chamada, método do serviço]. */
const MANUTENCAO: Array<[string, (ctl: MemoriesController, r: any) => Promise<unknown>, 'migrateSkillsToMemoryVars' | 'migrateLegacyLeadsToProfile' | 'cleanSkillHardcodedOrgInfo']> = [
  ['migrateSkills', (c, r) => c.migrateSkills(r), 'migrateSkillsToMemoryVars'],
  ['migrateLegacyLeads', (c, r) => c.migrateLegacyLeads(r, '10', undefined), 'migrateLegacyLeadsToProfile'],
  ['previewCleanSkillsHardcoded', (c, r) => c.previewCleanSkillsHardcoded(r), 'cleanSkillHardcodedOrgInfo'],
  ['applyCleanSkillsHardcoded', (c, r) => c.applyCleanSkillsHardcoded(r, 'false'), 'cleanSkillHardcodedOrgInfo'],
];

describe('Modelo e prompts do resumo da clínica: da plataforma', () => {
  describe('a clínica não altera o que vale para as outras', () => {
    it.each(NAO_PLATAFORMA.map((u) => [u.id, u]))('PUT pelo %s: 403 PERMISSION_DENIED, nada gravado', async (_id, u) => {
      const { ctl, prisma } = montar();
      negado(await ctl.updateOrgSettings(req(u), PAYLOAD_DA_TELA).catch((e) => e));
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
      expect(prisma.globalSetting.deleteMany).not.toHaveBeenCalled();
    });

    it('restaurar o padrão (prompt vazio) pelo ADMIN de clínica também é recusado, sem apagar nada', async () => {
      const { ctl, prisma, banco } = montar();
      banco.set('MEMORY_ORG_REBUILD_PROMPT', PROMPT);
      negado(await ctl.updateOrgSettings(req(ADMIN_A), { rebuild_prompt: '' }).catch((e) => e));
      expect(prisma.globalSetting.deleteMany).not.toHaveBeenCalled();
      expect(banco.get('MEMORY_ORG_REBUILD_PROMPT')).toBe(PROMPT);
    });

    it.each(MANUTENCAO)('manutenção %s pelo ADMIN de clínica: 403, nada executado', async (_n, chamar, metodo) => {
      for (const u of NAO_PLATAFORMA) {
        const { ctl, manutencao, queue } = montar();
        negado(await chamar(ctl, req(u)).catch((e) => e));
        expect(manutencao[metodo]).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
      }
    });
  });

  describe('a tela da clínica continua carregando', () => {
    it('GET pelo ADMIN de clínica: o mesmo formato de antes (sem 403)', async () => {
      const { ctl, banco } = montar();
      banco.set('MEMORY_ORG_MODEL', 'gpt-4.1-mini');
      const r: any = await ctl.getOrgSettings();
      expect(Object.keys(r).sort()).toEqual(
        [
          'available_models',
          'incremental_is_custom',
          'incremental_prompt',
          'incremental_prompt_default',
          'model',
          'model_default',
          'rebuild_is_custom',
          'rebuild_prompt',
          'rebuild_prompt_default',
        ].sort(),
      );
      expect(r.model).toBe('gpt-4.1-mini');
    });
  });

  describe('o dono e o SUPER_ADMIN sem conta gravam a configuração da plataforma', () => {
    it.each(PLATAFORMA.map((u) => [u.id, u]))('PUT pelo %s: grava as chaves globais (nunca a da conta)', async (_id, u) => {
      const { ctl, banco } = montar();
      const r: any = await ctl.updateOrgSettings(req(u), PAYLOAD_DA_TELA);
      expect([...banco.keys()].sort()).toEqual(['MEMORY_ORG_INCREMENTAL_PROMPT', 'MEMORY_ORG_MODEL']);
      expect(banco.get('MEMORY_ORG_MODEL')).toBe('gpt-4.1-mini');
      expect(r).toMatchObject({ model: 'gpt-4.1-mini', incremental_is_custom: true });
    });

    it.each(MANUTENCAO)('manutenção %s pelo dono e pelo SUPER_ADMIN sem conta: executa como antes', async (_n, chamar, metodo) => {
      for (const u of PLATAFORMA) {
        const { ctl, manutencao } = montar();
        await chamar(ctl, req(u));
        expect(manutencao[metodo]).toHaveBeenCalledTimes(1);
      }
    });
  });

  it('front: "Configurações Avançadas" só para o SUPER_ADMIN, e o salvar não sai para os demais', () => {
    const p = fs.readFileSync(path.resolve(__dirname, '../../../web/src/app/atendimento/settings/knowledge/page.tsx'), 'utf8');
    expect(p).toContain("import { useRole } from '@/lib/useRole';");
    expect(p).toContain('const { isSuperAdmin } = useRole();');
    expect(p).toContain('{!loading && isSuperAdmin && (');
    expect(p).toMatch(/const handleSaveSettings = async \(\) => \{\s*if \(!isSuperAdmin \|\| !settings\) return;/);
    expect(p).toContain('if (isSuperAdmin && advancedOpen && !settings) loadSettings();');
    expect(p).toContain('valem para todas as clínicas');
  });
});
