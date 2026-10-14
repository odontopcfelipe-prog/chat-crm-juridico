jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
import axios from 'axios';
import { PortalAuthService } from './portal-auth.service';

/**
 * BLINDAGEM — link do portal/anamnese sai pelo chip CLINICA da clínica (out/2026).
 * Antes: 1ª Instance por NOME → 'Comercial' (órfã, purpose NULL) vinha antes de
 * 't00000000-*' e o envio ia pra ela. Também mandava o telefone CRU (sem o 55).
 */
const TENANT = '00000000-0000-0000-0000-000000000000';
const CHIPS_POR_NOME = [
  { name: 'Comercial', purpose: null },
  { name: 't00000000-1', purpose: 'COMERCIAL' },
  { name: 't00000000-2', purpose: 'CLINICA' },
  { name: 't00000000-3', purpose: 'FINANCEIRO' },
  { name: 'whatsapp', purpose: null },
];

describe('PortalAuthService.dispatchWhatsApp — chip (blindagem)', () => {
  const post = (axios as any).post as jest.Mock;

  function build(chips: any[]) {
    const prisma: any = { instance: { findMany: jest.fn().mockResolvedValue(chips) } };
    const settings: any = { getWhatsAppConfig: jest.fn().mockResolvedValue({ apiUrl: 'https://evo', apiKey: 'k' }) };
    const svc = new PortalAuthService(prisma, {} as any, settings);
    return { svc, prisma };
  }

  beforeEach(() => post.mockReset());

  it('sai pelo CLINICA (t00000000-2), escopado pela clínica, com o número normalizado', async () => {
    post.mockResolvedValue({ data: { key: { id: 'wamid' } } });
    const { svc, prisma } = build(CHIPS_POR_NOME);
    const r = await (svc as any).dispatchWhatsApp(TENANT, '82988887777', 'Maria Silva', 'https://x/l', 'GENERIC');
    expect(r).toEqual({ status: 'SENT' });
    expect(prisma.instance.findMany.mock.calls[0][0].where).toEqual({ tenant_id: TENANT, type: 'whatsapp' });
    expect(post.mock.calls[0][0]).toBe('https://evo/message/sendText/t00000000-2');
    expect(post.mock.calls[0][1].number).toBe('5582988887777');
  });

  it('só FINANCEIRO → FAILED sem chamar a Evolution', async () => {
    const { svc } = build([{ name: 't00000000-3', purpose: 'FINANCEIRO' }]);
    const r = await (svc as any).dispatchWhatsApp(TENANT, '82988887777', 'Maria', 'https://x/l');
    expect(r.status).toBe('FAILED');
    expect(r.reason).toMatch(/Financeiro/);
    expect(post).not.toHaveBeenCalled();
  });

  it('2xx com exists:false → FAILED (não "enviado")', async () => {
    post.mockResolvedValue({ data: { response: { message: [{ exists: false, number: '5582988887777' }] } } });
    const { svc } = build(CHIPS_POR_NOME);
    const r = await (svc as any).dispatchWhatsApp(TENANT, '82988887777', 'Maria', 'https://x/l');
    expect(r.status).toBe('FAILED');
  });
});
