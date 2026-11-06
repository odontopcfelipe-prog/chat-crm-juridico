/**
 * Laboratório — e-mails automáticos com texto de laboratório e nascendo desligados.
 *
 * O laboratório vê os 6 eventos com o vocabulário dele. Cobrança gerada e pagamento
 * confirmado seguem ligados como já saíam; vencimento amanhã, pagamento atrasado e os
 * dois de agenda só saem depois que a própria conta liga. A clínica não muda.
 *
 * Banco de teste: dublê em memória. Dados de exemplo (repositório público).
 */
import { BadRequestException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { EmailAutomationService, LIMITE_DE_TESTE_DO_LAB } from './email-automation.service';
import { LAB_EMAIL_EVENTS } from './lab-email-events-textos';
import { EMAIL_EVENTS } from './email-events';
import { temVocabularioDeClinica, semVariaveis } from '../payment-gateway/cobranca-laboratorio';

const LAB = 'conta-lab';
const CLINICA = 'conta-clinica';

beforeEach(() => {
  __limparCacheLabTenants();
  LIMITE_DE_TESTE_DO_LAB.limpar();
});

function montar(overrides: any[] = [], statusDaConta = 'ACTIVE') {
  const enviados: any[] = [];
  const salvos: any[] = [];
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    tenantEmailTemplate: {
      findMany: jest.fn(async ({ where }: any) => overrides.filter((o) => o.tenant_id === where.tenant_id)),
      findUnique: jest.fn(
        async ({ where }: any) =>
          overrides.find((o) => o.tenant_id === where.tenant_id_event_key.tenant_id && o.event_key === where.tenant_id_event_key.event_key) ?? null,
      ),
      upsert: jest.fn(async (a: any) => {
        salvos.push(a);
        return a.create;
      }),
    },
    tenant: { findUnique: jest.fn(async () => ({ name: 'Lab Exemplo', email: 'lab@example.com', status: statusDaConta })) },
    globalSetting: { findMany: jest.fn(async () => []) },
  };
  const mail: any = {
    renderTemplate: jest.fn((p: any) => p.bodyHtml),
    send: jest.fn(async (m: any) => {
      enviados.push(m);
      return true;
    }),
  };
  return { svc: new EmailAutomationService(prisma, mail), enviados, salvos, prisma };
}

describe('catálogo do laboratório', () => {
  it('tem os mesmos eventos da clínica e nenhum texto fala de clínica', () => {
    expect(Object.keys(LAB_EMAIL_EVENTS).sort()).toEqual(EMAIL_EVENTS.map((e) => e.key).sort());
    for (const ev of Object.values(LAB_EMAIL_EVENTS)) {
      const texto = [ev.label, ev.description, ev.defaultSubject, ev.defaultBody, ...ev.variables.map((v) => v.label)].join('\n');
      expect(temVocabularioDeClinica(semVariaveis(texto))).toBe(false);
      expect(ev.variables.some((v) => (v.name as string) === 'paciente_nome')).toBe(false);
    }
  });
});

describe('lista e edição', () => {
  it('laboratório vê o texto de laboratório e só os dois de sempre ligados', async () => {
    const { svc } = montar();
    const lista = await svc.listForTenant(LAB);
    expect(lista.find((e) => e.key === 'cobranca_criada')?.enabled).toBe(true);
    expect(lista.find((e) => e.key === 'pagamento_confirmado')?.enabled).toBe(true);
    for (const k of ['vencimento_proximo', 'pagamento_atrasado', 'agendamento_criado', 'agendamento_remarcado']) {
      expect(lista.find((e) => e.key === k)?.enabled).toBe(false);
    }
    expect(lista.find((e) => e.key === 'agendamento_criado')?.label).toBe(LAB_EMAIL_EVENTS.agendamento_criado.label);
  });

  it('clínica: lista exatamente como era (tudo ligado, texto de clínica)', async () => {
    const { svc } = montar();
    const lista = await svc.listForTenant(CLINICA);
    expect(lista.every((e) => e.enabled)).toBe(true);
    expect(lista.find((e) => e.key === 'agendamento_criado')?.label).toBe('Consulta agendada');
    expect(lista.find((e) => e.key === 'cobranca_criada')?.variables.some((v) => v.name === 'paciente_nome')).toBe(true);
  });

  it('ligar grava; texto com palavra de clínica é recusado', async () => {
    const { svc, salvos } = montar();
    await svc.update(LAB, 'vencimento_proximo', { enabled: true });
    expect(salvos[0].create).toMatchObject({ enabled: true, subject: LAB_EMAIL_EVENTS.vencimento_proximo.defaultSubject });
    await expect(svc.update(LAB, 'vencimento_proximo', { body: 'Sua consulta vence amanhã' })).rejects.toBeInstanceOf(BadRequestException);
    await svc.update(LAB, 'pagamento_atrasado', { subject: 'Cobrança em aberto' });
    expect(salvos[1].create.enabled).toBe(false); // salvar o texto não liga o e-mail
  });
});

