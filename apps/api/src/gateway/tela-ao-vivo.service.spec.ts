/**
 * Tela ao vivo: só o dono do sistema abre (papel conferido no banco), a tela vai
 * só para a conexão dele, a pessoa acompanhada é sempre avisada, nada é guardado
 * e início e fim ficam registrados.
 */
import {
  ENTIDADE_DA_TELA,
  MAX_CARACTERES_POR_MINUTO,
  MAX_CARACTERES_POR_PEDACO,
  MAX_FILA_DO_OBSERVADOR,
  MAX_PEDACOS_POR_LOTE,
  TEMPO_MAXIMO_MS,
  TelaAoVivoService,
  lerQuadro,
} from './tela-ao-vivo.service';
import { eventosDaTela } from './tela-ao-vivo.eventos';
import { ChatGateway } from './chat.gateway';

const DONO = 'dono';
const ALVO = 'alvo';

function conexao(id: string, sub: string) {
  return {
    id,
    connected: true,
    data: { user: { sub } },
    emit: jest.fn(),
    emitLocal: jest.fn(),
    conn: { writeBuffer: [] as unknown[] },
  } as any;
}

function montar(papeisDoDono = ['SUPER_ADMIN', 'ADMIN']) {
  const auditLog = { create: jest.fn(async () => ({})) };
  const prisma: any = {
    auditLog,
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === DONO) return { id: DONO, roles: papeisDoDono, tenant_id: 'conta-dono' };
        if (where.id === ALVO) return { id: ALVO, roles: ['OPERADOR'], tenant_id: 'conta-b' };
        return null;
      }),
    },
  };
  const sockets = new Map<string, any>();
  const online = new Map<string, string[]>();
  const gateway: any = {
    server: {
      sockets: { sockets },
      local: { to: (id: string) => ({ emit: (...args: unknown[]) => sockets.get(id)?.emitLocal(...args) }) },
    },
    socketsDoUsuario: (u: string) => online.get(u) ?? [],
    isUserOnline: (u: string) => (online.get(u)?.length ?? 0) > 0,
  };
  const tela = new TelaAoVivoService(prisma, gateway);
  const abrir = (id: string, sub: string) => {
    const s = conexao(id, sub);
    sockets.set(id, s);
    online.set(sub, [...(online.get(sub) ?? []), id]);
    return s;
  };
  const fechar = (s: any) => {
    sockets.delete(s.id);
    s.connected = false;
    online.set(s.data.user.sub, (online.get(s.data.user.sub) ?? []).filter((x) => x !== s.id));
  };
  return { tela, prisma, auditLog, abrir, fechar };
}

const emitido = (s: any, evento: string) => s.emit.mock.calls.filter((c: any[]) => c[0] === evento).map((c: any[]) => c[1]);
/** O que chegou ao dono pelo envio local, o único que não passa pelo Redis. */
const quadros = (s: any) => s.emitLocal.mock.calls.filter((c: any[]) => c[0] === 'tela_quadro').map((c: any[]) => c[1]);
const sessaoDe = (alvo: any) => emitido(alvo, 'tela_comecar').at(-1).sessao as string;
const quadro = (sessao: string, extra: Record<string, unknown> = {}) => ({
  sessao, aba: 'aba-1', lote: 0, parte: 0, total: 1, dados: '[]', ...extra,
});

afterEach(() => jest.useRealTimers());

describe('quem pode abrir', () => {
  it('recusa quem não é o dono do sistema no banco, mesmo com o token dizendo que é', async () => {
    const { tela, auditLog, abrir } = montar(['ADMIN']);
    const dono = abrir('s-dono', DONO);
    dono.data.user.roles = ['SUPER_ADMIN'];
    const alvo = abrir('s-alvo', ALVO);

    await tela.assistir(dono, ALVO);

    expect(emitido(dono, 'tela_estado')).toEqual([{ estado: 'negado' }]);
    expect(emitido(alvo, 'tela_comecar')).toEqual([]);
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it('sem registro não há sessão: falhou ao gravar o início, a pessoa não é acompanhada', async () => {
    const { tela, auditLog, abrir } = montar();
    auditLog.create.mockRejectedValueOnce(new Error('banco fora'));
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);

    await tela.assistir(dono, ALVO);

    expect(emitido(dono, 'tela_estado').at(-1).estado).toBe('erro');
    expect(emitido(alvo, 'tela_comecar')).toEqual([]);
    tela.quadro(alvo, quadro('qualquer'));
    expect(quadros(dono)).toEqual([]);
  });

  it('o dono que saiu enquanto o início era registrado: encerra e fica anotado', async () => {
    const { tela, auditLog, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    auditLog.create.mockImplementationOnce(async () => {
      dono.connected = false;
      return {};
    });

    await tela.assistir(dono, ALVO);

    expect(emitido(alvo, 'tela_comecar')).toEqual([]);
    expect(auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: 'ENCERROU', meta_json: expect.objectContaining({ motivo: 'observador_saiu' }) }),
    });
  });

  it('não acompanha a própria conta nem usuário que não existe', async () => {
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);

    await tela.assistir(dono, DONO);
    await tela.assistir(dono, 'ninguem');

    expect(emitido(dono, 'tela_estado').map((e: any) => e.estado)).toEqual(['erro', 'erro']);
  });

  it('o dono que saiu durante a consulta não abre sessão', async () => {
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    dono.connected = false;

    await tela.assistir(dono, ALVO);

    expect(emitido(alvo, 'tela_comecar')).toEqual([]);
  });
});

