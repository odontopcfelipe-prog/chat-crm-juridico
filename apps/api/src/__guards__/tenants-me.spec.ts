/**
 * F1 — retrato de comportamento "clínica idêntica": GET /tenants/me.
 *
 * É a 1ª coisa que o web pede depois do login: nome e logo da clínica na barra
 * lateral e nos PDFs, cor do tema, status/trial (banner e modal), dono (wizard),
 * endereço/CRO/horários (Configurações › Identidade). As fases do laboratório
 * vão guardar o tipo da conta numa tabela própria; para um usuário de CLÍNICA
 * esta resposta não pode ganhar nem perder chave, nem mudar valor. Por isso o
 * retrato é EXATO (lista de chaves, recursiva e ordenada), não "contém".
 *
 * Usa o controller e o service reais (TenantsMeController → TenantsService.findOne)
 * com o Prisma mockado. A linha do Tenant que o mock devolve tem TODAS as colunas
 * do model (lidas do DMMF do Prisma client): coluna nova no Tenant aparece na
 * linha com um valor marcado, e só entra na resposta se o controller passar a
 * expô-la — aí este retrato reprova. A rota (método, caminho, ordem dos
 * controllers no módulo, sem @Public/@SuperAdmin) também é conferida.
 *
 * Se a mudança for de propósito para as clínicas: `npx jest __guards__/tenants-me -u`
 * em apps/api, commite o .snap junto e diga no commit o porquê (o web lê estas
 * chaves em useTenant/Sidebar/Identidade e precisa acompanhar).
 */
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@crm/shared';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { IS_SUPER_ADMIN_KEY } from '../auth/decorators/super-admin.decorator';
import { TenantsController, TenantsMeController } from '../tenants/tenants.controller';
import { TenantsModule } from '../tenants/tenants.module';
import { TenantsService } from '../tenants/tenants.service';

const TENANT_CLINICA = '00000000-0000-0000-0000-0000000000c1';

// O que GET /tenants/me devolve hoje para uma clínica (ordenado).
const CHAVES_TENANTS_ME = [
  'address',
  'address_complement',
  'address_number',
  'business_hours',
  'city',
  'cpf_cnpj',
  'custom_domain',
  'email',
  'id',
  'logo_url',
  'name',
  'neighborhood',
  'owner_user_id',
  'phone',
  'plan',
  'responsible_cro',
  'responsible_name',
  'slug',
  'state',
  'status',
  'theme_color',
  'trial_ends_at',
  'zip_code',
];

// Colunas do Tenant que ficam FORA da resposta hoje (só o SUPER_ADMIN vê, em
// /admin/tenants). Coluna nova no model cai aqui até alguém decidir se ela sai.
const COLUNAS_FORA = ['created_at', 'onboarding_state', 'suspended_at', 'suspended_reason', 'updated_at'];

/** Todas as chaves do objeto, recursivas ("a.b"), ordenadas. Array conta como valor. */
function chavesRecursivas(o: any, prefixo = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o) || o instanceof Date) return [];
  return Object.keys(o)
    .flatMap((k) => {
      const caminho = prefixo ? `${prefixo}.${k}` : k;
      const filhas = chavesRecursivas(o[k], caminho);
      return filhas.length ? [caminho, ...filhas] : [caminho];
    })
    .sort();
}

/** O que sai na rede: o Nest responde com JSON.stringify do retorno. */
const naRede = (r: any) => (r === null || r === undefined ? r : JSON.parse(JSON.stringify(r)));

/** Colunas escalares do model Tenant, como o Prisma client gerado as conhece. */
function colunasDoTenant(): Array<{ name: string; type: string; isRequired: boolean }> {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Tenant');
  if (!model) throw new Error('model Tenant sumiu do Prisma client');
  return model.fields
    .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
    .map((f) => ({ name: f.name, type: String(f.type), isRequired: f.isRequired }));
}

