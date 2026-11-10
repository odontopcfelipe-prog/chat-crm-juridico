/**
 * Aviso de WhatsApp na tela (nov/2026): GET /whatsapp/situacao-chips junta o estado ao
 * vivo do chip no servidor do WhatsApp com o que a vigia do worker registrou. A regra é
 * a do @crm/shared (situacaoDoChip, problemaDaVigia, chipDaConversa).
 *
 * Repositório público: ids e números fictícios.
 */
import { chipDaConversa, problemaDaVigia, situacaoDoChip } from '@crm/shared';
import { WhatsappService } from './whatsapp.service';

const CONTA = 'aaaabbbb-0000-0000-0000-000000000001'; // prefixo dos chips: taaaabbbb-
const OUTRA = 'ccccdddd-0000-0000-0000-000000000002';
const AGORA = Date.UTC(2026, 10, 9, 18, 0);

describe('situacaoDoChip', () => {
  it('estado ao vivo manda; a vigia só acrescenta instável e sem receber', () => {
    expect(situacaoDoChip('close', null)).toBe('desconectado');
    expect(situacaoDoChip('connecting', null)).toBe('reconectando');
    expect(situacaoDoChip('open', null)).toBe('ok');
    expect(situacaoDoChip('open', { problema: 'instavel' })).toBe('instavel');
    expect(situacaoDoChip('open', { problema: 'sem_receber' })).toBe('sem_receber');
    // Conectado de novo: o episódio "desconectado" da vigia não vira aviso na tela.
    expect(situacaoDoChip('open', { problema: 'desconectado' })).toBe('ok');
    expect(situacaoDoChip('close', { problema: 'instavel' })).toBe('desconectado');
  });

  it('sem estado (servidor não respondeu) não alarma', () => {
    expect(situacaoDoChip(undefined, null)).toBe('desconhecido');
    expect(situacaoDoChip('unknown', { problema: 'instavel' })).toBe('desconhecido');
    expect(situacaoDoChip('', null)).toBe('desconhecido');
  });
});

describe('problemaDaVigia', () => {
  it('lê o episódio aberto e ignora valor quebrado, chip normal ou episódio velho', () => {
    expect(problemaDaVigia(JSON.stringify({ problema: 'instavel', desde: 5, avisadoEm: AGORA - 1000 }), AGORA)).toEqual({
      problema: 'instavel',
      desde: 5,
    });
    expect(problemaDaVigia(JSON.stringify({ problema: null }), AGORA)).toBeNull();
    expect(problemaDaVigia('{oops', AGORA)).toBeNull();
    expect(problemaDaVigia(null, AGORA)).toBeNull();
    expect(problemaDaVigia(JSON.stringify({ problema: 'sem_receber', avisadoEm: AGORA - 25 * 3600e3 }), AGORA)).toBeNull();
  });
});

describe('chipDaConversa', () => {
  const chips = [
    { purpose: 'COMERCIAL', n: 'com' },
    { purpose: 'CLINICA', n: 'cli' },
    { purpose: 'FINANCEIRO', n: 'fin' },
  ];
  it('Financeiro → chip Financeiro; cliente → Clínica; lead → Comercial', () => {
    expect(chipDaConversa(chips, { inboxPurpose: 'FINANCEIRO', isClient: true })?.n).toBe('fin');
    expect(chipDaConversa(chips, { inboxPurpose: 'CLINICA', isClient: true })?.n).toBe('cli');
    expect(chipDaConversa(chips, { inboxPurpose: 'COMERCIAL', isClient: false })?.n).toBe('com');
  });
  it('dois chips da mesma função: o primeiro da lista (a API manda em ordem de criação, como o envio)', () => {
    const dois = [{ purpose: 'CLINICA', n: 'antigo' }, { purpose: 'CLINICA', n: 'novo' }];
    expect(chipDaConversa(dois, { isClient: true })?.n).toBe('antigo');
  });
  it('sem chip dessa função: conta com um chip só usa esse; senão, nenhum (não chuta)', () => {
    expect(chipDaConversa([{ purpose: 'COMERCIAL', n: 'unico' }], { isClient: true })?.n).toBe('unico');
    expect(chipDaConversa([chips[0], chips[2]], { isClient: true })).toBeNull();
  });
});

