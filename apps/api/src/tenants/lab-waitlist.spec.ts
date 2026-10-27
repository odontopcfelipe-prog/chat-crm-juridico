import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { IS_SUPER_ADMIN_KEY } from '../auth/decorators/super-admin.decorator';
import { InscricaoLaboratorioDto, LabWaitlistController } from './lab-waitlist.controller';
import { LabWaitlistService } from './lab-waitlist.service';

function montar(opts: { repetida?: boolean; donos?: string[]; mailFalha?: boolean } = {}) {
  const prisma: any = {
    labWaitlistEntry: {
      findFirst: jest.fn(async () => (opts.repetida ? { id: 'ja' } : null)),
      create: jest.fn(async ({ data }: any) => ({ id: 'novo', ...data })),
      findMany: jest.fn(async () => []),
    },
    user: { findMany: jest.fn(async () => (opts.donos ?? ['dono@exemplo.com']).map((email) => ({ email }))) },
  };
  const mail: any = {
    renderTemplate: jest.fn((o: any) => `<h1>${o.title}</h1>${o.bodyHtml}`),
    send: jest.fn(async () => {
      if (opts.mailFalha) throw new Error('smtp fora');
      return true;
    }),
  };
  return { prisma, mail, service: new LabWaitlistService(prisma, mail) };
}

const valida = { lab_name: '  Lab   Sorriso ', contact_name: 'Ana Souza', phone: '(82) 99999-8888', email: 'Ana@Exemplo.com', city: 'Maceió' };

describe('lista de espera do laboratório (/cadastrar)', () => {
  it('guarda o contato com o WhatsApp no formato de envio e avisa os donos por e-mail', async () => {
    const { prisma, mail, service } = montar({ donos: ['a@x.com', 'b@x.com', 'a@x.com'] });
    await expect(service.inscrever(valida)).resolves.toEqual({ ok: true });
    expect(prisma.labWaitlistEntry.create).toHaveBeenCalledWith({
      data: { lab_name: 'Lab Sorriso', contact_name: 'Ana Souza', phone: '5582999998888', email: 'ana@exemplo.com', city: 'Maceió' },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { roles: { has: 'SUPER_ADMIN' }, email: { not: '' } } }));
    expect(mail.send.mock.calls.map((c: any[]) => c[0].to)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('o mesmo WhatsApp (com ou sem 55/9) em 30 dias não vira linha nova nem e-mail, e a resposta é a mesma', async () => {
    const { prisma, mail, service } = montar({ repetida: true });
    await expect(service.inscrever(valida)).resolves.toEqual({ ok: true });
    const where = prisma.labWaitlistEntry.findFirst.mock.calls[0][0].where;
    expect(where.phone.in).toEqual(expect.arrayContaining(['5582999998888', '558299998888', '82999998888']));
    expect(where.created_at.gte.getTime()).toBeGreaterThan(Date.now() - 31 * 24 * 3600_000);
    expect(prisma.labWaitlistEntry.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('campo escondido preenchido (robô): responde ok e não grava nada', async () => {
    const { prisma, mail, service } = montar();
    await expect(service.inscrever({ ...valida, website: 'http://spam' })).resolves.toEqual({ ok: true });
    expect(prisma.labWaitlistEntry.findFirst).not.toHaveBeenCalled();
    expect(prisma.labWaitlistEntry.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...valida, phone: '9999-8888' }, 'WhatsApp'],
    [{ ...valida, phone: '' }, 'WhatsApp'],
    [{ ...valida, lab_name: ' ' }, 'laboratório'],
    [{ ...valida, contact_name: 'A' }, 'nome'],
  ])('dado faltando ou errado → 400 e nada gravado (%#)', async (dados, trecho) => {
    const { prisma, service } = montar();
    const erro = await service.inscrever(dados as any).catch((e) => e);
    expect(erro).toBeInstanceOf(BadRequestException);
    expect(erro.message).toContain(trecho);
    expect(prisma.labWaitlistEntry.create).not.toHaveBeenCalled();
  });

  it('o e-mail falhar não derruba a inscrição', async () => {
    const { prisma, service } = montar({ mailFalha: true });
    await expect(service.inscrever(valida)).resolves.toEqual({ ok: true });
    expect(prisma.labWaitlistEntry.create).toHaveBeenCalled();
  });

  it('o que a pessoa digitou vai escapado no e-mail', async () => {
    const { mail, service } = montar();
    await service.inscrever({ ...valida, lab_name: '<img src=x onerror=alert(1)>', contact_name: 'Ana "A" & Cia' });
    const corpo = mail.renderTemplate.mock.calls[0][0].bodyHtml as string;
    expect(corpo).not.toContain('<img');
    expect(corpo).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(corpo).toContain('Ana &quot;A&quot; &amp; Cia');
  });

  it('a lista é só para o SUPER_ADMIN; a inscrição é pública e com limite por minuto', () => {
    const proto = LabWaitlistController.prototype;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.inscrever)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.listar)).toBeUndefined();
    expect(Reflect.getMetadata(IS_SUPER_ADMIN_KEY, proto.listar)).toBe(true);
    const limites = Reflect.getMetadataKeys(proto.inscrever).filter((k: unknown) => String(k).startsWith('THROTTLER:LIMIT'));
    expect(limites.map((k: unknown) => Reflect.getMetadata(k, proto.inscrever))).toEqual([5]);
  });

  it('campo a mais no corpo é recusado (como no resto da API)', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta = { type: 'body' as const, metatype: InscricaoLaboratorioDto, data: '' };
    await expect(pipe.transform({ ...valida, tenant_id: 'x' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...valida, email: 'nao-e-email' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform(valida, meta)).resolves.toBeInstanceOf(InscricaoLaboratorioDto);
  });
});
