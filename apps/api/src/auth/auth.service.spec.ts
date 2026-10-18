import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail/mail.service';
import * as argon2 from 'argon2';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: Partial<UsersService>;
  let jwtService: Partial<JwtService>;
  let prisma: any;

  const mockUser = {
    id: 'user-1',
    email: 'admin@test.com',
    name: 'Admin',
    roles: ['ADMIN'],
    tenant_id: 'tenant-1',
    password_hash: '', // will be set in beforeAll
  };

  beforeAll(async () => {
    mockUser.password_hash = await argon2.hash('senha123');
  });

  beforeEach(async () => {
    usersService = {
      findOne: jest.fn(),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
    };

    // Gate SaaS do login consulta o status do tenant
    prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: { send: jest.fn(), renderTemplate: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('validateUser', () => {
    it('deve retornar usuario sem password_hash quando credenciais sao validas', async () => {
      (usersService.findOne as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.validateUser('admin@test.com', 'senha123');

      expect(result).toBeDefined();
      expect(result.id).toBe('user-1');
      expect(result.email).toBe('admin@test.com');
      expect(result).not.toHaveProperty('password_hash');
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tenant-1' } }),
      );
    });

    it('deve retornar null quando senha e invalida', async () => {
      (usersService.findOne as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.validateUser('admin@test.com', 'senhaerrada');

      expect(result).toBeNull();
    });

    it('deve retornar null quando usuario nao existe', async () => {
      (usersService.findOne as jest.Mock).mockResolvedValue(null);

      const result = await service.validateUser('naoexiste@test.com', 'qualquer');

      expect(result).toBeNull();
    });

    it('deve bloquear login quando o tenant esta suspenso', async () => {
      (usersService.findOne as jest.Mock).mockResolvedValue(mockUser);
      prisma.tenant.findUnique.mockResolvedValue({ status: 'SUSPENDED', suspended_reason: 'inadimplencia' });

      await expect(service.validateUser('admin@test.com', 'senha123')).rejects.toThrow(ForbiddenException);
    });

    it('deve bloquear login quando o trial expirou', async () => {
      (usersService.findOne as jest.Mock).mockResolvedValue(mockUser);
      prisma.tenant.findUnique.mockResolvedValue({ status: 'TRIAL', trial_ends_at: new Date(Date.now() - 1000) });

      await expect(service.validateUser('admin@test.com', 'senha123')).rejects.toThrow(ForbiddenException);
    });

    it('SUPER_ADMIN entra mesmo com tenant suspenso (sem consultar o tenant)', async () => {
      (usersService.findOne as jest.Mock).mockResolvedValue({ ...mockUser, roles: ['SUPER_ADMIN'] });
      prisma.tenant.findUnique.mockResolvedValue({ status: 'SUSPENDED' });

      const result = await service.validateUser('admin@test.com', 'senha123');

      expect(result.id).toBe('user-1');
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('deve retornar access_token e payload do usuario', async () => {
      const user = { id: 'user-1', email: 'admin@test.com', roles: ['ADMIN', 'DENTIST'], tenant_id: 'tenant-1' };

      const result = await service.login(user);

      expect(result.access_token).toBe('mock-jwt-token');
      expect(result.user.email).toBe('admin@test.com');
      expect(result.user.sub).toBe('user-1');
      expect(jwtService.sign).toHaveBeenCalledWith({
        email: 'admin@test.com',
        sub: 'user-1',
        roles: ['ADMIN', 'DENTIST'],
        tenant_id: 'tenant-1',
      });
    });

    it('deve converter o role legado (string) em roles[]', async () => {
      const user = { id: 'user-1', email: 'admin@test.com', role: 'ADMIN', tenant_id: 'tenant-1' };

      const result = await service.login(user);

      expect(result.user.roles).toEqual(['ADMIN']);
    });

    it('deve cair em OPERADOR quando o usuario nao tem role', async () => {
      const user = { id: 'user-1', email: 'op@test.com', tenant_id: 'tenant-1' };

      const result = await service.login(user);

      expect(result.user.roles).toEqual(['OPERADOR']);
    });
  });
});
