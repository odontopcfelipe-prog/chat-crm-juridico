import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import * as argon2 from 'argon2';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: Partial<UsersService>;
  let jwtService: Partial<JwtService>;

  const mockUser = {
    id: 'user-1',
    email: 'admin@test.com',
    name: 'Admin',
    role: 'ADMIN',
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
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
  });

  describe('login', () => {
    it('deve retornar access_token e payload do usuario', async () => {
      const user = { id: 'user-1', email: 'admin@test.com', role: 'ADMIN', tenant_id: 'tenant-1' };

      const result = await service.login(user);

      expect(result.access_token).toBe('mock-jwt-token');
      expect(result.user.email).toBe('admin@test.com');
      expect(result.user.sub).toBe('user-1');
      expect(jwtService.sign).toHaveBeenCalledWith({
        email: 'admin@test.com',
        sub: 'user-1',
        role: 'ADMIN',
        tenant_id: 'tenant-1',
      });
    });
  });
});