describe('aviso e registro', () => {
  it('todas as abas da pessoa recebem o aviso e o início fica registrado', async () => {
    const { tela, auditLog, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const a1 = abrir('s-a1', ALVO);
    const a2 = abrir('s-a2', ALVO);

    await tela.assistir(dono, ALVO);

    expect(emitido(a1, 'tela_comecar')).toHaveLength(1);
    expect(emitido(a2, 'tela_comecar')).toHaveLength(1);
    expect(emitido(dono, 'tela_estado').at(-1).estado).toBe('aguardando_tela');
    expect(auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entity: ENTIDADE_DA_TELA,
        action: 'INICIOU',
        actor_user_id: DONO,
        entity_id: ALVO,
        tenant_id: 'conta-b',
      }),
    });
  });

  it('aba aberta depois também entra na sessão e mostra o aviso', async () => {
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const a1 = abrir('s-a1', ALVO);
    await tela.assistir(dono, ALVO);

    const nova = abrir('s-a2', ALVO);
    tela.aoConectar(nova);

    expect(emitido(nova, 'tela_comecar')).toEqual([{ sessao: sessaoDe(a1) }]);
  });

  it('conexão de quem não está sendo acompanhado não recebe nada', () => {
    const { tela, abrir } = montar();
    const outra = abrir('s-x', 'outra-pessoa');
    tela.aoConectar(outra);
    expect(outra.emit).not.toHaveBeenCalled();
  });

  it('a pessoa cuja conexão não dá conta encerra a própria sessão', async () => {
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    const intruso = abrir('s-i', 'intruso');
    await tela.assistir(dono, ALVO);
    const sessao = sessaoDe(alvo);

    tela.desistir(intruso, { sessao });
    tela.desistir(alvo, { sessao: 'outra' });
    expect(emitido(alvo, 'tela_parar')).toEqual([]);

    tela.desistir(alvo, { sessao });
    expect(emitido(alvo, 'tela_parar')).toHaveLength(1);
    expect(emitido(dono, 'tela_estado').at(-1)).toEqual(expect.objectContaining({ estado: 'encerrada', motivo: 'lento' }));
  });

  it('o dono sair encerra: a pessoa para de ver o aviso e o fim fica registrado', async () => {
    const { tela, auditLog, abrir, fechar } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    await tela.assistir(dono, ALVO);

    fechar(dono);
    tela.aoDesconectar(dono);

    expect(emitido(alvo, 'tela_parar')).toHaveLength(1);
    expect(auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: 'ENCERROU',
        meta_json: expect.objectContaining({ motivo: 'observador_saiu', duracao_s: expect.any(Number) }),
      }),
    });
    tela.quadro(alvo, quadro(sessaoDe(alvo)));
    expect(quadros(dono)).toEqual([]);
  });

  it('acaba sozinha no tempo máximo', async () => {
    jest.useFakeTimers();
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    await tela.assistir(dono, ALVO);

    jest.advanceTimersByTime(TEMPO_MAXIMO_MS);

    expect(emitido(alvo, 'tela_parar')).toHaveLength(1);
    expect(emitido(dono, 'tela_estado').at(-1)).toEqual(expect.objectContaining({ estado: 'encerrada', motivo: 'tempo' }));
  });

  it('abrir outra pessoa encerra a anterior; só uma sessão por conexão do dono', async () => {
    const { tela, prisma, abrir } = montar();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === DONO) return { id: DONO, roles: ['SUPER_ADMIN'], tenant_id: 'x' };
      return { id: where.id, roles: [], tenant_id: 'b' };
    });
    const dono = abrir('s-dono', DONO);
    const a = abrir('s-a', ALVO);
    const b = abrir('s-b', 'outro');

    await tela.assistir(dono, ALVO);
    await tela.assistir(dono, 'outro');

    expect(emitido(a, 'tela_parar')).toHaveLength(1);
    expect(emitido(b, 'tela_comecar')).toHaveLength(1);
  });
});