describe('WhatsappService.situacaoDosChips', () => {
  type Linha = { tenant_id: string; name: string; purpose: string | null; created_at: number };

  function montar(opts: {
    linhas: Linha[];
    servidor: any[] | null;
    settings?: Record<string, string>;
    legado?: Record<string, string>;
  }) {
    const prisma: any = {
      instance: {
        findMany: jest.fn(async ({ where, orderBy }: any) => {
          expect(orderBy).toEqual({ created_at: 'asc' });
          return opts.linhas
            .filter((l) => l.tenant_id === where.tenant_id && where.type === 'whatsapp')
            .sort((a, b) => a.created_at - b.created_at)
            .map(({ name, purpose }) => ({ name, purpose }));
        }),
      },
      globalSetting: {
        findMany: jest.fn(async ({ where }: any) =>
          Object.entries(opts.settings ?? {})
            .filter(([k]) => where.key.in.includes(k))
            .map(([key, value]) => ({ key, value })),
        ),
      },
      tenantSetting: {
        findUnique: jest.fn(async ({ where }: any) => {
          const v = opts.legado?.[where.tenant_id_key.tenant_id];
          return where.tenant_id_key.key === 'EVOLUTION_INSTANCE_NAME' && v ? { value: v } : null;
        }),
      },
    };
    const svc = new WhatsappService({} as any, {} as any, prisma);
    const listar = jest.spyOn(svc, 'listInstances').mockImplementation(async () => opts.servidor as any);
    return { svc, listar };
  }

  const recente = () => Date.now() - 60_000;

  it('junta o estado ao vivo com a vigia, só dos chips da própria conta, em ordem de criação', async () => {
    const { svc } = montar({
      linhas: [
        { tenant_id: CONTA, name: 'taaaabbbb-3', purpose: 'FINANCEIRO', created_at: 3 },
        { tenant_id: CONTA, name: 'taaaabbbb-1', purpose: 'CLINICA', created_at: 1 },
        { tenant_id: CONTA, name: 'taaaabbbb-2', purpose: 'COMERCIAL', created_at: 2 },
        { tenant_id: OUTRA, name: 'tccccdddd-1', purpose: 'CLINICA', created_at: 0 },
      ],
      servidor: [
        { instanceName: 'taaaabbbb-1', status: 'open', phoneNumber: '558299990001' },
        { instanceName: 'taaaabbbb-2', status: 'close', phoneNumber: '558299990002' },
        { instanceName: 'taaaabbbb-3', status: 'connecting', phoneNumber: null },
        { instanceName: 'tccccdddd-1', status: 'close', phoneNumber: '558299990009' },
      ],
      settings: {
        'CHIP_VIGIA_ESTADO_taaaabbbb-1': JSON.stringify({ problema: 'sem_receber', desde: 123, avisadoEm: recente() }),
        // Estado de chip de outra conta nunca é lido.
        'CHIP_VIGIA_ESTADO_tccccdddd-1': JSON.stringify({ problema: 'instavel', desde: 9, avisadoEm: recente() }),
      },
    });
    expect(await svc.situacaoDosChips(CONTA)).toEqual([
      { instanceName: 'taaaabbbb-1', purpose: 'CLINICA', numero: '558299990001', situacao: 'sem_receber', desde: 123 },
      { instanceName: 'taaaabbbb-2', purpose: 'COMERCIAL', numero: '558299990002', situacao: 'desconectado', desde: null },
      { instanceName: 'taaaabbbb-3', purpose: 'FINANCEIRO', numero: null, situacao: 'reconectando', desde: null },
    ]);
  });

  it('vigia desligada na Central: o estado que ficou gravado não vira aviso', async () => {
    const { svc } = montar({
      linhas: [{ tenant_id: CONTA, name: 'taaaabbbb-1', purpose: 'CLINICA', created_at: 1 }],
      servidor: [{ instanceName: 'taaaabbbb-1', status: 'open', phoneNumber: null }],
      settings: {
        [`CHIP_VIGIA_ENABLED_${CONTA}`]: 'false',
        'CHIP_VIGIA_ESTADO_taaaabbbb-1': JSON.stringify({ problema: 'instavel', desde: 5, avisadoEm: recente() }),
      },
    });
    expect((await svc.situacaoDosChips(CONTA))[0].situacao).toBe('ok');
  });

  it('chip da conta ainda sem função entra; linha morta de nome solto (ex.: "whatsapp") não', async () => {
    const { svc } = montar({
      linhas: [
        { tenant_id: CONTA, name: 'whatsapp', purpose: null, created_at: 0 },
        { tenant_id: CONTA, name: 'Comercial', purpose: null, created_at: 1 },
        { tenant_id: CONTA, name: 'taaaabbbb-1', purpose: null, created_at: 2 },
      ],
      servidor: [
        { instanceName: 'Comercial', status: 'close', phoneNumber: '558299990003' },
        { instanceName: 'taaaabbbb-1', status: 'close', phoneNumber: '558299990004' },
      ],
    });
    expect(await svc.situacaoDosChips(CONTA)).toEqual([
      { instanceName: 'taaaabbbb-1', purpose: null, numero: '558299990004', situacao: 'desconectado', desde: null },
    ]);
  });

  it('chip legado (nome solto) só conta quando a conta não tem chip com função', async () => {
    const semFuncao = montar({
      linhas: [],
      servidor: [{ instanceName: 'legado-x', status: 'close', phoneNumber: null }],
      legado: { [CONTA]: 'legado-x' },
    });
    expect((await semFuncao.svc.situacaoDosChips(CONTA)).map((c) => c.instanceName)).toEqual(['legado-x']);

    const comFuncao = montar({
      linhas: [{ tenant_id: CONTA, name: 'taaaabbbb-1', purpose: 'CLINICA', created_at: 1 }],
      servidor: [
        { instanceName: 'legado-x', status: 'close', phoneNumber: null },
        { instanceName: 'taaaabbbb-1', status: 'open', phoneNumber: null },
      ],
      legado: { [CONTA]: 'legado-x' },
    });
    expect((await comFuncao.svc.situacaoDosChips(CONTA)).map((c) => c.instanceName)).toEqual(['taaaabbbb-1']);
  });

  it('servidor do WhatsApp sem resposta: tudo "desconhecido" (a tela não alarma)', async () => {
    const { svc } = montar({
      linhas: [
        { tenant_id: CONTA, name: 'taaaabbbb-1', purpose: 'CLINICA', created_at: 1 },
        { tenant_id: CONTA, name: 'taaaabbbb-2', purpose: 'COMERCIAL', created_at: 2 },
      ],
      servidor: null,
    });
    expect((await svc.situacaoDosChips(CONTA)).map((c) => c.situacao)).toEqual(['desconhecido', 'desconhecido']);
  });

  it('conta sem chip: lista vazia, sem consultar o servidor', async () => {
    const { svc, listar } = montar({ linhas: [], servidor: [] });
    expect(await svc.situacaoDosChips(CONTA)).toEqual([]);
    expect(listar).not.toHaveBeenCalled();
  });

  it('consulta o servidor no máximo a cada 30 s, mesmo com várias telas perguntando', async () => {
    const relogio = jest.spyOn(Date, 'now');
    try {
      relogio.mockReturnValue(AGORA);
      const { svc, listar } = montar({
        linhas: [{ tenant_id: CONTA, name: 'taaaabbbb-1', purpose: 'CLINICA', created_at: 1 }],
        servidor: [],
      });
      await svc.situacaoDosChips(CONTA);
      await svc.situacaoDosChips(OUTRA);
      relogio.mockReturnValue(AGORA + 29_000);
      await svc.situacaoDosChips(CONTA);
      expect(listar).toHaveBeenCalledTimes(1);
      relogio.mockReturnValue(AGORA + 31_000);
      await svc.situacaoDosChips(CONTA);
      expect(listar).toHaveBeenCalledTimes(2);
    } finally {
      relogio.mockRestore();
    }
  });
});
