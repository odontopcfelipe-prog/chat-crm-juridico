/**
 * Google Drive: a integração é da PLATAFORMA (uma pasta raiz e uma conta Google
 * para todas as contas). Configurar, conectar, testar e o papel timbrado são só
 * do SUPER_ADMIN; a clínica vê só "configurado sim/não". As pastas e arquivos de
 * lead são dado da clínica: só a própria conta alcança (lead legado sem conta
 * segue como antes). O retorno do Google só grava com o `state` assinado.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GoogleDriveController } from '../google-drive/google-drive.controller';
import { assinarEstadoOAuth, OAUTH_STATE_VALIDADE_MS, verificarEstadoOAuth } from '../google-drive/oauth-state';

const A = 'conta-a';
const B = 'conta-b';
const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const DENTISTA_A = { id: 'u-d', roles: ['DENTIST'], tenant_id: A };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };

const ENC_ANTES = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'chave-somente-teste';
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
afterAll(() => {
  if (ENC_ANTES === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ENC_ANTES;
});

const CONFIG_COMPLETA = {
  configured: true,
  hasServiceAccount: false,
  hasRootFolder: true,
  rootFolderId: 'pasta-raiz-teste',
  hasOAuth: true,
  oauthConfigured: true,
  oauthConnected: true,
  oauthUserEmail: 'dono@exemplo.com',
  hasLetterhead: true,
  letterheadTemplateId: 'timbrado-teste',
  letterheadTemplateName: 'Timbrado',
};

function montar(leads: Record<string, { tenant_id: string | null; google_drive_folder_id?: string | null; name?: string }>, usuarios: Record<string, string[]> = {}) {
  const drive: any = {
    getConfig: jest.fn(async () => ({ ...CONFIG_COMPLETA })),
    listFolderFiles: jest.fn(async () => [{ id: 'f1', name: 'raio-x.pdf' }]),
    isConfigured: jest.fn(async () => true),
    ensureLeadFolder: jest.fn(async () => 'pasta-do-lead'),
    getOAuthUrl: jest.fn(async (state: string) => `https://accounts.exemplo/o?state=${state}`),
    handleOAuthCallback: jest.fn(async () => ({ email: 'dono@exemplo.com' })),
  };
  const prisma: any = {
    lead: {
      findUnique: jest.fn(async ({ where }: any) => {
        const l = leads[where.id];
        return l ? { name: 'Paciente', google_drive_folder_id: 'pasta-x', ...l } : null;
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => (usuarios[where.id] ? { roles: usuarios[where.id] } : null)),
    },
    globalSetting: { upsert: jest.fn() },
  };
  return { ctl: new GoogleDriveController(drive, prisma), drive, prisma };
}

const req = (user: any) => ({ user });

function resposta() {
  const r: any = { redirect: jest.fn() };
  return r;
}

const ROTAS_DA_PLATAFORMA = [
  'saveConfig',
  'testConnection',
  'saveOAuthConfig',
  'getOAuthUrl',
  'disconnectOAuth',
  'getLetterhead',
  'searchFiles',
  'setLetterhead',
  'removeLetterhead',
] as const;

describe('Google Drive — integração da plataforma; pastas de lead por conta', () => {
  describe('a clínica não alcança a configuração da plataforma nem os leads de outra conta', () => {
    it.each(ROTAS_DA_PLATAFORMA)('%s exige SUPER_ADMIN (e não aceita só ADMIN)', (metodo) => {
      const roles = Reflect.getMetadata(ROLES_KEY, (GoogleDriveController.prototype as any)[metodo]);
      expect(roles).toEqual(['SUPER_ADMIN']);
    });

    it('RolesGuard: ADMIN de clínica leva 403 PERMISSION_DENIED; o dono (ADMIN + SUPER_ADMIN) passa', () => {
      const guard = new RolesGuard({
        getAllAndOverride: () => Reflect.getMetadata(ROLES_KEY, GoogleDriveController.prototype.saveConfig),
      } as any);
      const ctx = (user: any) =>
        ({ getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
      const e = (() => {
        try {
          guard.canActivate(ctx(ADMIN_A));
        } catch (x) {
          return x;
        }
      })();
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(guard.canActivate(ctx(DONO))).toBe(true);
      expect(guard.canActivate(ctx({ roles: ['SUPER_ADMIN'] }))).toBe(true);
    });

    it('arquivos do lead de OUTRA conta: 404, sem tocar no Drive', async () => {
      const { ctl, drive } = montar({ 'lead-b': { tenant_id: B } });
      for (const user of [ADMIN_A, DENTISTA_A]) {
        expect(await ctl.listLeadFiles('lead-b', req(user)).catch((e) => e)).toBeInstanceOf(NotFoundException);
      }
      expect(drive.listFolderFiles).not.toHaveBeenCalled();
    });

    it('criar pasta para lead de OUTRA conta: 404, sem criar nem gravar no lead', async () => {
      const { ctl, drive } = montar({ 'lead-b': { tenant_id: B } });
      expect(await ctl.createLeadFolder('lead-b', req(ADMIN_A)).catch((e) => e)).toBeInstanceOf(NotFoundException);
      expect(drive.ensureLeadFolder).not.toHaveBeenCalled();
      expect(drive.isConfigured).not.toHaveBeenCalled();
    });

    it('GET config para quem não é SUPER_ADMIN: sem pasta, timbrado nem e-mail da conta Google', async () => {
      const { ctl } = montar({});
      for (const user of [ADMIN_A, DENTISTA_A]) {
        const cfg = await ctl.getConfig(req(user));
        expect(cfg).toMatchObject({ rootFolderId: null, oauthUserEmail: null, letterheadTemplateId: null, letterheadTemplateName: null });
        expect(JSON.stringify(cfg)).not.toMatch(/pasta-raiz|dono@|timbrado/i);
      }
    });

    it('retorno do Google sem state, adulterado, vencido ou de quem não é mais SUPER_ADMIN: nada é gravado', async () => {
      const { ctl, drive } = montar({}, { 'u-dono': ['ADMIN', 'SUPER_ADMIN'], 'u-ex': ['ADMIN'] });
      const valido = assinarEstadoOAuth('u-dono');
      const [corpo, exp, sig] = valido.split('.');
      const casos = [
        undefined,
        '',
        'qualquer-coisa',
        `${Buffer.from('u-outro').toString('base64url')}.${exp}.${sig}`,
        `${corpo}.${Number(exp) + 1}.${sig}`,
        assinarEstadoOAuth('u-dono', Date.now() - OAUTH_STATE_VALIDADE_MS - 1000),
        assinarEstadoOAuth('u-ex'),
        assinarEstadoOAuth('u-sumiu'),
      ];
      for (const state of casos) {
        const res = resposta();
        await ctl.handleOAuthCallback('code-x', undefined as any, state as any, res);
        expect(res.redirect.mock.calls[0][0]).toContain('oauth=error');
      }
      expect(drive.handleOAuthCallback).not.toHaveBeenCalled();
    });
  });

  describe('a tela da clínica continua igual', () => {
    it('arquivos do lead da própria conta: lista como antes (Banco de Documentos)', async () => {
      const { ctl, drive } = montar({ 'lead-a': { tenant_id: A, google_drive_folder_id: 'pasta-a' } });
      expect(await ctl.listLeadFiles('lead-a', req(DENTISTA_A))).toEqual([{ id: 'f1', name: 'raio-x.pdf' }]);
      expect(drive.listFolderFiles).toHaveBeenCalledWith('pasta-a');
    });

    it('lead legado sem conta: segue como antes', async () => {
      const { ctl, drive } = montar({ 'lead-velho': { tenant_id: null, google_drive_folder_id: 'pasta-v' } });
      await ctl.listLeadFiles('lead-velho', req(ADMIN_A));
      expect(drive.listFolderFiles).toHaveBeenCalledWith('pasta-v');
      expect(await ctl.createLeadFolder('lead-velho', req(ADMIN_A))).toMatchObject({ ok: true });
    });

    it('lead sem pasta: [] como antes; lead inexistente: [] como antes', async () => {
      const { ctl, drive } = montar({ 'lead-a': { tenant_id: A, google_drive_folder_id: null } });
      expect(await ctl.listLeadFiles('lead-a', req(ADMIN_A))).toEqual([]);
      expect(await ctl.listLeadFiles('nao-existe', req(ADMIN_A))).toEqual([]);
      expect(drive.listFolderFiles).not.toHaveBeenCalled();
    });

    it('criar pasta para lead da própria conta: mesma resposta de antes', async () => {
      const { ctl, drive } = montar({ 'lead-a': { tenant_id: A, name: 'Maria' } });
      expect(await ctl.createLeadFolder('lead-a', req(ADMIN_A))).toEqual({
        ok: true,
        folderId: 'pasta-do-lead',
        folderUrl: 'https://drive.google.com/drive/folders/pasta-do-lead',
      });
      expect(drive.ensureLeadFolder).toHaveBeenCalledWith('lead-a', 'Maria');
    });

    it('Drive não configurado: o aviso não manda a clínica para uma tela que ela não vê', async () => {
      const { ctl, drive } = montar({ 'lead-a': { tenant_id: A } });
      drive.isConfigured.mockResolvedValue(false);
      const e: any = await ctl.createLeadFolder('lead-a', req(ADMIN_A)).catch((x) => x);
      expect(e.message).toMatch(/administrador do sistema/);
      expect(e.message).not.toMatch(/Configura[çc][õo]es > Google Drive/);
    });

    it('GET config para a clínica: o mesmo formato (mesmas chaves e os mesmos sim/não)', async () => {
      const { ctl } = montar({});
      const cfg = await ctl.getConfig(req(ADMIN_A));
      expect(Object.keys(cfg).sort()).toEqual(Object.keys(CONFIG_COMPLETA).sort());
      expect(cfg).toMatchObject({ configured: true, oauthConnected: true, hasLetterhead: true, hasRootFolder: true });
    });

    it('o menu de Configurações só mostra o Google Drive para o SUPER_ADMIN, e a tela vira só leitura', () => {
      const web = path.resolve(__dirname, '../../../web/src/app/atendimento/settings');
      const layout = fs.readFileSync(path.join(web, 'layout.tsx'), 'utf8');
      const bloco = layout.slice(layout.indexOf('const superAdminOnlyPaths'), layout.indexOf(']);', layout.indexOf('const superAdminOnlyPaths')));
      expect(bloco).toContain("'/atendimento/settings/google-drive'");
      expect(layout).toMatch(/isItemVisible[\s\S]{0,200}isSuperAdmin \|\| !superAdminOnlyPaths\.has\(href\)/);
      const pagina = fs.readFileSync(path.join(web, 'google-drive/page.tsx'), 'utf8');
      expect(pagina).toMatch(/if \(!isSuperAdmin\) \{\s*return \(/);
    });
  });

  describe('o dono (SUPER_ADMIN) segue com a tela inteira', () => {
    it('GET config completo', async () => {
      const { ctl } = montar({});
      expect(await ctl.getConfig(req(DONO))).toEqual(CONFIG_COMPLETA);
    });

    it('SUPER_ADMIN alcança lead de qualquer conta (como antes)', async () => {
      const { ctl, drive } = montar({ 'lead-b': { tenant_id: B, google_drive_folder_id: 'pasta-b' } });
      await ctl.listLeadFiles('lead-b', req(DONO));
      expect(drive.listFolderFiles).toHaveBeenCalledWith('pasta-b');
    });

    it('conectar: a URL leva o state assinado do usuário, e o retorno no prazo grava', async () => {
      const { ctl, drive } = montar({}, { 'u-dono': ['ADMIN', 'SUPER_ADMIN'] });
      const { url } = await ctl.getOAuthUrl(req(DONO));
      const state = decodeURIComponent(url.split('state=')[1]);
      expect(verificarEstadoOAuth(state)).toBe('u-dono');
      const res = resposta();
      await ctl.handleOAuthCallback('code-ok', undefined as any, state, res);
      expect(drive.handleOAuthCallback).toHaveBeenCalledWith('code-ok');
      expect(res.redirect.mock.calls[0][0]).toContain('oauth=success');
    });
  });
});
