/**
 * Socket: os eventos do cliente (join_conversation, leave_conversation,
 * join_user, typing) só aceitam o que as telas mandam — id de conversa em texto,
 * nunca sala de sistema — e qualquer erro deles (do banco, inclusive) vira só um
 * aviso no log. O typing só vale na conversa em que a pessoa entrou e manda
 * isTyping como true/false.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
// socket.io-client vem da raiz do monorepo (dependência do web).
import { io as conectar, type Socket as Cliente } from 'socket.io-client';
import { ChatGateway } from './chat.gateway';
import { eventosDoSocket, idDeConversa } from './socket-eventos';

const CONVS: Record<string, any> = {
  'conv-a': { inbox_id: 'in-a', assigned_user_id: null, assigned_dentist_id: null, tenant_id: 'a' },
  'conv-b': { inbox_id: 'in-b', assigned_user_id: null, assigned_dentist_id: null, tenant_id: 'b' },
};

/** Banco de mentira: id que não é texto dá erro (como o Prisma) e um id simula o banco fora. */
function gatewayDeTeste() {
  const prisma: any = {
    conversation: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (typeof where.id !== 'string') throw new Error('Argument id: Invalid value provided');
        if (where.id === 'conv-banco-fora') throw new Error("Can't reach database server");
        return CONVS[where.id] ?? null;
      }),
    },
    user: { findUnique: jest.fn(async () => ({ inboxes: [] })) },
  };
  const gw = new ChatGateway(prisma, {} as any, {} as any, {} as any, {} as any);
  (gw as any).assignPendingConversations = jest.fn(async () => undefined);
  return { gw, prisma };
}

const logger = () => ({ warn: jest.fn(), log: jest.fn(), error: jest.fn() }) as any;

describe('idDeConversa', () => {
  it('aceita id de conversa (texto curto, sem ":")', () => {
    expect(idDeConversa('0b6f8f2e-3c1a-4b8e-9a51-2f0d7c4e9a10')).toBe('0b6f8f2e-3c1a-4b8e-9a51-2f0d7c4e9a10');
    expect(idDeConversa('conv-a')).toBe('conv-a');
  });
  it('recusa o que não é id de conversa', () => {
    for (const v of [undefined, null, 0, 123, true, {}, { id: 'conv-a' }, { toString: 1 }, [], ['conv-a'], '', 'tenant:a', 'inbox:in-a', 'operators:a', 'user:u1', 'x'.repeat(101)]) {
      expect({ v, r: idDeConversa(v) }).toEqual({ v, r: null });
    }
  });
});

describe('ChatGateway.handleJoinConversation — id inválido nunca chega ao banco', () => {
  it.each([['ADMIN'], ['SUPER_ADMIN']])('%s — objeto, lista, número e sala de sistema: volta sem consultar, sem entrar e sem erro', async (papel) => {
    const { gw, prisma } = gatewayDeTeste();
    const rooms = new Set<string>();
    const s: any = { id: 's1', data: { user: { sub: 'u-a', tenant_id: 'a', roles: [papel] } }, join: (r: string) => rooms.add(r) };
    for (const v of [{}, ['conv-a'], 42, null, undefined, { toString: 1 }, 'tenant:b', 'user:u-b']) {
      await expect(gw.handleJoinConversation(v as any, s)).resolves.toBeUndefined();
    }
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    expect([...rooms]).toEqual([]);
  });
});