// Clínica de exemplo com tudo preenchido — inclusive o que NÃO pode vazar.
const EXEMPLO_COMPLETO: Record<string, any> = {
  id: TENANT_CLINICA,
  name: 'Clínica Exemplo',
  slug: 'clinica-exemplo',
  cpf_cnpj: '00000000000100',
  phone: '5582900000001',
  email: 'contato@clinica-exemplo.test',
  logo_url: 'data:image/png;base64,iVBORw0KGgo=',
  theme_color: '#0F766E',
  custom_domain: 'sistema.clinica-exemplo.test',
  zip_code: '57000000',
  address: 'Rua Exemplo',
  address_number: '100',
  address_complement: 'Sala 2',
  neighborhood: 'Centro',
  city: 'Cidade Exemplo',
  state: 'AL',
  responsible_name: 'Dra. Responsável Exemplo',
  responsible_cro: '00000-AL',
  business_hours: 'Seg-Sex 08:00-18:00, Sab 08:00-12:00',
  owner_user_id: 'u-admin-exemplo',
  status: 'TRIAL',
  plan: 'PRO',
  trial_ends_at: new Date('2026-11-03T15:00:00.000Z'),
  suspended_at: new Date('2026-09-01T12:00:00.000Z'),
  suspended_reason: 'motivo interno de exemplo (não pode sair em /tenants/me)',
  onboarding_state: { whatsapp: 'done', asaas: 'pending', completed_at: '2026-10-01T12:00:00.000Z' },
  created_at: new Date('2026-01-10T12:00:00.000Z'),
  updated_at: new Date('2026-10-19T12:00:00.000Z'),
};

// Clínica recém-cadastrada: só o que o banco exige (o resto null).
const EXEMPLO_MINIMO: Record<string, any> = {
  id: TENANT_CLINICA,
  name: 'Clínica Exemplo',
  status: 'ACTIVE',
  plan: 'STARTER',
  onboarding_state: {},
  created_at: new Date('2026-10-19T12:00:00.000Z'),
  updated_at: new Date('2026-10-19T12:00:00.000Z'),
};

/** A linha como o Prisma devolveria: uma chave por coluna do model, nem mais nem menos. */
function linhaDoTenant(exemplo: Record<string, any>, completo: boolean) {
  return Object.fromEntries(
    colunasDoTenant().map((c) => {
      if (c.name in exemplo) return [c.name, exemplo[c.name]];
      // Coluna que este retrato ainda não conhece: valor marcado (vaza = aparece no diff).
      if (completo || c.isRequired) return [c.name, `<coluna nova do Tenant: ${c.name}>`];
      return [c.name, null];
    }),
  );
}

function montar(linha: Record<string, any> | null) {
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async (args: any) => {
        if (!linha) return null;
        // findOne pede _count: devolve um contador por relação pedida (o controller não expõe).
        const pedidos = Object.keys(args?.include?._count?.select ?? {});
        return { ...linha, _count: Object.fromEntries(pedidos.map((k, i) => [k, i + 1])) };
      }),
    },
  };
  const controller = new TenantsMeController(new TenantsService(prisma, {} as any));
  return { controller, prisma };
}

/** req.user como o JwtStrategy monta para um usuário de clínica (ver auth-payload.spec). */
function req(roles: string[]) {
  return { user: { id: 'u-clinica-1', email: 'recepcao@clinica.teste', roles, role: roles[0], tenant_id: TENANT_CLINICA } };
}

