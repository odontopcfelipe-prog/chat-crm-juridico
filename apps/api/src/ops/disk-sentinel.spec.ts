/**
 * F0b — vigia de disco: e-mail aos SUPER_ADMIN em 80% e 90%, no máximo 1 por
 * faixa por dia (mesmo com 2 réplicas). statfs simulado — não lê disco real.
 */
import { promises as fs } from 'fs';
import { DiskSentinelService, faixaAtingida, limites, usoDoDisco } from './disk-sentinel.service';

function statfs(pctUsado: number) {
  const blocks = 1000;
  const usados = Math.round((blocks * pctUsado) / 100);
  return { bsize: 1024 ** 2, blocks, bfree: blocks - usados, bavail: blocks - usados } as any;
}

function montar() {
  const settings = new Map<string, string>();
  const enviados: string[] = [];
  const prisma: any = {
    globalSetting: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const atual = settings.get(where.key);
        const casa =
          atual !== undefined &&
          (typeof where.value === 'string' ? atual === where.value : atual !== where.value.not);
        if (casa) {
          settings.set(where.key, data.value);
          return { count: 1 };
        }
        return { count: 0 };
      }),
      create: jest.fn(async ({ data }: any) => {
        if (settings.has(data.key)) throw new Error('P2002');
        settings.set(data.key, data.value);
      }),
    },
    user: { findMany: jest.fn(async () => [{ email: 'dono@exemplo.com' }]) },
    $queryRawUnsafe: jest.fn(async () => [{ n: BigInt(5 * 1024 ** 3) }]),
  };
  const mail: any = {
    renderTemplate: jest.fn(() => '<html>'),
    send: jest.fn(async ({ subject }: any) => {
      enviados.push(subject);
      return true;
    }),
  };
  return { svc: new DiskSentinelService(prisma, mail), settings, enviados, prisma, mail };
}

describe('faixas', () => {
  it('padrão 80 e 90; env muda (e ignora lixo)', () => {
    expect(limites(undefined)).toEqual([80, 90]);
    expect(limites('2, 1')).toEqual([1, 2]);
    expect(limites('abc')).toEqual([80, 90]);
  });
  it('maior faixa atingida', () => {
    expect(faixaAtingida(79.9, [80, 90])).toBeNull();
    expect(faixaAtingida(85, [80, 90])).toBe(80);
    expect(faixaAtingida(93, [80, 90])).toBe(90);
  });
  it('uso igual ao df', async () => {
    jest.spyOn(fs, 'statfs').mockResolvedValueOnce(statfs(82));
    await expect(usoDoDisco('/x')).resolves.toMatchObject({ pct: 82 });
  });
});

describe('DiskSentinelService.verificar', () => {
  afterEach(() => jest.restoreAllMocks());

  it('abaixo de 80% → nada', async () => {
    const { svc, enviados } = montar();
    jest.spyOn(fs, 'statfs').mockResolvedValue(statfs(70));
    await svc.verificar();
    expect(enviados).toEqual([]);
  });

  it('85% → 1 e-mail no dia, mesmo rodando de novo (ou em outra réplica)', async () => {
    const { svc, enviados, settings } = montar();
    jest.spyOn(fs, 'statfs').mockResolvedValue(statfs(85));
    await svc.verificar();
    await svc.verificar();
    expect(enviados).toEqual(['⚠️ Disco do servidor em 85%']);
    expect([...settings.keys()]).toEqual(['DISK_SENTINEL_80']);
  });

  it('subiu de 85% para 92% no mesmo dia → manda o da faixa de 90%', async () => {
    const { svc, enviados } = montar();
    const spy = jest.spyOn(fs, 'statfs').mockResolvedValue(statfs(85));
    await svc.verificar();
    spy.mockResolvedValue(statfs(92));
    await svc.verificar();
    await svc.verificar();
    expect(enviados).toEqual(['⚠️ Disco do servidor em 85%', '⚠️ Disco do servidor em 92%']);
  });

  it.each([
    ['SMTP falha (lança)', (mail: any) => mail.send.mockRejectedValueOnce(new Error('ETIMEDOUT'))],
    ['SMTP não configurado (false)', (mail: any) => mail.send.mockResolvedValueOnce(false)],
  ])('%s na 1ª rodada → a trava volta e a rodada seguinte manda', async (_n, falhar) => {
    const { svc, enviados, mail, settings } = montar();
    jest.spyOn(fs, 'statfs').mockResolvedValue(statfs(85));
    falhar(mail);
    await svc.verificar();
    expect(enviados).toEqual([]);
    expect(settings.get('DISK_SENTINEL_80')).toBe('');
    await svc.verificar();
    await svc.verificar();
    expect(enviados).toEqual(['⚠️ Disco do servidor em 85%']);
  });

  it('sem SUPER_ADMIN com e-mail → não gasta a trava do dia', async () => {
    const { svc, prisma, settings, enviados } = montar();
    prisma.user.findMany.mockResolvedValueOnce([]);
    jest.spyOn(fs, 'statfs').mockResolvedValue(statfs(85));
    await svc.verificar();
    expect(settings.get('DISK_SENTINEL_80')).toBe('');
    await svc.verificar();
    expect(enviados).toHaveLength(1);
  });

  it('aviso de ontem não segura o de hoje', async () => {
    const { svc, enviados, settings } = montar();
    settings.set('DISK_SENTINEL_80', '2000-01-01');
    jest.spyOn(fs, 'statfs').mockResolvedValue(statfs(81));
    await svc.verificar();
    expect(enviados).toHaveLength(1);
  });

  it('DISK_SENTINEL_OFF=1 → desligado; statfs falhando → só loga', async () => {
    const { svc, enviados } = montar();
    process.env.DISK_SENTINEL_OFF = '1';
    jest.spyOn(fs, 'statfs').mockResolvedValue(statfs(99));
    await svc.verificar();
    delete process.env.DISK_SENTINEL_OFF;
    jest.spyOn(fs, 'statfs').mockRejectedValue(new Error('ENOENT'));
    await expect(svc.verificar()).resolves.toBeUndefined();
    expect(enviados).toEqual([]);
  });
});
