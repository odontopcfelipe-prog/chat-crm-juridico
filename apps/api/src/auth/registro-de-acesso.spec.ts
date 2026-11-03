/**
 * Registro de acesso (Marco Civil, art. 15): cada entrada pela tela de login grava
 * data/hora, quem entrou e o IP; senha errada não grava; falha na gravação nunca
 * impede o login; a resposta do login não muda. A limpeza diária apaga só o que
 * passou de 6 meses.
 *
 * Classes reais (AuthController, AuthService, UsersService) com o Prisma mockado.
 */
import { Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DIAS_DE_GUARDA_DO_ACESSO, LimpezaDoRegistroDeAcesso, limiteDaGuarda } from './registro-de-acesso';
import { UsersService } from '../users/users.service';
import { origemDaRequisicao } from '../common/utils/origem-da-requisicao';

const SENHA_TESTE = 'senha-de-teste-123';
const CONTA = 'tenant-clinica-exemplo';
const DIA = 24 * 60 * 60 * 1000;

let hash: string;
beforeAll(async () => {
  hash = await argon2.hash(SENHA_TESTE);
});
beforeEach(() => {
  for (const nivel of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const usuario = {
  id: 'u-recepcao-1',
  email: 'recepcao@clinica.teste',
  name: 'Recepção Teste',
  roles: ['OPERADOR'],
  tenant_id: CONTA,
};

function montar(create: jest.Mock = jest.fn().mockResolvedValue({})) {
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ password_hash: hash, ...usuario }) },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', suspended_reason: null, trial_ends_at: null, name: 'Clínica Teste' }),
    },
    accessLog: { create },
  };
  const users = new UsersService(prisma, {} as any, {} as any);
  const mail: any = { send: jest.fn(), renderTemplate: jest.fn() };
  const auth = new AuthService(users, new JwtService({ secret: 'segredo-so-de-teste' }), prisma, mail);
  return { controller: new AuthController(auth), prisma };
}

const pedido = {
  headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9', 'user-agent': 'Navegador de teste' },
  ip: '10.0.0.2',
};

describe('registro de acesso no POST /auth/login', () => {
  it('login certo: 1 registro com quem entrou, a conta, o IP do Cloudflare e o navegador', async () => {
    const { controller, prisma } = montar();
    const r: any = await controller.login({ email: usuario.email, password: SENHA_TESTE } as any, pedido);

    expect(Object.keys(r)).toEqual(['access_token', 'user']);
    expect(prisma.accessLog.create.mock.calls).toEqual([
      [{ data: { user_id: 'u-recepcao-1', tenant_id: CONTA, ip: '203.0.113.7', user_agent: 'Navegador de teste' } }],
    ]);
  });

  it('senha errada: 401 e nenhum registro', async () => {
    const { controller, prisma } = montar();
    await expect(controller.login({ email: usuario.email, password: 'outra-senha' } as any, pedido)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.accessLog.create).not.toHaveBeenCalled();
  });

  it('gravação falhou: o login segue com a mesma resposta', async () => {
    const ok = montar();
    const falhou = montar(jest.fn().mockRejectedValue(new Error('banco fora')));
    const a: any = await ok.controller.login({ email: usuario.email, password: SENHA_TESTE } as any, pedido);
    const b: any = await falhou.controller.login({ email: usuario.email, password: SENHA_TESTE } as any, pedido);
    expect(b.user).toEqual(a.user);
    expect(typeof b.access_token).toBe('string');
    expect(falhou.prisma.accessLog.create).toHaveBeenCalledTimes(1);
  });
});

describe('origem do pedido', () => {
  it('sem Cloudflare: 1º item do X-Forwarded-For; sem cabeçalho: o IP da conexão sem o prefixo IPv6', () => {
    expect(origemDaRequisicao({ headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } })).toEqual({
      ip: '198.51.100.9',
      user_agent: null,
    });
    expect(origemDaRequisicao({ headers: {}, ip: '::ffff:10.0.0.2' })).toEqual({ ip: '10.0.0.2', user_agent: null });
    expect(origemDaRequisicao(undefined)).toEqual({ ip: null, user_agent: null });
  });

  it('navegador cortado em 300 caracteres e IP em 64', () => {
    const o = origemDaRequisicao({ headers: { 'cf-connecting-ip': '1'.repeat(80), 'user-agent': 'x'.repeat(400) } });
    expect(o.ip).toHaveLength(64);
    expect(o.user_agent).toHaveLength(300);
  });
});

describe('limpeza diária', () => {
  it('guarda 186 dias (mais que qualquer período de 6 meses) e apaga só o que é mais velho', async () => {
    expect(DIAS_DE_GUARDA_DO_ACESSO).toBeGreaterThanOrEqual(184);
    const agora = new Date('2026-11-03T07:20:00.000Z');
    expect(limiteDaGuarda(agora).getTime()).toBe(agora.getTime() - 186 * DIA);

    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const limpeza = new LimpezaDoRegistroDeAcesso({ accessLog: { deleteMany } } as any);
    await expect(limpeza.limpar(agora)).resolves.toBe(3);
    expect(deleteMany.mock.calls).toEqual([[{ where: { created_at: { lt: limiteDaGuarda(agora) } } }]]);
  });

  it('falha na limpeza não derruba nada', async () => {
    const limpeza = new LimpezaDoRegistroDeAcesso({ accessLog: { deleteMany: jest.fn().mockRejectedValue(new Error('x')) } } as any);
    await expect(limpeza.limpar()).resolves.toBe(0);
  });
});
