import axios from 'axios';
import { PaymentAlertsCronService } from './payment-alerts-cron.service';

jest.mock('axios');
const mockedGet = axios.get as jest.Mock;

/** Monta o serviço com banco/settings falsos. `local` = status no banco por chargeId;
 *  `asaas` = status no Asaas por externalId (string) ou erro HTTP (number). */
function montar(local: Record<string, { status: string; received_in_cash: boolean }>, asaas: Record<string, string | number>) {
  const prisma: any = {
    paymentGatewayCharge: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as string[]).filter((id) => local[id]).map((id) => ({ id, ...local[id] }))),
    },
  };
  const settings: any = {
    getAsaasConfig: jest.fn(async () => ({ apiKey: 'k', baseUrl: 'https://asaas' })),
    getEvolutionConfig: jest.fn(async () => ({ apiUrl: 'https://evo', apiKey: 'e' })),
  };
  mockedGet.mockImplementation(async (url: string) => {
    const ext = url.split('/payments/')[1];
    const v = asaas[ext];
    if (typeof v === 'number') throw Object.assign(new Error('http'), { response: { status: v } });
    if (v === undefined) throw new Error('timeout');
    return { data: { status: v } };
  });
  const svc = new PaymentAlertsCronService(prisma, settings);
  return { svc: svc as any, prisma, settings };
}

const membro = (id: string, amount: number, extra: any = {}) => ({
  chargeId: id, externalId: `pay_${id}`, gateway: 'ASAAS', amount, dueDate: new Date('2026-10-08T00:00:00Z'),
  link: `https://inv/${id}`, codigo: `pix-${id}`, ...extra,
});
const pick = (members: any[]) => ({
  chargeId: members[0].chargeId, externalId: members[0].externalId, gateway: 'ASAAS', patientId: 'pac1', tenantId: 't1',
  stage: 'boleto_1d_antes', phone: '82999990000', name: 'Gabriela', amount: members.reduce((s, m) => s + m.amount, 0),
  count: members.length, dueDate: members[0].dueDate, link: members[0].link, members, codigo: members.length === 1 ? members[0].codigo : undefined,
  pdfUrls: [], tipo: 'pix',
});

