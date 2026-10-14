'use client';

/**
 * BoletosTab — Onda 16 (Sistema Financeiro Completo).
 *
 * Lista TODAS as cobranças do tenant (sinal/entrada/parcelas de tratamento)
 * com filtros pesados:
 *  - Status (todos / em aberto / pagos / atrasados / vencendo)
 *  - Tipo (sinal / entrada / parcela)
 *  - Forma (PIX / BOLETO / CARTAO)
 *  - Período (por due_date)
 *  - Por paciente
 *  - Por dentista
 *
 * E ações por linha: Abrir boleto, copiar PIX, lembrete WhatsApp, marcar
 * pago em espécie (quando aplicável), abrir ficha do paciente.
 *
 * Endpoint: GET /financeiro/charges
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Search, AlertTriangle, Clock, Check, ExternalLink,
  Copy, MessageCircle, DollarSign, FileText, Filter, X, Trash2, Users, ChevronRight, ChevronDown, BarChart3, CalendarDays,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { PatientAvatar } from '@/components/PatientAvatar';
// Apagar boleto é ADMIN-only.
import { useRole } from '@/lib/useRole';
import { toBrazilWhatsappNumber } from '@crm/shared';
import BoletosKpis, { type ChargesKpis } from './BoletosKpis';
import BoletosMesResumo, {
  MES_COR, diaDoVencimento, mesAtualMaceio, nomeDoMes, statusDoMes, type MesGuardaChuva, type MesStatus,
} from './BoletosMesResumo';

interface Charge {
  id: string;
  external_id: string;
  gateway: string;
  billing_type: string;
  kind: string | null;
  status: string;
  computed_status: 'PAGO' | 'CANCELADO' | 'ATRASADO' | 'EM_ABERTO';
  amount: number;
  net_value: number | null;
  due_date: string;
  paid_at: string | null;
  payment_date: string | null;
  received_in_cash: boolean;
  days_overdue: number;
  /** Em aberto e vence HOJE no fuso da clínica (backend calcula). */
  due_today?: boolean;
  description: string | null;
  boleto_url: string | null;
  pix_qr_code: string | null;
  pix_copy_paste: string | null;
  invoice_url: string | null;
  treatment_plan_id: string | null;
  installment_id: string | null;
  installment_label: string | null;
  patient: { id: string; name: string | null; phone: string | null; cpf: string | null; avatar_url?: string | null } | null;
  dentist: { id: string; name: string } | null;
  quote_number: number | null;
  created_at: string;
}

interface Props {
  dentistId?: string;
}

const fmtBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
// Vencimento é DATA gravada à meia-noite UTC (ver overdue.util do shared). No fuso
// do navegador (UTC-3) ela virava o dia ANTERIOR ("vence 01/10" aparecia 30/09).
// Lê a data em UTC — mesma régua do backend pra vencido/vence hoje.
const fmtDue = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

const STATUS_GROUPS = [
  // Onda 18.x — "Negativados" no lugar de "Em aberto": visão POR PACIENTE (ordem
  // alfabética) de quem tem ≥1 boleto atrasado; cada paciente expande e mostra
  // todos os boletos em aberto dele (atrasados + a vencer). O backend traz a
  // carteira inteira dos devedores (statusGroup=negativados).
  { key: 'negativados', label: 'Negativados', icon: Users, color: 'text-red-400' },
  // Tudo que VENCE no mês escolhido, por dia: pago verde · vence hoje amarelo ·
  // a vencer normal · atrasado vermelho (resumo + calendário em BoletosMesResumo).
  { key: 'month', label: 'Do mês', icon: CalendarDays, color: 'text-primary' },
  { key: 'upcoming', label: 'Vencem 7d', icon: Clock, color: 'text-amber-400' },
  { key: 'paid', label: 'Pagos', icon: Check, color: 'text-emerald-400' },
  { key: 'all', label: 'Todos', icon: Users, color: 'text-foreground' },
  // Onda 18.x — Relatório: só o dashboard completo (todos os detalhes), sem lista.
  { key: 'report', label: 'Relatório', icon: BarChart3, color: 'text-primary' },
] as const;
// Abas EXCLUSIVAS: cada chip mostra SÓ o seu status (lista única). O chip "Todos"
// (Onda 18.x) é POR PACIENTE: todo mundo que tem boleto, com pagos/abertos/atrasados/
// cancelados. Abre em "Negativados".
type StatusGroup = 'all' | typeof STATUS_GROUPS[number]['key'];

const KIND_LABEL: Record<string, string> = {
  SINAL: 'Sinal',
  ENTRADA: 'Entrada',
  INSTALLMENT: 'Parcela',
};

const computedStatusBadge = (status: Charge['computed_status'], opts?: { dueToday?: boolean; mes?: boolean }) => {
  const map = {
    PAGO: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: 'Pago' },
    EM_ABERTO: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Em aberto' },
    ATRASADO: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Atrasado' },
    CANCELADO: { bg: 'bg-muted', text: 'text-muted-foreground', label: 'Cancelado' },
  } as const;
  // Vence hoje = amarelo (em qualquer aba). Na aba "Do mês", o resto em aberto é
  // "A vencer" sem cor (pedido: "os a vencer normal").
  const s =
    status === 'EM_ABERTO' && opts?.dueToday
      ? { bg: 'bg-yellow-400/20', text: 'text-yellow-600 dark:text-yellow-400', label: 'Vence hoje' }
      : status === 'EM_ABERTO' && opts?.mes
        ? { bg: 'bg-muted', text: 'text-foreground', label: 'A vencer' }
        : map[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
};

// Onda 18.x — BUGFIX: usava só os dígitos do telefone. Salvo como "(82) 9940-3053"
// virava 8299403053 (SEM o 55) e o wa.me abria contato errado/inexistente.
// toBrazilWhatsappNumber é o helper único do projeto (nunca refazer essa lógica).
const waLink = (phone: string | null, msg: string) => {
  const num = toBrazilWhatsappNumber(phone);
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
};