describe('socket de verdade: entrada fora do esperado e erro do banco só viram aviso no log', () => {
  let http: HttpServer;
  let servidor: Server;
  let cliente: Cliente;
  let gw: ChatGateway;
  let prisma: any;
  let log: any;
  // Promise rejeitada sem tratamento ou erro lançado fora de try: nenhum dos dois pode aparecer.
  const soltas: unknown[] = [];
  const naRejeicao = (motivo: unknown) => soltas.push(motivo);

  beforeAll(async () => {
    process.on('unhandledRejection', naRejeicao);
    process.on('uncaughtException', naRejeicao);
    ({ gw, prisma } = gatewayDeTeste());
    log = logger();
    http = createServer();
    servidor = new Server(http);
    gw.server = servidor;
    servidor.use((socket, next) => {
      socket.data.user = { sub: 'adm-a', tenant_id: 'a', roles: ['ADMIN'], name: 'Ana' };
      next();
    });
    // Igual ao main.ts.
    servidor.on('connection', (socket) => {
      socket.join('tenant:a');
      const eventos = eventosDoSocket(socket, gw, () => true, log);
      socket.on('join_conversation', eventos.joinConversation);
      socket.on('leave_conversation', eventos.leaveConversation);
      socket.on('join_user', eventos.joinUser);
      socket.on('typing', eventos.typing);
    });
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', () => ok()));
    const { port } = http.address() as AddressInfo;
    cliente = conectar(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((ok, falha) => {
      cliente.on('connect', () => ok());
      cliente.on('connect_error', falha);
    });
  });

  afterAll(async () => {
    process.off('unhandledRejection', naRejeicao);
    process.off('uncaughtException', naRejeicao);
    cliente?.close();
    await new Promise<void>((ok) => servidor.close(() => ok()));
  });

  const entrou = (sala: string) =>
    new Promise<void>((ok, falha) => {
      const t = setTimeout(() => falha(new Error(`não entrou em ${sala}`)), 3000);
      cliente.once('joined_room', (d: any) => {
        clearTimeout(t);
        expect(d).toEqual({ room: sala });
        ok();
      });
    });
  const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

  it('valores que não são texto, sala de sistema e banco fora: nada escapa, e o servidor segue atendendo', async () => {
    const sair = jest.spyOn(gw, 'handleLeaveConversation');
    const usuario = jest.spyOn(gw, 'handleJoinUser');
    const venenos: unknown[] = [{}, { id: 'conv-a' }, ['conv-a'], 123, null, true, { toString: 1 }, [{ toString: 1 }], 'tenant:b', 'x'.repeat(500)];
    for (const v of [...venenos, 'conv-banco-fora']) cliente.emit('join_conversation', v);
    cliente.emit('join_conversation'); // sem argumento nenhum
    for (const v of [...venenos, 'tenant:a']) cliente.emit('leave_conversation', v);
    for (const v of [...venenos, 'y'.repeat(500)]) cliente.emit('join_user', v);
    cliente.emit('typing', 'nao-e-objeto');
    cliente.emit('typing', null);
    cliente.emit('typing', { toString: 1 });
    cliente.emit('typing', { conversationId: { x: 1 }, isTyping: true });
    cliente.emit('typing', { conversationId: { toString: 1 }, isTyping: true });
    await esperar(200);
    expect(soltas).toEqual([]);
    // Só o id de texto chegou ao banco (o que simula o banco fora).
    expect(prisma.conversation.findUnique.mock.calls.map((c: any[]) => c[0].where.id)).toEqual(['conv-banco-fora']);
    const avisos = log.warn.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(avisos).toMatch(/join_conversation falhou .*Can't reach database server/);
    // Os 11 inválidos do join param na porta, antes do gateway, cada um com um aviso.
    expect(log.warn.mock.calls.filter((c: any[]) => /BLOQUEADO: join_conversation com id invalido/.test(c[0]))).toHaveLength(11);
    // Sair e join_user: nada estranho chega ao gateway (nem ao log dele), e nada falha.
    // ('tenant:b' é texto curto: o join_user repassa e o gateway recusa — não é o id da pessoa.)
    const saidas = sair.mock.calls.map((c) => c[0]);
    const usuarios = usuario.mock.calls.map((c) => c[0]);
    sair.mockRestore();
    usuario.mockRestore();
    expect(saidas).toEqual([]);
    expect(usuarios).toEqual(['tenant:b']);
    expect(avisos).not.toMatch(/leave_conversation falhou|join_user falhou|typing falhou/);
    // O leave_conversation não tira ninguém de sala de sistema.
    const [noServidor] = await servidor.fetchSockets();
    expect([...noServidor.rooms]).toContain('tenant:a');

    // Depois de tudo isso, o mesmo socket ainda entra numa conversa da clínica.
    const ok = entrou('conv-a');
    cliente.emit('join_conversation', 'conv-a');
    await ok;
    expect(soltas).toEqual([]);
  });

  it('typing: só na conversa em que entrou, nunca na sala da clínica; isTyping vira true/false', async () => {
    const recebidos: Array<{ sala: string; dados: unknown }> = [];
    const emitir = jest.spyOn(gw, 'emitTypingIndicator').mockImplementation((sala, dados) => {
      recebidos.push({ sala, dados });
    });
    try {
      cliente.emit('typing', { conversationId: 'tenant:a', isTyping: true });
      cliente.emit('typing', { conversationId: 'conv-b', isTyping: true }); // não entrou
      cliente.emit('typing', { conversationId: 'conv-a', isTyping: true });
      cliente.emit('typing', { conversationId: 'conv-a', isTyping: { muito: 'x'.repeat(1000) } });
      cliente.emit('typing', { conversationId: 'conv-a', isTyping: false });
      await esperar(150);
      expect(recebidos).toEqual([
        { sala: 'conv-a', dados: { userId: 'adm-a', userName: 'Ana', isTyping: true } },
        { sala: 'conv-a', dados: { userId: 'adm-a', userName: 'Ana', isTyping: false } },
        { sala: 'conv-a', dados: { userId: 'adm-a', userName: 'Ana', isTyping: false } },
      ]);
    } finally {
      emitir.mockRestore();
    }
    expect(soltas).toEqual([]);
  });

  it('erro síncrono dentro de um evento também não escapa', async () => {
    const quebrar = jest.spyOn(gw, 'handleLeaveConversation').mockImplementation(() => {
      throw new Error('quebrou');
    });
    try {
      cliente.emit('leave_conversation', 'conv-a');
      await esperar(100);
      expect(log.warn.mock.calls.map((c: any[]) => c[0]).join('\n')).toMatch(/leave_conversation falhou .*quebrou/);
    } finally {
      quebrar.mockRestore();
    }
    // E o servidor continua respondendo.
    const ok = entrou('conv-a');
    cliente.emit('join_conversation', 'conv-a');
    await ok;
    expect(soltas).toEqual([]);
  });
});

describe('trava: todo evento do cliente no main.ts passa pelo eventosDoSocket', () => {
  /** Os socket.on/once dentro do io.on('connection') do main.ts: [evento, texto do handler]. */
  function eventosDoMain(codigo: string): Array<[string, string]> {
    const fonte = ts.createSourceFile('main.ts', codigo, ts.ScriptTarget.Latest, true);
    const achados: Array<[string, string]> = [];
    const visitar = (no: ts.Node) => {
      if (
        ts.isCallExpression(no) &&
        ts.isPropertyAccessExpression(no.expression) &&
        no.expression.name.text === 'on' &&
        ts.isStringLiteral(no.arguments[0]) &&
        ['connection', 'connect'].includes(no.arguments[0].text)
      ) {
        const fn = no.arguments[1];
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name)) {
          const param = fn.parameters[0].name.text;
          const dentro = (n: ts.Node) => {
            if (
              ts.isCallExpression(n) &&
              ts.isPropertyAccessExpression(n.expression) &&
              ts.isIdentifier(n.expression.expression) &&
              n.expression.expression.text === param &&
              ['on', 'once', 'onAny', 'prependAny', 'prependListener', 'addListener'].includes(n.expression.name.text)
            ) {
              const ev = n.arguments[0];
              const evento = ev && ts.isStringLiteral(ev) ? ev.text : `(${n.expression.name.text})`;
              achados.push([evento, (n.arguments[1] ?? n.arguments[0])?.getText() ?? '']);
            }
            ts.forEachChild(n, dentro);
          };
          dentro(fn.body);
        }
      }
      ts.forEachChild(no, visitar);
    };
    visitar(fonte);
    return achados;
  }
  /** 'disconnect' é do próprio socket.io (sem dado do cliente) e só mexe em memória. */
  const acusar = (codigo: string) =>
    eventosDoMain(codigo)
      .filter(([evento, handler]) => evento !== 'disconnect' && !/^eventos\.\w+$/.test(handler))
      .map(([evento, handler]) => `${evento}: ${handler.slice(0, 60)}`);

  it('a própria trava acusa handler direto e deixa passar o eventosDoSocket', () => {
    const ruim = `io.on('connection', (socket) => {
      const eventos = eventosDoSocket(socket, gw, lim, logger);
      socket.on('join_conversation', eventos.joinConversation);
      socket.on('novo', async (x) => { await gw.algo(x); });
      socket.onAny((ev) => gw.outro(ev));
    });`;
    expect(acusar(ruim)).toEqual(['novo: async (x) => { await gw.algo(x); }', '(onAny): (ev) => gw.outro(ev)']);
  });

  it('no main.ts de verdade: os quatro eventos do cliente passam pelo eventosDoSocket', () => {
    const codigo = fs.readFileSync(path.resolve(__dirname, '..', 'main.ts'), 'utf8');
    const eventos = eventosDoMain(codigo).map(([e]) => e).sort();
    expect(eventos).toEqual(['disconnect', 'join_conversation', 'join_user', 'leave_conversation', 'typing']);
    expect(acusar(codigo)).toEqual([]);
  });
});
