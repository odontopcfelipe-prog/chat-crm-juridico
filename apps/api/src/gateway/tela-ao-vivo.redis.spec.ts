/**
 * Tela ao vivo com as bibliotecas de verdade (socket.io + adapter do Redis): o
 * conteúdo da tela chega ao dono e não é publicado no Redis. O Redis aqui é de
 * mentira, só para ver o que seria publicado.
 */
import { EventEmitter } from 'events';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, type Socket } from 'socket.io';
// socket.io-client vem da raiz do monorepo (dependência do web).
import { io as conectar, type Socket as Cliente } from 'socket.io-client';
import { TelaAoVivoService } from './tela-ao-vivo.service';

class RedisDeMentira extends EventEmitter {
  status = 'ready';
  constructor(readonly publicados: Buffer[]) {
    super();
  }
  publish(_canal: string, msg: Buffer | string) {
    this.publicados.push(Buffer.from(msg));
    return Promise.resolve(0);
  }
  psubscribe() { return Promise.resolve(); }
  subscribe() { return Promise.resolve(); }
  punsubscribe() { return Promise.resolve(); }
  unsubscribe() { return Promise.resolve(); }
  duplicate() { return new RedisDeMentira(this.publicados); }
  pubsub() { return Promise.resolve(0); }
}

describe('tela ao vivo com socket.io e adapter do Redis', () => {
  const publicados: Buffer[] = [];
  const noServidor = new Map<string, Socket>();
  const online = new Map<string, string[]>();
  let http: HttpServer;
  let io: Server;
  let clientes: Cliente[] = [];

  const entrar = async (sub: string): Promise<Cliente> => {
    const { port } = http.address() as AddressInfo;
    const cliente = conectar(`http://127.0.0.1:${port}`, { transports: ['websocket'], auth: { sub } });
    clientes.push(cliente);
    await new Promise<void>((pronto) => cliente.once('connect', () => pronto()));
    return cliente;
  };
  const foiPublicado = (texto: string) => publicados.some((p) => p.toString('latin1').includes(texto));

  beforeAll(async () => {
    http = createServer();
    io = new Server(http, {
      transports: ['websocket'],
      connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: true },
    });
    const pub = new RedisDeMentira(publicados);
    io.adapter(createAdapter(pub as any, pub.duplicate() as any));
    io.use((s, n) => {
      s.data.user = { sub: s.handshake.auth.sub };
      n();
    });
    io.on('connection', (s) => {
      noServidor.set(s.data.user.sub, s);
      online.set(s.data.user.sub, [s.id]);
    });
    await new Promise<void>((pronto) => http.listen(0, '127.0.0.1', () => pronto()));
  });

  afterAll(async () => {
    clientes.forEach((c) => c.close());
    await io.close();
  });

  it('o quadro chega só ao dono e não vai para o Redis', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'dono' ? { id: 'dono', roles: ['SUPER_ADMIN'] } : { id: where.id, tenant_id: 'conta' },
        ),
      },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    const gateway: any = {
      server: io,
      socketsDoUsuario: (u: string) => online.get(u) ?? [],
      isUserOnline: (u: string) => (online.get(u)?.length ?? 0) > 0,
    };
    const tela = new TelaAoVivoService(prisma, gateway);

    const dono = await entrar('dono');
    const alvo = await entrar('alvo');
    const curioso = await entrar('curioso');
    const nadaParaOCurioso = jest.fn();
    curioso.on('tela_quadro', nadaParaOCurioso);

    const comecou = new Promise<{ sessao: string }>((r) => alvo.once('tela_comecar', r));
    await tela.assistir(noServidor.get('dono')!, 'alvo');
    const { sessao } = await comecou;

    const recebido = new Promise<any>((r) => dono.once('tela_quadro', r));
    tela.quadro(noServidor.get('alvo')!, { sessao, aba: 'a', lote: 0, parte: 0, total: 1, dados: 'CONTEUDO-DA-TELA' });

    expect((await recebido).dados).toBe('CONTEUDO-DA-TELA');
    expect(foiPublicado('CONTEUDO-DA-TELA')).toBe(false);
    expect(nadaParaOCurioso).not.toHaveBeenCalled();

    // Controle: o Redis de mentira pega o que `socket.emit` publica, então a trava funciona.
    const controle = new Promise((r) => dono.once('controle', r));
    noServidor.get('dono')!.emit('controle', { dados: 'CONTROLE-PUBLICADO' });
    await controle;
    expect(foiPublicado('CONTROLE-PUBLICADO')).toBe(true);
  });
});
