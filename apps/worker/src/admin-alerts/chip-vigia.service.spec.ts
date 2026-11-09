/**
 * Vigia dos chips — o serviço com banco falso, servidor do WhatsApp falso e o envio
 * (sendAdminAlert) trocado por um espião. Duas "réplicas" do worker dividem o mesmo banco:
 * o aviso sai uma vez só. Dados de exemplo (repositório público: nada real).
 */
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { __limparCacheLabTenants } from '@crm/shared';
import { ChipVigiaService } from './chip-vigia.service';
import { sendAdminAlert } from './admin-alert';

jest.mock('axios', () => {
  const m: any = { post: jest.fn(), get: jest.fn() };
  m.default = m;
  return { __esModule: true, ...m };
});
jest.mock('./admin-alert', () => ({ sendAdminAlert: jest.fn() }));

const MIN = 60_000;
/** Hora de Maceió (UTC−3). 09/11/2026 = segunda. */
const m = (dia: number, h: number, min = 0) => Date.UTC(2026, 10, dia, h + 3, min);

const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const SUSPENSA = 'tenant-suspensa';
const DESLIGOU = 'tenant-desligou';
const EVO = 'https://evolution.exemplo.test';
const SETTINGS: any = { getEvolutionConfig: async () => ({ apiUrl: EVO, apiKey: 'chave-somente-teste' }) };

const CHIPS = [
  { name: 'cli-1', tenant_id: CLINICA, purpose: 'CLINICA' },
  { name: 'fin-1', tenant_id: CLINICA, purpose: 'FINANCEIRO' },
  { name: 'lab-1', tenant_id: LAB, purpose: 'COMERCIAL' },
  { name: 'sus-1', tenant_id: SUSPENSA, purpose: 'CLINICA' },
  { name: 'off-1', tenant_id: DESLIGOU, purpose: 'CLINICA' },
];

const ENTREGUE = { sent: 1, failed: 0, phones: ['5582900000009'], noPhone: false };
const FALHOU = { sent: 0, failed: 1, phones: ['5582900000009'], noPhone: false };
const SEM_NUMERO = { sent: 0, failed: 0, phones: [], noPhone: true };

function criarBanco(extra: { holidays?: any[] } = {}) {
  const settings = new Map<string, string>([[`CHIP_VIGIA_ENABLED_${DESLIGOU}`, 'false']]);
  const placar = { conflitos: 0 };
  /** Cede a vez entre as réplicas a cada consulta (como um banco de verdade). */
  const vez = () => new Promise((r) => setImmediate(r));
  const prisma: any = {
    instance: {
      findMany: jest.fn(async ({ where }: any) => {
        expect(where).toMatchObject({ type: 'whatsapp', purpose: { in: ['COMERCIAL', 'CLINICA', 'FINANCEIRO'] } });
        await vez();
        return CHIPS;
      }),
    },
    globalSetting: {
      findMany: jest.fn(async ({ where }: any) => {
        const out = [...settings].filter(([k]) => where.key.in.includes(k)).map(([key, value]) => ({ key, value }));
        await vez();
        return out;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        await vez();
        if (settings.get(where.key) !== where.value) {
          placar.conflitos++;
          return { count: 0 };
        }
        settings.set(where.key, data.value);
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }: any) => {
        await vez();
        if (settings.has(data.key)) {
          placar.conflitos++;
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        settings.set(data.key, data.value);
        return data;
      }),
    },
    tenant: {
      findMany: jest.fn(async () => [
        { id: CLINICA, status: 'ACTIVE' },
        { id: LAB, status: 'ACTIVE' },
        { id: SUSPENSA, status: 'SUSPENDED' },
        { id: DESLIGOU, status: 'TRIAL' },
      ]),
    },
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    holiday: { findMany: jest.fn(async () => extra.holidays ?? []) },
  };
  const estado = (chip: string) => JSON.parse(settings.get(`CHIP_VIGIA_ESTADO_${chip}`) ?? 'null');
  return { prisma, settings, placar, estado };
}

/** Servidor do WhatsApp falso: estado de cada chip e mensagens recebidas por chip. */
const servidor = {
  estado: {} as Record<string, string>,
  recebidas: {} as Record<string, number[]>,
  fora: false,
};

const enviado = sendAdminAlert as jest.Mock;
const textos = () => enviado.mock.calls.map((c) => c[3].text as string);

beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});