describe('freio ao vivo dentro da régua', () => {
  beforeEach(() => mockedGet.mockReset());

  it('CASO REAL: banco PENDING mas Asaas RECEIVED → não envia nada e barra o paciente (fila não trava)', async () => {
    const { svc } = montar({ c1: { status: 'PENDING', received_in_cash: false } }, { pay_c1: 'RECEIVED' });
    const sendText = jest.spyOn(svc, 'sendWhatsApp');
    const r = await svc.sendPacedCharge(pick([membro('c1', 2750)]), Date.now());
    expect(r).toBe('freio');
    expect(sendText).not.toHaveBeenCalled();
    expect(svc.freioBarrado({ patientId: 'pac1', stage: 'boleto_1d_antes', tenantId: 't1' })).toBe(true);
  });

  it('recebido na clínica (received_in_cash) → não cobra nem consulta o Asaas', async () => {
    const { svc } = montar({ c1: { status: 'PENDING', received_in_cash: true } }, {});
    expect(await svc.aplicarFreioAoVivo(pick([membro('c1', 2750)]))).toBe('vazio');
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('agrupado: tira só a paga e recalcula total/código', async () => {
    const { svc } = montar(
      { c1: { status: 'OVERDUE', received_in_cash: false }, c2: { status: 'OVERDUE', received_in_cash: false } },
      { pay_c1: 'CONFIRMED', pay_c2: 'OVERDUE' },
    );
    const p = pick([membro('c1', 500), membro('c2', 300)]);
    expect(await svc.aplicarFreioAoVivo(p)).toBe('ok');
    expect(p.count).toBe(1);
    expect(p.amount).toBe(300);
    expect(p.chargeId).toBe('c2');
    expect(p.codigo).toBe('pix-c2');
  });

  it('Asaas fora do ar → não envia agora (fail-closed) e tenta depois', async () => {
    const { svc } = montar({ c1: { status: 'PENDING', received_in_cash: false } }, { pay_c1: 503 });
    expect(await svc.aplicarFreioAoVivo(pick([membro('c1', 100)]))).toBe('indisponivel');
  });

  it('cobrança que sumiu do Asaas (404) → não cobra', async () => {
    const { svc } = montar({ c1: { status: 'PENDING', received_in_cash: false } }, { pay_c1: 404 });
    expect(await svc.aplicarFreioAoVivo(pick([membro('c1', 100)]))).toBe('vazio');
  });

  it('tudo em aberto no banco e no Asaas → segue o envio normal', async () => {
    const { svc } = montar({ c1: { status: 'PENDING', received_in_cash: false } }, { pay_c1: 'PENDING' });
    const p = pick([membro('c1', 100)]);
    expect(await svc.aplicarFreioAoVivo(p)).toBe('ok');
    expect(p.count).toBe(1);
  });

  it('cobrança local (sem Asaas) paga no banco → não cobra', async () => {
    const { svc } = montar({ c1: { status: 'RECEIVED', received_in_cash: false } }, {});
    const p = pick([membro('c1', 100, { gateway: 'LOCAL', externalId: undefined })]);
    expect(await svc.aplicarFreioAoVivo(p)).toBe('vazio');
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("agrupado que vira único: texto passa a ser o da cobrança que FICOU (tipo e vence-em)", async () => {
    const { svc } = montar(
      { c1: { status: "PENDING", received_in_cash: false }, c2: { status: "PENDING", received_in_cash: false } },
      { pay_c1: "RECEIVED", pay_c2: "PENDING" },
    );
    const p: any = pick([membro("c1", 500, { tipo: "pix" }), membro("c2", 300, { tipo: "boleto", venceEm: "na segunda-feira", pdfUrl: "https://pdf/c2" })]);
    p.tipo = "pix"; p.venceEm = undefined;
    expect(await svc.aplicarFreioAoVivo(p)).toBe("ok");
    expect(p.tipo).toBe("boleto");
    expect(p.venceEm).toBe("na segunda-feira");
    expect(p.pdfUrls).toEqual(["https://pdf/c2"]);
  });

  it("clínica sem chave Asaas → barra a CLÍNICA inteira (não paciente por paciente)", async () => {
    const { svc, settings } = montar({ c1: { status: "PENDING", received_in_cash: false } }, {});
    settings.getAsaasConfig.mockResolvedValue(null);
    expect(await svc.sendPacedCharge(pick([membro("c1", 100)]), Date.now())).toBe("freio");
    expect(svc.freioBarrado({ patientId: "OUTRO", stage: "boleto_no_dia", tenantId: "t1" })).toBe(true);
    expect(svc.freioBarrado({ patientId: "OUTRO", stage: "boleto_no_dia", tenantId: "t2" })).toBe(false);
  });

  it("chave recusada pelo Asaas (401) → também barra a clínica", async () => {
    const { svc } = montar({ c1: { status: "PENDING", received_in_cash: false } }, { pay_c1: 401 });
    expect(await svc.aplicarFreioAoVivo(pick([membro("c1", 100)]))).toBe("indisponivel_clinica");
  });

  it("WhatsApp não configurado → nem consulta o Asaas", async () => {
    const { svc, settings } = montar({ c1: { status: "PENDING", received_in_cash: false } }, { pay_c1: "RECEIVED" });
    settings.getEvolutionConfig.mockResolvedValue({ apiUrl: "", apiKey: "" });
    expect(await svc.sendPacedCharge(pick([membro("c1", 100)]), Date.now())).toBe("cooldown");
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("fila NÃO trava: se o 1º escolhido já foi pago, o mesmo tick passa pro próximo", async () => {
    const { svc } = montar(
      { c1: { status: "PENDING", received_in_cash: false }, c2: { status: "PENDING", received_in_cash: false } },
      { pay_c1: "RECEIVED", pay_c2: "PENDING" },
    );
    const pago = pick([membro("c1", 100)]);
    const aberto = { ...pick([membro("c2", 200)]), patientId: "pac2" };
    jest.spyOn(svc, "findNextIntro").mockResolvedValue(null);
    jest.spyOn(svc, "findNextCharge").mockImplementation(async () =>
      [pago, aberto].find((g: any) => !svc.freioBarrado(g)) || null);
    jest.spyOn(svc, "findNextOverdue").mockResolvedValue(null);
    const envio = jest.spyOn(svc, "sendPacedCharge");
    jest.spyOn(svc, "sendWhatsApp").mockResolvedValue("msg-id");
    jest.spyOn(svc, "logSent").mockResolvedValue(undefined);
    jest.spyOn(svc, "logDispatchUnificado").mockResolvedValue(undefined);
    jest.spyOn(svc, "registerInFinanceiroConversation").mockResolvedValue(undefined);
    jest.spyOn(svc, "resolveFinanceiroInstance").mockResolvedValue("fin1");
    jest.spyOn(svc, "resolveClinicName").mockResolvedValue("Clínica");
    jest.spyOn(svc, "resolveTemplate").mockResolvedValue("Oi {nome}, vence {data} {valor}");
    expect(await svc.sendOnePacedCharge()).toBe("sent");
    expect(envio).toHaveBeenCalledTimes(2);
    expect((envio.mock.calls[1][0] as any).patientId).toBe("pac2");
  });
});