describe('a tela só vai para o dono', () => {
  it('repassa o quadro só para a conexão do dono, sem o id da sessão', async () => {
    const { tela, auditLog, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    const curioso = abrir('s-c', 'curioso');
    await tela.assistir(dono, ALVO);

    tela.quadro(alvo, quadro(sessaoDe(alvo), { dados: '[{"type":4}]' }));

    expect(quadros(dono)).toEqual([{ aba: 'aba-1', lote: 0, parte: 0, total: 1, dados: '[{"type":4}]' }]);
    expect(curioso.emit).not.toHaveBeenCalled();
    // Nunca por socket.emit: esse caminho publica no Redis.
    expect(emitido(dono, 'tela_quadro')).toEqual([]);
    // Nada do conteúdo da tela vai para o registro.
    expect(JSON.stringify(auditLog.create.mock.calls)).not.toContain('type":4');
  });

  it('descarta quadro de quem não é a pessoa acompanhada', async () => {
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    const intruso = abrir('s-i', 'intruso');
    await tela.assistir(dono, ALVO);

    tela.quadro(intruso, quadro(sessaoDe(alvo)));

    expect(quadros(dono)).toEqual([]);
  });

  it('descarta quadro de sessão antiga', async () => {
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    await tela.assistir(dono, ALVO);

    tela.quadro(alvo, quadro('sessao-velha'));

    expect(quadros(dono)).toEqual([]);
  });

  it('só uma aba transmite: a nova assume no começo e a anterior para', async () => {
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const a1 = abrir('s-a1', ALVO);
    const a2 = abrir('s-a2', ALVO);
    await tela.assistir(dono, ALVO);
    const sessao = sessaoDe(a1);

    tela.quadro(a1, quadro(sessao));
    tela.quadro(a2, quadro(sessao, { aba: 'aba-2', lote: 3 })); // meio de transmissão: não assume
    expect(quadros(dono)).toHaveLength(1);

    tela.quadro(a2, quadro(sessao, { aba: 'aba-2' }));
    expect(emitido(a1, 'tela_pausar')).toHaveLength(1);
    expect(quadros(dono)).toHaveLength(2);

    tela.quadro(a1, quadro(sessao, { lote: 1 })); // aba antiga atrasada
    expect(quadros(dono)).toHaveLength(2);
  });

  it('avisa o dono quando a pessoa sai da aba, fecha a aba ou fica offline', async () => {
    const { tela, abrir, fechar } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    await tela.assistir(dono, ALVO);
    const sessao = sessaoDe(alvo);
    tela.quadro(alvo, quadro(sessao));

    tela.escondida(alvo, { sessao });
    expect(emitido(dono, 'tela_estado').at(-1).estado).toBe('aba_escondida');

    tela.quadro(alvo, quadro(sessao, { aba: 'aba-3' }));
    fechar(alvo);
    tela.aoDesconectar(alvo);
    expect(emitido(dono, 'tela_estado').at(-1).estado).toBe('offline');
  });

  it('larga a sessão quando a transmissão passa do limite ou o dono não dá conta', async () => {
    const excesso = montar();
    const dono = excesso.abrir('s-dono', DONO);
    const alvo = excesso.abrir('s-alvo', ALVO);
    await excesso.tela.assistir(dono, ALVO);
    const pedaco = 'x'.repeat(MAX_CARACTERES_POR_PEDACO);
    const vezes = Math.ceil(MAX_CARACTERES_POR_MINUTO / MAX_CARACTERES_POR_PEDACO) + 1;
    for (let i = 0; i < vezes; i += 1) {
      excesso.tela.quadro(alvo, quadro(sessaoDe(alvo), { dados: pedaco }));
    }
    expect(emitido(dono, 'tela_estado').at(-1)).toEqual(expect.objectContaining({ estado: 'encerrada', motivo: 'excesso' }));

    const lento = montar();
    const dono2 = lento.abrir('s-dono', DONO);
    const alvo2 = lento.abrir('s-alvo', ALVO);
    await lento.tela.assistir(dono2, ALVO);
    dono2.conn.writeBuffer = new Array(MAX_FILA_DO_OBSERVADOR + 1).fill(0);
    lento.tela.quadro(alvo2, quadro(sessaoDe(alvo2)));
    expect(emitido(dono2, 'tela_estado').at(-1)).toEqual(expect.objectContaining({ estado: 'encerrada', motivo: 'lento' }));
    expect(quadros(dono2)).toEqual([]);
  });
});

describe('lerQuadro', () => {
  const certo = { sessao: 's', aba: 'a', lote: 0, parte: 0, total: 1, dados: '[]' };

  it('aceita o que o navegador manda', () => {
    expect(lerQuadro(certo)).toEqual(certo);
    expect(lerQuadro({ ...certo, parte: MAX_PEDACOS_POR_LOTE - 1, total: MAX_PEDACOS_POR_LOTE })).not.toBeNull();
  });

  it('recusa o resto', () => {
    const errados: unknown[] = [
      undefined, null, 1, 'x', [],
      { ...certo, sessao: 1 }, { ...certo, sessao: '' }, { ...certo, sessao: 'x'.repeat(65) },
      { ...certo, aba: {} }, { ...certo, aba: '' },
      { ...certo, lote: -1 }, { ...certo, lote: 1.5 }, { ...certo, lote: '0' },
      { ...certo, total: 0 }, { ...certo, total: MAX_PEDACOS_POR_LOTE + 1 },
      { ...certo, parte: 1 }, { ...certo, parte: -1 },
      { ...certo, dados: 1 }, { ...certo, dados: '' }, { ...certo, dados: 'x'.repeat(MAX_CARACTERES_POR_PEDACO + 1) },
    ];
    for (const v of errados) expect(lerQuadro(v)).toBeNull();
  });
});

describe('eventos do socket', () => {
  const logger = () => ({ warn: jest.fn(), log: jest.fn(), error: jest.fn() }) as any;

  it('nenhum erro escapa, nem do banco', async () => {
    const { tela, prisma, abrir } = montar();
    prisma.user.findUnique.mockRejectedValue(new Error("Can't reach database server"));
    const dono = abrir('s-dono', DONO);
    const log = logger();
    const eventos = eventosDaTela(dono, tela, () => true, log);

    expect(() => eventos.assistir(ALVO)).not.toThrow();
    await new Promise((r) => setImmediate(r));

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('tela_assistir falhou'));
  });

  it('id que não é texto curto nem chega ao banco', () => {
    const { tela, prisma, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const eventos = eventosDaTela(dono, tela, () => true, logger());

    for (const v of [undefined, null, 1, {}, [], '', 'x'.repeat(101)]) eventos.assistir(v);

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('confirma cada pedaço, mesmo o descartado: o navegador da pessoa nunca fica esperando', async () => {
    const { tela, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const alvo = abrir('s-alvo', ALVO);
    await tela.assistir(dono, ALVO);
    const eventos = eventosDaTela(alvo, tela, () => true, logger());
    const confirmar = jest.fn();

    eventos.quadro(quadro(sessaoDe(alvo)), confirmar);
    eventos.quadro({ lixo: true }, confirmar);

    expect(confirmar).toHaveBeenCalledTimes(2);
    expect(quadros(dono)).toHaveLength(1);
  });

  it('confirmação que falha não derruba a API', () => {
    const { tela, abrir } = montar();
    const alvo = abrir('s-alvo', ALVO);
    const log = logger();
    const eventos = eventosDaTela(alvo, tela, () => true, log);

    expect(() => eventos.quadro({ lixo: true }, () => { throw new Error('caiu'); })).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('tela_quadro falhou'));
  });

  it('conexão só da tela ao vivo não conta como online nem recebe conversas pendentes', () => {
    const prisma: any = { user: { findUnique: jest.fn(async () => null) } };
    const gateway = new ChatGateway(prisma, {} as any, {} as any, {} as any, {} as any);
    const soTela: any = { id: 's1', data: { user: { sub: DONO, tenant_id: 't' }, soTela: true } };
    const normal: any = { id: 's2', data: { user: { sub: 'outra', tenant_id: 't' } } };

    gateway.handleConnection(soTela);
    gateway.handleConnection(normal);

    expect(gateway.isUserOnline(DONO)).toBe(false);
    expect(gateway.isUserOnline('outra')).toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);

    gateway.handleDisconnect(soTela);
    expect(gateway.isUserOnline('outra')).toBe(true);
  });

  it('respeita o limite de eventos por minuto', () => {
    const { tela, prisma, abrir } = montar();
    const dono = abrir('s-dono', DONO);
    const eventos = eventosDaTela(dono, tela, () => false, logger());

    eventos.assistir(ALVO);

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
