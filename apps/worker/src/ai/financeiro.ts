/**
 * CARLA — IA do chip FINANCEIRO. Lê o financeiro do PRÓPRIO paciente da conversa e
 * reenvia boletos/PIX sob pedido. Módulo-FOLHA (funções puras com prisma/settings/axios):
 * NÃO é provider Nest, não importa nada da API → sem ciclo de DI (ver memória do "Ciclo
 * de DI derruba a API"). Chamado pelo ai.processor só quando profilePurpose==='FINANCEIRO'.
 *
 * SEGURANÇA (regra nº1 do dono: NUNCA boleto de outra pessoa):
 *  - As cobranças saem SEMPRE do paciente vinculado ao lead DESTA conversa + tenant
 *    (mesmo `where` tenant-scoped de PaymentGatewayService.getChargesByPatient na API).
 *  - Nunca se busca cobrança por nome/CPF/telefone que o paciente digitar, nem por
 *    charge_id vindo do modelo: o id só vem da lista escopada (`sendable`).
 *  - O telefone de envio é o do lead DESTA conversa (mesma pessoa dona das cobranças).
 *  - FREIO ao vivo antes de ENVIAR (cobranca-freio): relê status local + Asaas; quem
 *    já pagou/cancelou/sumiu NÃO recebe. FAIL-CLOSED: Asaas fora do ar OU clínica sem
 *    config Asaas para uma cobrança Asaas = NÃO envia (igual à régua).
 *  - O RESUMO também é reconciliado ao vivo no Asaas (quando há config), pra não
 *    afirmar dívida de parcela já paga (webhook perdido).
 *  - Idempotência própria (AuditLog CARLA_SEND): retry do job/BullMQ não reenvia o
 *    mesmo boleto; chave distinta da régua (não silencia os crons).
 */
import axios from 'axios';
import { toBrazilWhatsappNumber } from '@crm/shared';
import { veredictoLocal, veredictoAsaas, combinar } from '../payment/cobranca-freio';

/** Teto de peças por disparo (anti-ban), igual ao agrupado da régua (GROUP_MAX_PDFS). */
const MAX_PECAS = 6;
/** Teto de cobranças reconciliadas ao vivo ao montar o resumo (limita custo/latência). */
const MAX_RECONCILE = 12;
/** Janela de idempotência do reenvio on-demand (cobre retry do job e pedido repetido). */
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** Uma cobrança EM ABERTO do paciente, pronta pra reenviar. */
export interface FinanceiroSendable {
  chargeId: string;
  externalId: string | null;
  gateway: string | null;
  amount: number;
  dueDate: Date | null;
  status: string; // PENDING | OVERDUE
  billingType: string | null;
  boletoUrl: string | null;
  invoiceUrl: string | null;
  pixCopyPaste: string | null;
}

export interface FinanceiroContext {
  /** null = não achei paciente cadastrado p/ este lead (Carla redireciona/escala). */
  patientId: string | null;
  /** Texto factual pra injetar no prompt — a Carla responde a partir DISTO. */
  resumoText: string;
  /** Cobranças em aberto do paciente (fonte dos reenvios — nunca de outra pessoa). */
  sendable: FinanceiroSendable[];
}

/** Ação financeira emitida pela Carla no JSON (espelha o scheduling_action). */
export interface FinanceiroAction {
  action: 'enviar_boletos' | 'enviar_pix' | 'enviar_vencidos' | 'enviar_todos';
  /** 1-based: índice na lista de PARCELAS EM ABERTO (opcional — envia só essa). */
  item?: number;
}

const ACOES = new Set(['enviar_boletos', 'enviar_pix', 'enviar_vencidos', 'enviar_todos']);

/** Lê o financeiro_action do JSON da IA (topo ou dentro de updates). null = sem ação. */
export function normalizeFinanceiroAction(parsed: any): FinanceiroAction | null {
  const raw = parsed?.financeiro_action ?? parsed?.updates?.financeiro_action ?? null;
  if (!raw || typeof raw !== 'object') return null;
  const action = String(raw.action || '').trim().toLowerCase();
  if (!ACOES.has(action)) return null;
  const out: FinanceiroAction = { action: action as FinanceiroAction['action'] };
  const item = Number(raw.item);
  if (Number.isInteger(item) && item >= 1) out.item = item;
  return out;
}

