/**
 * Webhook de radiografia — conta do exame resolvida pela chave do provider.
 *
 * O payload identifica a conta pelo nome (tenant_slug), que nao e unico. O
 * webhook considera todas as contas com esse nome e grava o exame na conta do
 * provider cuja chave bate com o header. Com um nome so, o fluxo e o de antes.
 *
 * Idempotencia por (source, source_external_id): so devolve exame da conta do
 * provider casado. Se a chave ja pertence a outra conta, nada dela e devolvido:
 * registra no log e responde 'ja recebido' sem dados (o indice unico e global,
 * entao o exame nao e gravado de novo).
 */
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { RadiographyService } from './radiography.service';

type Tenant = { id: string; name: string; created_at: Date };
type Provider = {
  id: string; tenant_id: string; name: string; source_slug: string;
  api_key_hash: string; active: boolean;
};

const CHAVE_CLINICA = 'chave-centro-radiologico-1';
const CHAVE_OUTRA = 'chave-centro-radiologico-2';
let HASH_CLINICA: string;
let HASH_OUTRA: string;

beforeAll(async () => {
  HASH_CLINICA = await argon2.hash(CHAVE_CLINICA);
  HASH_OUTRA = await argon2.hash(CHAVE_OUTRA);
});

function montar(opts: {
  tenants: Tenant[];
  providers: Provider[];
  exameExistente?: any;
  /** Outro envio grava este exame entre a busca e o create (indice unico → P2002). */
  exameNaCorrida?: any;
  falhaCreate?: Error;
  pacientes?: { id: string; tenant_id: string; cpf: string }[];
  falhaTenants?: boolean;
  falhaProviders?: boolean;
}) {
  const criados: any[] = [];
  let exameNoBanco: any = opts.exameExistente ?? null;
  const prisma: any = {
    tenant: {
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        if (opts.falhaTenants) throw new Error('banco indisponivel');
        expect(where).toEqual({ name: { equals: expect.any(String), mode: 'insensitive' } });
        expect(orderBy).toEqual([{ created_at: 'asc' }, { id: 'asc' }]);
        const alvo = where.name.equals.toLowerCase();
        return opts.tenants
          .filter((t) => t.name.toLowerCase() === alvo)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
          .map(({ id, name }) => ({ id, name }));
      }),
      findFirst: jest.fn(),
    },
    radiographyProvider: {
      // Devolve na ordem inversa de cadastro: a ordem das contas vem do service
      findMany: jest.fn(async ({ where }: any) => {
        if (opts.falhaProviders) throw new Error('banco indisponivel');
        const ids: string[] = where.tenant_id.in;
        return opts.providers
          .filter((p) => ids.includes(p.tenant_id) && p.active === where.active)
          .reverse();
      }),
      update: jest.fn(async () => ({})),
    },
    radiographyExam: {
      findUnique: jest.fn(async ({ where }: any) => {
        expect(Object.keys(where)).toEqual(['source_source_external_id']);
        const { source, source_external_id } = where.source_source_external_id;
        return exameNoBanco && exameNoBanco.source === source && exameNoBanco.source_external_id === source_external_id
          ? exameNoBanco
          : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (opts.falhaCreate) throw opts.falhaCreate;
        if (opts.exameNaCorrida && exameNoBanco !== opts.exameNaCorrida) {
          exameNoBanco = opts.exameNaCorrida;
          throw Object.assign(new Error('Unique constraint failed on the fields: (`source`,`source_external_id`)'), { code: 'P2002' });
        }
        const exam = { id: `exam-${criados.length + 1}`, ...data };
        criados.push(exam);
        return exam;
      }),
    },
    patient: {
      findFirst: jest.fn(async ({ where }: any) =>
        (opts.pacientes || []).find((p) => p.tenant_id === where.tenant_id && p.cpf === where.cpf) ?? null),
    },
  };
  const s3: any = { uploadBuffer: jest.fn(async () => undefined) };
  const service = new RadiographyService(prisma, s3);
  const logs: string[] = [];
  for (const nivel of ['log', 'warn'] as const) {
    jest.spyOn((service as any).logger, nivel).mockImplementation((m: any) => { logs.push(`${nivel}: ${m}`); });
  }
  return { service, prisma, s3, criados, logs };
}

const payload = (extra: Record<string, any> = {}) => ({
  tenant_slug: 'Clinica Sorriso',
  source_external_id: 'EX-100',
  exam_type: 'PANORAMIC',
  image_base64: Buffer.from('imagem').toString('base64'),
  image_mime: 'image/png',
  patient_cpf: '123.456.789-00',
  ...extra,
}) as any;

const clinica: Tenant = { id: 't-clinica', name: 'Clinica Sorriso', created_at: new Date('2025-01-10T00:00:00Z') };
const provClinica: Provider = {
  id: 'p-clinica', tenant_id: 't-clinica', name: 'Centro A', source_slug: 'centroa',
  api_key_hash: '', active: true,
};

