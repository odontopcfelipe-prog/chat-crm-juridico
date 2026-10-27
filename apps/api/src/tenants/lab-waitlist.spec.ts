import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { IS_SUPER_ADMIN_KEY } from '../auth/decorators/super-admin.decorator';
import { InscricaoLaboratorioDto, LabWaitlistController, quemEnvia } from './lab-waitlist.controller';
import { LabWaitlistService, TETO_POR_DIA } from './lab-waitlist.service';

function montar(opts: { repetida?: boolean; avisoNaHora?: boolean; noDia?: number; donos?: string[]; mailFalha?: boolean; mailTrava?: boolean } = {}) {
  const prisma: any = {
    labWaitlistEntry: {
      // 1ª busca = repetida pelo WhatsApp; 2ª = alguma inscrição na última hora.
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.phone) return opts.repetida ? { id: 'ja' } : null;
        return opts.avisoNaHora ? { id: 'outra' } : null;
      }),
      count: jest.fn(async () => opts.noDia ?? 0),
      create: jest.fn(async ({ data }: any) => ({ id: 'novo', ...data })),
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    user: { findMany: jest.fn(async () => (opts.donos ?? ['dono@exemplo.com']).map((email) => ({ email }))) },
  };
  const mail: any = {
    renderTemplate: jest.fn((o: any) => `<h1>${o.title}</h1>${o.bodyHtml}<a href="${o.ctaUrl}">${o.ctaLabel}</a>`),
    send: jest.fn(() => {
      if (opts.mailTrava) return new Promise(() => undefined);
      if (opts.mailFalha) return Promise.reject(new Error('smtp fora'));
      return Promise.resolve(true);
    }),
  };
  return { prisma, mail, service: new LabWaitlistService(prisma, mail) };
}

/** O aviso sai sem esperar: deixa as promessas pendentes andarem. */
const esvaziar = () => new Promise((r) => setImmediate(r));

const valida = { lab_name: '  Lab   Sorriso ', contact_name: 'Ana Souza', phone: '(82) 99999-8888', email: 'Ana@Exemplo.com', city: 'Maceió' };