beforeEach(() => {
  __limparCacheLabTenants();
  enviado.mockReset().mockResolvedValue(ENTREGUE);
  servidor.fora = false;
  servidor.estado = { 'cli-1': 'open', 'fin-1': 'open', 'lab-1': 'open', 'sus-1': 'open', 'off-1': 'open' };
  servidor.recebidas = {};
  (axios.get as jest.Mock).mockReset().mockImplementation(async (url: string) => {
    if (servidor.fora) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(url).toBe(`${EVO}/instance/fetchInstances`);
    return {
      data: Object.entries(servidor.estado).map(([name, connectionStatus]) => ({
        name,
        connectionStatus,
        ownerJid: name === 'cli-1' ? '558299990001@s.whatsapp.net' : null,
      })),
    };
  });
  (axios.post as jest.Mock).mockReset().mockImplementation(async (url: string) => {
    const chip = decodeURIComponent(url.split('/').pop() as string);
    const ts = servidor.recebidas[chip] ?? [];
    // Inclui uma mensagem de grupo bem recente: não pode contar como "recebeu".
    const grupo = { key: { remoteJid: '120363000000000000@g.us' }, messageTimestamp: Math.floor(Date.UTC(2026, 10, 9, 23) / 1000) };
    return {
      data: {
        messages: {
          records: [grupo, ...ts.map((t) => ({ key: { remoteJid: '5582900000001@s.whatsapp.net' }, messageTimestamp: Math.floor(t / 1000) }))],
        },
      },
    };
  });
});

/** Roda as réplicas minuto a minuto, de `de` até `ate` (inclusive), ao mesmo tempo. */
async function rodar(replicas: ChipVigiaService[], de: number, ate: number, antes?: (t: number) => void) {
  for (let t = de; t <= ate; t += MIN) {
    antes?.(t);
    await Promise.all(replicas.map((r) => r.processar(t)));
  }
}