beforeAll(() => { provClinica.api_key_hash = HASH_CLINICA; });

describe('Webhook de radiografia: uma conta com o nome (fluxo de sempre)', () => {
  it('chave certa grava o exame na conta, sobe a imagem e vincula o paciente pelo CPF', async () => {
    const { service, prisma, s3, criados } = montar({
      tenants: [clinica],
      providers: [provClinica],
      pacientes: [{ id: 'pac-1', tenant_id: 't-clinica', cpf: '12345678900' }],
    });

    const exam: any = await service.webhook(CHAVE_CLINICA, payload());

    expect(criados).toHaveLength(1);
    expect(exam.tenant_id).toBe('t-clinica');
    expect(exam.provider_id).toBe('p-clinica');
    expect(exam.patient_id).toBe('pac-1');
    expect(exam.status).toBe('LINKED');
    expect(s3.uploadBuffer).toHaveBeenCalledTimes(1);
    expect((s3.uploadBuffer as jest.Mock).mock.calls[0][0]).toMatch(/^radiography\/t-clinica\/centroa\/EX-100-[0-9a-f]{8}\.png$/);
    expect(prisma.radiographyProvider.update).toHaveBeenCalledWith({
      where: { id: 'p-clinica' },
      data: { webhook_count: { increment: 1 }, last_received_at: expect.any(Date) },
    });
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it('nome com maiusculas/minusculas diferentes continua achando a conta', async () => {
    const { service, criados } = montar({ tenants: [clinica], providers: [provClinica] });
    await service.webhook(CHAVE_CLINICA, payload({ tenant_slug: 'CLINICA SORRISO' }));
    expect(criados).toHaveLength(1);
    expect(criados[0].tenant_id).toBe('t-clinica');
    expect(criados[0].status).toBe('RECEIVED');
  });

  it('exame repetido devolve o existente sem novo upload (idempotencia)', async () => {
    const existente = { id: 'exam-antigo', tenant_id: 't-clinica', source: 'centroa', source_external_id: 'EX-100' };
    const { service, prisma, s3, criados } = montar({
      tenants: [clinica], providers: [provClinica], exameExistente: existente,
    });
    await expect(service.webhook(CHAVE_CLINICA, payload())).resolves.toBe(existente);
    expect(criados).toHaveLength(0);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.radiographyProvider.update).not.toHaveBeenCalled();
  });

  it('conta sem provider ativo recusa com 401, como antes', async () => {
    const { service, criados } = montar({
      tenants: [clinica], providers: [{ ...provClinica, active: false }],
    });
    await expect(service.webhook(CHAVE_CLINICA, payload())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(criados).toHaveLength(0);
  });
});

describe('Webhook de radiografia: varias contas com o mesmo nome', () => {
  const outraNova: Tenant = { id: 't-outra-nova', name: 'clinica sorriso', created_at: new Date('2026-10-01T00:00:00Z') };
  const outraAntiga: Tenant = { id: 't-outra-antiga', name: 'Clinica Sorriso', created_at: new Date('2024-05-01T00:00:00Z') };

  it('conta nova com o mesmo nome e sem provider: o exame entra na clinica', async () => {
    const { service, s3, criados } = montar({
      tenants: [clinica, outraNova],
      providers: [provClinica],
      pacientes: [
        { id: 'pac-clinica', tenant_id: 't-clinica', cpf: '12345678900' },
        { id: 'pac-outra', tenant_id: 't-outra-nova', cpf: '12345678900' },
      ],
    });
    await service.webhook(CHAVE_CLINICA, payload());
    expect(criados).toHaveLength(1);
    expect(criados[0].tenant_id).toBe('t-clinica');
    expect(criados[0].patient_id).toBe('pac-clinica');
    expect((s3.uploadBuffer as jest.Mock).mock.calls[0][0]).toMatch(/^radiography\/t-clinica\//);
  });

  it('conta mais antiga com o mesmo nome e sem provider: o exame entra na clinica', async () => {
    const { service, criados } = montar({
      tenants: [outraAntiga, clinica],
      providers: [provClinica],
    });
    await service.webhook(CHAVE_CLINICA, payload());
    expect(criados).toHaveLength(1);
    expect(criados[0].tenant_id).toBe('t-clinica');
  });

  it('duas contas com providers proprios: cada chave grava na sua conta', async () => {
    const provOutra: Provider = {
      id: 'p-outra', tenant_id: 't-outra-nova', name: 'Centro B', source_slug: 'centrob',
      api_key_hash: HASH_OUTRA, active: true,
    };
    const a = montar({ tenants: [clinica, outraNova], providers: [provClinica, provOutra] });
    await a.service.webhook(CHAVE_CLINICA, payload());
    expect(a.criados[0].tenant_id).toBe('t-clinica');
    expect(a.criados[0].provider_id).toBe('p-clinica');

    const b = montar({ tenants: [clinica, outraNova], providers: [provClinica, provOutra] });
    await b.service.webhook(CHAVE_OUTRA, payload({ source_external_id: 'EX-200' }));
    expect(b.criados[0].tenant_id).toBe('t-outra-nova');
    expect(b.criados[0].provider_id).toBe('p-outra');
    expect((b.s3.uploadBuffer as jest.Mock).mock.calls[0][0]).toMatch(/^radiography\/t-outra-nova\/centrob\//);
  });

  it('mesma chave em duas contas: fica com a conta mais antiga', async () => {
    const provOutraMesmaChave: Provider = {
      id: 'p-outra', tenant_id: 't-outra-nova', name: 'Centro A', source_slug: 'centroa',
      api_key_hash: HASH_CLINICA, active: true,
    };
    const { service, criados } = montar({
      tenants: [clinica, outraNova], providers: [provClinica, provOutraMesmaChave],
    });
    await service.webhook(CHAVE_CLINICA, payload());
    expect(criados[0].tenant_id).toBe('t-clinica');
    expect(criados[0].provider_id).toBe('p-clinica');
  });

  it('provider desligado em outra conta com o mesmo nome nao interfere', async () => {
    const provOutraDesligado: Provider = {
      id: 'p-outra', tenant_id: 't-outra-antiga', name: 'Centro A', source_slug: 'centroa',
      api_key_hash: HASH_CLINICA, active: false,
    };
    const { service, criados } = montar({
      tenants: [outraAntiga, clinica], providers: [provOutraDesligado, provClinica],
    });
    await service.webhook(CHAVE_CLINICA, payload());
    expect(criados[0].tenant_id).toBe('t-clinica');
  });
});

describe('Webhook de radiografia: idempotencia so na conta do provider', () => {
  // Exame de outra conta com a mesma chave (source + source_external_id)
  const exameDeOutraConta = {
    id: 'exam-outra-conta',
    tenant_id: 't-outra-conta',
    patient_id: 'pac-outra-conta',
    provider_id: 'p-outra-conta',
    source: 'centroa',
    source_external_id: 'EX-100',
    image_s3_key: 'radiography/t-outra-conta/centroa/EX-100-aaaa0000.png',
    report_text: 'laudo da outra conta',
    report_html: '<p>laudo da outra conta</p>',
    external_patient_cpf: '98765432100',
    external_patient_name: 'Paciente Outra Conta',
    status: 'LINKED',
  };
  const semNadaDaOutraConta = (resposta: any) => {
    const texto = JSON.stringify(resposta);
    for (const v of ['exam-outra-conta', 't-outra-conta', 'pac-outra-conta', 'p-outra-conta',
      'radiography/t-outra-conta', 'laudo da outra conta', '98765432100', 'Paciente Outra Conta']) {
      expect(texto).not.toContain(v);
    }
  };

  it('chave ja recebida em outra conta: responde ja recebido sem dados, nao grava e registra no log', async () => {
    const { service, prisma, s3, criados, logs } = montar({
      tenants: [clinica], providers: [provClinica], exameExistente: exameDeOutraConta,
    });

    const resposta = await service.webhook(CHAVE_CLINICA, payload());

    expect(resposta).toEqual({ status: 'ALREADY_RECEIVED', source_external_id: 'EX-100' });
    semNadaDaOutraConta(resposta);
    expect(criados).toHaveLength(0);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.radiographyProvider.update).not.toHaveBeenCalled();
    expect(logs.some((l) =>
      l.startsWith('warn: [Radiography] Envio repetido de outra conta') &&
      l.includes('source=centroa') && l.includes('source_external_id=EX-100') &&
      l.includes('conta do provider t-clinica'))).toBe(true);
  });

  it('varias contas com o mesmo nome: a chave da clinica nao devolve o exame da outra conta', async () => {
    const outraMesmoNome: Tenant = { id: 't-outra-conta', name: 'Clinica Sorriso', created_at: new Date('2024-01-01T00:00:00Z') };
    const provOutra: Provider = {
      id: 'p-outra-conta', tenant_id: 't-outra-conta', name: 'Centro A', source_slug: 'centroa',
      api_key_hash: HASH_OUTRA, active: true,
    };
    const { service, criados } = montar({
      tenants: [outraMesmoNome, clinica], providers: [provOutra, provClinica], exameExistente: exameDeOutraConta,
    });
    const resposta = await service.webhook(CHAVE_CLINICA, payload());
    expect(resposta).toEqual({ status: 'ALREADY_RECEIVED', source_external_id: 'EX-100' });
    semNadaDaOutraConta(resposta);
    expect(criados).toHaveLength(0);

    // A chave da propria conta dona do exame continua recebendo o existente
    const dona = montar({
      tenants: [outraMesmoNome, clinica], providers: [provOutra, provClinica], exameExistente: exameDeOutraConta,
    });
    await expect(dona.service.webhook(CHAVE_OUTRA, payload())).resolves.toBe(exameDeOutraConta);
  });

  it('mesmo id externo em outro centro (source diferente): exame novo gravado normalmente', async () => {
    const { service, criados } = montar({
      tenants: [clinica], providers: [provClinica],
      exameExistente: { ...exameDeOutraConta, source: 'outrocentro' },
    });
    await service.webhook(CHAVE_CLINICA, payload());
    expect(criados).toHaveLength(1);
    expect(criados[0].tenant_id).toBe('t-clinica');
  });

  it('dois envios ao mesmo tempo (indice unico no create): mesma resposta de envio repetido', async () => {
    const daClinica = { ...exameDeOutraConta, id: 'exam-clinica', tenant_id: 't-clinica' };
    const mesma = montar({ tenants: [clinica], providers: [provClinica], exameNaCorrida: daClinica });
    await expect(mesma.service.webhook(CHAVE_CLINICA, payload())).resolves.toBe(daClinica);
    expect(mesma.criados).toHaveLength(0);

    const outra = montar({ tenants: [clinica], providers: [provClinica], exameNaCorrida: exameDeOutraConta });
    const resposta = await outra.service.webhook(CHAVE_CLINICA, payload());
    expect(resposta).toEqual({ status: 'ALREADY_RECEIVED', source_external_id: 'EX-100' });
    semNadaDaOutraConta(resposta);
    expect(outra.prisma.radiographyProvider.update).not.toHaveBeenCalled();
  });

  it('erro do banco no create que nao e de chave repetida: erro sobe, como antes', async () => {
    const { service, prisma } = montar({
      tenants: [clinica], providers: [provClinica], falhaCreate: new Error('banco indisponivel'),
    });
    await expect(service.webhook(CHAVE_CLINICA, payload())).rejects.toThrow('banco indisponivel');
    expect(prisma.radiographyProvider.update).not.toHaveBeenCalled();
  });
});

describe('Webhook de radiografia: aviso que nao confere', () => {
  it('chave que nao bate com nenhum provider das contas: 401 e nada gravado', async () => {
    const outra: Tenant = { id: 't-outra', name: 'Clinica Sorriso', created_at: new Date('2026-01-01T00:00:00Z') };
    const { service, prisma, s3, criados } = montar({ tenants: [clinica, outra], providers: [provClinica] });
    await expect(service.webhook('chave-desconhecida', payload())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(criados).toHaveLength(0);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.radiographyProvider.update).not.toHaveBeenCalled();
    expect(prisma.radiographyExam.findUnique).not.toHaveBeenCalled();
  });

  it('nome que nao existe: 401 e nada gravado', async () => {
    const { service, prisma, criados } = montar({ tenants: [clinica], providers: [provClinica] });
    await expect(service.webhook(CHAVE_CLINICA, payload({ tenant_slug: 'Outra Clinica' })))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(criados).toHaveLength(0);
    expect(prisma.radiographyProvider.findMany).not.toHaveBeenCalled();
  });

  it('sem header de chave: 401 antes de consultar o banco', async () => {
    const { service, prisma } = montar({ tenants: [clinica], providers: [provClinica] });
    await expect(service.webhook('', payload())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });
});

describe('Webhook de radiografia: falhas na conferencia', () => {
  it('hash de provider ilegivel e pulado e o provider seguinte ainda confere', async () => {
    const provQuebrado: Provider = { ...provClinica, id: 'p-quebrado', source_slug: 'velho', api_key_hash: 'nao-e-hash' };
    const { service, criados } = montar({ tenants: [clinica], providers: [provClinica, provQuebrado] });
    await service.webhook(CHAVE_CLINICA, payload());
    expect(criados).toHaveLength(1);
    expect(criados[0].provider_id).toBe('p-clinica');
  });

  it('banco fora do ar ao achar as contas: erro sobe (o centro reenvia) e nada gravado', async () => {
    const { service, s3, criados } = montar({ tenants: [clinica], providers: [provClinica], falhaTenants: true });
    await expect(service.webhook(CHAVE_CLINICA, payload())).rejects.toThrow('banco indisponivel');
    expect(criados).toHaveLength(0);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
  });

  it('banco fora do ar ao achar os providers: erro sobe (o centro reenvia) e nada gravado', async () => {
    const { service, criados } = montar({ tenants: [clinica], providers: [provClinica], falhaProviders: true });
    await expect(service.webhook(CHAVE_CLINICA, payload())).rejects.toThrow('banco indisponivel');
    expect(criados).toHaveLength(0);
  });
});