describe('lista de espera do laboratório (/cadastrar)', () => {
  it('guarda o contato com o WhatsApp pronto para envio e avisa os donos, sem nada do que foi digitado no e-mail', async () => {
    const { prisma, mail, service } = montar({ donos: ['a@x.com', 'b@x.com', 'a@x.com'] });
    await expect(service.inscrever({ ...valida, lab_name: 'Lab <b>Golpe</b> pague em http://x' })).resolves.toEqual({ ok: true });
    expect(prisma.labWaitlistEntry.create).toHaveBeenCalledWith({
      data: { lab_name: 'Lab <b>Golpe</b> pague em http://x', contact_name: 'Ana Souza', phone: '5582999998888', email: 'ana@exemplo.com', city: 'Maceió' },
    });
    await esvaziar();
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { roles: { has: 'SUPER_ADMIN' }, email: { not: '' } } }));
    expect(mail.send.mock.calls.map((c: any[]) => c[0].to)).toEqual(['a@x.com', 'b@x.com']);
    const enviado = JSON.stringify(mail.send.mock.calls) + JSON.stringify(mail.renderTemplate.mock.calls);
    for (const digitado of ['Golpe', 'http://x', 'Ana Souza', '5582999998888', 'ana@exemplo.com', 'Maceió']) {
      expect(enviado).not.toContain(digitado);
    }
    expect(mail.renderTemplate.mock.calls[0][0].ctaUrl).toMatch(/\/admin\/lista-espera$/);
  });

  it('o mesmo WhatsApp (com ou sem 55/9) em 30 dias não vira linha nova nem e-mail, e a resposta é a mesma', async () => {
    const { prisma, mail, service } = montar({ repetida: true });
    await expect(service.inscrever(valida)).resolves.toEqual({ ok: true });
    const where = prisma.labWaitlistEntry.findFirst.mock.calls[0][0].where;
    expect(where.phone.in).toEqual(expect.arrayContaining(['5582999998888', '558299998888', '82999998888']));
    expect(where.created_at.gte.getTime()).toBeGreaterThan(Date.now() - 31 * 24 * 3600_000);
    expect(prisma.labWaitlistEntry.create).not.toHaveBeenCalled();
    await esvaziar();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('já houve inscrição na última hora: grava, mas não manda outro e-mail', async () => {
    const { prisma, mail, service } = montar({ avisoNaHora: true });
    await expect(service.inscrever(valida)).resolves.toEqual({ ok: true });
    expect(prisma.labWaitlistEntry.create).toHaveBeenCalled();
    const hora = prisma.labWaitlistEntry.findFirst.mock.calls[1][0].where.created_at.gte.getTime();
    expect(Date.now() - hora).toBeGreaterThanOrEqual(3600_000 - 1000);
    expect(Date.now() - hora).toBeLessThanOrEqual(3600_000 + 1000);
    await esvaziar();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('teto do dia: com o máximo de inscrições em 24 h, responde ok e não grava nem avisa', async () => {
    const { prisma, mail, service } = montar({ noDia: TETO_POR_DIA });
    await expect(service.inscrever(valida)).resolves.toEqual({ ok: true });
    expect(prisma.labWaitlistEntry.count.mock.calls[0][0].where.created_at.gte.getTime()).toBeGreaterThan(Date.now() - 24 * 3600_000 - 1000);
    expect(prisma.labWaitlistEntry.create).not.toHaveBeenCalled();
    await esvaziar();
    expect(mail.send).not.toHaveBeenCalled();
    const umAbaixo = montar({ noDia: TETO_POR_DIA - 1 });
    await umAbaixo.service.inscrever(valida);
    expect(umAbaixo.prisma.labWaitlistEntry.create).toHaveBeenCalled();
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
    [{ ...valida, phone: '55 82 9988-877' }, 'WhatsApp'],
    [{ ...valida, phone: '5500999998888' }, 'WhatsApp'],
    [{ ...valida, lab_name: ' ' }, 'laboratório'],
    [{ ...valida, contact_name: 'A' }, 'nome'],
  ])('dado faltando ou errado → 400 e nada gravado (%#)', async (dados, trecho) => {
    const { prisma, service } = montar();
    const erro = await service.inscrever(dados as any).catch((e) => e);
    expect(erro).toBeInstanceOf(BadRequestException);
    expect(erro.message).toContain(trecho);
    expect(prisma.labWaitlistEntry.create).not.toHaveBeenCalled();
  });

  it('o e-mail falhar ou travar não atrasa nem derruba a inscrição', async () => {
    const falha = montar({ mailFalha: true });
    await expect(falha.service.inscrever(valida)).resolves.toEqual({ ok: true });
    await esvaziar();
    const trava = montar({ mailTrava: true });
    await expect(trava.service.inscrever(valida)).resolves.toEqual({ ok: true });
    expect(trava.prisma.labWaitlistEntry.create).toHaveBeenCalled();
  });

  it('remover apaga só a inscrição pedida', async () => {
    const { prisma, service } = montar();
    await expect(service.remover('id-1')).resolves.toEqual({ removidos: 1 });
    expect(prisma.labWaitlistEntry.deleteMany).toHaveBeenCalledWith({ where: { id: 'id-1' } });
  });

  it('a inscrição é pública, com limite por visitante; listar e remover são só do SUPER_ADMIN', () => {
    const proto = LabWaitlistController.prototype;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.inscrever)).toBe(true);
    for (const m of [proto.listar, proto.remover]) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, m)).toBeUndefined();
      expect(Reflect.getMetadata(IS_SUPER_ADMIN_KEY, m)).toBe(true);
    }
    const chaves = Reflect.getMetadataKeys(proto.inscrever).map(String);
    expect(Reflect.getMetadata(chaves.find((k) => k.startsWith('THROTTLER:LIMIT'))!, proto.inscrever)).toBe(5);
    expect(Reflect.getMetadata(chaves.find((k) => k.startsWith('THROTTLER:TRACKER'))!, proto.inscrever)).toBe(quemEnvia);
  });

  it('quem envia: o IP de verdade que o Cloudflare passa; sem ele, o da conexão', () => {
    expect(quemEnvia({ headers: { 'cf-connecting-ip': '203.0.113.7' }, ip: '10.0.0.2' })).toBe('203.0.113.7');
    expect(quemEnvia({ headers: { 'cf-connecting-ip': '198.51.100.9' }, ip: '10.0.0.2' })).not.toBe(
      quemEnvia({ headers: { 'cf-connecting-ip': '203.0.113.7' }, ip: '10.0.0.2' }),
    );
    expect(quemEnvia({ headers: { 'x-forwarded-for': '1.2.3.4' }, ip: '10.0.0.2' })).toBe('10.0.0.2');
    expect(quemEnvia({ headers: {}, ip: '10.0.0.2' })).toBe('10.0.0.2');
  });

  it('campo a mais no corpo é recusado (como no resto da API)', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta = { type: 'body' as const, metatype: InscricaoLaboratorioDto, data: '' };
    await expect(pipe.transform({ ...valida, tenant_id: 'x' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...valida, email: 'nao-e-email' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform(valida, meta)).resolves.toBeInstanceOf(InscricaoLaboratorioDto);
  });
});
