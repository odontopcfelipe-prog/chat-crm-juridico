/**
 * F2 parte 4 — a política de rotas do laboratório (business-type/lab-route-policy.ts)
 * contra as rotas que EXISTEM no código (o mesmo gerador do inventário, por AST).
 *
 * ESTRITO (reprova o CI):
 *   - toda entrada das listas aponta para um handler/controller que existe
 *     (entrada morta = alguém renomeou e o laboratório perdeu a rota sem saber);
 *   - liberado e negado não se cruzam;
 *   - nada liberado é @Public (o guard nem roda nelas), exige SUPER_ADMIN, grava
 *     a configuração da plataforma (I14) ou é de controller de clínica/IA;
 *   - o que o layout chama em TODA página está liberado (senão toda tela do
 *     laboratório quebra);
 *   - o LabTenantGuard é o ÚLTIMO APP_GUARD.
 * SÓ AVISA: handler que não está em lista nenhuma. Ele já nasce FECHADO para o
 * laboratório (negação por padrão); o aviso (log do jest e resumo do job no
 * GitHub) é para alguém decidir se o laboratório também usa — sem travar o
 * deploy da clínica.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CONTROLLERS_SO_DE_CLINICA,
  ROTAS_DO_LABORATORIO,
  ROTAS_SO_DE_CLINICA,
  rotaDoLaboratorio,
} from '../business-type/lab-route-policy';

type Handler = { metodo: string; rota: string; acesso: string[] };
type Controller = { classe: string; acesso: string[]; handlers: Handler[] };
type ModuloInventario = {
  gerarInventario(app: string): { controllers: Controller[]; globais: Array<{ token: string; classe: string }> };
};

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const inv = require(path.join(RAIZ, 'scripts', 'ci', 'inventario.cjs')) as ModuloInventario;

/** Chamadas do layout do atendimento para TODO logado (o laboratório também). */
const CHAMADAS_DE_TODA_PAGINA: readonly string[] = [
  'UsersController.getMe', // permissões e setor (useUserPermissions), barra lateral, início
  'UsersController.getAvatar', // foto na barra lateral
  'TenantsMeController.getMyTenant', // marca, logo, aviso de teste (useTenant)
  'TenantsMeController.getMyOnboarding', // aviso de primeiros passos no início
  'PontoController.status', // "Meu ponto" no menu (usePontoStatus)
  'TeamChatController.overview', // conversa da equipe (balão em toda página)
  'ConversationsController.getUnreadCounts', // selo de não lidas
  'TasksController.findAll', // selo de tarefas
  'WhatsappController.myNumbers', // aviso de chip desconectado (a cada 90 s)
  'CommercialController.quotesDashboard', // selo de propostas na barra lateral
  'CalendarController.pendingValidation', // selo de atendimentos a validar na barra lateral (ADMIN, a cada 5 min)
];

/**
 * Handlers que gravam a configuração da PLATAFORMA (GlobalSetting) — nunca para
 * o laboratório (I14), mesmo que um dia alguém os ponha na lista de liberados.
 */
const GRAVAM_CONFIG_DA_PLATAFORMA: readonly string[] = [
  'SettingsController.upsert',
  'SettingsController.saveSmtp',
  'SettingsController.saveDjenLawyers',
  'SettingsController.setWhatsAppConfig',
  'SettingsController.setAiConfig',
  'SettingsController.setAiPriceTable',
  'SettingsController.setClicksign',
  'SettingsController.setContract',
  'SettingsController.setTtsConfig',
  'SettingsController.createSkill',
  'SettingsController.updateSkill',
  'SettingsController.deleteSkill',
  'SettingsController.toggleSkill',
  'SettingsController.resetSkillsToDefaults',
  'SettingsController.migrateSdrToOdonto',
  'SettingsController.createSkillTool',
  'SettingsController.updateSkillTool',
  'SettingsController.deleteSkillTool',
  'SettingsController.uploadSkillAsset',
  'SettingsController.updateSkillAsset',
  'SettingsController.deleteSkillAsset',
  'MemoriesController.updateOrgSettings',
  'GoogleDriveController.saveConfig',
  'GoogleDriveController.saveOAuthConfig',
  'GlobalAnamnesisController.update',
  'TenantsController.seedAll',
];

let controllers: Controller[];
let globais: Array<{ token: string; classe: string }>;
let handlers: Map<string, { controller: Controller; handler: Handler }>;

