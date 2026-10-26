/**
 * Skills da IA (instruções, ferramentas e referências) são da PLATAFORMA:
 *
 *  - criar, editar, ligar/desligar, apagar, sincronizar, ferramentas e
 *    referências: só o SUPER_ADMIN (o dono tem ADMIN + SUPER_ADMIN); o ADMIN de
 *    clínica recebe 403 PERMISSION_DENIED sem nada ser gravado nem enviado;
 *  - leitura: o ADMIN de clínica continua lendo como antes (a tela de Ajustes IA
 *    carrega as skills); laboratório (sem IA) recebe lista vazia;
 *  - front: sem botões de criar/editar/apagar para quem não é SUPER_ADMIN.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { SettingsController } from '../settings/settings.controller';

const A = 'conta-a';
const LAB = 'conta-lab';
const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const ADMIN_LAB = { id: 'u-l', roles: ['ADMIN'], tenant_id: LAB };
const ADMIN_SEM_CONTA = { id: 'u-x', roles: ['ADMIN'], tenant_id: null };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN'], tenant_id: null };

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
beforeEach(() => __limparCacheLabTenants());

function montar() {
  const service: any = {
    getSkills: jest.fn(async () => [{ id: 's1', name: 'Skill' }]),
    toggleSkill: jest.fn(async () => undefined),
    resetSkillsToDefaults: jest.fn(async () => ({ ok: true })),
    migrateSdrToOdonto: jest.fn(async () => ({ ok: true })),
    createSkill: jest.fn(async () => ({ id: 'nova' })),
    updateSkill: jest.fn(async () => ({ id: 's1' })),
    deleteSkill: jest.fn(async () => ({ id: 's1' })),
    getSkillTools: jest.fn(async () => [{ id: 't1' }]),
    createSkillTool: jest.fn(async () => ({ id: 't2' })),
    updateSkillTool: jest.fn(async () => ({ id: 't1' })),
    deleteSkillTool: jest.fn(async () => ({ id: 't1' })),
    getSkillAssets: jest.fn(async () => [{ id: 'a1' }]),
    createSkillAsset: jest.fn(async () => ({ id: 'a2' })),
    updateSkillAsset: jest.fn(async () => ({ id: 'a1' })),
    deleteSkillAsset: jest.fn(async () => ({ id: 'a1', s3_key: 'skill-assets/s1/x.md' })),
    findSkillAssetById: jest.fn(async () => ({ id: 'a1', s3_key: 'k', name: 'ref.md' })),
  };
  const s3: any = {
    uploadBuffer: jest.fn(async () => undefined),
    deleteObject: jest.fn(async () => undefined),
    getObjectBuffer: jest.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'text/markdown' })),
  };
  const prisma: any = { tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) } };
  const ctl = new SettingsController(service, {} as any, s3, prisma, {} as any);
  return { ctl, service, s3 };
}

const req = (user: any) => ({ user });
const arquivo = { originalname: 'ref.md', buffer: Buffer.from('# ref'), mimetype: 'text/markdown', size: 5 };

/** Cada escrita: [nome, chamada, método do serviço que grava]. */
const ESCRITAS: Array<[string, (ctl: SettingsController, r: any) => Promise<unknown>, string]> = [
  ['toggleSkill', (c, r) => c.toggleSkill(r, 's1', { isActive: false }), 'toggleSkill'],
  ['resetSkillsToDefaults', (c, r) => c.resetSkillsToDefaults(r), 'resetSkillsToDefaults'],
  ['migrateSdrToOdonto', (c, r) => c.migrateSdrToOdonto(r), 'migrateSdrToOdonto'],
  ['createSkill', (c, r) => c.createSkill(r, { name: 'x' } as any), 'createSkill'],
  ['updateSkill', (c, r) => c.updateSkill(r, 's1', { name: 'y' } as any), 'updateSkill'],
  ['deleteSkill', (c, r) => c.deleteSkill(r, 's1'), 'deleteSkill'],
  ['createSkillTool', (c, r) => c.createSkillTool(r, 's1', { name: 't' } as any), 'createSkillTool'],
  ['updateSkillTool', (c, r) => c.updateSkillTool(r, 't1', { name: 't' } as any), 'updateSkillTool'],
  ['deleteSkillTool', (c, r) => c.deleteSkillTool(r, 't1'), 'deleteSkillTool'],
  ['uploadSkillAsset', (c, r) => c.uploadSkillAsset(r, 's1', arquivo, { asset_type: 'reference' }), 'createSkillAsset'],
  ['updateSkillAsset', (c, r) => c.updateSkillAsset(r, 'a1', { content_text: 'novo' }), 'updateSkillAsset'],
  ['deleteSkillAsset', (c, r) => c.deleteSkillAsset(r, 'a1'), 'deleteSkillAsset'],
];