describe('retrato: GET /tenants/me para usuário de clínica (F1)', () => {
  it('rota: GET tenants/me → TenantsMeController.getMyTenant, registrado antes do /tenants/:id, sem @Public nem @SuperAdmin', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TenantsMeController)).toBe('tenants');
    const handler = TenantsMeController.prototype.getMyTenant;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('me');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    // Nenhum decorator a mais na rota (permissão, papel, público, guard).
    expect(Reflect.getMetadataKeys(handler).sort()).toEqual([METHOD_METADATA, PATH_METADATA].sort());
    for (const chave of [IS_PUBLIC_KEY, IS_SUPER_ADMIN_KEY, GUARDS_METADATA]) {
      expect(Reflect.getMetadata(chave, TenantsMeController)).toBeUndefined();
    }

    // Ordem importa: o TenantsController tem GET :id com @SuperAdmin e engoliria o "me".
    const controllers: any[] = Reflect.getMetadata('controllers', TenantsModule);
    expect(controllers.indexOf(TenantsMeController)).toBeGreaterThanOrEqual(0);
    expect(controllers.indexOf(TenantsMeController)).toBeLessThan(controllers.indexOf(TenantsController));
    expect(Reflect.getMetadata(PATH_METADATA, TenantsController)).toBe('tenants');
    expect(Reflect.getMetadata(IS_SUPER_ADMIN_KEY, TenantsController.prototype.findOne)).toBe(true);
  });

  it('as colunas do Tenant que ficam fora da resposta', () => {
    const colunas = colunasDoTenant().map((c) => c.name);
    expect(colunas.filter((c) => !CHAVES_TENANTS_ME.includes(c)).sort()).toEqual(COLUNAS_FORA);
    // E toda chave da resposta é uma coluna do Tenant (nada calculado nem de outra tabela).
    expect(CHAVES_TENANTS_ME.filter((k) => !colunas.includes(k))).toEqual([]);
  });

  it('clínica com tudo preenchido: chaves exatas, valores e o JSON que sai na rede', async () => {
    const { controller, prisma } = montar(linhaDoTenant(EXEMPLO_COMPLETO, true));
    const r = await controller.getMyTenant(req(['ADMIN']));

    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.findUnique.mock.calls[0][0]).toMatchSnapshot('consulta ao banco (TenantsService.findOne)');

    const corpo = naRede(r);
    expect(chavesRecursivas(corpo)).toEqual(CHAVES_TENANTS_ME);
    expect(corpo).not.toHaveProperty('_count');
    for (const coluna of COLUNAS_FORA) expect(corpo).not.toHaveProperty(coluna);
    expect(corpo).toMatchSnapshot('resposta');
    // Ordem das chaves como sai no corpo da resposta.
    expect(JSON.stringify(r, null, 2)).toMatchSnapshot('corpo JSON na ordem da rede');
  });

  it('clínica recém-cadastrada (opcionais vazios): mesmas chaves, com null', async () => {
    const { controller } = montar(linhaDoTenant(EXEMPLO_MINIMO, false));
    const corpo = naRede(await controller.getMyTenant(req(['ADMIN'])));

    expect(chavesRecursivas(corpo)).toEqual(CHAVES_TENANTS_ME);
    expect(corpo).toMatchSnapshot('resposta');
  });

  it('linha antiga sem as colunas de endereço/responsável (undefined): o controller devolve null, mesmas chaves', async () => {
    const linha = linhaDoTenant(EXEMPLO_COMPLETO, true);
    const semIdentidade = [
      'zip_code', 'address', 'address_number', 'address_complement', 'neighborhood',
      'city', 'state', 'responsible_name', 'responsible_cro', 'business_hours',
    ];
    for (const k of semIdentidade) delete linha[k];
    const { controller } = montar(linha);
    const corpo = naRede(await controller.getMyTenant(req(['ADMIN'])));

    expect(chavesRecursivas(corpo)).toEqual(CHAVES_TENANTS_ME);
    for (const k of semIdentidade) expect(corpo[k]).toBeNull();
  });

  it('a resposta não depende do setor de quem pede (mesmo corpo para todo papel de clínica)', async () => {
    const { controller } = montar(linhaDoTenant(EXEMPLO_COMPLETO, true));
    const doAdmin = naRede(await controller.getMyTenant(req(['ADMIN'])));
    for (const roles of [['DENTIST'], ['OPERADOR'], ['COMERCIAL'], ['ASSISTANT'], ['FINANCEIRO'], ['ADMIN', 'DENTIST']]) {
      expect(naRede(await controller.getMyTenant(req(roles)))).toEqual(doAdmin);
    }
  });

  it('sem tenant no token → null sem ir ao banco; tenant inexistente → null', async () => {
    const vazio = montar(linhaDoTenant(EXEMPLO_COMPLETO, true));
    expect(await vazio.controller.getMyTenant({ user: { ...req(['ADMIN']).user, tenant_id: undefined } })).toBeNull();
    expect(await vazio.controller.getMyTenant({})).toBeNull();
    expect(vazio.prisma.tenant.findUnique).not.toHaveBeenCalled();

    const inexistente = montar(null);
    expect(await inexistente.controller.getMyTenant(req(['ADMIN']))).toBeNull();
    expect(inexistente.prisma.tenant.findUnique.mock.calls[0][0].where).toEqual({ id: TENANT_CLINICA });
  });
});