beforeAll(() => {
  const gerado = inv.gerarInventario('api');
  controllers = gerado.controllers;
  globais = gerado.globais;
  handlers = new Map();
  for (const c of controllers) for (const h of c.handlers) handlers.set(h.metodo, { controller: c, handler: h });
}, 120_000);

const publica = (c: Controller, h: Handler) => [...c.acesso, ...h.acesso].some((a) => /@Public\b/.test(a));
/** Só o dono da plataforma: @SuperAdmin, ou @Roles só com SUPER_ADMIN (ADMIN junto não conta). */
const soDoDono = (c: Controller, h: Handler) =>
  [...c.acesso, ...h.acesso].some((a) => {
    if (/@SuperAdmin\b/.test(a)) return true;
    const roles = /@Roles\(([^)]*)\)/.exec(a)?.[1].match(/'([A-Z_]+)'/g);
    return !!roles?.length && roles.every((r) => r === "'SUPER_ADMIN'");
  });

describe('política de rotas do laboratório', () => {
  it('toda entrada aponta para algo que existe no código', () => {
    const classes = new Set(controllers.map((c) => c.classe));
    const mortas = [
      ...[...ROTAS_DO_LABORATORIO, ...ROTAS_SO_DE_CLINICA].filter((k) => !handlers.has(k)),
      ...[...CONTROLLERS_SO_DE_CLINICA].filter((c) => !classes.has(c)),
      ...[...CHAMADAS_DE_TODA_PAGINA, ...GRAVAM_CONFIG_DA_PLATAFORMA].filter((k) => !handlers.has(k)),
    ];
    expect(mortas).toEqual([]);
  });

  it('liberado e negado não se cruzam', () => {
    const cruzados = [...ROTAS_DO_LABORATORIO].filter(
      (k) => ROTAS_SO_DE_CLINICA.has(k) || CONTROLLERS_SO_DE_CLINICA.has(k.split('.')[0]),
    );
    const redundantes = [...ROTAS_SO_DE_CLINICA].filter((k) => CONTROLLERS_SO_DE_CLINICA.has(k.split('.')[0]));
    expect({ cruzados, redundantes }).toEqual({ cruzados: [], redundantes: [] });
  });

  it('nada liberado é @Public, só do SUPER_ADMIN ou grava configuração da plataforma', () => {
    const errados = [...ROTAS_DO_LABORATORIO].filter((k) => {
      const achado = handlers.get(k);
      if (!achado) return false; // o teste de existência já pega
      return publica(achado.controller, achado.handler) || soDoDono(achado.controller, achado.handler) || GRAVAM_CONFIG_DA_PLATAFORMA.includes(k);
    });
    expect(errados).toEqual([]);
  });

  it('o que o layout chama em toda página está liberado', () => {
    expect(CHAMADAS_DE_TODA_PAGINA.filter((k) => !rotaDoLaboratorio(k))).toEqual([]);
  });

  it('o LabTenantGuard é o último APP_GUARD', () => {
    const guards = globais.filter((g) => g.token === 'APP_GUARD').map((g) => g.classe);
    expect(guards[guards.length - 1]).toBe('LabTenantGuard');
  });

  it('handler sem classificação (só avisa: já nasce fechado para o laboratório)', () => {
    const semDecisao: string[] = [];
    for (const [k, { controller, handler }] of handlers) {
      if (publica(controller, handler)) continue;
      if (ROTAS_DO_LABORATORIO.has(k) || ROTAS_SO_DE_CLINICA.has(k) || CONTROLLERS_SO_DE_CLINICA.has(controller.classe)) continue;
      semDecisao.push(`${k} (${handler.rota})`);
    }
    if (!semDecisao.length) return;
    const texto =
      `[política do laboratório] ${semDecisao.length} rota(s) sem classificação — FECHADAS para o laboratório até ` +
      `alguém decidir (apps/api/src/business-type/lab-route-policy.ts):\n  ${semDecisao.join('\n  ')}`;
    console.warn(texto);
    const destino = process.env.GITHUB_STEP_SUMMARY;
    if (destino) {
      try {
        fs.appendFileSync(destino, `\n### Política de rotas do laboratório\n\n\`\`\`\n${texto}\n\`\`\`\n`);
      } catch {
        // o resumo do job é só conveniência
      }
    }
  });
});