export default function BoletosTab({ dentistId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [total, setTotal] = useState(0);
  // Abre em "Negativados". Chips são abas exclusivas — clicar troca o status mostrado
  // (o chip "Todos" volta pra visão agrupada). Nunca fica sem nenhum ativo.
  const [statusGroup, setStatusGroup] = useState<StatusGroup>('negativados');
  // Negativados: pacientes expandidos (id → true). Começa tudo recolhido.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));
  const [kind, setKind] = useState<string>('');
  const [billingType, setBillingType] = useState<string>('');
  const [search, setSearch] = useState('');
  // Busca é SERVER-SIDE (atravessa toda a carteira, não só as 200 carregadas).
  // Debounce pra não bater na API a cada tecla.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);
  const searching = debouncedSearch.trim().length > 0;
  // Aba "Do mês": mês escolhido (AAAA-MM), "hoje" da clínica e o que entrou no mês
  // de boletos de outros meses (vêm do backend), + filtros de dia/situação.
  const [mes, setMes] = useState<string>(mesAtualMaceio);
  const [mesHoje, setMesHoje] = useState<string | null>(null);
  const [mesOutros, setMesOutros] = useState<{ count: number; total: number } | null>(null);
  const [mesGuardaChuvas, setMesGuardaChuvas] = useState<MesGuardaChuva[]>([]);
  const [diaSel, setDiaSel] = useState<string | null>(null);
  const [statusSel, setStatusSel] = useState<MesStatus | null>(null);
  // Qual mês está de fato em `charges` (null enquanto carrega outra coisa) — o
  // resumo não mostra números de outro mês/aba sob o título do mês novo.
  const [mesCarregado, setMesCarregado] = useState<string | null>(null);
  // Falhou ao carregar o mês → aviso com "tentar de novo" (não "nenhuma cobrança").
  const [mesErro, setMesErro] = useState(false);
  const isMes = statusGroup === 'month' && !searching;
  const trocarMes = (m: string) => { setMes(m); setDiaSel(null); setStatusSel(null); };
  // No celular a lista fica bem abaixo do calendário: ao tocar num dia, rola até ela.
  const escolherDia = (d: string | null) => {
    setDiaSel(d);
    if (d && typeof window !== 'undefined' && window.innerWidth < 640) {
      setTimeout(() => document.getElementById('boletos-lista')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  };
  const [markingCash, setMarkingCash] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const role = useRole(); // role.isAdmin gateia o botão de apagar boleto
  // Onda 18.x — KPIs do dashboard (carteira inteira, por chip). Recarrega junto com a lista.
  const [kpis, setKpis] = useState<ChargesKpis | null>(null);
  const [kpisLoading, setKpisLoading] = useState(true);
  const fetchKpis = useCallback(async () => {
    setKpisLoading(true);
    try {
      // Os filtros de tipo/forma valem pro dashboard também (senão os cartões
      // mostrariam a carteira inteira com a lista filtrada).
      const params: any = {};
      if (dentistId) params.dentistId = dentistId;
      if (kind) params.kind = kind;
      if (billingType) params.billingType = billingType;
      const r = await api.get<ChargesKpis>('/financeiro/charges/kpis', { params });
      setKpis(r.data);
    } catch { /* dashboard é best-effort — a lista continua */ }
    finally { setKpisLoading(false); }
  }, [dentistId, kind, billingType]);
  useEffect(() => { fetchKpis(); }, [fetchKpis]);

  // Só a resposta da ÚLTIMA requisição vale: trocar de mês/aba rápido não deixa uma
  // resposta atrasada sobrescrever a tela (dados de outro mês sob o título novo).
  const reqId = useRef(0);
  // `silencioso`: recarga depois de receber/cancelar — mantém a lista na tela (sem
  // spinner, sem perder a rolagem) e só troca quando a resposta chega.
  const fetchData = useCallback(async (opts?: { silencioso?: boolean }) => {
    const my = ++reqId.current;
    const atual = () => my === reqId.current;
    // Relatório: só o dashboard — não carrega lista.
    if (statusGroup === 'report' && !debouncedSearch.trim()) { setCharges([]); setTotal(0); setLoading(false); return; }
    if (!opts?.silencioso) {
      setLoading(true);
      setMesCarregado(null);
    }
    setMesErro(false);
    const term = debouncedSearch.trim();
    const isMesReq = statusGroup === 'month' && !term;
    try {
      // "Do mês": endpoint próprio — tudo que vence no mês (sem canceladas) + o
      // "hoje" da clínica + o que entrou no mês de boletos de outros meses.
      if (isMesReq) {
        const params: any = { month: mes };
        if (kind) params.kind = kind;
        // Sem billingType: "Do mês" já é só boleto (o seletor de forma fica escondido lá).
        if (dentistId) params.dentistId = dentistId;
        const r = await api.get('/financeiro/charges/month', { params });
        if (!atual()) return;
        setCharges(r.data?.data || []);
        setTotal(r.data?.total || 0);
        setMesHoje(r.data?.today || null);
        setMesOutros(r.data?.received_other_months || null);
        setMesGuardaChuvas(r.data?.umbrellas || []);
        setMesCarregado(r.data?.month || mes);
        return;
      }
      // Negativados/Todos agrupam por paciente no front → pedem a carteira (tetos 2000/5000 no back).
      const params: any = { limit: term ? 500 : statusGroup === 'negativados' || statusGroup === 'all' ? 2000 : 200 };
      // Buscando um paciente → traz TODOS os status dele (pago/aberto/atrasado):
      // manda `search` e NÃO manda statusGroup (o chip é ignorado durante a busca).
      if (term) params.search = term;
      else params.statusGroup = statusGroup === 'all' ? 'all_patients' : statusGroup;
      if (kind) params.kind = kind;
      if (billingType) params.billingType = billingType;
      if (dentistId) params.dentistId = dentistId;
      const r = await api.get('/financeiro/charges', { params });
      if (!atual()) return;
      setCharges(r.data?.data || []);
      setTotal(r.data?.total || 0);
    } catch (e: any) {
      if (!atual()) return;
      // Onda 16.1 — mostra status code + mensagem do backend pra debugar.
      // Quando backend ainda nao deployou, da 404; quando query falha, 500
      // + mensagem clara. Ajuda muito pra ngm ficar adivinhando.
      const status = e?.response?.status;
      const msg = e?.response?.data?.message || e?.message || 'erro desconhecido';
      const rota = isMesReq ? '/financeiro/charges/month' : '/financeiro/charges';
      if (status === 404) {
        showError(`Endpoint ${rota} não disponível. Backend ainda não deployou — aguarde o redeploy completar.`);
      } else {
        showError(`Erro ao carregar boletos (${status || 'sem status'}): ${msg}`);
      }
      // Do mês: não deixa a lista de outro mês/aba sob o título do mês — mostra o erro.
      if (isMesReq && !opts?.silencioso) {
        setCharges([]);
        setTotal(0);
        setMesOutros(null);
        setMesGuardaChuvas([]);
        setMesErro(true);
      }
    } finally {
      if (atual()) setLoading(false);
    }
  }, [statusGroup, kind, billingType, dentistId, debouncedSearch, mes]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return charges;
    const digits = s.replace(/\D/g, ''); // dígitos do termo — pra casar telefone/CPF sem máscara
    return charges.filter((c) => {
      if (
        c.patient?.name?.toLowerCase().includes(s) ||
        c.dentist?.name?.toLowerCase().includes(s) ||
        c.installment_label?.toLowerCase().includes(s) ||
        String(c.quote_number || '').includes(s)
      ) return true;
      // Telefone / CPF: compara SÓ dígitos (ignora máscara/pontuação dos dois lados).
      if (digits.length >= 3) {
        const phoneDigits = (c.patient?.phone || '').replace(/\D/g, '');
        const cpfDigits = (c.patient?.cpf || '').replace(/\D/g, '');
        if (phoneDigits.includes(digits) || cpfDigits.includes(digits)) return true;
      }
      return false;
    });
  }, [charges, search]);

  // "Este mês": só as cobranças com VENCIMENTO no mês atual (respeita a busca).
  // Mês pela DATA do vencimento (parte UTC) e "mês atual" de Maceió — mesma régua da
  // aba "Do mês" (no fuso do navegador o dia 1º caía no mês anterior).
  const mesHojeMaceio = mesAtualMaceio();
  const monthStats = useMemo(() => {
    return filtered.reduce(
      (acc, c) => {
        if (diaDoVencimento(c).slice(0, 7) !== mesHojeMaceio) return acc;
        acc.count += 1;
        acc.totalValue += c.amount;
        if (c.computed_status === 'ATRASADO') acc.overdue += c.amount;
        else if (c.computed_status === 'EM_ABERTO') acc.open += c.amount;
        else if (c.computed_status === 'PAGO') acc.paid += c.amount;
        return acc;
      },
      { count: 0, totalValue: 0, paid: 0, open: 0, overdue: 0 },
    );
  }, [filtered, mesHojeMaceio]);
  const mesLabel = new Date(`${mesHojeMaceio}-01T12:00:00Z`)
    .toLocaleDateString('pt-BR', { month: 'short', timeZone: 'UTC' })
    .replace('.', '');

  // O que está NA TELA: na aba "Do mês" respeita o dia e a situação escolhidos no
  // resumo. Lista, CSV e contador usam a mesma coisa (antes o CSV exportava o mês todo).
  const visiveis = useMemo(() => {
    if (!isMes || (!diaSel && !statusSel)) return filtered;
    return filtered.filter(
      (c) => (!diaSel || diaDoVencimento(c) === diaSel) && (!statusSel || statusDoMes(c) === statusSel),
    );
  }, [filtered, isMes, diaSel, statusSel]);

  // Onda 18.x — BUGFIX: a rota chamada aqui (/payment-gateway/charges/:id/mark-cash-
  // received) NÃO existe → todo clique dava erro. Cada gateway tem a sua:
  //   ASAAS → POST /payment-gateway/charges/asaas/:external_id/receive-in-cash
  //           (dá baixa no Asaas + marca local + lança a RECEITA no caixa)
  //   CASH  → POST /charges/:id/mark-cash-received (cobrança local, sem Asaas)
  // A forma (espécie/PIX/cartão) é escolhida na hora — vai pro caixa e pro
  // comprovante; antes ia tudo como "dinheiro".
  const handleMarkCash = async (c: Charge) => {
    const METHODS = [
      { key: 'DINHEIRO', label: 'Espécie (dinheiro)' },
      { key: 'PIX', label: 'PIX da clínica' },
      { key: 'PIX_MAQUININHA', label: 'PIX na maquineta' },
      { key: 'CARTAO', label: 'Cartão (maquineta)' },
    ];
    const escolha = prompt(
      `Receber ${c.installment_label || 'cobrança'} de ${c.patient?.name || 'paciente'} (${fmtBRL(c.amount)}).\n\n` +
      `Como foi pago?\n${METHODS.map((m, i) => `${i + 1} - ${m.label}`).join('\n')}\n\n` +
      `Digite o número (1-${METHODS.length}) ou cancele.`,
      '1',
    );
    if (escolha === null) return;
    const idx = parseInt((escolha || '').trim(), 10) - 1;
    const method = METHODS[idx];
    if (!method) { showError('Opção inválida — informe um número de 1 a 4.'); return; }
    setMarkingCash(c.id);
    try {
      if (c.gateway === 'CASH') {
        await api.post(`/charges/${c.id}/mark-cash-received`);
      } else {
        if (!c.external_id) { showError('Cobrança sem ID do Asaas — não dá pra dar baixa por aqui.'); return; }
        await api.post(`/payment-gateway/charges/asaas/${c.external_id}/receive-in-cash`, { payment_method: method.key });
      }
      showSuccess(`Recebimento registrado (${method.label})`);
      fetchData({ silencioso: true });
      fetchKpis();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao marcar como pago');
    } finally {
      setMarkingCash(null);
    }
  };

  // Apagar boleto (ADMIN) — apaga no Asaas E no sistema, silenciosamente.
  // Onda 18.x — CSV da lista atual (respeita chip + filtros + busca). Separador ";"
  // e BOM: é o que o Excel em pt-BR abre com as colunas certas, sem importação.
  const exportarCsv = () => {
    const cols = ['Paciente', 'Telefone', 'CPF', 'Tipo', 'Valor', 'Vencimento', 'Status', 'Dias em atraso', 'Pago em', 'Forma', 'Dentista', 'Proposta', 'ID Asaas'];
    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const STATUS_TXT: Record<string, string> = { PAGO: 'Pago', EM_ABERTO: 'Em aberto', ATRASADO: 'Atrasado', CANCELADO: 'Cancelado' };
    const linhas = visiveis.map((c) => [
      c.patient?.name || 'Sem nome',
      c.patient?.phone || '',
      c.patient?.cpf || '',
      c.installment_label || KIND_LABEL[c.kind || ''] || '',
      // Vírgula decimal — o Excel pt-BR soma a coluna direto.
      c.amount.toFixed(2).replace('.', ','),
      fmtDue(c.due_date),
      STATUS_TXT[c.computed_status] || c.computed_status,
      c.computed_status === 'ATRASADO' ? c.days_overdue : '',
      c.paid_at ? fmtDate(c.paid_at) : '',
      c.received_in_cash ? 'Recebido na clínica' : c.billing_type,
      c.dentist?.name || '',
      c.quote_number ? `#${c.quote_number}` : '',
      c.external_id || '',
    ].map(esc).join(';'));
    const csv = '﻿' + [cols.join(';'), ...linhas].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = isMes ? `boletos-do-mes-${mes}${diaSel ? `-dia-${diaSel.slice(8, 10)}` : ''}${statusSel ? `-${statusSel}` : ''}.csv` : `boletos-${statusGroup}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showSuccess(`${visiveis.length} cobrança(s) exportada(s)`);
  };

  const handleDeleteBoleto = async (c: Charge) => {
    if (deletingId) return;
    if (c.status === 'RECEIVED' || c.status === 'CONFIRMED' || c.received_in_cash) {
      showError('Cobrança já paga — não pode ser cancelada.');
      return;
    }
    if (!c.external_id) { showError('Cobrança sem ID do Asaas — não dá pra cancelar por aqui.'); return; }
    // Onda 18.x — mesma régua da ficha do paciente: CANCELAR com rastro (a cobrança
    // fica no cadastro como "Cancelado" com quem/quando/motivo, prova até judicial).
    // Antes o texto dizia "apaga, não dá pra desfazer" e o motivo NÃO era enviado —
    // o rastro nascia sem justificativa.
    const reason = window.prompt(
      `CANCELAR a cobrança de ${c.patient?.name || 'paciente'} (${fmtBRL(c.amount)})?\n\n` +
      `Apaga o boleto NO ASAAS (o link/QR para de funcionar) e tira da inadimplência,\n` +
      `MAS ela FICA REGISTRADA no cadastro como "Cancelado", com quem/quando/motivo —\n` +
      `pra eventual revisão até judicial. O paciente NÃO é avisado.\n\n` +
      `Digite o MOTIVO do cancelamento:`,
      'Cobrança gerada por engano',
    );
    if (reason === null) return; // fechou/cancelou o prompt
    const motivo = reason.trim();
    if (!motivo) { showError('Informe o motivo do cancelamento (fica no rastro da cobrança).'); return; }
    setDeletingId(c.id);
    try {
      await api.delete(`/payment-gateway/charges/asaas/${c.external_id}?reason=${encodeURIComponent(motivo)}`);
      showSuccess('Cobrança cancelada — fica registrada no cadastro.');
      fetchData({ silencioso: true });
      fetchKpis();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao cancelar a cobrança.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCopyPix = async (pix: string) => {
    try {
      await navigator.clipboard.writeText(pix);
      showSuccess('PIX copia-e-cola copiado');
    } catch {
      showError('Não foi possível copiar');
    }
  };

  // Agrupa a visão "Todos" em Em Aberto / Vencidos / Pagos, cada grupo por data
  // (aberto e vencidos por vencimento; pagos pelo pagamento mais recente). Com um
  // chip específico selecionado o backend já filtrou → lista única, sem cabeçalho.
  type Group = {
    key: string; label: string; icon: any; color: string; rows: Charge[]; total: number;
    // Negativados (por paciente): cabeçalho recolhível + resumo.
    patient?: Charge['patient'];
    overdueCount?: number; overdueTotal?: number; openCount?: number;
    paidCount?: number; paidTotal?: number; cancelledCount?: number; openTotal?: number;
    // Pagos: divisória por DIA do pagamento.
    dateGroup?: boolean;
    // Do mês: divisória por DIA do vencimento (AAAA-MM-DD) + quanto já entrou dele.
    // `total`/`paidTotal`/`count` são do DIA INTEIRO (o filtro de situação só esconde
    // linhas — senão "recebido de" mentia: com "Recebido" ativo o dia parecia quitado).
    dueDay?: { iso: string; isToday: boolean; paidTotal: number; total: number; count: number };
  };
  const groups = useMemo<Group[]>(() => {
    // DO MÊS: uma divisória por DIA DE VENCIMENTO (1 → 31), respeitando o dia e a
    // situação escolhidos no resumo. Dentro do dia: atrasado, vence hoje, a vencer,
    // pago — e por nome.
    if (statusGroup === 'month' && !searching) {
      const ordem: Record<MesStatus, number> = { atrasado: 0, hoje: 1, aberto: 2, pago: 3 };
      const byDay = new Map<string, Group>();
      for (const c of filtered) {
        const k = diaDoVencimento(c);
        if (diaSel && k !== diaSel) continue;
        const st = statusDoMes(c);
        let g = byDay.get(k);
        if (!g) {
          const label = new Date(`${k}T12:00:00Z`)
            .toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' })
            .replace('.', '');
          g = {
            key: `v-${k}`, label, icon: CalendarDays, color: 'text-foreground', rows: [], total: 0,
            dueDay: { iso: k, isToday: k === mesHoje, paidTotal: 0, total: 0, count: 0 },
          };
          byDay.set(k, g);
        }
        g.dueDay!.total += c.amount;
        g.dueDay!.count += 1;
        if (st === 'pago') g.dueDay!.paidTotal += c.amount;
        if (statusSel && st !== statusSel) continue; // só esconde a linha
        g.rows.push(c);
        g.total += c.amount;
      }
      const nome = (c: Charge) => c.patient?.name || '';
      return [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([, g]) => g.rows.length > 0) // dia sem nenhuma linha da situação escolhida
        .map(([, g]) => ({
          ...g,
          rows: g.rows.sort((a, b) =>
            ordem[statusDoMes(a)] - ordem[statusDoMes(b)] || nome(a).localeCompare(nome(b), 'pt-BR', { sensitivity: 'base' })),
        }));
    }
    // Onda 18.x — POR PACIENTE (ordem alfabética, recolhido por padrão):
    //  • NEGATIVADOS: só quem tem ≥1 atrasado (back manda a carteira em aberto deles);
    //  • TODOS: todo paciente com boleto no sistema, com TUDO que negociou — pagos,
    //    em aberto, atrasados e cancelados/apagados (back manda a carteira inteira).
    // Sem paciente resolvido → "Sem nome" no fim.
    if ((statusGroup === 'negativados' || statusGroup === 'all') && !searching) {
      const onlyDebtors = statusGroup === 'negativados';
      const byPatient = new Map<string, Group>();
      for (const c of filtered) {
        const pid = c.patient?.id || '__sem_nome__';
        let g = byPatient.get(pid);
        if (!g) {
          g = {
            key: `p-${pid}`, label: c.patient?.name || 'Sem nome', icon: Users, color: onlyDebtors ? 'text-red-400' : 'text-foreground',
            rows: [], total: 0, patient: c.patient,
            overdueCount: 0, overdueTotal: 0, openCount: 0, paidCount: 0, paidTotal: 0, cancelledCount: 0, openTotal: 0,
          };
          byPatient.set(pid, g);
        }
        g.rows.push(c);
        g.total += c.amount;
        if (c.computed_status === 'ATRASADO') { g.overdueCount!++; g.overdueTotal! += c.amount; g.openTotal! += c.amount; }
        else if (c.computed_status === 'EM_ABERTO') { g.openCount!++; g.openTotal! += c.amount; }
        else if (c.computed_status === 'PAGO') { g.paidCount!++; g.paidTotal! += c.amount; }
        else if (c.computed_status === 'CANCELADO') g.cancelledCount!++;
      }
      const byDueAsc = (a: Charge, b: Charge) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      return [...byPatient.values()]
        // Negativados: só quem tem ≥1 atrasado (o back já garante; defesa se um filtro
        // secundário — tipo/forma — deixou o paciente só com boletos a vencer).
        .filter((g) => !onlyDebtors || (g.overdueCount || 0) > 0)
        .map((g) => ({ ...g, rows: g.rows.sort(byDueAsc) }))
        .sort((a, b) => {
          if (a.key === 'p-__sem_nome__') return 1;
          if (b.key === 'p-__sem_nome__') return -1;
          return a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' });
        });
    }
    // Onda 18.x — PAGOS: uma divisória por DIA do pagamento (mais recente primeiro),
    // com quantidade e total do dia. Dentro do dia, do pagamento mais recente ao mais
    // antigo. Sem data de pagamento → "Sem data" no fim.
    if (statusGroup === 'paid' && !searching) {
      const paidIso = (c: Charge) => c.paid_at || c.payment_date || null;
      const dayKey = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('sv-SE') : '');
      const byDay = new Map<string, Group>();
      for (const c of filtered) {
        const iso = paidIso(c);
        const k = dayKey(iso);
        let g = byDay.get(k);
        if (!g) {
          const label = iso
            ? new Date(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).replace('.', '')
            : 'Sem data de pagamento';
          g = { key: `d-${k || 'none'}`, label, icon: Check, color: 'text-emerald-400', rows: [], total: 0, dateGroup: true };
          byDay.set(k, g);
        }
        g.rows.push(c);
        g.total += c.amount;
      }
      const t = (c: Charge) => new Date(paidIso(c) || 0).getTime();
      return [...byDay.entries()]
        .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : b.localeCompare(a))) // dia mais recente primeiro
        .map(([, g]) => ({ ...g, rows: g.rows.sort((a, b) => t(b) - t(a)) }));
    }
    // Buscando um paciente → sempre a visão agrupada (mostra pago + aberto + atrasado
    // dele de uma vez), ignorando o chip de status que estiver ativo.
    if (statusGroup !== 'all' && !searching) {
      // Lista única do filtro ativo, com cabeçalho (nome + contagem + total) pra
      // deixar claro qual status está sendo mostrado.
      const active = STATUS_GROUPS.find((g) => g.key === statusGroup);
      return [{ key: 'flat', label: active?.label || '', icon: active?.icon || FileText, color: active?.color || 'text-foreground', rows: filtered, total: filtered.reduce((s, c) => s + c.amount, 0) }];
    }
    const byDueAsc = (a: Charge, b: Charge) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
    const paidTime = (c: Charge) => new Date(c.paid_at || c.payment_date || c.due_date).getTime();
    const emAberto = filtered.filter((c) => c.computed_status === 'EM_ABERTO').sort(byDueAsc);
    const vencidos = filtered.filter((c) => c.computed_status === 'ATRASADO').sort(byDueAsc);
    const pagos = filtered.filter((c) => c.computed_status === 'PAGO').sort((a, b) => paidTime(b) - paidTime(a));
    const sum = (rows: Charge[]) => rows.reduce((s, c) => s + c.amount, 0);
    return [
      { key: 'aberto', label: 'Em Aberto', icon: Clock, color: 'text-blue-400', rows: emAberto, total: sum(emAberto) },
      { key: 'vencidos', label: 'Vencidos', icon: AlertTriangle, color: 'text-red-400', rows: vencidos, total: sum(vencidos) },
      { key: 'pagos', label: 'Pagos', icon: Check, color: 'text-emerald-400', rows: pagos, total: sum(pagos) },
    ].filter((g) => g.rows.length > 0);
  }, [filtered, statusGroup, searching, diaSel, statusSel, mesHoje]);

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="bg-card border border-border rounded-xl p-3 space-y-3">
        {/* Status chips */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {STATUS_GROUPS.map((g) => {
            const Icon = g.icon;
            return (
              <button
                key={g.key}
                onClick={() => setStatusGroup(g.key)}
                title={searching ? 'Filtro de status ignorado durante a busca por paciente' : undefined}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                  searching ? 'opacity-40' : ''
                } ${
                  statusGroup === g.key && !searching
                    ? 'bg-primary text-primary-foreground'
                    : `bg-background border border-border ${g.color} hover:bg-accent/30`
                }`}
              >
                <Icon size={13} />
                {g.label}
              </button>
            );
          })}
        </div>

        {/* Filtros secundários */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border rounded-lg flex-1 min-w-[200px]">
            <Search size={13} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, telefone ou CPF..."
              className="flex-1 bg-transparent text-xs focus:outline-none"
            />
          </div>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="px-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none"
          >
            <option value="">Todos os tipos</option>
            <option value="SINAL">Sinal</option>
            <option value="ENTRADA">Entrada</option>
            <option value="INSTALLMENT">Parcela</option>
          </select>
          {/* "Do mês" já é só boleto — o filtro de forma não se aplica ali. */}
          {!isMes && (
          <select
            value={billingType}
            onChange={(e) => setBillingType(e.target.value)}
            className="px-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none"
          >
            <option value="">Toda forma</option>
            <option value="PIX">PIX</option>
            <option value="BOLETO">Boleto</option>
            <option value="CREDIT_CARD">Cartão</option>
          </select>
          )}
          {/* Onda 18.x — exporta o que está na tela (mesmos filtros) pra conferência
              offline / envio ao contador. Gera no navegador, sem passar pela API. */}
          {visiveis.length > 0 && (
            <button
              type="button"
              onClick={exportarCsv}
              title="Baixar a lista atual em CSV (abre no Excel)"
              className="px-3 py-1.5 text-xs font-semibold bg-background border border-border rounded-lg hover:bg-accent/40 inline-flex items-center gap-1.5"
            >
              <FileText size={13} /> CSV
            </button>
          )}
        </div>

        {/* Onda 18.x — contagem da listagem (os KPIs de valor vivem no dashboard abaixo). */}
        {(statusGroup !== 'report' || searching) && (
        <div className="flex items-center gap-2 pt-2 border-t border-border/50 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <span>{visiveis.length} de {total} cobrança(s) carregada(s)</span>
          {/* Onda 18.x — a agregação por paciente (Negativados/Todos) é feita sobre o
              que foi CARREGADO. Se a API cortou no teto, os totais por paciente ficam
              incompletos — avisa em vez de mostrar número errado em silêncio. */}
          {charges.length < total && (
            <span className="inline-flex items-center gap-1 normal-case text-amber-600 dark:text-amber-400">
              <AlertTriangle size={11} />
              {isMes
                ? `lista cortada no limite — o resumo do mês considera só ${charges.length} de ${total} cobranças; use o filtro de tipo`
                : `lista cortada no limite — os totais por paciente consideram só ${charges.length} de ${total}; use a busca pra ver um paciente específico`}
            </span>
          )}
          {!isMes && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">Este mês ({mesLabel})</span>
            {monthStats.count} cobrança(s) · {fmtBRL(monthStats.totalValue)}
          </span>
          )}
        </div>
        )}
      </div>

      {/* Onda 18.x — Dashboard de KPIs contextual ao chip (carteira inteira). */}
      {/* "Do mês" tem resumo próprio (mês, faixa recebido × falta, calendário). */}
      {isMes ? (
        <BoletosMesResumo
          mes={mes}
          hoje={mesHoje}
          charges={mesCarregado === mes ? charges : []}
          pronto={mesCarregado === mes}
          loading={loading}
          recebidoOutrosMeses={mesCarregado === mes ? mesOutros : null}
          guardaChuvas={mesCarregado === mes ? mesGuardaChuvas : []}
          diaSelecionado={diaSel}
          statusSelecionado={statusSel}
          onMes={trocarMes}
          onDia={escolherDia}
          onStatus={setStatusSel}
        />
      ) : (
        <BoletosKpis kpis={kpis} chip={searching ? "all" : statusGroup} loading={kpisLoading} />
      )}

      {/* Lista */}
      {statusGroup === 'report' && !searching ? null : loading ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Loader2 size={24} className="mx-auto animate-spin text-primary" />
        </div>
      ) : isMes && mesErro ? (
        <div className="bg-card border border-red-500/40 rounded-xl p-8 text-center space-y-3">
          <AlertTriangle size={28} className="mx-auto text-red-500" />
          <p className="text-sm text-foreground">
            Não foi possível carregar os boletos de {nomeDoMes(mes).toLowerCase()}.
          </p>
          <button
            type="button"
            onClick={() => fetchData()}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:opacity-90"
          >
            Tentar de novo
          </button>
        </div>
      ) : filtered.length === 0 || (isMes && groups.length === 0) ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <FileText size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            {statusGroup === 'negativados' && !searching
              ? 'Nenhum paciente negativado — carteira em dia 🎉'
              : isMes
                ? filtered.length === 0
                  ? `Nenhuma cobrança vence em ${nomeDoMes(mes).toLowerCase()}.`
                  : 'Nenhuma cobrança nesse dia/situação — limpe o filtro no resumo acima.'
                : 'Nenhuma cobrança encontrada nos filtros'}
          </p>
        </div>
      ) : (
        <div id="boletos-lista" className="bg-card border border-border rounded-xl overflow-hidden scroll-mt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Paciente</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Tipo</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Valor</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Vencimento</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Forma</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-center">Status</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-center">Ações</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const GIcon = g.icon;
                  const isPatientGroup = g.patient !== undefined;
                  const isOpen = !isPatientGroup || !!expanded[g.key];
                  return (
                  <Fragment key={g.key}>
                  {g.label && isPatientGroup ? (
                    // Negativados — linha do PACIENTE: clica pra expandir/recolher os boletos dele.
                    <tr
                      className="bg-muted/40 border-y border-border cursor-pointer hover:bg-accent/20 transition-colors"
                      onClick={() => toggleExpanded(g.key)}
                    >
                      <td colSpan={7} className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          {isOpen ? <ChevronDown size={14} className="text-muted-foreground shrink-0" /> : <ChevronRight size={14} className="text-muted-foreground shrink-0" />}
                          {g.patient ? (
                            <PatientAvatar patientId={g.patient.id} patientName={g.label} avatarUrl={g.patient.avatar_url} size={28} shape="circle" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-muted grid place-items-center"><Users size={13} className="text-muted-foreground" /></div>
                          )}
                          <div className="flex flex-col min-w-0">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); g.patient?.id && router.push(`/atendimento/pacientes/${g.patient.id}?tab=financial`); }}
                              className="text-sm font-bold text-foreground hover:text-primary text-left truncate"
                              title="Abrir a ficha financeira do paciente"
                            >
                              {g.label}
                            </button>
                            {g.patient?.phone && <span className="text-[10px] text-muted-foreground">{g.patient.phone}</span>}
                          </div>
                          {/* Badges por status — só os que existem pro paciente. */}
                          <span className="flex items-center gap-1 flex-wrap">
                            {(g.overdueCount || 0) > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/15 text-red-400 whitespace-nowrap">
                                {g.overdueCount} atrasado{(g.overdueCount || 0) > 1 ? 's' : ''} · {fmtBRL(g.overdueTotal || 0)}
                              </span>
                            )}
                            {(g.openCount || 0) > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-400 whitespace-nowrap">
                                {g.openCount} a vencer
                              </span>
                            )}
                            {(g.paidCount || 0) > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-500 whitespace-nowrap">
                                {g.paidCount} pago{(g.paidCount || 0) > 1 ? 's' : ''} · {fmtBRL(g.paidTotal || 0)}
                              </span>
                            )}
                            {(g.cancelledCount || 0) > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-muted text-muted-foreground whitespace-nowrap">
                                {g.cancelledCount} cancelado{(g.cancelledCount || 0) > 1 ? 's' : ''}
                              </span>
                            )}
                          </span>
                          <span className="ml-auto text-right whitespace-nowrap">
                            <span className="block text-[9px] uppercase tracking-wider text-muted-foreground">
                              {g.rows.length} boleto{g.rows.length > 1 ? 's' : ''} · {(g.openTotal || 0) > 0 ? 'em aberto' : 'nada em aberto'}
                            </span>
                            <span className={`text-[12px] font-bold tabular-nums ${(g.openTotal || 0) > 0 ? 'text-foreground' : 'text-emerald-500'}`}>
                              {(g.openTotal || 0) > 0 ? fmtBRL(g.openTotal || 0) : '✓ quitado'}
                            </span>
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : g.label && g.dueDay ? (
                    <>
                    {groups[0]?.key !== g.key && (
                      <tr aria-hidden className="bg-background">
                        <td colSpan={7} className="h-4 p-0 border-0" />
                      </tr>
                    )}
                    {/* Do mês — divisória por DIA DE VENCIMENTO: quanto vence e quanto já entrou. */}
                    <tr className={`border-y border-border ${g.dueDay.isToday ? 'bg-yellow-400/[0.14] border-t-2 border-t-yellow-400/70' : 'bg-muted/40'}`}>
                      <td colSpan={7} className="px-3 py-2">
                        {/* A tabela rola de lado no celular: o conteúdo fica preso à esquerda e
                            limitado à largura da tela, pra o "recebido de" não sumir à direita. */}
                        <div className="sticky left-3 flex items-center gap-x-2 gap-y-0.5 flex-wrap w-[min(100%,calc(100vw_-_5rem))]">
                          <CalendarDays size={13} className={g.dueDay.isToday ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground'} />
                          <span className="text-[11px] font-bold uppercase tracking-wide text-foreground">
                            {g.label}{g.dueDay.isToday && ' · hoje'}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {g.rows.length === g.dueDay.count
                              ? `(${g.dueDay.count} cobrança${g.dueDay.count > 1 ? 's' : ''})`
                              : `(mostrando ${g.rows.length} de ${g.dueDay.count})`}
                          </span>
                          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                            <span className="font-bold text-emerald-600 dark:text-emerald-400">{fmtBRL(g.dueDay.paidTotal)}</span>
                            {' recebido de '}
                            <span className="font-bold text-foreground">{fmtBRL(g.dueDay.total)}</span>
                          </span>
                        </div>
                      </td>
                    </tr>
                    </>
                  ) : g.label && g.dateGroup ? (
                    <>
                    {/* Respiro em branco entre um dia e o próximo (não antes do primeiro). */}
                    {groups[0]?.key !== g.key && (
                      <tr aria-hidden className="bg-background">
                        <td colSpan={7} className="h-7 p-0 border-0" />
                      </tr>
                    )}
                    {/* Pagos — divisória por DIA: faixa verde forte com data, quantidade e total do dia. */}
                    {/* Mesma proporção dos cabeçalhos das outras abas (11px, py-2) — só a
                        cor verde e a borda de cima marcam a troca de dia. */}
                    <tr className="bg-emerald-500/[0.07] border-t-2 border-t-emerald-500/40 border-b border-border">
                      <td colSpan={7} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Check size={13} className="text-emerald-500" strokeWidth={3} />
                          <span className="text-[11px] font-bold uppercase tracking-wide text-foreground">{g.label}</span>
                          <span className="text-[10px] text-muted-foreground">
                            ({g.rows.length} pagamento{g.rows.length > 1 ? 's' : ''})
                          </span>
                          <span className="ml-auto text-[11px] font-bold tabular-nums text-emerald-500">{fmtBRL(g.total)}</span>
                        </div>
                      </td>
                    </tr>
                    </>
                  ) : g.label ? (
                    <tr className="bg-muted/40 border-y border-border">
                      <td colSpan={7} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <GIcon size={13} className={g.color} />
                          <span className="text-[11px] font-bold uppercase tracking-wide text-foreground">{g.label}</span>
                          <span className="text-[10px] text-muted-foreground">({g.rows.length})</span>
                          <span className={`ml-auto text-[11px] font-bold tabular-nums ${g.color}`}>{fmtBRL(g.total)}</span>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {isOpen && g.rows.map((c) => {
                  const isOverdue = c.computed_status === 'ATRASADO';
                  const isPaid = c.computed_status === 'PAGO';
                  const isDueToday = !!c.due_today && c.computed_status === 'EM_ABERTO';
                  // Do mês: a LINHA inteira leva a cor da situação (faixa à esquerda + fundo).
                  const tom = isMes ? statusDoMes(c) : null;
                  const linhaTom =
                    tom === 'pago' ? 'bg-emerald-500/[0.06]'
                      : tom === 'hoje' ? 'bg-yellow-400/[0.12]'
                        : tom === 'atrasado' ? 'bg-red-500/[0.06]'
                          : '';
                  const faixaTom =
                    tom === 'pago' ? 'border-l-[3px] border-l-emerald-500'
                      : tom === 'hoje' ? 'border-l-[3px] border-l-yellow-400'
                        : tom === 'atrasado' ? 'border-l-[3px] border-l-red-500'
                          : tom === 'aberto' ? 'border-l-[3px] border-l-transparent'
                            : '';
                  const reminderMsg = `Olá ${c.patient?.name || ''}! Lembrando do pagamento de ${fmtBRL(c.amount)} (${c.installment_label}) com vencimento em ${fmtDue(c.due_date)}.${
                    c.boleto_url ? ` Boleto: ${c.boleto_url}` : ''
                  }`;
                  return (
                    <tr key={c.id} className={`border-b border-border/50 hover:bg-accent/10 transition-colors ${linhaTom}`}>
                      <td className={`px-3 py-2.5 ${faixaTom}`}>
                        <div className="flex items-center gap-2.5">
                          {c.patient && (
                            <PatientAvatar
                              patientId={c.patient.id}
                              patientName={c.patient.name || 'Sem nome'}
                              avatarUrl={c.patient.avatar_url}
                              size={28}
                              shape="circle"
                            />
                          )}
                          <div className="flex flex-col min-w-0">
                            <button
                              onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                              className="text-sm font-semibold text-foreground hover:text-primary text-left truncate"
                            >
                              {c.patient?.name || 'Sem nome'}
                            </button>
                            {c.dentist?.name && (
                              <span className="text-[10px] text-muted-foreground">{c.dentist.name}</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-xs text-foreground">
                          {c.installment_label || KIND_LABEL[c.kind || ''] || '—'}
                        </span>
                        {c.quote_number && (
                          <span className="text-[10px] text-muted-foreground ml-1.5">#{c.quote_number}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className={`text-sm font-bold tabular-nums ${isPaid ? 'text-emerald-400' : isOverdue ? 'text-red-400' : isDueToday ? MES_COR.hoje.text : 'text-foreground'}`}>
                          {fmtBRL(c.amount)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col">
                          <span className="text-xs text-foreground tabular-nums">{fmtDue(c.due_date)}</span>
                          {isOverdue && (
                            <span className="text-[10px] text-red-400 font-semibold">{c.days_overdue}d em atraso</span>
                          )}
                          {isPaid && c.paid_at && (
                            <span className="text-[10px] text-emerald-400">Pago em {fmtDate(c.paid_at)}</span>
                          )}
                          {c.received_in_cash && (
                            <span className="text-[10px] text-emerald-400 font-semibold">Espécie</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-[10px] text-muted-foreground">{c.billing_type}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {computedStatusBadge(c.computed_status, { dueToday: isDueToday, mes: isMes })}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-center gap-1">
                          {c.boleto_url && (
                            <a
                              href={c.boleto_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded-lg hover:bg-accent/30 text-muted-foreground hover:text-primary transition-colors"
                              title="Abrir boleto"
                            >
                              <ExternalLink size={13} />
                            </a>
                          )}
                          {c.pix_copy_paste && (
                            <button
                              onClick={() => handleCopyPix(c.pix_copy_paste!)}
                              className="p-1.5 rounded-lg hover:bg-accent/30 text-muted-foreground hover:text-primary transition-colors"
                              title="Copiar PIX copia-e-cola"
                            >
                              <Copy size={13} />
                            </button>
                          )}
                          {!isPaid && c.patient?.phone && (
                            <a
                              href={waLink(c.patient.phone, reminderMsg) || '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded-lg hover:bg-emerald-500/15 text-emerald-400 transition-colors"
                              title="Lembrete via WhatsApp"
                            >
                              <MessageCircle size={13} />
                            </a>
                          )}
                          {/* Vale pros dois gateways: ASAAS dá baixa no Asaas + caixa; CASH marca local. */}
                          {!isPaid && c.computed_status !== 'CANCELADO' && (
                            <button
                              onClick={() => handleMarkCash(c)}
                              disabled={markingCash === c.id}
                              className="p-1.5 rounded-lg hover:bg-emerald-500/15 text-emerald-400 transition-colors disabled:opacity-50"
                              title="Registrar recebimento na clínica (espécie, PIX ou cartão)"
                            >
                              {markingCash === c.id ? <Loader2 size={13} className="animate-spin" /> : <DollarSign size={13} />}
                            </button>
                          )}
                          {/* Apagar — SOMENTE ADMIN, só enquanto NÃO paga. Apaga no Asaas + sistema. */}
                          {role.isAdmin && !isPaid && c.external_id && (
                            <button
                              onClick={() => handleDeleteBoleto(c)}
                              disabled={deletingId === c.id}
                              className="p-1.5 rounded-lg hover:bg-red-500/15 text-red-500 transition-colors disabled:opacity-50"
                              title="Cancelar a cobrança (fica registrada como Cancelado, com motivo) — admin"
                            >
                              {deletingId === c.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                  })}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