describe('envio', () => {
  const vars = { paciente_nome: 'Dra. Ana', valor: 'R$ 10,00', vencimento: '01/01/2027', forma_pagamento: 'PIX' };

  it('desligado no laboratório não sai; ligado pela conta sai com texto de laboratório', async () => {
    const off = montar();
    expect(await off.svc.dispatch('vencimento_proximo', LAB, 'a@example.com', vars)).toBe(false);
    expect(await off.svc.dispatch('agendamento_criado', LAB, 'a@example.com', { cliente_nome: 'Ana' })).toBe(false);
    expect(off.enviados).toHaveLength(0);

    const on = montar([{ tenant_id: LAB, event_key: 'vencimento_proximo', enabled: true, subject: null, body: null }].map((o) => ({
      ...o,
      subject: LAB_EMAIL_EVENTS.vencimento_proximo.defaultSubject,
      body: LAB_EMAIL_EVENTS.vencimento_proximo.defaultBody,
    })));
    expect(await on.svc.dispatch('vencimento_proximo', LAB, 'a@example.com', vars)).toBe(true);
    expect(on.enviados[0].html).toContain('Dra. Ana');
  });

  it.each(['SUSPENDED', 'DELETED'])('conta %s: nenhum e-mail automático sai, nem os ligados por padrão', async (status) => {
    const { svc, enviados } = montar([], status);
    expect(await svc.dispatch('cobranca_criada', LAB, 'a@example.com', vars)).toBe(false);
    expect(await svc.dispatch('pagamento_confirmado', LAB, 'a@example.com', vars)).toBe(false);
    expect(enviados).toHaveLength(0);
  });

  it('conta congelada (LAB_FREEZE): nenhum e-mail automático sai', async () => {
    const { svc, enviados, prisma } = montar();
    prisma.globalSetting.findMany.mockResolvedValue([{ value: 'true' }]);
    expect(await svc.dispatch('cobranca_criada', LAB, 'a@example.com', vars)).toBe(false);
    expect(enviados).toHaveLength(0);
  });

  it('conta em teste continua enviando', async () => {
    const { svc, enviados } = montar([], 'TRIAL');
    expect(await svc.dispatch('cobranca_criada', LAB, 'a@example.com', vars)).toBe(true);
    expect(enviados).toHaveLength(1);
  });

  it('clínica suspensa: o e-mail sai como sempre, sem ler o status', async () => {
    const { svc, enviados, prisma } = montar([], 'SUSPENDED');
    expect(await svc.dispatch('vencimento_proximo', CLINICA, 'a@example.com', vars)).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(prisma.globalSetting.findMany).not.toHaveBeenCalled();
  });

  it('cobrança criada e pagamento confirmado seguem saindo sem a conta ligar nada; {{cliente_nome}} recebe o nome', async () => {
    const { svc, enviados } = montar();
    expect(await svc.dispatch('cobranca_criada', LAB, 'a@example.com', vars)).toBe(true);
    expect(enviados[0].html).toContain('Olá, Dra. Ana!');
  });

  it('o teste ignora o liga/desliga', async () => {
    const { svc, enviados } = montar();
    await svc.sendTest(LAB, 'pagamento_atrasado', 'adm@example.com');
    expect(enviados).toHaveLength(1);
    expect(enviados[0].html).toContain('Maria da Silva');
  });

  const editado = (tenant_id: string) => ({
    tenant_id,
    event_key: 'pagamento_atrasado',
    enabled: true,
    subject: 'Assunto editado',
    body: 'Texto editado pela conta',
  });

  it('laboratório: o sexto teste do dia responde 429 e não envia; outra conta segue', async () => {
    const { svc, enviados } = montar();
    for (let i = 0; i < 5; i++) await svc.sendTest(LAB, 'pagamento_atrasado', 'adm@example.com');
    expect(enviados).toHaveLength(5);
    await expect(svc.sendTest(LAB, 'pagamento_atrasado', 'adm@example.com')).rejects.toMatchObject({ status: 429 });
    expect(enviados).toHaveLength(5);
  });

  it('laboratório em TRIAL: o teste sai com o texto padrão, nunca com o editado', async () => {
    const { svc, enviados } = montar([editado(LAB)], 'TRIAL');
    await svc.sendTest(LAB, 'pagamento_atrasado', 'adm@example.com');
    expect(enviados[0].subject).not.toBe('Assunto editado');
    expect(enviados[0].html).not.toContain('Texto editado pela conta');
    expect(enviados[0].html).toContain('Maria da Silva');
  });

  it('laboratório em ACTIVE: o teste sai com o texto editado', async () => {
    const { svc, enviados } = montar([editado(LAB)]);
    await svc.sendTest(LAB, 'pagamento_atrasado', 'adm@example.com');
    expect(enviados[0].subject).toBe('Assunto editado');
    expect(enviados[0].html).toContain('Texto editado pela conta');
  });

  it('clínica: sem limite de testes, com o texto editado em qualquer status', async () => {
    const { svc, enviados } = montar([editado(CLINICA)], 'TRIAL');
    for (let i = 0; i < 6; i++) await svc.sendTest(CLINICA, 'pagamento_atrasado', 'adm@example.com');
    expect(enviados).toHaveLength(6);
    expect(enviados[0].subject).toBe('Assunto editado');
    expect(enviados[0].html).toContain('Texto editado pela conta');
  });

  it('clínica: sem linha da conta o e-mail sai como sempre', async () => {
    const { svc, enviados } = montar();
    expect(await svc.dispatch('vencimento_proximo', CLINICA, 'a@example.com', vars)).toBe(true);
    expect(enviados[0].html).toContain('Olá, Dra. Ana!');
  });
});