describe('Skills da IA: escrita só da plataforma', () => {
  describe('a clínica não altera as skills (de todas as contas)', () => {
    it.each(ESCRITAS)('%s pelo ADMIN de clínica: 403 PERMISSION_DENIED, nada gravado', async (_n, chamar, metodo) => {
      for (const u of [ADMIN_A, ADMIN_SEM_CONTA, ADMIN_LAB]) {
        const { ctl, service, s3 } = montar();
        const e = await chamar(ctl, req(u)).catch((x) => x);
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(service[metodo]).not.toHaveBeenCalled();
        expect(s3.uploadBuffer).not.toHaveBeenCalled();
        expect(s3.deleteObject).not.toHaveBeenCalled();
      }
    });
  });

  describe('a tela da clínica continua carregando', () => {
    it('ADMIN de clínica lê skills, ferramentas e referências como antes', async () => {
      const { ctl, service } = montar();
      expect(await ctl.getSkills(req(ADMIN_A))).toEqual([{ id: 's1', name: 'Skill' }]);
      expect(await ctl.getSkillTools(req(ADMIN_A), 's1')).toEqual([{ id: 't1' }]);
      expect(await ctl.getSkillAssets(req(ADMIN_A), 's1')).toEqual([{ id: 'a1' }]);
      expect(service.getSkills).toHaveBeenCalledTimes(1);
    });

    it('laboratório: lista vazia (sem 403) e download 404, sem ler as skills', async () => {
      const { ctl, service } = montar();
      expect(await ctl.getSkills(req(ADMIN_LAB))).toEqual([]);
      expect(await ctl.getSkillTools(req(ADMIN_LAB), 's1')).toEqual([]);
      expect(await ctl.getSkillAssets(req(ADMIN_LAB), 's1')).toEqual([]);
      const res: any = { set: jest.fn(), send: jest.fn() };
      expect(await ctl.downloadSkillAsset(req(ADMIN_LAB), 'a1', res).catch((e) => e)).toBeInstanceOf(NotFoundException);
      expect(service.getSkills).not.toHaveBeenCalled();
      expect(service.findSkillAssetById).not.toHaveBeenCalled();
    });
  });

  describe('o dono e o SUPER_ADMIN sem conta seguem editando', () => {
    it.each(ESCRITAS)('%s pelo dono (ADMIN + SUPER_ADMIN): grava como antes', async (_n, chamar, metodo) => {
      for (const u of [DONO, SUPER_SEM_CONTA]) {
        const { ctl, service } = montar();
        await chamar(ctl, req(u));
        expect(service[metodo]).toHaveBeenCalledTimes(1);
      }
    });

    it('upload pelo dono sobe o arquivo e cria a referência', async () => {
      const { ctl, s3, service } = montar();
      await ctl.uploadSkillAsset(req(DONO), 's1', arquivo, { asset_type: 'reference' });
      expect(s3.uploadBuffer).toHaveBeenCalledTimes(1);
      expect(service.createSkillAsset.mock.calls[0][1]).toMatchObject({ name: 'ref.md', asset_type: 'reference', content_text: '# ref' });
    });
  });

  it('front: sem criar/editar/apagar/ligar skill para quem não é SUPER_ADMIN', () => {
    const p = fs.readFileSync(path.resolve(__dirname, '../../../web/src/app/atendimento/settings/ai/page.tsx'), 'utf8');
    for (const fn of ['saveSkill', 'deleteSkill', 'toggleSkill']) {
      expect(p).toMatch(new RegExp(`const ${fn} = async \\([^)]*\\) => \\{\\s*if \\(!isSuperAdmin\\) return;`));
    }
    expect(p).toContain('{isSuperAdmin && !creatingHere && (');
    expect(p).toContain('{isSuperAdmin && creatingHere && (');
    expect(p).toContain('{isSuperAdmin && editingId === skill.id && (');
    expect(p).toContain("{isSuperAdmin && chip.id === 'COMERCIAL'");
    expect(p).toMatch(/onClick=\{\(\) => toggleSkill\(skill\.id, skill\.isActive\)\}\s*disabled=\{!isSuperAdmin\}/);
    const editar = p.indexOf('onClick={() => (editingId === skill.id ? cancelEdit() : openEdit(skill))}');
    expect(p.lastIndexOf('{isSuperAdmin && (', editar)).toBeGreaterThan(p.lastIndexOf('const renderSkillCard', editar));
  });
});