const moeda = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const ddmm = (d: Date | null) =>
  d ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}` : '—';

/** Status locais que contam como "em aberto" (os únicos reenviáveis). */
const ABERTO = new Set(['PENDING', 'OVERDUE']);

/** Uma cobrança usa o Asaas (tem external_id e gateway Asaas/legado)? */
const isAsaasCharge = (externalId: string | null, gateway: string | null) =>
  !!externalId && (!gateway || String(gateway).toUpperCase() === 'ASAAS');

/** Config Asaas do tenant (chave própria/matriz) — null se a clínica não pode consultar. */
async function asaasCfg(settings: any, tenantId: string | null): Promise<{ apiKey: string; baseUrl: string } | null> {
  if (!tenantId) return null; // nunca cair na chave global por tenant vazio (incidente de vazamento)
  try { return await settings.getAsaasConfig(tenantId); } catch { return null; }
}

/** Consulta o status ao vivo no Asaas (GET /payments/{id}). */
async function consultarAsaas(cfg: { apiKey: string; baseUrl: string }, externalId: string) {
  try {
    const { data } = await axios.get(`${cfg.baseUrl}/payments/${externalId}`, {
      headers: { access_token: cfg.apiKey, 'User-Agent': 'LexCRM/1.0' },
      timeout: 15000,
    });
    return { ok: true as const, status: data?.status ?? null, deleted: data?.deleted ?? false };
  } catch (e: any) {
    return { ok: false as const, httpStatus: e?.response?.status ?? null };
  }
}

/** Busca PDF (bankSlipUrl), link (invoiceUrl) e PIX copia-e-cola ao vivo no Asaas. */
async function enriquecer(cfg: { apiKey: string; baseUrl: string }, externalId: string): Promise<{ pdf?: string; inv?: string; pix?: string }> {
  const headers = { access_token: cfg.apiKey, 'User-Agent': 'LexCRM/1.0' };
  const out: { pdf?: string; inv?: string; pix?: string } = {};
  try {
    const { data } = await axios.get(`${cfg.baseUrl}/payments/${externalId}`, { headers, timeout: 15000 });
    if (data?.bankSlipUrl) out.pdf = data.bankSlipUrl;
    if (data?.invoiceUrl) out.inv = data.invoiceUrl;
  } catch { /* best-effort */ }
  try {
    const { data } = await axios.get(`${cfg.baseUrl}/payments/${externalId}/pixQrCode`, { headers, timeout: 15000 });
    if (data?.payload) out.pix = data.payload;
  } catch { /* best-effort */ }
  return out;
}

/**
 * Carrega o resumo financeiro SEGURO do paciente do lead desta conversa. Replica o
 * `where` de PaymentGatewayService.getChargesByPatient (API): patient validado por
 * tenant, cobranças por tenant_id + OR(patient_id, customer_external_id do lead).
 * Reconcilia ao vivo no Asaas (quando há config) pra não listar parcela já paga.
 */
export async function loadFinanceiroContext(
  prisma: any,
  settings: any,
  tenantId: string | null,
  leadId: string | null,
): Promise<FinanceiroContext> {
  const vazio = (msg: string): FinanceiroContext => ({ patientId: null, resumoText: msg, sendable: [] });
  if (!tenantId || !leadId) return vazio('(sem clínica/contato resolvido — não é possível consultar o financeiro)');

  // 1) Paciente DESTE lead, na MESMA clínica (nunca de outro tenant).
  const patient = await prisma.patient
    .findFirst({ where: { lead_id: leadId, tenant_id: tenantId }, select: { id: true, lead_id: true } })
    .catch(() => null);
  if (!patient) {
    return vazio('(este contato não tem cadastro de paciente nesta clínica — não há financeiro a mostrar; oriente a procurar o contato principal)');
  }

  // 2) Vínculos da cobrança: direto (patient_id) + cadeia do cliente Asaas (external_id).
  //    Mesma lógica da API; o lookup do customer ganha tenant_id (defesa em profundidade).
  const or: any[] = [{ patient_id: patient.id }];
  if (patient.lead_id) {
    const customer = await prisma.paymentGatewayCustomer
      .findFirst({
        where: { lead_id: patient.lead_id, gateway: 'ASAAS', tenant_id: tenantId },
        select: { external_id: true },
      })
      .catch(() => null);
    if (customer?.external_id) or.push({ customer_external_id: customer.external_id });
  }

  const charges: any[] = await prisma.paymentGatewayCharge
    .findMany({
      where: { tenant_id: tenantId, OR: or },
      orderBy: { due_date: 'asc' },
      take: 100,
      select: {
        id: true, external_id: true, gateway: true, amount: true, due_date: true, status: true,
        billing_type: true, boleto_url: true, invoice_url: true, pix_copy_paste: true,
        received_in_cash: true, cancelled_at: true,
      },
    })
    .catch(() => [] as any[]);

  // 3) Partição por status local (a Carla só expõe/reenvia o que está EM ABERTO).
  let pagas = 0;
  const abertasRaw: any[] = [];
  for (const c of charges) {
    const st = String(c.status || '').toUpperCase();
    if (c.cancelled_at || st === 'DELETED' || st === 'CANCELLED' || st === 'REFUNDED') continue;
    if (c.received_in_cash || st === 'RECEIVED' || st === 'CONFIRMED' || st === 'RECEIVED_IN_CASH') { pagas++; continue; }
    if (ABERTO.has(st)) abertasRaw.push(c);
  }

  // 4) Reconciliação ao vivo no Asaas: o status local pode estar velho (webhook perdido),
  //    mostrando como "em aberto" algo já pago. Confere as abertas Asaas e tira as pagas.
  //    Sem config Asaas, mantém o local (o FREIO do envio ainda protege a cobrança).
  const cfg = await asaasCfg(settings, tenantId);
  const abertas: any[] = [];
  if (cfg) {
    let checados = 0;
    for (const c of abertasRaw) {
      if (checados < MAX_RECONCILE && isAsaasCharge(c.external_id, c.gateway)) {
        checados++;
        const v = veredictoAsaas(await consultarAsaas(cfg, c.external_id));
        if (v === 'nao_cobrar') { pagas++; continue; } // pago/estornado/removido no Asaas
        // 'indisponivel' (não deu pra conferir) → mantém como aberta (conservador no texto)
      }
      abertas.push(c);
    }
  } else {
    abertas.push(...abertasRaw);
  }

  const sendable: FinanceiroSendable[] = abertas.map((c) => ({
    chargeId: c.id,
    externalId: c.external_id ?? null,
    gateway: c.gateway ?? null,
    amount: Number(c.amount ?? 0),
    dueDate: c.due_date ? new Date(c.due_date) : null,
    status: String(c.status || '').toUpperCase(),
    billingType: c.billing_type ?? null,
    boletoUrl: c.boleto_url ?? null,
    invoiceUrl: c.invoice_url ?? null,
    pixCopyPaste: c.pix_copy_paste ?? null,
  }));

  const vencidas = sendable.filter((c) => c.status === 'OVERDUE');
  const totalAberto = sendable.reduce((s, c) => s + c.amount, 0);
  const totalVencido = vencidas.reduce((s, c) => s + c.amount, 0);
  const proxima = sendable[0] || null;

  if (sendable.length === 0) {
    const txt = pagas > 0
      ? `RESUMO FINANCEIRO (dados reais DESTE paciente): nenhuma parcela em aberto — está tudo quitado (${pagas} paga(s)).`
      : 'RESUMO FINANCEIRO (dados reais DESTE paciente): nenhuma cobrança registrada no sistema.';
    return { patientId: patient.id, resumoText: txt, sendable };
  }

  const linhas = sendable
    .map((c, i) => `  ${i + 1}. ${ddmm(c.dueDate)} — ${moeda(c.amount)} — ${c.status === 'OVERDUE' ? 'atrasada' : 'em aberto'}`)
    .join('\n');

  const resumoText =
    'RESUMO FINANCEIRO (dados REAIS do paciente DESTA conversa — só dele, nunca de outra pessoa; responda a partir DESTES números):\n' +
    `- Parcelas pagas: ${pagas}\n` +
    `- Em aberto: ${sendable.length} (total ${moeda(totalAberto)})\n` +
    (vencidas.length ? `- Atrasadas: ${vencidas.length} (total ${moeda(totalVencido)})\n` : '- Atrasadas: nenhuma\n') +
    (proxima ? `- Próxima a vencer: ${ddmm(proxima.dueDate)} (${moeda(proxima.amount)})\n` : '') +
    'PARCELAS EM ABERTO (ordem de vencimento — o número é o "item" pra reenviar uma específica):\n' +
    linhas;

  return { patientId: patient.id, resumoText, sendable };
}

async function sendText(evo: { apiUrl: string; apiKey: string; instance: string }, phone: string, text: string): Promise<boolean> {
  try {
    await axios.post(
      `${evo.apiUrl}/message/sendText/${evo.instance}`,
      { number: toBrazilWhatsappNumber(phone), text },
      { headers: { apikey: evo.apiKey }, timeout: 15000 },
    );
    return true;
  } catch { return false; }
}

async function sendPdf(evo: { apiUrl: string; apiKey: string; instance: string }, phone: string, pdfUrl: string, caption: string): Promise<boolean> {
  try {
    await axios.post(
      `${evo.apiUrl}/message/sendMedia/${evo.instance}`,
      { number: toBrazilWhatsappNumber(phone), mediatype: 'document', media: pdfUrl, fileName: 'boleto.pdf', mimetype: 'application/pdf', caption },
      { headers: { apikey: evo.apiKey }, timeout: 20000 },
    );
    return true;
  } catch { return false; }
}

export interface FinanceiroSendResult {
  attempted: number;
  sent: number;
  blocked: number; // barrados pelo freio (já pago/cancelado/Asaas fora/sem config)
  reason?: string;
}

/**
 * Reenvia os boletos/PIX das cobranças EM ABERTO do paciente (vindas de `sendable`),
 * pela instância FINANCEIRO desta conversa, com FREIO ao vivo por cobrança (fail-closed)
 * e idempotência por charge (AuditLog CARLA_SEND). dryRun nunca envia.
 */
export async function runFinanceiroSend(opts: {
  prisma: any;
  settings: any;
  logger: { log: (m: string) => void; warn: (m: string) => void };
  tenantId: string;
  phone: string;
  instanceName: string;
  action: FinanceiroAction;
  sendable: FinanceiroSendable[];
  dryRun?: boolean;
}): Promise<FinanceiroSendResult> {
  const { prisma, settings, logger, tenantId, phone, instanceName, action, sendable, dryRun } = opts;
  if (dryRun) return { attempted: 0, sent: 0, blocked: 0, reason: 'dry-run' };
  if (!tenantId || !phone || !instanceName) return { attempted: 0, sent: 0, blocked: 0, reason: 'sem tenant/telefone/instância' };

  // Seleção — SEMPRE da lista escopada (nunca id solto do modelo). `item` indexa a
  // lista EXIBIDA no resumo (= sendable) e tem precedência; item fora da faixa NÃO
  // vira "enviar todos" (não silencia) — não envia nada.
  let alvos: FinanceiroSendable[];
  if (action.item != null) {
    if (action.item >= 1 && action.item <= sendable.length) alvos = [sendable[action.item - 1]];
    else return { attempted: 0, sent: 0, blocked: 0, reason: 'item fora da faixa' };
  } else if (action.action === 'enviar_vencidos') {
    alvos = sendable.filter((c) => c.status === 'OVERDUE');
  } else {
    alvos = sendable;
  }
  if (alvos.length === 0) return { attempted: 0, sent: 0, blocked: 0, reason: 'nada a enviar' };
  if (alvos.length > MAX_PECAS) alvos = alvos.slice(0, MAX_PECAS);

  const pixOnly = action.action === 'enviar_pix';
  const { apiUrl, apiKey } = await settings.getEvolutionConfig();
  if (!apiUrl) return { attempted: alvos.length, sent: 0, blocked: 0, reason: 'evolution não configurada' };
  const evo = { apiUrl, apiKey, instance: instanceName };
  const cfg = await asaasCfg(settings, tenantId);
  const dedupFloor = new Date(Date.now() - DEDUP_WINDOW_MS);

  let sent = 0;
  let blocked = 0;
  for (const c of alvos) {
    const asaas = isAsaasCharge(c.externalId, c.gateway);

    // ── FREIO AO VIVO: nunca reenviar cobrança já paga/cancelada. FAIL-CLOSED. ──
    const fresh = await prisma.paymentGatewayCharge
      .findUnique({ where: { id: c.chargeId }, select: { status: true, received_in_cash: true } })
      .catch(() => null);
    const vLocal = veredictoLocal(fresh);
    let veredicto = vLocal;
    if (asaas) {
      if (!cfg) {
        // Cobrança Asaas mas a clínica não pode consultar (sem chave/isolada): não dá
        // pra confiar no status local (pode estar pago sem baixa) → NÃO envia.
        blocked++;
        logger.warn(`[CARLA] cobrança ${c.chargeId} não reenviada (sem config Asaas p/ conferir — fail-closed).`);
        continue;
      }
      veredicto = combinar(vLocal, veredictoAsaas(await consultarAsaas(cfg, c.externalId!)));
    }
    if (veredicto !== 'cobrar') {
      blocked++;
      logger.log(`[CARLA] cobrança ${c.chargeId} não reenviada (freio: ${veredicto}).`);
      continue;
    }

    // ── Idempotência: não reenviar a MESMA cobrança duas vezes na janela (retry do
    //    job / pedido repetido). Chave própria (CARLA_SEND) — não silencia os crons. ──
    const jaEnviado = await prisma.auditLog
      .findFirst({ where: { entity: 'CARLA_SEND', entity_id: c.chargeId, created_at: { gt: dedupFloor } }, select: { id: true } })
      .catch(() => null);
    if (jaEnviado) {
      logger.log(`[CARLA] cobrança ${c.chargeId} já reenviada há pouco — pulando (idempotência).`);
      continue;
    }

    // Enriquecer PDF/PIX ao vivo se faltarem no banco (carteira importada).
    let pdf = c.boletoUrl;
    let pix = c.pixCopyPaste;
    let inv = c.invoiceUrl;
    if (asaas && cfg && ((!pdf && !pixOnly) || !pix)) {
      const ex = await enriquecer(cfg, c.externalId!);
      pdf = pdf || ex.pdf || null;
      pix = pix || ex.pix || null;
      inv = inv || ex.inv || null;
    }

    const venc = ddmm(c.dueDate);
    const val = moeda(c.amount);
    let enviouPeca = false;
    if (!pixOnly && pdf) {
      if (await sendPdf(evo, phone, pdf, `Parcela de ${venc} — ${val}`)) enviouPeca = true;
    }
    if (pix) {
      // PIX copia-e-cola em mensagem separada (igual a régua).
      if (await sendText(evo, phone, pix)) enviouPeca = true;
    }
    if (!enviouPeca && !pixOnly && inv) {
      if (await sendText(evo, phone, `Parcela de ${venc} (${val}): ${inv}`)) enviouPeca = true;
    }
    if (enviouPeca) {
      sent++;
      await prisma.auditLog
        .create({ data: { entity: 'CARLA_SEND', entity_id: c.chargeId, action: action.action, meta_json: { tenant_id: tenantId, sent_at: new Date().toISOString() } } })
        .catch(() => { /* best-effort */ });
    }
    // Pequeno respiro entre peças (anti-ban).
    await new Promise((r) => setTimeout(r, 1200));
  }

  logger.log(`[CARLA] reenvio concluído: ${sent} enviada(s), ${blocked} barrada(s) pelo freio (de ${alvos.length}).`);
  return { attempted: alvos.length, sent, blocked };
}
