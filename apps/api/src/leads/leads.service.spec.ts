import { Test, TestingModule } from '@nestjs/testing';
import { LeadsService } from './leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { AutomationsService } from '../automations/automations.service';
import { GoogleDriveService } from '../google-drive/google-drive.service';


describe('LeadsService', () => {
  let service: LeadsService;
  let mockPrisma: any;
  let mockChatGateway: any;
  let mockAutomations: any;

  beforeEach(async () => {
    mockPrisma = {
      lead: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        // create() procura um gêmeo (mesmo assinante em outra variante 55/9) antes de criar
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn((input: any): any => {
        if (typeof input === 'function') return input(mockPrisma);
        return Promise.all(input);
      }),
    };

    mockChatGateway = {
      emitConversationsUpdate: jest.fn(),
      emitNewLeadNotification: jest.fn().mockResolvedValue(undefined),
    };

    mockAutomations = {
      onNewLead: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeadsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ChatGateway, useValue: mockChatGateway },
        { provide: AutomationsService, useValue: mockAutomations },
        { provide: GoogleDriveService, useValue: {} },
      ],
    }).compile();

    service = module.get<LeadsService>(LeadsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should normalize phone with 13 digits (remove 9th digit)', async () => {
      const mockLead = { id: '1', name: 'Test', phone: '558299130127', tenant_id: null };
      mockPrisma.lead.create.mockResolvedValue(mockLead);

      await service.create({ name: 'Test', phone: '5582999130127' });

      expect(mockPrisma.lead.create).toHaveBeenCalledWith({
        data: { name: 'Test', phone: '558299130127' },
      });
    });

    it('should keep phone with 12 digits unchanged', async () => {
      const mockLead = { id: '1', name: 'Test', phone: '558299130127', tenant_id: null };
      mockPrisma.lead.create.mockResolvedValue(mockLead);

      await service.create({ name: 'Test', phone: '558299130127' });

      expect(mockPrisma.lead.create).toHaveBeenCalledWith({
        data: { name: 'Test', phone: '558299130127' },
      });
    });

    it('should add the 55 country code to a local 11-digit phone', async () => {
      const mockLead = { id: '1', name: 'Test', phone: '558299130127', tenant_id: null };
      mockPrisma.lead.create.mockResolvedValue(mockLead);

      await service.create({ name: 'Test', phone: '82999130127' });

      expect(mockPrisma.lead.create).toHaveBeenCalledWith({
        data: { name: 'Test', phone: '558299130127' },
      });
    });

    it('should fire the new-lead automation and notification', async () => {
      const mockLead = { id: '1', name: 'Test', phone: '558299130127', tenant_id: 't1', cs_user_id: null, origin: null };
      mockPrisma.lead.create.mockResolvedValue(mockLead);

      await service.create({ name: 'Test', phone: '558299130127', tenant: { connect: { id: 't1' } } } as any, 'inbox-1');

      expect(mockAutomations.onNewLead).toHaveBeenCalledWith('1', 't1');
      expect(mockChatGateway.emitNewLeadNotification).toHaveBeenCalledWith(
        't1', null, 'inbox-1', expect.objectContaining({ leadId: '1' }),
      );
    });

    it('should adopt the existing lead when the phone is already saved in another format', async () => {
      const twin = { id: 'existing', name: 'Old', phone: '82999130127', tenant_id: 't1' };
      mockPrisma.lead.findFirst.mockResolvedValue(twin);

      const result = await service.create({ name: 'Test', phone: '5582999130127', tenant_id: 't1' } as any);

      expect(result).toBe(twin);
      expect(mockPrisma.lead.findFirst).toHaveBeenCalledWith({
        where: { tenant_id: 't1', phone: { in: expect.arrayContaining(['558299130127', '82999130127']) } },
      });
      expect(mockPrisma.lead.create).not.toHaveBeenCalled();
      expect(mockAutomations.onNewLead).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return lead when found', async () => {
      const mockLead = { id: '1', name: 'Test', phone: '558299130127' };
      mockPrisma.lead.findUnique.mockResolvedValue(mockLead);

      const result = await service.findOne('1');
      expect(result).toEqual(mockLead);
    });

    it('should return null when lead not found', async () => {
      mockPrisma.lead.findUnique.mockResolvedValue(null);

      const result = await service.findOne('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all leads without pagination', async () => {
      const mockLeads = [
        { id: '1', name: 'A', phone: '551', conversations: [], _count: { conversations: 0 } },
        { id: '2', name: 'B', phone: '552', conversations: [], _count: { conversations: 0 } },
      ];
      mockPrisma.lead.findMany.mockResolvedValue(mockLeads);

      const result = await service.findAll();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return paginated result when page and limit are provided', async () => {
      const mockLeads = [
        { id: '1', name: 'A', phone: '551', conversations: [], _count: { conversations: 0 } },
      ];
      mockPrisma.lead.findMany.mockResolvedValue(mockLeads);
      mockPrisma.lead.count.mockResolvedValue(10);

      const result = await service.findAll(undefined, undefined, 1, 5);
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
    });
  });

  describe('checkPhone', () => {
    it('should return exists=true when phone is found', async () => {
      const mockLead = { id: '1', name: 'Test', phone: '558299130127' };
      mockPrisma.lead.findFirst.mockResolvedValue(mockLead);

      const result = await service.checkPhone('5582999130127');
      expect(result.exists).toBe(true);
      expect(result.lead).toEqual(mockLead);
    });

    it('should return exists=false when phone not found', async () => {
      mockPrisma.lead.findFirst.mockResolvedValue(null);

      const result = await service.checkPhone('5582999999999');
      expect(result.exists).toBe(false);
    });
  });
});