describe('ChipVigiaService', () => {
  it('desconectado → um aviso só com duas réplicas ao mesmo tempo, por outro chip; normalizado → outro aviso', async () => {
    const { prisma, placar, estado } = criarBanco();
    const a = new ChipVigiaService(prisma, SETTINGS);
    const b = new ChipVigiaService(prisma, SETTINGS);

    await rodar([a, b], m(9, 10, 0), m(9, 10, 4));
    expect(estado('cli-1')).toMatchObject({ vistoOpen: true, problema: null });
    placar.conflitos = 0;

    servidor.estado['cli-1'] = 'close';
    await rodar([a, b], m(9, 10, 5), m(9, 10, 20));

    expect(enviado).toHaveBeenCalledTimes(1);
    expect(placar.conflitos).toBeGreaterThanOrEqual(1); // a outra réplica perdeu a troca no banco
    const [, , tenant, opts] = enviado.mock.calls[0];
    expect(tenant).toBe(CLINICA);
    expect(opts).toMatchObject({ type: 'chip_whatsapp', disparo: 'chip_whatsapp', chipsPorUltimo: ['cli-1'] });
    expect(opts.text).toContain('*WhatsApp desconectado*');
    expect(opts.text).toContain('*Clínica* (82) 9999-0001');
    expect(opts.text).toContain('desde as 10:05');
    expect(estado('cli-1')).toMatchObject({ problema: 'desconectado' });

    servidor.estado['cli-1'] = 'open';
    await rodar([a, b], m(9, 10, 21), m(9, 10, 40));
    expect(enviado).toHaveBeenCalledTimes(2);
    expect(textos()[1]).toContain('*WhatsApp normalizado*');
    expect(textos()[1]).toContain('voltou ao normal às 10:21, depois de 16 min com problema');
    expect(estado('cli-1')).toMatchObject({ problema: null });
  });

  it('chip que nunca esteve conectado (QR não lido, abandonado) não avisa', async () => {
    const { prisma, estado } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    servidor.estado['fin-1'] = 'close';
    await rodar([vigia], m(9, 10, 0), m(9, 10, 40));
    expect(enviado).not.toHaveBeenCalled();
    expect(estado('fin-1')).toBeNull();
  });

  it('aviso que nenhum chip entregou: tenta de novo a cada 10 min e para no que chegar', async () => {
    const { prisma, estado } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    enviado.mockReset().mockResolvedValueOnce(FALHOU).mockResolvedValueOnce(FALHOU).mockResolvedValue(ENTREGUE);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 2));
    servidor.estado['cli-1'] = 'close';
    await rodar([vigia], m(9, 10, 3), m(9, 11, 0));
    expect(enviado).toHaveBeenCalledTimes(3);
    const horas = enviado.mock.calls.map((c) => c[3].text.includes('desconectado'));
    expect(horas).toEqual([true, true, true]);
    expect(estado('cli-1')).toMatchObject({ problema: 'desconectado', falhasEnvio: 0, envioFalhouEm: null });
  });

  it('ninguém para receber: tenta 3 vezes e desiste', async () => {
    const { prisma, estado } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    enviado.mockReset().mockResolvedValue(SEM_NUMERO);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 2));
    servidor.estado['cli-1'] = 'close';
    await rodar([vigia], m(9, 10, 3), m(9, 11, 30));
    expect(enviado).toHaveBeenCalledTimes(3);
    expect(estado('cli-1')).toMatchObject({ problema: 'desconectado', falhasEnvio: 0 });
  });

  it('laboratório fica de fora', async () => {
    const { prisma } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 2));
    servidor.estado['lab-1'] = 'close';
    await rodar([vigia], m(9, 10, 3), m(9, 10, 30));
    expect(enviado).not.toHaveBeenCalled();
  });

  it('conta suspensa fica de fora', async () => {
    const { prisma } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 2));
    servidor.estado['sus-1'] = 'close';
    await rodar([vigia], m(9, 10, 3), m(9, 10, 30));
    expect(enviado).not.toHaveBeenCalled();
  });

  it('clínica que desligou a vigia na Central fica de fora', async () => {
    const { prisma } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 2));
    servidor.estado['off-1'] = 'close';
    await rodar([vigia], m(9, 10, 3), m(9, 10, 30));
    expect(enviado).not.toHaveBeenCalled();
  });

  it('chip instável (cai e volta) avisa uma vez', async () => {
    const { prisma } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 2));
    await rodar([vigia], m(9, 10, 3), m(9, 10, 15), (t) => {
      servidor.estado['fin-1'] = Math.floor(t / MIN) % 2 ? 'connecting' : 'open';
    });
    expect(enviado).toHaveBeenCalledTimes(1);
    expect(textos()[0]).toContain('*WhatsApp instável*');
    expect(enviado.mock.calls[0][3].chipsPorUltimo).toEqual(['fin-1']);
  });

  it('servidor do WhatsApp fora do ar: não conta leitura nem avisa', async () => {
    const { prisma } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 2));
    servidor.fora = true;
    await rodar([vigia], m(9, 10, 3), m(9, 10, 30));
    expect(enviado).not.toHaveBeenCalled();
  });

  it('estado vazio na resposta do servidor = desconhecido, não desconectado', async () => {
    const { prisma } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 2));
    servidor.estado['cli-1'] = '';
    await rodar([vigia], m(9, 10, 3), m(9, 10, 30));
    expect(enviado).not.toHaveBeenCalled();
  });

  it('conectado mas sem receber: avisa depois de 2 h sem mensagem e fecha quando chega uma', async () => {
    const { prisma } = criarBanco();
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    // 41 mensagens de 2 em 2 min entre 08:00 e 09:20; depois, nada (só o grupo, que não conta).
    servidor.recebidas['cli-1'] = Array.from({ length: 41 }, (_, i) => m(9, 8, 0) + i * 2 * MIN);
    await rodar([vigia], m(9, 11, 0), m(9, 11, 19)); // 1h59 de silêncio: ainda não
    expect(enviado).not.toHaveBeenCalled();
    await rodar([vigia], m(9, 11, 20), m(9, 11, 20)); // 2 h
    expect(enviado).toHaveBeenCalledTimes(1);
    expect(textos()[0]).toContain('*WhatsApp sem receber mensagens*');
    expect(textos()[0]).toContain('desde as 09:20');

    servidor.recebidas['cli-1'].push(m(9, 11, 22));
    await rodar([vigia], m(9, 11, 21), m(9, 11, 25));
    expect(enviado).toHaveBeenCalledTimes(2);
    expect(textos()[1]).toContain('voltou a receber mensagens às 11:22');
  });

  it('feriado: não mede silêncio', async () => {
    const { prisma } = criarBanco({ holidays: [{ tenant_id: null, date: new Date('2026-11-09T00:00:00.000Z'), recurring_yearly: false }] });
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    servidor.recebidas['cli-1'] = Array.from({ length: 41 }, (_, i) => m(9, 8, 0) + i * 2 * MIN);
    await rodar([vigia], m(9, 11, 0), m(9, 12, 0));
    expect(enviado).not.toHaveBeenCalled();
  });

  it('não conseguiu ler quais contas são laboratório: pula a rodada', async () => {
    const { prisma } = criarBanco();
    prisma.tenantBusinessProfile.findMany = jest.fn(async () => {
      throw new Error('banco fora');
    });
    const vigia = new ChipVigiaService(prisma, SETTINGS);
    await rodar([vigia], m(9, 10, 0), m(9, 10, 20));
    expect(enviado).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});
