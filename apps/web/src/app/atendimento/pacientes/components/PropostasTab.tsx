'use client';

/**
 * PropostasTab — Onda 8.
 *
 * Comparacao lado-a-lado dos orcamentos do paciente agrupados por priority
 * (COMPLETO / ESSENCIAL / URGENTE). Inspirado no "Modo negociação" de
 * referencia. Operador apresenta as 3 alternativas pro paciente comparar:
 *  - Completo: plano ideal, todos os procedimentos sugeridos
 *  - Essencial: plano mais enxuto, so o que nao pode esperar
 *  - Urgente: foco no problema imediato
 *
 * Click no card abre o orcamento na aba Orcamentos em modo detalhe (reusa
 * fluxo existente — sem botoes de aprovacao aqui, ficam onde sempre foram).
 *
 * Sem schema novo, sem endpoint novo — usa GET /patients/:id/quotes que ja
 * existe. Filtra DRAFT/SENT (aceitos/rejeitados ja foram decididos).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Loader2, DollarSign, ChevronRight, Layers, AlertTriangle, Check, Flame,
  Plus, X, Clock, MessageSquare, Pencil, Send, ChevronDown, ChevronUp, ArrowLeft,
  Building2, ShieldCheck, XCircle, Search, Trash2, Gift, FileText, Eye,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
// Onda 14.18 — identificador unificado entre as 4 abas
import { getQuoteDisplayName, getQuoteNumberBadge } from '@/lib/quote-display';
// Onda 14.24 — timeline "Proximos passos" no painel da proposta aceita.
// Onda 14.24.1 — Painel desativado (operador pediu pra remover). Componente
// + backend continuam no repo. Pra reativar: descomentar este import + bloco
// no JSX (busque "Onda 14.24 — Painel" abaixo).
// import ProximosPassosTimeline from './ProximosPassosTimeline';

interface Props {
  patientId: string;
  /**
   * Abre o orcamento no detalhe da aba Orcamentos. Parent (PacienteFichaInner)
   * cuida da navegacao (router + setTab).
   */
  onOpenQuoteDetail?: (quoteId: string) => void;
  /**
   * Onda 14.23 — vai pra aba Avaliacao pra criar um orcamento. Usado pelo
   * dialog "Nova proposta" no empty state (quando paciente nao tem nenhum
   * orcamento ainda) e no atalho "Criar novo orcamento".
   */
  onGoToEvaluation?: () => void;
}

interface QuoteListItem {
  id: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  title: string | null;
  /** Onda 14.18 — numero sequencial global por tenant. Identificador unificado
   *  entre as 4 abas. Auto-incrementado no backend. */
  quote_number?: number;
  /** Onda 14.21 — false esconde da aba Propostas (mantem nas demais abas). */
  visible_in_proposals?: boolean;
  /** Onda 14.33 — marca a proposta "escolhida pra apresentar ao paciente".
   *  So uma por paciente por vez. Card destacado, demais esmaecidos. */
  is_chosen_proposal?: boolean;
  total_value: string | number;
  created_at: string;
  valid_until?: string | null;
  priority?: 'COMPLETO' | 'ESSENCIAL' | 'URGENTE' | null;
  _count?: { items: number };
  /** Onda 9 — soma duration_minutes × qty de cada item (vem do backend) */
  total_duration_minutes?: number;
  /** Onda 11 — contagem de contrapropostas registradas em notes */
  counter_proposals_count?: number;
  /** Onda 11.1 — aprovacao parcial: contadores e valores monetarios */
  approved_count?: number;
  pending_count?: number;
  approved_value?: number;
  pending_value?: number;
}

interface QuoteItemDetail {
  id: string;
  total_price: string | number;
  notes: string | null;
  /** Onda 11.1 — item aprovado em-place (status do item, nao do quote) */
  approved_at?: string | null;
  procedure: { name: string };
}

interface QuoteDetailLite {
  id: string;
  title: string | null;
  /** Onda 14.18 — numero sequencial global por tenant (igual ao do QuoteListItem). */
  quote_number?: number;
  status: QuoteListItem['status'];
  total_value: string | number;
  valid_until: string | null;
  notes: string | null;
  items: QuoteItemDetail[];
  /** Onda 14.26 — toggle "exigir credit-check" desta venda. Default true. */
  requires_credit_check?: boolean;
  /** Onda 14.33 — proposta escolhida pra aguardar decisao do paciente */
  is_chosen_proposal?: boolean;
  /** Onda 14.38 — forma de pagamento + entrada apresentada quando marcada como proposta */
  chosen_payment_key?: string | null;
  chosen_down_payment?: string | number | null;
  /** Onda 15 (etapa 16.8) — plano de cobranca da entrada congelado quando
   *  operador clica em "Salvar proposta". Restaurado ao reabrir o painel. */
  chosen_signal_value?: string | number | null;
  chosen_signal_method?: 'PIX' | 'BOLETO' | 'CASH' | string | null;
  chosen_entrada_due_date?: string | null;
  chosen_installments_start_date?: string | null;
}

/** Onda 10 — parseia linhas [CONTRAPROPOSTA YYYY-MM-DD HH:mm] do campo notes */
interface CounterProposalEntry {
  timestamp: string;
  body: string; // texto apos o timestamp (ex: "Essencial em PIX à vista = R$ 15.675,00 — paciente vai pensar")
}

/** Onda 12 — payload + resposta do credit-check */
interface CreditCheckRequest {
  cpf: string;
  nome: string;
  data_nascimento: string;
  renda_mensal: number;
  telefone: string;
  profissao: string;
  parcela_alvo: number;
  parcelas: number;
  valor_total: number;
}

interface CreditCheckResult {
  status: 'approved' | 'pending' | 'denied';
  decision_id: string;
  ratio: number;
  message: string;
  motivo?: string;
  suggestion?: string;
  conditions?: {
    max_parcelas: number;
    parcela_aprovada: number;
    total_aprovado: number;
    juros_mes: number;
    entrada_pct: number;
  };
  /** Onda 12.1 — fonte da decisao: internal (mock), asaas_history (cliente
   *  recorrente da clinica) ou serasa (quando integrar). */
  source?: 'internal' | 'asaas_history' | 'serasa';
  /** Onda 12.1 — sumario do historico Asaas quando o paciente e cliente recorrente */
  asaas_summary?: {
    is_recurring: boolean;
    on_time_rate?: number;
    charges_count?: number;
  };
  checked_at: string;
}

function parseCounterProposals(notes: string | null): CounterProposalEntry[] {
  if (!notes) return [];
  const re = /^\[CONTRAPROPOSTA (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.+)$/;
  return notes
    .split('\n')
    .map((line) => {
      const m = line.match(re);
      return m ? { timestamp: m[1], body: m[2].trim() } : null;
    })
    .filter((e): e is CounterProposalEntry => e !== null)
    .reverse(); // mais recente primeiro
}

/** Onda 13 — tipos de bônus de fechamento */
type BonusType =
  | 'CORTESIA'
  | 'DESCONTO_EXTRA'
  | 'GARANTIA_ESTENDIDA'
  | 'PROCEDIMENTO_ADICIONAL'
  | 'CARENCIA'
  | 'PERSONALIZADO';

interface BonusTemplate {
  type: BonusType;
  icon: React.ReactNode;
  label: string;
  description: string;
  placeholder: string;
  /** se true, mostra input de % adicional */
  hasDiscountInput?: boolean;
}

const BONUS_TEMPLATES: BonusTemplate[] = [
  {
    type: 'CORTESIA',
    icon: <Gift size={16} />,
    label: 'Cortesia clínica',
    description: 'limpeza, clareamento, kit higiene oral...',
    placeholder: 'Ex: Limpeza profissional + clareamento de bandeja inclusos',
  },
  {
    type: 'DESCONTO_EXTRA',
    icon: <DollarSign size={16} />,
    label: 'Desconto extra',
    description: 'aplica % adicional no orçamento (recalcula total)',
    placeholder: 'Ex: 3% extra se fechar até sexta',
    hasDiscountInput: true,
  },
  {
    type: 'GARANTIA_ESTENDIDA',
    icon: <ShieldCheck size={16} />,
    label: 'Garantia estendida',
    description: '12 meses em vez de 6, manutenção inclusa...',
    placeholder: 'Ex: Garantia estendida pra 12 meses + 1 manutenção anual',
  },
  {
    type: 'PROCEDIMENTO_ADICIONAL',
    icon: <Plus size={16} />,
    label: 'Procedimento adicional',
    description: 'panorâmica, moldagem digital, consultas extras...',
    placeholder: 'Ex: Radiografia panorâmica + moldagem digital inclusas',
  },
  {
    type: 'CARENCIA',
    icon: <Clock size={16} />,
    label: 'Carência na entrada',
    description: '30 dias pra pagar a 1ª parcela / entrada parcelada',
    placeholder: 'Ex: 30 dias de carência pra primeira parcela',
  },
  {
    type: 'PERSONALIZADO',
    icon: <Pencil size={16} />,
    label: 'Personalizado',
    description: 'texto livre — escreva o bônus do jeito que quiser',
    placeholder: 'Descreva o bônus oferecido ao paciente...',
  },
];

interface BonusEntry {
  timestamp: string;
  type: BonusType;
  validUntil: Date;
  delta?: number;
  body: string;
  /** Onda 13 — true quando valid_until < agora */
  expired: boolean;
  /** Onda 13 — true quando faltar < 24h pra expirar */
  expiringSoon: boolean;
}

/** Onda 13 — parser de linhas [BONUS ts type=X valido_ate=Y delta=Z] body */
function parseBonuses(notes: string | null): BonusEntry[] {
  if (!notes) return [];
  const re =
    /^\[BONUS (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) type=(\w+) valido_ate=([^\s\]]+)(?:\s+delta=([\d.]+))?\]\s*(.+)$/;
  const now = new Date();
  return notes
    .split('\n')
    .map((line) => {
      const m = line.match(re);
      if (!m) return null;
      const validUntil = new Date(m[3]);
      const msUntilExpiry = validUntil.getTime() - now.getTime();
      return {
        timestamp: m[1],
        type: m[2] as BonusType,
        validUntil,
        delta: m[4] ? Number(m[4]) : undefined,
        body: m[5].trim(),
        expired: msUntilExpiry < 0,
        expiringSoon: msUntilExpiry > 0 && msUntilExpiry < 24 * 60 * 60 * 1000,
      } as BonusEntry;
    })
    .filter((e): e is BonusEntry => e !== null)
    .reverse(); // mais recente primeiro
}

type Priority = 'COMPLETO' | 'ESSENCIAL' | 'URGENTE';

// Onda 9 — ordem na referencia: "do mais apertado pro mais completo"
const PRIORITY_ORDER: Priority[] = ['URGENTE', 'ESSENCIAL', 'COMPLETO'];

/**
 * Onda 14.19 — Variantes visuais do card de proposta. Alem das 3 priorities
 * canonicas (URGENTE/ESSENCIAL/COMPLETO) o sistema agora suporta versoes
 * "LIVRE" — propostas extras sem priority pre-definida que aparecem em
 * scroll lateral. Permite operador criar quantas variacoes quiser sem
 * brigar pelo mesmo slot. q.priority no banco continua sendo Priority |
 * null; "LIVRE" e SO um conceito de UI pra quotes com priority=null.
 */
type CardVariant = Priority | 'LIVRE';
const CARD_VARIANTS: readonly CardVariant[] = ['URGENTE', 'ESSENCIAL', 'COMPLETO', 'LIVRE'] as const;

/** Onda 9 — formata minutos como "−Xh cadeira" ou "Xmin cadeira" */
function formatCadeira(totalMinutes: number | undefined): string | null {
  if (!totalMinutes || totalMinutes <= 0) return null;
  if (totalMinutes < 60) return `${totalMinutes}min cadeira`;
  const h = Math.round((totalMinutes / 60) * 10) / 10; // 1 casa
  // arredonda pra inteiro se for .0
  const display = h % 1 === 0 ? `${Math.floor(h)}h` : `${h.toString().replace('.', ',')}h`;
  return `${display} cadeira`;
}

/** Onda 9 — opcoes de pagamento renderizadas no painel inline.
 *  Onda 11.2 — adicionado interestRate (% a.m.) pra suportar boleto parcelado.
 *  Onda 11.3 — adicionado downPaymentPercent (entrada que abate as parcelas).
 *  Onda 11.4 — adicionado variant 'cartao' (1x-12x sem juros). */
interface PaymentOption {
  key: string;
  label: string;
  sublabel: string;
  discountPercent: number; // 0 = sem desconto
  installments: number;
  variant: 'avista' | 'cartao' | 'parcelado';
  /** Onda 11.2 — % de juros ao mes (default 0 = sem juros, Tabela Price quando > 0) */
  interestRate?: number;
  /** Onda 11.3 — % de entrada (default 0). Reduz valor financiado antes de
   *  aplicar Price → parcelas menores. Entrada paga a vista no fechamento. */
  downPaymentPercent?: number;
  /** Onda 14.25 — flag visual: opcao destacada em verde, separada do resto.
   *  Usada pelo "Boleto a vista" (10% desconto, sem juros, sem consulta). */
  isAVistaHighlight?: boolean;
}

function buildPaymentOptions(): {
  avista: PaymentOption[];
  cartao: PaymentOption[];
  parcelado: PaymentOption[];
} {
  // Onda 11.4 — gera 12 opcoes de cartao (1x ate 12x).
  // Onda 11.7 — 1x..6x sem juros / 7x..12x com juros padrao PagBank 3,59% a.m.
  const PAGBANK_INTEREST_RATE = 3.59; // % ao mes (taxa padrao PagBank para 7x-12x)
  const cartao: PaymentOption[] = Array.from({ length: 12 }, (_, idx) => {
    const n = idx + 1;
    return {
      key: `cartao-${n}x`,
      label: `${n}x`,
      sublabel: '',
      discountPercent: 0,
      installments: n,
      variant: 'cartao',
      interestRate: n <= 6 ? 0 : PAGBANK_INTEREST_RATE,
    };
  });

  return {
    avista: [
      {
        key: 'pix',
        label: 'PIX ou dinheiro',
        sublabel: 'à vista',
        discountPercent: 10,
        installments: 1,
        variant: 'avista',
      },
    ],
    // Onda 11.4 — Cartao de credito 1x ate 12x sem juros
    cartao,
    // Onda 14.4 — Boleto/Financiamento Banco PASSOS.
    // Onda 14.25 — reestruturado:
    //   - boleto-avista (PRIMEIRA, destacada em verde): 10% desconto, sem
    //     juros, sem consulta de credito. Pagamento imediato no boleto.
    //   - 1x: pagamento em 30 dias COM juros 1.5%/mes (exige consulta)
    //   - 2x..24x: parcelado com juros 1.5%/mes, entrada 20% a partir de 12x
    //     (todas exigem consulta de credito).
    parcelado: [
      // Opcao destacada — separada visualmente do resto na UI
      {
        key: 'boleto-avista',
        label: 'À vista',
        sublabel: 'boleto à vista',
        discountPercent: 10,
        installments: 1,
        variant: 'parcelado' as const,
        interestRate: 0,
        downPaymentPercent: 0,
        isAVistaHighlight: true,
      },
      // 1x..24x com juros (parcela 1 = 30 dias). Entrada 20% a partir de 12x.
      ...Array.from({ length: 24 }, (_, idx) => {
        const n = idx + 1;
        const hasDownPayment = n >= 12;
        return {
          key: `parcelado-${n}x`,
          label: `${n}x`,
          sublabel: n === 1 ? '30 dias' : '',
          discountPercent: 0,
          installments: n,
          variant: 'parcelado' as const,
          interestRate: 1.5,
          downPaymentPercent: hasDownPayment ? 20 : 0,
        };
      }),
    ],
  };
}

/** Calcula valor final dado opcao + total base.
 *  Onda 11.2 — usa Tabela Price quando interestRate > 0: PMT = PV × i / (1 − (1+i)^(−n))
 *  Onda 11.3 — quando downPaymentPercent > 0:
 *    1. Entrada (downPayment) = total × downPaymentPercent / 100 (paga a vista)
 *    2. Valor financiado = total − entrada
 *    3. Aplica Price sobre o valor financiado
 *    4. Total final = entrada + (parcelas × n)
 *  Onda 14.29 — customDownPayment (R$) SOBRESCREVE o downPaymentPercent
 *    da opcao. Operador digita valor manual (ex: R$ 5.000) e isso vira a
 *    entrada efetiva pra TODAS as opcoes parceladas (cartao + boleto).
 *    Opcoes a vista (variant=avista E key=boleto-avista) ignoram entrada
 *    custom — sao pagamentos imediatos, nao fazem sentido com entrada.
 */
function applyPaymentOption(
  total: number,
  opt: PaymentOption,
  customDownPayment?: number,
): {
  /** total final pago (descontos aplicados ou juros somados) */
  finalValue: number;
  /** valor de cada parcela mensal (ou finalValue/installments se 1x) */
  installmentValue: number;
  /** desconto aplicado (so a vista) */
  savedValue: number;
  /** juros pagos a mais (so parcelado com juros) */
  extraInterest: number;
  /** Onda 11.3 — valor da entrada (so parcelado com entrada) */
  downPaymentValue: number;
  /** Onda 11.3 — valor que sera financiado (total - entrada) */
  financedAmount: number;
} {
  // Onda 14.29 — opcoes a vista (PIX e Boleto a vista) ignoram entrada custom
  const isAvistaTotal = opt.variant === 'avista' || opt.key === 'boleto-avista';
  // Entrada efetiva: custom (se > 0 e nao for avista) sobrescreve o default
  // do opt.downPaymentPercent. Sempre limitada a total - 1 centavo pra nao
  // gerar parcelas em valor 0.
  const customClamped = (customDownPayment ?? 0) > 0
    ? Math.min(Math.max(0, customDownPayment as number), total - 0.01)
    : 0;

  if (opt.interestRate && opt.interestRate > 0) {
    const downPaymentValue = isAvistaTotal
      ? 0
      : customClamped > 0
      ? customClamped
      : (opt.downPaymentPercent ?? 0) > 0
      ? total * ((opt.downPaymentPercent ?? 0) / 100)
      : 0;
    const financedAmount = total - downPaymentValue;
    const i = opt.interestRate / 100;
    const n = opt.installments;
    const pmt = financedAmount * i / (1 - Math.pow(1 + i, -n));
    const totalInstallments = pmt * n;
    const finalValue = downPaymentValue + totalInstallments;
    return {
      finalValue,
      installmentValue: pmt,
      savedValue: 0,
      extraInterest: finalValue - total,
      downPaymentValue,
      financedAmount,
    };
  }
  // Onda 14.29 — opcao sem juros mas com entrada custom (ex: cartao 6x sem
  // juros + entrada 5k): entrada abate do total, parcelas dividem o resto.
  // Aplicada so se nao for avista (PIX/Boleto a vista preservam comportamento).
  if (!isAvistaTotal && customClamped > 0) {
    const downPaymentValue = customClamped;
    const financedAmount = total - downPaymentValue;
    return {
      finalValue: total,
      installmentValue: financedAmount / opt.installments,
      savedValue: 0,
      extraInterest: 0,
      downPaymentValue,
      financedAmount,
    };
  }
  const savedValue = total * (opt.discountPercent / 100);
  const finalValue = total - savedValue;
  return {
    finalValue,
    installmentValue: finalValue / opt.installments,
    savedValue,
    extraInterest: 0,
    downPaymentValue: 0,
    financedAmount: finalValue,
  };
}

function fmtBRL(n: number): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Onda 15 (etapa 10) — Renderiza o modal direto no <body> via portal.
 *
 * Necessario porque no FX "neon" (glass) o CSS aplica `backdrop-filter` em
 * `.bg-card` (globals.css). backdrop-filter cria um "containing block" pra
 * elementos `position: fixed`. Como os modais de parcelas sao renderizados
 * DENTRO do painel `.bg-card` da proposta, sem o portal eles ancoravam no
 * painel (apareciam "em baixo") em vez de centralizar na viewport. O portal
 * joga o modal pro body, escapando do containing block.
 */
function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

/**
 * Onda 15 (etapa 14) — Modal "profissional" pra exibir o QR PIX da clinica
 * em vez da pagina hospedada do Asaas (que tem Open Finance, branding Asaas,
 * etc.). Usado no emit do sinal/entrada quando a forma e PIX.
 *
 * - QR code grande, copia-cola com botao "Copiar"
 * - Mantem um botao discreto "Abrir pagina de pagamento" como fallback
 *   pra quando o operador quer enviar o link pro paciente (WhatsApp)
 * - Portado pro body (escapa do containing-block do .bg-card neon)
 */
function PixQrDialog({
  qrCode,
  copyPaste,
  amount,
  invoiceUrl,
  title,
  subtitle,
  onClose,
}: {
  qrCode: string;
  copyPaste: string;
  amount: number;
  invoiceUrl?: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          className="bg-card border border-border rounded-xl shadow-2xl max-w-md w-full overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-5 border-b border-border bg-emerald-500/10 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-bold text-emerald-800">{title}</h3>
              {subtitle && <p className="text-xs text-emerald-700 mt-1">{subtitle}</p>}
              <p className="text-2xl font-extrabold tabular-nums text-emerald-700 mt-2">R$ {fmtBRL(amount)}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1.5 -mr-1 hover:bg-accent/50 rounded-md transition-colors shrink-0"
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          </div>

          <div className="p-5 space-y-4">
            <div className="bg-muted/20 border border-border rounded-lg p-4 text-center">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-bold mb-2">
                Escaneie o QR Code
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/png;base64,${qrCode}`}
                alt="QR Code PIX"
                className="w-56 h-56 mx-auto rounded-md"
              />
            </div>

            {copyPaste && (
              <div className="space-y-1.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-bold">
                  Ou copie o código PIX
                </p>
                <div className="flex items-start gap-2">
                  <code className="flex-1 text-[10px] font-mono break-all bg-muted/20 border border-border rounded-md p-2 max-h-20 overflow-y-auto">
                    {copyPaste}
                  </code>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(copyPaste);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      } catch {
                        showError('Falha ao copiar — copie manualmente');
                      }
                    }}
                    className="px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shrink-0 transition-colors"
                  >
                    {copied ? '✓ Copiado' : 'Copiar'}
                  </button>
                </div>
              </div>
            )}

            {invoiceUrl && (
              <button
                type="button"
                onClick={() => window.open(invoiceUrl, '_blank', 'noopener,noreferrer')}
                className="w-full text-xs px-3 py-2 rounded-md border border-border hover:bg-accent/50 text-muted-foreground transition-colors"
                title="Abre a página hospedada do Asaas — útil pra copiar o link e mandar pro paciente via WhatsApp"
              >
                🔗 Abrir página de pagamento (pra enviar ao paciente)
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

interface VariantConfig {
  label: string;
  description: string;
  icon: React.ReactNode;
  borderCls: string;
  bgCls: string;
  iconCls: string;
  selectedBorderCls: string;
  selectedBgCls: string;
}

const PRIORITY_CONFIG: Record<Priority, VariantConfig> = {
  URGENTE: {
    label: 'Urgente',
    description: 'só o que dói ou bloqueia o resto',
    icon: <Flame size={14} />,
    borderCls: 'border-red-500/30 hover:border-red-500/60',
    bgCls: 'bg-red-500/5',
    iconCls: 'text-red-700',
    // Onda 14.36 — Removido ring-2 dos selected pra evitar desproporcao
    // visual entre cards. Antes o card selected ficava com halo externo
    // (ring) que dava sensacao de ser "maior" que os outros. Agora todos
    // usam mesmo sistema: border-2 + bg-color. Destaque vem de bg + cor
    // de borda mais opaca.
    selectedBorderCls: 'border-red-500',
    selectedBgCls: 'bg-red-500/10',
  },
  ESSENCIAL: {
    label: 'Essencial',
    description: 'só o que não pode esperar — sem estética opcional',
    icon: <AlertTriangle size={14} />,
    borderCls: 'border-amber-500/30 hover:border-amber-500/60',
    bgCls: 'bg-amber-500/5',
    iconCls: 'text-amber-700',
    selectedBorderCls: 'border-amber-500',
    selectedBgCls: 'bg-amber-500/10',
  },
  COMPLETO: {
    label: 'Completo',
    description: 'plano ideal — todos os procedimentos sugeridos',
    icon: <Check size={14} />,
    borderCls: 'border-emerald-500/30 hover:border-emerald-500/60',
    bgCls: 'bg-emerald-500/5',
    iconCls: 'text-emerald-700',
    selectedBorderCls: 'border-emerald-500',
    selectedBgCls: 'bg-emerald-500/10',
  },
};

/**
 * Onda 14.19 — Config visual pro card variante "LIVRE" (proposta extra sem
 * priority canonica). Usa paleta neutra/azul pra diferenciar dos 3 slots
 * fixos sem competir visualmente.
 */
const LIVRE_CONFIG: VariantConfig = {
  label: 'Versão livre',
  description: 'variação extra sem prioridade fixa',
  icon: <Layers size={14} />,
  borderCls: 'border-sky-500/30 hover:border-sky-500/60',
  bgCls: 'bg-sky-500/5',
  iconCls: 'text-sky-700',
  // Onda 14.36 — sem ring (vide comentario em PRIORITY_CONFIG)
  selectedBorderCls: 'border-sky-500',
  selectedBgCls: 'bg-sky-500/10',
};

/** Resolve config pra qualquer CardVariant. */
function getVariantConfig(variant: CardVariant): VariantConfig {
  return variant === 'LIVRE' ? LIVRE_CONFIG : PRIORITY_CONFIG[variant];
}

export default function PropostasTab({ patientId, onOpenQuoteDetail, onGoToEvaluation }: Props) {
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Onda 8.1 — picker pra atribuir orcamento a slot vazio (Completo/Essencial/Urgente).
  const [pickerFor, setPickerFor] = useState<Priority | null>(null);
  const [assigning, setAssigning] = useState(false);
  // Onda 9 — seleção atual (qual versão tô oferecendo agora). Persiste por
  // paciente via sessionStorage pra sobreviver navegacao entre abas.
  const selectionKey = `propostas-selected-${patientId}`;
  const paymentKeyStorage = `propostas-payment-${patientId}`;
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.sessionStorage.getItem(selectionKey); } catch { return null; }
  });
  // Detalhe do quote selecionado (items + preços), carregado sob demanda.
  const [selectedDetail, setSelectedDetail] = useState<QuoteDetailLite | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Onda 11 — forma de pagamento persistida por paciente (sobrevive reload/aba)
  const [activePaymentKey, setActivePaymentKey] = useState<string>(() => {
    if (typeof window === 'undefined') return 'pix';
    try { return window.sessionStorage.getItem(paymentKeyStorage) || 'pix'; } catch { return 'pix'; }
  });
  // Expandir lista completa de items (padrao mostra top-4)
  const [itemsExpanded, setItemsExpanded] = useState(false);
  // Dialog "+ nova versao"
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [creatingVersion, setCreatingVersion] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<QuoteListItem[]>(`/patients/${patientId}/quotes`);
      setQuotes(data);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao carregar propostas');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  // Persiste a seleção
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (selectedId) window.sessionStorage.setItem(selectionKey, selectedId);
      else window.sessionStorage.removeItem(selectionKey);
    } catch { /* ignora */ }
  }, [selectedId, selectionKey]);

  // Onda 11 — persiste forma de pagamento
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.sessionStorage.setItem(paymentKeyStorage, activePaymentKey); }
    catch { /* ignora */ }
  }, [activePaymentKey, paymentKeyStorage]);

  // Carrega detalhe quando muda a seleção (ou quote da lista atualiza)
  useEffect(() => {
    if (!selectedId) { setSelectedDetail(null); return; }
    let cancelled = false;
    setLoadingDetail(true);
    setItemsExpanded(false);
    api.get<QuoteDetailLite>(`/quotes/${selectedId}`)
      .then(({ data }) => { if (!cancelled) setSelectedDetail(data); })
      .catch((err) => {
        if (cancelled) return;
        const e = err as { response?: { data?: { message?: string } } };
        showError(e?.response?.data?.message || 'Erro ao carregar detalhe');
        // Quote pode ter sido deletado — limpa seleção
        setSelectedId(null);
      })
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Onda 8.1 — atribui priority a um quote existente.
  const assignPriority = useCallback(async (quoteId: string, priority: Priority) => {
    setAssigning(true);
    try {
      await api.patch(`/quotes/${quoteId}`, { priority });
      showSuccess(`Orçamento marcado como ${PRIORITY_CONFIG[priority].label}`);
      setPickerFor(null);
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao atribuir prioridade');
    } finally {
      setAssigning(false);
    }
  }, [load]);

  // Onda 12.5 — Remove o quote do slot (limpa priority, NAO exclui o quote).
  // Orcamento continua existente na aba Orcamentos e volta pra "Sem prioridade
  // definida" aqui — pode ser re-atribuido pelo picker depois.
  const removeFromSlot = useCallback(async (quoteId: string, label: string) => {
    const ok = window.confirm(
      `Remover do slot "${label}"?\n\nO orçamento NÃO será excluído — ele volta pra "Sem prioridade definida" e pode ser atribuído de novo a qualquer momento.`,
    );
    if (!ok) return;
    try {
      await api.patch(`/quotes/${quoteId}`, { priority: null });
      // Se o card removido estava selecionado, limpa selecao
      setSelectedId((prev) => (prev === quoteId ? null : prev));
      showSuccess(`Removido do slot ${label}`);
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao remover do slot');
    }
  }, [load]);

  // Onda 14.26 — Toggle "Exige consulta de credito" no card boleto da proposta.
  // PATCH /quotes/:id { requires_credit_check }. Optimistic update no
  // selectedDetail pra resposta imediata.
  const toggleRequiresCreditCheck = useCallback(async (quoteId: string, value: boolean) => {
    // Optimistic local
    setSelectedDetail((prev) => prev && prev.id === quoteId ? { ...prev, requires_credit_check: value } : prev);
    try {
      await api.patch(`/quotes/${quoteId}`, { requires_credit_check: value });
      showSuccess(value ? 'Consulta de crédito obrigatória ativada' : 'Consulta de crédito dispensada');
      // Refetch em background pra garantir consistencia
      load();
    } catch (err: unknown) {
      // Reverte
      await load();
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao atualizar');
    }
  }, [load]);

  // Onda 14.33 — Marca proposta como "escolhida" (aguardando decisao do
  // paciente). Card destacado + demais esmaecidos. So uma por paciente.
  // Optimistic update local + refetch em background.
  //
  // Onda 14.38 — agora aceita payment_key + down_payment pra persistir a
  // forma de pagamento + entrada apresentada pelo operador. PDF do
  // orcamento usa esses dados pra mostrar "Proposta de pagamento".
  const chooseAsProposal = useCallback(async (
    quoteId: string,
    opts?: {
      payment_key?: string | null;
      down_payment?: number | null;
      // Onda 15 (etapa 16.8) — persistir tambem o plano de cobranca (sinal,
      // metodo, datas) pra operador nao perder configuracao ao salvar.
      signal_value?: number | null;
      signal_method?: string | null;
      entrada_due_date?: string | null;
      installments_start_date?: string | null;
    },
  ) => {
    // Optimistic — atualiza estado local antes do PATCH
    setQuotes((prev) =>
      prev.map((q) => ({
        ...q,
        is_chosen_proposal: q.id === quoteId,
      })),
    );
    setSelectedDetail((prev) =>
      prev && prev.id === quoteId ? { ...prev, is_chosen_proposal: true } : prev,
    );
    try {
      await api.post(`/quotes/${quoteId}/choose-as-proposal`, {
        payment_key: opts?.payment_key || null,
        down_payment: opts?.down_payment || 0,
        signal_value: opts?.signal_value ?? null,
        signal_method: opts?.signal_method ?? null,
        entrada_due_date: opts?.entrada_due_date ?? null,
        installments_start_date: opts?.installments_start_date ?? null,
      });
      showSuccess('Proposta salva — aguardando decisão do paciente');
      load(); // refetch em background pra garantir consistencia
    } catch (err: unknown) {
      await load(); // reverte
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao salvar proposta');
    }
  }, [load]);

  // Onda 14.33 — Desmarca a proposta escolhida (volta ao estado neutro).
  const unchooseAsProposal = useCallback(async (quoteId: string) => {
    setQuotes((prev) =>
      prev.map((q) =>
        q.id === quoteId ? { ...q, is_chosen_proposal: false } : q,
      ),
    );
    setSelectedDetail((prev) =>
      prev && prev.id === quoteId ? { ...prev, is_chosen_proposal: false } : prev,
    );
    try {
      await api.post(`/quotes/${quoteId}/unchoose-as-proposal`, {});
      showSuccess('Proposta desmarcada');
      load();
    } catch (err: unknown) {
      await load();
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao desmarcar');
    }
  }, [load]);

  // Onda 14.21 — "Remover da aba Propostas" (qualquer card, incluindo LIVRE).
  // Seta visible_in_proposals=false: a quote some daqui mas continua intacta
  // nas abas Avaliacao, Orcamentos e Financeiro. Optimistic update pra resposta
  // imediata. Confirm avisa o operador que e so esta aba.
  const hideFromProposals = useCallback(async (quoteId: string) => {
    const ok = window.confirm(
      'Remover este card da aba Propostas?\n\nO orçamento NÃO será excluído — continua disponível nas abas Avaliação e Orçamentos. Pra trazer de volta, recrie a partir de lá.',
    );
    if (!ok) return;
    // Optimistic — esconde imediatamente
    setQuotes((prev) => prev.map((q) =>
      q.id === quoteId ? { ...q, visible_in_proposals: false } : q,
    ));
    setSelectedId((prev) => (prev === quoteId ? null : prev));
    try {
      await api.patch(`/quotes/${quoteId}`, { visible_in_proposals: false });
      showSuccess('Removido da aba Propostas');
    } catch (err: unknown) {
      // Reverte
      await load();
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao remover da aba');
    }
  }, [load]);

  // Onda 9 — "+ nova versão" original: criava DRAFT vazio + atribuia priority
  // + redirecionava pra preencher. Problema: gerava orcamentos fantasma vazios
  // no banco e duplicava trabalho do operador.
  //
  // Onda 14.23 — "Nova proposta" agora ATRIBUI priority a um orcamento ja
  // existente (criado na aba Avaliacao). Nao cria DRAFT vazio. Tambem ja
  // garante visible_in_proposals=true pra trazer de volta orcamentos que
  // o operador removeu antes.
  const attachQuoteToPriority = useCallback(async (quoteId: string, priority: Priority | null) => {
    setCreatingVersion(true);
    // Optimistic — atualiza estado local antes do PATCH
    setQuotes((prev) => prev.map((q) =>
      q.id === quoteId ? { ...q, priority: priority || null, visible_in_proposals: true } : q,
    ));
    try {
      await api.patch(`/quotes/${quoteId}`, {
        priority,
        visible_in_proposals: true,
      });
      const label = priority ? PRIORITY_CONFIG[priority].label : 'Livre';
      showSuccess(`Orçamento atribuído como ${label}`);
      setNewVersionOpen(false);
      // Refetch pra garantir consistencia (categoria/contadores/etc)
      load();
    } catch (err: unknown) {
      await load(); // reverte
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao atribuir');
    } finally {
      setCreatingVersion(false);
    }
  }, [load]);

  // Onda 9 — envia oferta atual pro paciente via WhatsApp
  const [sending, setSending] = useState(false);
  const sendToPatient = useCallback(async () => {
    if (!selectedDetail) return;
    setSending(true);
    try {
      await api.post(`/quotes/${selectedDetail.id}/send-whatsapp`);
      showSuccess('Proposta enviada pro paciente');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao enviar');
    } finally {
      setSending(false);
    }
  }, [selectedDetail]);

  // Onda 12 — Consulta de credito do Financiamento Banco PASSOS
  const [creditCheckOpen, setCreditCheckOpen] = useState(false);
  // Onda 14.4 — parcelas pre-selecionadas no credit-check (12, 18, 24, etc)
  const [creditCheckInitialInstallments, setCreditCheckInitialInstallments] = useState<number>(18);
  // Onda 14.56 — entrada custom escolhida pelo operador no painel da proposta.
  // Propagada do PropostaPainel ate o CreditCheckDialog pra garantir que o
  // valor financiado (e os boletos gerados) refletem a entrada configurada.
  // Antes a entrada aparecia na modal de tabela mas era ignorada no
  // apply-financing, gerando boletos pelo total cheio sem descontar a entrada.
  const [creditCheckCustomDownPayment, setCreditCheckCustomDownPayment] = useState<number>(0);
  // Onda 14.58 — sinal + datas customizadas pra dividir a cobranca em
  // sinal (hoje) + entrada (data X) + parcelas (data Y).
  const [creditCheckSignalValue, setCreditCheckSignalValue] = useState<number>(0);
  const [creditCheckSignalMethod, setCreditCheckSignalMethod] = useState<'PIX' | 'BOLETO' | 'CASH'>('PIX');
  const [creditCheckEntradaDueDate, setCreditCheckEntradaDueDate] = useState<string>('');
  const [creditCheckInstallmentsStartDate, setCreditCheckInstallmentsStartDate] = useState<string>('');

  // Onda 13 — Bônus de fechamento
  const [bonusOpen, setBonusOpen] = useState(false);
  const [savingBonus, setSavingBonus] = useState(false);

  // Onda 14.5 — Aprovar e cobrar (gera cobranca direta no Asaas)
  interface ApproveAndBillResult {
    quote_id: string;
    plan_id: string;
    charge: { id: string; status: string };
    billing_type: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
    installment_count?: number;
    pix?: { qrCode: string; copyPaste: string; expirationDate: string } | null;
    boleto?: { url: string; barcode: string | null } | null;
    invoice_url?: string | null;
    /** Onda 14.11 — true quando backend retornou cobranca ja existente */
    is_existing?: boolean;
  }
  const [approveBillOpen, setApproveBillOpen] = useState(false);
  const [approveBillResult, setApproveBillResult] = useState<ApproveAndBillResult | null>(null);
  const [approvingBill, setApprovingBill] = useState(false);

  // Onda 14.5 — Aprovar proposta + gerar cobranca direta
  const approveAndBill = useCallback(async (extras?: {
    customDownPayment?: number;
    customSignalValue?: number;
    customSignalMethod?: 'PIX' | 'BOLETO' | 'CASH';
    customEntradaDueDate?: string;
    customInstallmentsStartDate?: string;
  }) => {
    if (!selectedDetail) return;
    // Mapeia activePaymentKey pra payment_method + installments
    const opts = buildPaymentOptions();
    const allOpts = [...opts.avista, ...opts.cartao, ...opts.parcelado];
    const activeOpt = allOpts.find((o) => o.key === activePaymentKey) || opts.avista[0];

    // Calcula valor final conforme a forma de pagamento
    // Usa pending_value se ha aprovacao parcial
    const approvedValue = selectedDetail.items
      .filter((it) => !!it.approved_at)
      .reduce((acc, it) => acc + Number(it.total_price), 0);
    const totalBruto = Number(selectedDetail.total_value);
    const hasPartial = selectedDetail.items.some((it) => !!it.approved_at);
    const baseTotal = hasPartial ? approvedValue : totalBruto;
    const customDp = extras?.customDownPayment ?? 0;
    const calc = applyPaymentOption(baseTotal, activeOpt, customDp);

    // Onda 15 (etapa 16) — Boleto parcelado COM consulta DISPENSADA: chama
    // apply-financing direto (sem decision_id). Backend ja aceita decision_id
    // como opcional. Caso a consulta esteja EXIGIDA, segue bloqueando com
    // mensagem orientadora (operador deve passar pelo card do Boleto pra a
    // consulta abrir automaticamente).
    if (activeOpt.variant === 'parcelado' && activeOpt.installments > 1) {
      const ccRequired = selectedDetail.requires_credit_check !== false;
      if (ccRequired) {
        showError(
          'Boleto parcelado com consulta EXIGIDA: clique no card do Boleto, ' +
          'escolha as parcelas e o sistema abre a consulta de crédito automaticamente. ' +
          'Pra pular a consulta, desmarque "Exigir consulta de crédito" no modal do Boleto.',
        );
        return;
      }
      // Dispensada — aplica financing direto
      if (calc.finalValue < 5.0) {
        showError(`Asaas exige R$ 5,00 minimo por cobranca (atual: R$ ${calc.finalValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}).`);
        return;
      }
      // Onda 15 (etapa 16.7) — Sinal em ESPECIE (CASH) precisa de tratamento
      // dedicado: nao da pra mandar signal_method=CASH pro /apply-financing
      // (DTO so aceita PIX|BOLETO) e tampouco converter pra BOLETO (geraria
      // um boleto Asaas no lugar do recebimento em maos — bug que apareceu
      // em testes). Fluxo correto: registrar a especie primeiro (cria CASH
      // charge + mark-cash-received) e depois chamar /apply-financing SEM
      // signal_method (backend ve hasSignal=true por kind e pula a criacao
      // do sinal, mas usa signal_value pra calcular entrada-restante).
      const isCashSignal =
        extras?.customSignalMethod === 'CASH' &&
        !!extras?.customSignalValue &&
        extras.customSignalValue > 0;
      const signalAmt = extras?.customSignalValue || 0;
      const confirmLines = [
        `Aprovar e gerar boleto parcelado em ${activeOpt.installments}x?`,
        '',
      ];
      if (isCashSignal) {
        confirmLines.push(
          `Sinal: R$ ${signalAmt.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} em ESPÉCIE (recebido em mãos, sem Asaas)`,
        );
      } else if (signalAmt > 0) {
        confirmLines.push(
          `Sinal: R$ ${signalAmt.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} via ${extras?.customSignalMethod || 'BOLETO'}`,
        );
      }
      if (customDp > 0) {
        const restante = customDp - signalAmt;
        confirmLines.push(
          `Entrada (restante): R$ ${restante.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} em boleto`,
        );
      }
      confirmLines.push(
        `${activeOpt.installments}x de R$ ${calc.installmentValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        `Total final: R$ ${calc.finalValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        '',
        '⚠ Consulta de crédito DISPENSADA — operador assume o risco.',
        '',
        'Isso vai:',
        '• Aceitar o orçamento (ACCEPTED)',
        '• Ativar o plano',
      );
      if (isCashSignal) {
        confirmLines.push(`• Registrar o sinal R$ ${signalAmt.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} como recebido em espécie`);
      }
      confirmLines.push(`• Gerar entrada + ${activeOpt.installments} boletos no Asaas`);
      if (!window.confirm(confirmLines.join('\n'))) return;
      setApprovingBill(true);
      // DTO do backend exige maxDecimalPlaces: 2 nos valores monetarios.
      const round2 = (n: number) => Math.round(n * 100) / 100;
      try {
        // Passo 1 (so se CASH): emite + da baixa do sinal em especie
        if (isCashSignal) {
          const restValueLocal = Math.max(0, customDp - signalAmt);
          const cashBody: any = {
            signalValue: round2(signalAmt),
            signalMethod: 'CASH',
            restValue: restValueLocal,
            restMethod: 'BOLETO',
            parts: ['SIGNAL'],
          };
          if (restValueLocal > 0 && extras?.customEntradaDueDate) {
            cashBody.restDueDate = extras.customEntradaDueDate;
          }
          const { data: emitData } = await api.post(
            `/quotes/${selectedDetail.id}/emit-down-payment`,
            cashBody,
          );
          const cashCharge = (emitData?.charges ?? []).find((c: any) => c.kind === 'SINAL')
            || (emitData?.charges ?? [])[0];
          if (!cashCharge?.id) {
            throw new Error('Falha ao criar registro do sinal em espécie.');
          }
          if (cashCharge.gateway !== 'CASH') {
            throw new Error(
              `Já existe um sinal emitido via ${cashCharge.billing_type || cashCharge.gateway} no Asaas. ` +
              'Cancele essa cobrança primeiro pra usar espécie.',
            );
          }
          if (!cashCharge.received_in_cash) {
            await api.post(`/charges/${cashCharge.id}/mark-cash-received`);
          }
        }
        // Passo 2: aplica financing.
        // - Quando CASH, o backend ve hasSignal=true (sinal CASH ja existe) e
        //   pula a criacao do SINAL, mas usa signal_value pra calcular o
        //   restante da entrada que vira boleto (entrada - sinal).
        // - Quando PIX/BOLETO, manda signal_method tambem; backend cria a
        //   cobranca do sinal correspondente.
        const applyBody: any = {
          down_payment_value: round2(customDp),
          installment_count: activeOpt.installments,
          installment_value: round2(calc.installmentValue),
        };
        if (signalAmt > 0) {
          applyBody.signal_value = round2(signalAmt);
          if (!isCashSignal) {
            applyBody.signal_method = extras?.customSignalMethod || 'BOLETO';
          }
        }
        if (extras?.customEntradaDueDate) applyBody.entrada_due_date = extras.customEntradaDueDate;
        if (extras?.customInstallmentsStartDate) applyBody.installments_start_date = extras.customInstallmentsStartDate;
        await api.post(`/quotes/${selectedDetail.id}/apply-financing`, applyBody);
        showSuccess(
          isCashSignal
            ? 'Sinal em espécie registrado + entrada e parcelas geradas.'
            : 'Proposta aprovada e boletos gerados (consulta dispensada).',
        );
        load();
      } catch (err: unknown) {
        const e = err as { response?: { data?: { message?: string } }; message?: string };
        showError(e?.response?.data?.message || e?.message || 'Erro ao aprovar e gerar boletos');
      } finally {
        setApprovingBill(false);
      }
      return;
    }

    // Determina billing_type
    let billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
    let installmentCount: number | undefined;
    let valueToCharge: number;

    if (activeOpt.variant === 'avista') {
      // PIX/dinheiro à vista — usa billingType PIX (Asaas suporta dinheiro via baixa manual)
      billingType = 'PIX';
      valueToCharge = calc.finalValue; // com desconto
    } else if (activeOpt.variant === 'cartao') {
      billingType = 'CREDIT_CARD';
      installmentCount = activeOpt.installments;
      valueToCharge = calc.finalValue; // com juros se houver
    } else {
      // parcelado 1x (boleto à vista)
      billingType = 'BOLETO';
      valueToCharge = calc.finalValue;
    }

    // Onda 14.10 — Asaas exige valor minimo de R$ 5,00 por cobranca.
    // Bloqueia ANTES de enviar (em vez de receber 400 generico).
    const ASAAS_MIN_VALUE = 5.0;
    if (valueToCharge < ASAAS_MIN_VALUE) {
      showError(
        `Asaas exige valor mínimo de R$ 5,00 por cobrança. ` +
        `Valor atual: R$ ${valueToCharge.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}. ` +
        `Aumente o valor do orçamento ou aplique outra forma de pagamento.`,
      );
      return;
    }

    const confirmMsg =
      `Aprovar proposta?\n\n` +
      `Forma: ${billingType === 'PIX' ? 'PIX' : billingType === 'CREDIT_CARD' ? `Cartão ${installmentCount}x` : 'Boleto à vista'}\n` +
      `Valor: R$ ${valueToCharge.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n\n` +
      `Isso vai:\n` +
      `• Aceitar o orçamento (vira ACCEPTED)\n` +
      `• Ativar o plano de tratamento\n` +
      `• Gerar cobrança no Asaas\n` +
      `• Enviar pro paciente`;
    if (!window.confirm(confirmMsg)) return;

    setApprovingBill(true);
    // Onda 17.8 — AbortController com timeout de 60s. Antes, se o backend
    // (ou o Asaas) demorava muito, a requisicao ficava pendente sem fim,
    // o operador via "loading" infinito sem feedback. Agora aborta limpo
    // depois de 60s e mostra mensagem util.
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), 60_000);
    try {
      const { data } = await api.post<ApproveAndBillResult>(
        `/quotes/${selectedDetail.id}/approve-and-bill`,
        {
          billing_type: billingType,
          value: valueToCharge,
          installment_count: installmentCount,
        },
        { signal: abortCtrl.signal, timeout: 60_000 },
      );
      setApproveBillResult(data);
      setApproveBillOpen(true);
      showSuccess('Proposta aprovada e cobrança gerada!');
      load(); // refresh lista
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string }; status?: number }; code?: string; name?: string; message?: string };
      const isAbort =
        e?.name === 'CanceledError' ||
        e?.name === 'AbortError' ||
        e?.code === 'ECONNABORTED' ||
        (e?.message || '').toLowerCase().includes('abort') ||
        (e?.message || '').toLowerCase().includes('timeout');
      if (isAbort) {
        showError(
          'A operação demorou mais de 60s e foi cancelada. Pode ser ' +
          'lentidão no Asaas. Verifique no Financeiro se a cobrança ' +
          'foi gerada antes de tentar de novo (pra evitar duplicar).',
        );
      } else {
        showError(e?.response?.data?.message || 'Erro ao aprovar e gerar cobrança');
      }
    } finally {
      clearTimeout(timeoutId);
      setApprovingBill(false);
    }
  }, [selectedDetail, activePaymentKey, load]);

  // Onda 13 — adiciona bônus de fechamento ao quote selecionado
  const addBonus = useCallback(async (payload: {
    type: BonusType;
    description: string;
    valid_until: string;
    discount_percent_delta?: number;
  }) => {
    if (!selectedDetail) return;
    setSavingBonus(true);
    try {
      const { data } = await api.post<{ notes: string; total_value: number }>(
        `/quotes/${selectedDetail.id}/bonus`,
        payload,
      );
      // Atualiza local — recarrega detail pra refletir mudancas (notes + total)
      setSelectedDetail((prev) =>
        prev ? { ...prev, notes: data.notes, total_value: data.total_value } : prev,
      );
      setBonusOpen(false);
      showSuccess('Bônus adicionado à proposta');
      load(); // refresh lista (total mudou no card)
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao adicionar bônus');
    } finally {
      setSavingBonus(false);
    }
  }, [selectedDetail, load]);

  // Onda 10 — Salvar contraproposta (registra oferta como linha em notes)
  const [counterPropOpen, setCounterPropOpen] = useState(false);
  const [savingCounter, setSavingCounter] = useState(false);
  const saveCounterProposal = useCallback(
    async (payload: { payment_label: string; final_value: number; note?: string }) => {
      if (!selectedDetail) return;
      setSavingCounter(true);
      try {
        const { data } = await api.post<{ id: string; notes: string }>(
          `/quotes/${selectedDetail.id}/counter-proposal`,
          payload,
        );
        // Atualiza apenas o campo notes do detail local (evita refetch)
        setSelectedDetail((prev) => (prev ? { ...prev, notes: data.notes } : prev));
        setCounterPropOpen(false);
        showSuccess('Contraproposta salva no histórico');
        // Onda 11 — refresh da lista pra badge "N propostas" atualizar no card
        load();
      } catch (err: unknown) {
        const e = err as { response?: { data?: { message?: string } } };
        showError(e?.response?.data?.message || 'Erro ao salvar contraproposta');
      } finally {
        setSavingCounter(false);
      }
    },
    [selectedDetail, load],
  );

  // Filtra DRAFT/SENT/ACCEPTED (aceitos continuam visiveis pra operador
  // acompanhar status + gerar cobranca se faltou).
  // Onda 14.7 — antes filtrava so DRAFT/SENT; ACCEPTED sumia da lista,
  // confundindo o operador apos clicar "Aprovar e cobrar".
  const grouped = useMemo(() => {
    const eligible = quotes.filter(
      (q) =>
        (q.status === 'DRAFT' || q.status === 'SENT' || q.status === 'ACCEPTED') &&
        // Onda 14.21 — esconde quotes que o operador clicou "remover" da aba
        // Propostas. Continuam intactas em Avaliacao/Orcamentos/Financeiro.
        // visible_in_proposals === false explicitamente. undefined/true = visivel.
        q.visible_in_proposals !== false,
    );
    const m = new Map<Priority | 'NONE', QuoteListItem[]>();
    for (const q of eligible) {
      const key = (q.priority || 'NONE') as Priority | 'NONE';
      const arr = m.get(key) || [];
      arr.push(q);
      m.set(key, arr);
    }
    // Ordena cada grupo por created_at desc (mais recente primeiro)
    m.forEach((arr) => arr.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    ));
    return m;
  }, [quotes]);

  // Total da proposta COMPLETO (mais alta) — referencia pra calcular
  // diferenca nas outras. Onda 11.1 — usa approved_value quando ha aprovacao
  // parcial (compara o que vai ser pago, nao o bruto).
  const completoTotal = useMemo(() => {
    const cs = grouped.get('COMPLETO');
    if (!cs || cs.length === 0) return null;
    const c = cs[0];
    const ac = c.approved_count ?? 0;
    return ac > 0
      ? Number(c.approved_value ?? 0)
      : Number(c.total_value);
  }, [grouped]);

  // Onda 15 (etapa 11) — So mostra o spinner de tela cheia no PRIMEIRO load
  // (sem dados ainda). Refetches em background (ex: toggle de consulta de
  // credito chamando load()) NAO podem desmontar o painel/modal — antes isso
  // fechava o modal de parcelas toda vez que se clicava na opcao de consulta.
  if (loading && quotes.length === 0) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando propostas...
      </div>
    );
  }

  const eligibleCount = Array.from(grouped.values()).reduce((acc, arr) => acc + arr.length, 0);

  if (eligibleCount === 0) {
    // Onda 14.23 — empty state da aba inteira:
    // - Se ja ha orcamentos no paciente (mas nenhum visivel aqui), oferece
    //   atribuir priority via dialog "+ Nova proposta"
    // - Se nao ha orcamento nenhum, oferece criar na aba Avaliacao primeiro
    const hasAnyQuotes = quotes.some(
      (q) => q.status === 'DRAFT' || q.status === 'SENT' || q.status === 'ACCEPTED',
    );
    return (
      <div className="bg-card border border-border border-dashed rounded-xl p-10 text-center">
        <Layers size={32} className="mx-auto text-muted-foreground/60 mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">
          Nenhuma proposta pra comparar
        </p>
        <p className="text-xs text-muted-foreground max-w-md mx-auto mb-4">
          {hasAnyQuotes
            ? <>Você já tem orçamentos criados. Clique em <strong>“+ Nova proposta”</strong> pra atribuir prioridade (Urgente, Essencial, Completo ou Livre).</>
            : <>Pra criar uma proposta, primeiro crie um orçamento na aba <strong>Avaliação</strong>. Depois venha aqui pra atribuir prioridade.</>
          }
        </p>
        {hasAnyQuotes ? (
          <button
            type="button"
            onClick={() => setNewVersionOpen(true)}
            className="text-xs font-semibold text-primary-foreground bg-primary px-3 py-1.5 rounded-lg hover:opacity-90 inline-flex items-center gap-1"
          >
            <Plus size={14} />
            Nova proposta
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onGoToEvaluation?.()}
            disabled={!onGoToEvaluation}
            className="text-xs font-semibold text-primary-foreground bg-primary px-3 py-1.5 rounded-lg hover:opacity-90 inline-flex items-center gap-1 disabled:opacity-50"
          >
            Ir para Avaliação
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Layers size={16} className="text-primary" />
            Versões do plano
          </h2>
          <p className="text-xs text-muted-foreground">
            do mais apertado pro mais completo · clique num card pra abrir a
            proposta com formas de pagamento
          </p>
        </div>
        <button
          type="button"
          onClick={() => setNewVersionOpen(true)}
          className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
        >
          <Plus size={14} />
          Nova proposta
        </button>
      </div>

      {/* Onda 14.19 — Scroll horizontal proporcional.
          Onda 14.20 — Slots vazios sumem: so renderiza cards de propostas
          que existem (mais botao "+ nova versao" no header pra adicionar).
          Cards usam flex-1 com min/max-width: ocupam o espaco disponivel
          igualmente quando ha poucos (1 card = 100%, 2 cards = 50% cada,
          etc), e quando o total excede o viewport, vira scroll horizontal
          mantendo o min-width de 260px.

          `pb-3` da espaco pra scrollbar nao cortar shadow. `-mx-1 px-1`
          permite scrollar ate as bordas sem cortar visual.
          Onda 14.21 — items-stretch garante que TODOS os cards tenham a
          mesma altura (do maior conteudo). Antes alguns ficavam menores
          se tinham menos info (ex: LIVRE com 0 itens). */}
      <div className="flex flex-nowrap items-stretch overflow-x-auto snap-x gap-3 pb-3 -mx-1 px-1 scrollbar-thin scrollbar-thumb-border">
        {(() => {
          // Onda 14.20 — monta lista linear de cards a renderizar (apenas
          // propostas reais — placeholders vazios foram removidos). Ordem:
          //   1. URGENTE (mais recente primeiro, depois v2, v3...)
          //   2. ESSENCIAL idem
          //   3. COMPLETO idem
          //   4. LIVRE (quotes sem priority)
          type CardEntry = {
            key: string;
            variant: CardVariant;
            quote: QuoteListItem;
            versionTag: string | null; // "v2", "v3" pras antigas; null pra main e LIVRE
            cfg: VariantConfig;
          };
          const entries: CardEntry[] = [];
          for (const priority of PRIORITY_ORDER) {
            const items = grouped.get(priority) || [];
            const cfg = PRIORITY_CONFIG[priority];
            items.forEach((q, idx) => {
              entries.push({
                key: `q-${q.id}`,
                variant: priority,
                quote: q,
                versionTag: idx === 0 ? null : `v${idx + 1}`,
                cfg,
              });
            });
          }
          for (const q of grouped.get('NONE') || []) {
            entries.push({
              key: `livre-${q.id}`,
              variant: 'LIVRE',
              quote: q,
              versionTag: null,
              cfg: LIVRE_CONFIG,
            });
          }

          // Onda 14.33 — Detecta se ha alguma proposta "chosen" no paciente.
          // Se sim, dim todas as outras (exceto a chosen propriamente).
          const chosenEntryId = entries.find((e) => e.quote.is_chosen_proposal)?.quote.id ?? null;

          return entries.map((entry) => {
            const isSelected = selectedId === entry.quote.id;
            const isChosen = entry.quote.is_chosen_proposal === true;
            const dimmed = chosenEntryId !== null && entry.quote.id !== chosenEntryId;
            return (
              <div
                key={entry.key}
                // Onda 14.20 — flex-1 proporcional, min-w garante legibilidade
                // e dispara scroll quando total > viewport, max-w impede card
                // unico ocupar 100% horrivel em telas largas.
                // Onda 14.21 — h-auto + child com h-full + parent items-stretch
                // = todos os cards com mesma altura visual.
                className="snap-start flex-1 basis-[280px] min-w-[260px] max-w-[400px] flex relative h-auto"
              >
                {entry.versionTag && (
                  <span
                    className="absolute -top-2 left-3 z-10 text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-foreground shadow-sm border border-border"
                    title="Versão extra da mesma prioridade"
                  >
                    {entry.versionTag}
                  </span>
                )}
                <PropostaCard
                  variant={entry.variant}
                  cfg={entry.cfg}
                  quote={entry.quote}
                  olderCount={0}
                  completoTotal={completoTotal}
                  selected={isSelected}
                  isChosen={isChosen}
                  dimmed={dimmed}
                  onToggleSelect={() => setSelectedId(isSelected ? null : entry.quote.id)}
                  onPickEmpty={() => {
                    if (entry.variant !== 'LIVRE') setPickerFor(entry.variant);
                  }}
                  // Onda 14.21 — lixeira agora "remove desta aba" em TODOS
                  // os cards (incluindo LIVRE). Seta visible_in_proposals=false.
                  // A quote continua em Avaliacao/Orcamentos/Financeiro.
                  onRemoveFromSlot={() => hideFromProposals(entry.quote.id)}
                />
              </div>
            );
          });
        })()}
      </div>

      {/* Onda 9 — Painel inline da proposta selecionada (negociacao ao vivo) */}
      {selectedId && (
        <PropostaPainel
          loading={loadingDetail}
          detail={selectedDetail}
          priority={
            (quotes.find((q) => q.id === selectedId)?.priority as Priority | undefined) || null
          }
          activePaymentKey={activePaymentKey}
          onChangePayment={setActivePaymentKey}
          itemsExpanded={itemsExpanded}
          onToggleItems={() => setItemsExpanded((v) => !v)}
          onClose={() => setSelectedId(null)}
          onAjustar={() => selectedDetail && onOpenQuoteDetail?.(selectedDetail.id)}
          onSend={sendToPatient}
          sending={sending}
          onSaveCounter={() => setCounterPropOpen(true)}
          onOpenCreditCheck={() => setCreditCheckOpen(true)}
          onOpenCreditCheckForParcelas={(params) => {
            setCreditCheckInitialInstallments(params.installments);
            // Onda 14.56 — captura entrada custom
            setCreditCheckCustomDownPayment(params.customDownPayment ?? 0);
            // Onda 14.58 — captura sinal + datas
            setCreditCheckSignalValue(params.signalValue ?? 0);
            setCreditCheckSignalMethod(params.signalMethod ?? 'PIX');
            setCreditCheckEntradaDueDate(params.entradaDueDate ?? '');
            setCreditCheckInstallmentsStartDate(params.installmentsStartDate ?? '');
            setCreditCheckOpen(true);
          }}
          onAddBonus={() => setBonusOpen(true)}
          onApproveAndBill={approveAndBill}
          // Onda 14.26 — toggle "exige consulta de credito" no card boleto
          onToggleRequiresCreditCheck={(value) => toggleRequiresCreditCheck(selectedId!, value)}
          // Onda 14.33 / 14.38 — salvar proposta como "aguardando decisão do
          // paciente" + persistir forma de pagamento e entrada que o operador
          // configurou no painel (pra PDF/whatsapp mostrarem a oferta).
          onChooseAsProposal={(opts) => selectedId && chooseAsProposal(selectedId, opts)}
          onUnchooseAsProposal={() => selectedId && unchooseAsProposal(selectedId)}
        />
      )}

      {/* Onda 8.1 — Picker modal: lista quotes elegiveis pra atribuir ao slot */}
      {pickerFor && (
        <QuotePicker
          targetPriority={pickerFor}
          quotes={quotes.filter((q) => q.status === 'DRAFT' || q.status === 'SENT')}
          loading={assigning}
          onCancel={() => setPickerFor(null)}
          onSelect={(quoteId) => assignPriority(quoteId, pickerFor)}
        />
      )}

      {/* Onda 14.23 — Dialog "Nova proposta" (2 steps):
          1. Escolhe priority (so as restantes — ocupadas sao filtradas)
          2. Escolhe qual orcamento existente atribuir
          Em vez de criar DRAFT vazio, reusa um orcamento ja criado. */}
      {newVersionOpen && (
        <NewVersionDialog
          existingPriorities={
            new Set(
              Array.from(grouped.keys()).filter((k): k is Priority => k !== 'NONE'),
            )
          }
          // Onda 14.23 — lista de orcamentos elegiveis (DRAFT/SENT/ACCEPTED).
          // Inclui ocultos (visible_in_proposals=false) pra operador conseguir
          // "trazer de volta" um orcamento que ele removeu antes. PATCH ja
          // re-seta visible=true.
          availableQuotes={quotes.filter((q) =>
            q.status === 'DRAFT' || q.status === 'SENT' || q.status === 'ACCEPTED'
          )}
          loading={creatingVersion}
          onCancel={() => setNewVersionOpen(false)}
          onAttach={attachQuoteToPriority}
          onGoToAvaliacao={() => {
            setNewVersionOpen(false);
            onGoToEvaluation?.();
          }}
        />
      )}

      {/* Onda 10 — Dialog "Salvar contraproposta" */}
      {counterPropOpen && selectedDetail && (() => {
        // Onda 11.1 — usa approved_value quando ha aprovacao parcial (proposta
        // de pagamento e sobre o que paciente ja topou).
        const totalBruto = Number(selectedDetail.total_value);
        const approvedValue = selectedDetail.items
          .filter((it) => !!it.approved_at)
          .reduce((acc, it) => acc + Number(it.total_price), 0);
        const hasApproved = selectedDetail.items.some((it) => !!it.approved_at);
        const total = hasApproved ? approvedValue : totalBruto;
        const opts = buildPaymentOptions();
        const allOptions = [...opts.avista, ...opts.cartao, ...opts.parcelado];
        const activeOption = allOptions.find((o) => o.key === activePaymentKey) || opts.avista[0];
        const calc = applyPaymentOption(total, activeOption);
        const priority = (quotes.find((q) => q.id === selectedId)?.priority as Priority | undefined) || null;
        const priorityLabel = priority ? PRIORITY_CONFIG[priority].label : 'Proposta';
        const paymentLabel =
          activeOption.variant === 'avista'
            ? `${activeOption.label} à vista`
            : activeOption.variant === 'cartao'
            ? `${activeOption.installments}x no cartão (${(activeOption.interestRate ?? 0) === 0 ? 'sem juros' : `juros PagBank ${activeOption.interestRate}%/mês`})`
            : `${activeOption.installments}x no Financiamento Banco PASSOS (entrada ${activeOption.downPaymentPercent ?? 0}% + ${activeOption.interestRate}%/mês)`;
        // Onda 11.2 — finalValue agora reflete o que foi ofertado:
        // a vista = descontado / parcelado = total com juros
        const finalValue = calc.finalValue;
        return (
          <CounterProposalDialog
            priorityLabel={priorityLabel}
            paymentLabel={paymentLabel}
            finalValue={finalValue}
            loading={savingCounter}
            onCancel={() => setCounterPropOpen(false)}
            onSave={(note) =>
              saveCounterProposal({
                payment_label: paymentLabel,
                final_value: finalValue,
                note,
              })
            }
          />
        );
      })()}

      {/* Onda 12 — Dialog "Financiamento Banco PASSOS" (consulta de credito) */}
      {/* Onda 13 — Dialog "Adicionar bônus de fechamento" */}
      {bonusOpen && selectedDetail && (
        <BonusDialog
          loading={savingBonus}
          onCancel={() => setBonusOpen(false)}
          onSave={addBonus}
        />
      )}

      {/* Onda 14.5 — Modal de resultado "Aprovar e cobrar" */}
      {approveBillOpen && approveBillResult && (
        <ApproveBillResultDialog
          result={approveBillResult}
          onClose={() => {
            setApproveBillOpen(false);
            setApproveBillResult(null);
            setSelectedId(null); // fecha o painel (quote ja foi aceito)
          }}
        />
      )}
      {approvingBill && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
          <div className="bg-card border border-border rounded-xl p-6 flex flex-col items-center gap-3 shadow-2xl max-w-md text-center">
            <Loader2 size={28} className="animate-spin text-emerald-600" />
            <div>
              <p className="text-sm font-semibold text-foreground">Aprovando proposta + gerando cobrança...</p>
              <p className="text-xs text-muted-foreground mt-1">
                Pode levar até 1 minuto enquanto integra com o Asaas. Não feche a janela.
              </p>
            </div>
          </div>
        </div>
      )}

      {creditCheckOpen && selectedDetail && (() => {
        const totalForCheck = (() => {
          const approved = selectedDetail.items
            .filter((it) => !!it.approved_at)
            .reduce((acc, it) => acc + Number(it.total_price), 0);
          const has = selectedDetail.items.some((it) => !!it.approved_at);
          return has ? approved : Number(selectedDetail.total_value);
        })();
        return (
          <CreditCheckDialog
            quoteId={selectedDetail.id}
            // Onda 14.27 — patientId pra pre-preencher dados + salvar no cadastro
            patientId={patientId}
            valorTotal={totalForCheck}
            initialInstallments={creditCheckInitialInstallments}
            // Onda 14.56 — entrada custom configurada pelo operador. Sem isso
            // o calc do dialog ignorava a entrada e gerava boletos errados.
            customDownPayment={creditCheckCustomDownPayment}
            // Onda 14.58 — sinal + datas customizadas pra dividir a cobranca
            customSignalValue={creditCheckSignalValue}
            customSignalMethod={creditCheckSignalMethod}
            customEntradaDueDate={creditCheckEntradaDueDate}
            customInstallmentsStartDate={creditCheckInstallmentsStartDate}
            onCancel={() => setCreditCheckOpen(false)}
            onAppliedSuccess={(parcelaKey) => {
              setActivePaymentKey(parcelaKey);
              load(); // refresh lista pra refletir quote ACCEPTED
              showSuccess('Boletos gerados e proposta aplicada');
            }}
          />
        );
      })()}

      {/* Onda 12.6 — Bloco "Sem prioridade definida" removido.
          Orcamentos sem priority continuam acessiveis via picker dos cards
          vazios (sao listados quando voce clica em "Escolher orcamento"
          em qualquer slot Urgente/Essencial/Completo). */}
    </div>
  );
}

// ─── Card individual da proposta ────────────────────────────────

function PropostaCard({
  variant,
  cfg,
  quote,
  olderCount,
  completoTotal,
  selected,
  isChosen = false,
  dimmed = false,
  onToggleSelect,
  onPickEmpty,
  onRemoveFromSlot,
}: {
  /** Onda 14.19 — variante visual: 3 priorities canonicas OU 'LIVRE'. */
  variant: CardVariant;
  cfg: VariantConfig;
  quote: QuoteListItem | undefined;
  olderCount: number;
  completoTotal: number | null;
  /** Onda 9 — card destacado quando e a versao "selecionada" pra negociar */
  selected: boolean;
  /** Onda 14.33 — quote.is_chosen_proposal=true (proposta escolhida pra
   *  aguardar paciente). Mostra ring colorido + badge AGUARDANDO PACIENTE. */
  isChosen?: boolean;
  /** Onda 14.33 — alguma OUTRA proposta do paciente esta chosen. Este card
   *  fica esmaecido (opacity-50) pra reduzir confusao visual. */
  dimmed?: boolean;
  /** Onda 9 — click no card preenchido alterna seleção (abre/fecha painel inline) */
  onToggleSelect: () => void;
  /** Onda 8.1 — click no card vazio abre picker pra atribuir orcamento ao slot.
   *  Para variant=LIVRE este handler nao e usado (cards LIVRE so existem
   *  quando ha quote — nao tem placeholder vazio). */
  onPickEmpty: () => void;
  /** Onda 12.5 — Remove o orcamento deste slot (limpa priority, NAO exclui).
   *  Slot vira vazio e o orcamento volta pra "Sem prioridade definida".
   *  Para variant=LIVRE este botao some (nao ha priority pra limpar). */
  onRemoveFromSlot: () => void;
}) {
  const priority = variant === 'LIVRE' ? null : variant;
  // Quote nao existe → empty state clicavel: click abre picker pra escolher
  // qual orcamento (sem priority ou em outro slot) vai pra esse slot.
  if (!quote) {
    return (
      <button
        type="button"
        onClick={onPickEmpty}
        className={`p-4 rounded-xl border-2 border-dashed ${cfg.borderCls} bg-card text-left w-full transition-all hover:opacity-100 hover:shadow-sm hover:bg-accent/30 opacity-70 group`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className={cfg.iconCls}>{cfg.icon}</span>
          <h3 className={`text-sm font-bold ${cfg.iconCls}`}>{cfg.label}</h3>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3">
          {cfg.description}
        </p>
        <p className="text-xs text-muted-foreground italic mb-3">
          Sem proposta {cfg.label.toLowerCase()} criada ainda.
        </p>
        <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${cfg.iconCls} group-hover:underline`}>
          <Plus size={12} />
          <span>Escolher orçamento</span>
        </div>
      </button>
    );
  }

  const totalBruto = Number(quote.total_value);
  // Onda 11.1 — se ha aprovacao parcial, exibe approved_value como base
  // (o que paciente ja topou e vai pagar). Pendentes ficam de fora da proposta.
  // Senao usa total_value.
  const approvedCount = quote.approved_count ?? 0;
  const approvedValue = Number(quote.approved_value ?? 0);
  const pendingValue = Number(quote.pending_value ?? totalBruto);
  const hasPartialApproval = approvedCount > 0;
  const total = hasPartialApproval ? approvedValue : totalBruto;
  const isSent = quote.status === 'SENT';
  const isAccepted = quote.status === 'ACCEPTED';
  const cadeira = formatCadeira(quote.total_duration_minutes);
  // Diferenca vs Completo (so faz sentido pra Essencial/Urgente).
  // Usa approved value de ambos os lados pra comparacao justa do que vai
  // ser efetivamente pago.
  const diffVsCompleto =
    completoTotal !== null && priority !== 'COMPLETO'
      ? total - completoTotal
      : null;

  return (
    <button
      type="button"
      onClick={onToggleSelect}
      data-selected={selected ? '1' : '0'}
      data-chosen={isChosen ? '1' : '0'}
      data-dimmed={dimmed ? '1' : '0'}
      className={`p-4 rounded-xl border-2 text-left transition-all hover:shadow-md group relative flex flex-col h-full w-full ${
        isChosen
          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
          : selected
          ? `${cfg.selectedBorderCls} ${cfg.selectedBgCls}`
          : `${cfg.borderCls} ${cfg.bgCls}`
      } ${dimmed ? 'opacity-50 grayscale hover:opacity-100 hover:grayscale-0' : ''}`}
    >
      {/* Onda 14.33 — Badge "AGUARDANDO PACIENTE" — proposta escolhida.
          Tem precedencia sobre "atual" / "ACEITO" (raro mas pra clarificar).
          Onda 14.37 — amarelo solido (antes era azul).
          Onda 14.39 — Movido pra dentro do card (banner no topo) em vez de
          absolute. Estava sendo cortado pelo overflow-x-auto do container
          parent (scroll horizontal cortava o `-right-2`). Banner ocupa
          width total do card e sempre cabe. */}
      {isChosen && (
        <div className="-mx-4 -mt-4 mb-3 px-3 py-1 bg-amber-500 text-amber-950 text-[10px] font-bold flex items-center gap-1.5 rounded-t-xl">
          <Clock size={10} strokeWidth={3} />
          AGUARDANDO PACIENTE
        </div>
      )}

      {/* Onda 14.50 — Badge "atual" virou banner no topo do card.
          Antes era pill em -top-2 -right-2 (metade pra fora, era cortado).
          Agora segue o mesmo padrao do banner "AGUARDANDO PACIENTE" (chosen). */}
      {isSent && !selected && !isChosen && (
        <div className="-mx-4 -mt-4 mb-3 px-3 py-1 bg-orange-500 text-white text-[10px] font-bold flex items-center gap-1.5 rounded-t-xl">
          ATUAL
        </div>
      )}

      {/* Onda 14.7 — Badge "ACEITO" quando quote foi aprovado.
          Onda 14.50 — Virou banner no topo do card (mesmo padrao de chosen).
          Antes era pill em -top-2 -right-2 (metade pra fora, era cortado). */}
      {isAccepted && !isChosen && (
        <div className="-mx-4 -mt-4 mb-3 px-3 py-1 bg-emerald-600 text-white text-[10px] font-bold flex items-center gap-1.5 rounded-t-xl">
          <Check size={10} strokeWidth={3} />
          ACEITO
        </div>
      )}

      {/* Onda 11 — Badge "N propostas" quando ha contrapropostas registradas */}
      {(quote.counter_proposals_count ?? 0) > 0 && (
        <span
          className="absolute -top-2 -left-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary text-primary-foreground shadow-sm flex items-center gap-1"
          title="contrapropostas registradas"
        >
          <MessageSquare size={9} />
          {quote.counter_proposals_count}
        </span>
      )}

      {/* Onda 12.5 / 14.21 — Lixeirinha "Remover desta aba". Visivel em TODOS
          os cards (URGENTE/ESSENCIAL/COMPLETO/LIVRE) pra consistencia visual.
          Acao: seta visible_in_proposals=false (so esconde da aba Propostas).
          O orcamento continua intacto em Avaliacao/Orcamentos/Financeiro. */}
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onRemoveFromSlot();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onRemoveFromSlot();
          }
        }}
        className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground hover:text-red-700 hover:bg-red-500/10 transition-colors cursor-pointer"
        aria-label="Remover desta aba"
        title="Remover desta aba (continua em Avaliação e Orçamentos)"
      >
        <Trash2 size={12} />
      </span>

      {/* Header com priority */}
      <div className="flex items-center gap-2 mb-2">
        <span className={cfg.iconCls}>{cfg.icon}</span>
        <h3 className={`text-sm font-bold ${cfg.iconCls}`}>{cfg.label}</h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3 leading-tight">
        {cfg.description}
      </p>

      {/* Titulo custom + contagem + horas cadeira */}
      <div className="mb-2">
        {/* Onda 14.18 — identificador unificado: #NNN · Nome. Sempre visivel
            (mesmo sem title customizado) pra operador localizar a proposta
            nas outras abas. Usa o mesmo helper de Avaliacao/Orcamentos/Financeiro. */}
        <p
          className="text-xs font-semibold text-foreground truncate mb-1 flex items-center gap-1.5"
          title={`${getQuoteNumberBadge(quote)} ${getQuoteDisplayName(quote)}`}
        >
          <span className="font-mono text-primary shrink-0">
            {getQuoteNumberBadge(quote) || '·'}
          </span>
          <span className="truncate">{getQuoteDisplayName(quote)}</span>
        </p>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1">
            <Layers size={10} />
            {hasPartialApproval ? (
              <>
                <span className="text-emerald-700 font-semibold">
                  {approvedCount} aprovado{approvedCount === 1 ? '' : 's'}
                </span>
                {' · '}
                {quote.pending_count ?? 0} em aberto
              </>
            ) : (
              <>
                {quote._count?.items ?? 0} {quote._count?.items === 1 ? 'item' : 'itens'}
              </>
            )}
          </span>
          {cadeira && (
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {cadeira}
            </span>
          )}
        </div>
      </div>

      {/* Total — quando ha aprovacao parcial, exibe approved_value como destaque
          (o que paciente ja topou e vai pagar). Pendente vira info secundaria. */}
      <p className="text-xl font-bold text-foreground">
        R$ {fmtBRL(total)}
      </p>
      {hasPartialApproval ? (
        <p className="text-[11px] text-muted-foreground mt-0.5">
          <span className="text-emerald-700">já aprovado</span> · + R$ {fmtBRL(pendingValue)} em aberto
        </p>
      ) : null}

      {/* Diferenca vs Completo */}
      {diffVsCompleto !== null && diffVsCompleto < 0 && (
        <p className="text-[11px] text-emerald-700 mt-1">
          −R$ {fmtBRL(Math.abs(diffVsCompleto))} vs completo
        </p>
      )}

      {/* Older count — "+N anteriores".
          Onda 14.19 — agora versoes antigas viram cards proprios no scroll
          horizontal, mas mantemos esta linha como contagem secundaria caso
          o callsite passe olderCount > 0 (por compatibilidade). */}
      {olderCount > 0 && (
        <p className="text-[10px] text-muted-foreground mt-2 italic">
          + {olderCount} versão {olderCount === 1 ? 'anterior' : 'anteriores'}
          {variant !== 'LIVRE' ? ' desta categoria' : ''}
        </p>
      )}

      {/* Footer: estado de seleção — Onda 12.7: mt-auto pra alinhar todos
          os footers na mesma linha, "selecionado" maior+verde+bold */}
      <div className={`mt-auto pt-3 border-t border-border/40 flex items-center justify-between ${
        selected ? '' : 'text-[11px] text-muted-foreground group-hover:text-foreground'
      }`}>
        {selected ? (
          <span className="flex items-center gap-1.5 text-base font-bold text-emerald-700">
            <Check size={18} strokeWidth={2.5} />
            Selecionado
          </span>
        ) : (
          <>
            <span>ver proposta</span>
            <ChevronDown size={12} />
          </>
        )}
      </div>
    </button>
  );
}

// ─── Onda 14.29 — Input de Entrada Opcional ────────────────────────
//
// Mini-card acima dos cards de pagamento. Operador digita valor (R$) que
// abate do total parcelavel. Cartao e Boleto parcelado recalculam parcelas
// sobre (total - entrada). PIX e Boleto a vista ignoram (sao pagamentos
// imediatos).
//
// Presets de % rapidos (10/20/30/50) facilitam negociacao. Slider opcional
// pra ajuste fino. Tudo local — nao persiste no banco, ferramenta de
// simulacao ao vivo.

function DownPaymentInput({
  total,
  value,
  onChange,
}: {
  total: number;
  value: number;
  onChange: (v: number) => void;
}) {
  // Onda 14.29 (fix) — Input fully controlled pelo parent. Antes tinhamos
  // state local `text` + useEffect pra sincronizar com value, o que disparava
  // "setState in effect" no lint. Agora derivamos text direto do value e
  // onChange comunica pro parent — sem state local nem effect.
  const text = value > 0 ? `R$ ${fmtBRL(value)}` : '';

  const handleChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    const num = digits === '' ? 0 : Number(digits) / 100;
    onChange(num);
  };

  const applyPercent = (pct: number) => {
    const v = Math.round(total * (pct / 100));
    onChange(v);
  };

  const clear = () => {
    onChange(0);
  };

  const hasEntry = value > 0;
  const remaining = Math.max(0, total - value);
  const pctOfTotal = hasEntry ? Math.round((value / total) * 100) : 0;

  return (
    <div className={`mb-3 p-3 rounded-lg border transition-colors ${
      hasEntry
        ? 'border-amber-500/50 bg-amber-500/5'
        : 'border-border border-dashed bg-muted/10'
    }`}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <DollarSign size={14} className={hasEntry ? 'text-amber-700' : 'text-muted-foreground'} />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground">
              Entrada opcional
              {hasEntry && (
                <span className="ml-2 text-[10px] font-normal text-amber-700">
                  ({pctOfTotal}% do total)
                </span>
              )}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {hasEntry
                ? <>
                    a parcelar: <strong className="text-foreground tabular-nums">R$ {fmtBRL(remaining)}</strong>
                    <span className="opacity-60"> · só afeta cartão e boleto parcelado</span>
                  </>
                : 'abate do total — cartão e boleto parcelado recalculam parcelas'}
            </p>
          </div>
        </div>

        <input
          type="text"
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="R$ 0,00"
          inputMode="numeric"
          className={`w-32 text-sm font-semibold tabular-nums px-3 py-1.5 rounded-md border bg-background text-right focus:outline-none focus:ring-2 ${
            hasEntry
              ? 'border-amber-500 focus:ring-amber-500/30'
              : 'border-border focus:ring-amber-500/30 focus:border-amber-500'
          }`}
        />

        <div className="flex items-center gap-1 shrink-0">
          {[10, 20, 30, 50].map((pct) => {
            const isActive = pctOfTotal === pct;
            return (
              <button
                key={pct}
                type="button"
                onClick={() => applyPercent(pct)}
                className={`text-[10px] font-semibold px-2 py-1 rounded border transition-colors ${
                  isActive
                    ? 'border-amber-600 bg-amber-500/15 text-amber-800'
                    : 'border-border bg-card hover:bg-accent'
                }`}
              >
                {pct}%
              </button>
            );
          })}
          {hasEntry && (
            <button
              type="button"
              onClick={clear}
              className="text-[10px] font-semibold px-2 py-1 rounded border border-border bg-card hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
              title="Remover entrada"
            >
              <X size={10} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Onda 14.58 — Sinal + Entrada + Inicio das parcelas ─────────────
//
// Card que aparece embaixo do DownPaymentInput quando customDownPayment > 0.
// Permite dividir a entrada em 2 boletos (sinal cobrado hoje via PIX/Boleto +
// entrada cobrada na data configuravel) + configurar quando comeca a 1a
// parcela.
//
// Comportamento padrao (sem mudar): se sinal=0 e datas vazias, gera 1 boleto
// de entrada + parcelas comecando em entrada+30d (igual antes da Onda 14.58).
function SignalDatesInput({
  totalEntrada,
  signalValue,
  signalMethod,
  entradaDueDate,
  installmentsStartDate,
  onChangeSignalValue,
  onChangeSignalMethod,
  onChangeEntradaDueDate,
  onChangeInstallmentsStartDate,
  /** Onda 14.59 — quote/perms pra renderizar botao "Emitir cobranca da entrada" */
  quoteId,
  canEmit,
  installmentCount,
  installmentValue,
  restMethod = 'BOLETO',
  onChangeRestMethod,
}: {
  totalEntrada: number;
  signalValue: number;
  signalMethod: 'PIX' | 'BOLETO' | 'CASH';
  entradaDueDate: string;
  installmentsStartDate: string;
  onChangeSignalValue: (v: number) => void;
  onChangeSignalMethod: (m: 'PIX' | 'BOLETO' | 'CASH') => void;
  onChangeEntradaDueDate: (d: string) => void;
  onChangeInstallmentsStartDate: (d: string) => void;
  quoteId?: string;
  canEmit?: boolean;
  /** Onda 15 (etapa 12) — qtd + valor da parcela do boleto selecionado, pra
   *  emitir o parcelado manualmente (botao "Emitir parcelas"). undefined =
   *  nao ha boleto parcelado selecionado → botao desabilitado. */
  installmentCount?: number;
  installmentValue?: number;
  restMethod?: 'PIX' | 'BOLETO' | 'CASH';
  onChangeRestMethod?: (m: 'PIX' | 'BOLETO' | 'CASH') => void;
}) {
  const [expanded, setExpanded] = useState(signalValue > 0 || !!entradaDueDate);
  // Onda 14.59.2 — Estado dos 3 botoes individuais (sinal/entrada/parcelas)
  const [emittingPart, setEmittingPart] = useState<null | 'SIGNAL' | 'REST' | 'INSTALLMENTS'>(null);
  const [emitResult, setEmitResult] = useState<{ ok: boolean; msg: string; charges?: any[] } | null>(null);
  // Link da cobranca por parte (apos emitir). Reapertar abre a 2a via existente — nao cria nova.
  const [partLink, setPartLink] = useState<{ SIGNAL?: string; REST?: string }>({});
  // Onda 15 (etapa 14) — Dados PIX por parte (QR + copia-cola). Quando preenchido,
  // o botao "2a via" abre o modal PixQrDialog em vez de redirecionar pro Asaas.
  type PixCacheData = { qrCode: string; copyPaste: string; amount: number; invoiceUrl?: string };
  const [partPix, setPartPix] = useState<{ SIGNAL?: PixCacheData; REST?: PixCacheData }>({});
  const [pixDialog, setPixDialog] = useState<null | (PixCacheData & { kind: 'SIGNAL' | 'REST' })>(null);

  const emitPart = async (part: 'SIGNAL' | 'REST' | 'INSTALLMENTS') => {
    if (!quoteId) return;
    setEmittingPart(part);
    setEmitResult(null);
    try {
      let data: any;
      if (part === 'INSTALLMENTS') {
        // Onda 15 (etapa 12) — Emite o parcelado via endpoint dedicado. A 1a
        // parcela vence em installmentsStartDate (ou +30d se vazio) e o Asaas
        // gera as demais a cada 30 dias conforme installmentCount. O backend
        // exige sinal+entrada PAGOS (retorna 400 com mensagem clara senao).
        if (!installmentCount || !installmentValue) {
          showError('Selecione a quantidade de parcelas no card do Boleto antes de emitir.');
          return;
        }
        const dueLabel = installmentsStartDate ? `1ª vence em ${installmentsStartDate}` : '1ª vence em ~30 dias';
        const ok = window.confirm(
          `Emitir ${installmentCount}x de R$ ${fmtBRL(installmentValue)} (${dueLabel}, demais a cada 30 dias)?\n\n` +
          `Isso gera boletos REAIS no Asaas. Só funciona se o sinal + entrada já estiverem pagos.`,
        );
        if (!ok) return;
        const { data: instData } = await api.post(`/quotes/${quoteId}/emit-installments`, {
          installmentCount,
          installmentValue,
          ...(installmentsStartDate ? { firstDueDate: installmentsStartDate } : {}),
        });
        const instCharges = instData?.charges ?? [];
        setEmitResult({
          ok: true,
          msg: instData?.idempotent
            ? 'Parcelas já estavam emitidas — não criou novas cobranças.'
            : `Parcelas emitidas: ${installmentCount}x de R$ ${fmtBRL(installmentValue)}.`,
          charges: instCharges,
        });
        showSuccess(instData?.idempotent ? 'Parcelas já emitidas' : 'Parcelas emitidas');
        return;
      }
      // Onda 15 (etapa 13) — SINAL em ESPÉCIE: confirma + emite + da baixa
      // num clique so (cria registro CASH no DB + chama mark-cash-received).
      // Backend e idempotente nos dois endpoints, entao cliques repetidos sao
      // seguros (retornam o registro existente).
      if (part === 'SIGNAL' && signalMethod === 'CASH') {
        const ok = window.confirm(
          `Registrar sinal R$ ${fmtBRL(signalValue)} como recebido em espécie?\n\n` +
          `Confirme que o paciente entregou o dinheiro em mãos. ` +
          `Isso cria o registro e já dá baixa.`,
        );
        if (!ok) return;
        const restValueLocal = Math.max(0, totalEntrada - signalValue);
        const cashBody: any = {
          signalValue,
          signalMethod,
          restValue: restValueLocal,
          restMethod,
          parts: ['SIGNAL'],
        };
        if (restValueLocal > 0 && entradaDueDate) cashBody.restDueDate = entradaDueDate;
        const { data: emitData } = await api.post(`/quotes/${quoteId}/emit-down-payment`, cashBody);
        // Procura especificamente o SINAL (idempotencia pode devolver SINAL+ENTRADA juntos).
        const cashCharge = (emitData?.charges ?? []).find((c: any) => c.kind === 'SINAL')
          || (emitData?.charges ?? [])[0];
        if (!cashCharge?.id) {
          showError('Falha ao criar registro do sinal em espécie.');
          return;
        }
        // Onda 15 (etapa 13.1) — Se ja existe um sinal PIX/BOLETO emitido, o
        // backend (idempotencia) retorna ele em vez de criar um CASH novo.
        // Espécie nao pode "dar baixa" num boleto/PIX do Asaas — o operador
        // precisa cancelar a cobranca anterior primeiro. Mostra mensagem clara.
        if (cashCharge.gateway !== 'CASH') {
          const tipo = cashCharge.billing_type || cashCharge.gateway || 'PIX/BOLETO';
          const msg = `Já existe um sinal emitido via ${tipo} no Asaas. ` +
            `Para registrar em espécie, cancele essa cobrança primeiro (aba Financeiro). ` +
            `Espécie fica registrada só no sistema, sem passar pelo Asaas.`;
          setEmitResult({ ok: false, msg });
          showError(msg);
          return;
        }
        const wasAlreadyReceived = !!cashCharge.received_in_cash;
        await api.post(`/charges/${cashCharge.id}/mark-cash-received`);
        const alreadyDone = wasAlreadyReceived || !!emitData?.idempotent;
        setEmitResult({
          ok: true,
          msg: alreadyDone
            ? 'Sinal em espécie já estava registrado como recebido.'
            : `Sinal R$ ${fmtBRL(signalValue)} registrado como recebido em espécie.`,
          charges: [cashCharge],
        });
        showSuccess(alreadyDone ? 'Sinal em espécie já registrado' : 'Sinal recebido em espécie registrado');
        return;
      }
      const restValue = Math.max(0, totalEntrada - signalValue);
      const body: any = {
        signalValue,
        signalMethod,
        restValue,
        restMethod,
        parts: [part],
      };
      if (restValue > 0 && entradaDueDate) body.restDueDate = entradaDueDate;
      ({ data } = await api.post(`/quotes/${quoteId}/emit-down-payment`, body));
      const charges = data?.charges ?? [];
      const partLabel = part === 'SIGNAL' ? 'Sinal' : 'Entrada';
      setEmitResult({
        ok: true,
        msg: data?.idempotent
          ? `${partLabel} ja estava emitido — abrindo 2a via (nao criou nova cobranca).`
          : `${partLabel} emitido com sucesso (${charges.length} cobranca).`,
        charges,
      });
      // Onda 15 (etapa 14) — Procura a charge da parte (idempotencia pode
      // devolver SINAL+ENTRADA juntos) e decide como mostrar:
      //  - PIX com QR populado: abre nosso PixQrDialog (cara da clinica)
      //  - resto (BOLETO ou PIX antigo sem QR): abre a 2a via via link
      const myKind = part === 'SIGNAL' ? 'SINAL' : 'ENTRADA';
      const myCharge = charges.find((c: any) => c.kind === myKind) || charges[0];
      if (myCharge?.billing_type === 'PIX' && myCharge?.pix_qr_code) {
        const pixObj = {
          qrCode: myCharge.pix_qr_code as string,
          copyPaste: (myCharge.pix_copy_paste as string) || '',
          amount: Number(myCharge.amount),
          invoiceUrl: (myCharge.invoice_url as string) || undefined,
        };
        setPartPix((prev) => ({ ...prev, [part]: pixObj }));
        setPixDialog({ ...pixObj, kind: part });
      } else {
        const link = myCharge?.invoice_url || myCharge?.boleto_url || null;
        if (link && (part === 'SIGNAL' || part === 'REST')) {
          setPartLink((prev) => ({ ...prev, [part]: link }));
          if (data?.idempotent && typeof window !== 'undefined') {
            window.open(link, '_blank', 'noopener,noreferrer');
          }
        }
      }
      showSuccess(data?.idempotent ? `${partLabel}: 2a via aberta` : `${partLabel} emitido`);
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || 'Erro desconhecido';
      setEmitResult({ ok: false, msg });
      showError(`Falha ao emitir: ${msg}`);
    } finally {
      setEmittingPart(null);
    }
  };

  const signalText = signalValue > 0 ? `R$ ${fmtBRL(signalValue)}` : '';
  const handleSignalChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    const num = digits === '' ? 0 : Number(digits) / 100;
    // Clamp ao totalEntrada (sinal nao pode ser maior que a entrada total)
    onChangeSignalValue(Math.min(num, totalEntrada));
  };
  const entradaBoletoValue = Math.max(0, totalEntrada - signalValue);

  return (
    <div className="mb-3 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
      >
        <Clock size={14} className="text-blue-700 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground">
            Plano de cobrança da entrada
            {signalValue > 0 && (
              <span className="ml-2 text-[10px] font-normal text-blue-700">
                · sinal R$ {fmtBRL(signalValue)} ({signalMethod}) +
                entrada R$ {fmtBRL(entradaBoletoValue)}
              </span>
            )}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {expanded
              ? 'Configure sinal + datas dos boletos abaixo. Vazios = comportamento padrão (1 entrada + parcelas em 30 dias).'
              : 'Clique pra dividir em sinal (hoje) + entrada (data X) e configurar início das parcelas'}
          </p>
        </div>
        <span className="text-blue-700 shrink-0">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {/* SINAL — parte paga hoje no fechamento */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-center">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-foreground">
                Sinal de fechamento
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                  (cobrado hoje)
                </span>
              </p>
              <p className="text-[10px] text-muted-foreground">
                Parte da entrada que o paciente paga no momento do fechamento.
                Resto vai no boleto da entrada.
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => onChangeSignalMethod('PIX')}
                className={`text-[10px] font-semibold px-2 py-1 rounded border transition-colors ${
                  signalMethod === 'PIX'
                    ? 'border-blue-600 bg-blue-500/15 text-blue-800'
                    : 'border-border bg-card hover:bg-accent'
                }`}
                title="Cobra via PIX (link/QR imediato)"
              >
                PIX
              </button>
              <button
                type="button"
                onClick={() => onChangeSignalMethod('BOLETO')}
                className={`text-[10px] font-semibold px-2 py-1 rounded border transition-colors ${
                  signalMethod === 'BOLETO'
                    ? 'border-blue-600 bg-blue-500/15 text-blue-800'
                    : 'border-border bg-card hover:bg-accent'
                }`}
                title="Cobra via Boleto vencendo hoje"
              >
                Boleto
              </button>
              <button
                type="button"
                onClick={() => onChangeSignalMethod('CASH')}
                className={`text-[10px] font-semibold px-2 py-1 rounded border transition-colors ${
                  signalMethod === 'CASH'
                    ? 'border-blue-600 bg-blue-500/15 text-blue-800'
                    : 'border-border bg-card hover:bg-accent'
                }`}
                title="Recebido em especie (operador confirma manualmente)"
              >
                Espécie
              </button>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="text"
                value={signalText}
                onChange={(e) => handleSignalChange(e.target.value)}
                placeholder="R$ 0,00"
                inputMode="numeric"
                className="w-28 text-sm font-semibold tabular-nums px-3 py-1.5 rounded-md border border-border bg-background text-right focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
              />
              {quoteId && canEmit && totalEntrada > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    partPix.SIGNAL
                      ? setPixDialog({ ...partPix.SIGNAL, kind: 'SIGNAL' })
                      : partLink.SIGNAL
                      ? window.open(partLink.SIGNAL, '_blank', 'noopener,noreferrer')
                      : emitPart('SIGNAL')
                  }
                  disabled={!!emittingPart || (!partPix.SIGNAL && !partLink.SIGNAL && signalValue <= 0)}
                  className={`inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-white text-[11px] font-bold shadow-sm transition-colors shrink-0 whitespace-nowrap disabled:bg-stone-300 disabled:text-stone-500 disabled:cursor-not-allowed ${(partPix.SIGNAL || partLink.SIGNAL) ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
                  title={partPix.SIGNAL ? 'Mostrar QR PIX de novo (não cria nova cobrança)' : partLink.SIGNAL ? 'Abrir 2ª via (não cria nova cobrança)' : signalValue <= 0 ? 'Configure um valor de sinal > 0' : signalMethod === 'CASH' ? `Registrar sinal R$ ${fmtBRL(signalValue)} como recebido em espécie (1 clique cria e dá baixa)` : `Emitir sinal R$ ${fmtBRL(signalValue)} (${signalMethod})`}
                >
                  {emittingPart === 'SIGNAL' ? <Loader2 size={11} className="animate-spin" /> : partPix.SIGNAL ? '📱 Ver QR' : partLink.SIGNAL ? '📄 2ª via' : signalMethod === 'CASH' ? '✓ Registrar recebido' : '💸 Emitir'}
                </button>
              )}
            </div>
          </div>

          {/* ENTRADA (boleto resto) — valor calculado + data */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-center">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-foreground">
                Entrada (boleto)
              </p>
              <p className="text-[10px] text-muted-foreground">
                R$ {fmtBRL(entradaBoletoValue)} · vencimento configurável (geralmente fim do mês)
              </p>
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0">Vence em:</span>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="date"
                value={entradaDueDate}
                onChange={(e) => onChangeEntradaDueDate(e.target.value)}
                className="w-36 text-xs px-2 py-1.5 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
              />
              {quoteId && canEmit && totalEntrada > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    partPix.REST
                      ? setPixDialog({ ...partPix.REST, kind: 'REST' })
                      : partLink.REST
                      ? window.open(partLink.REST, '_blank', 'noopener,noreferrer')
                      : emitPart('REST')
                  }
                  disabled={!!emittingPart || (!partPix.REST && !partLink.REST && (entradaBoletoValue <= 0 || !entradaDueDate))}
                  className={`inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-white text-[11px] font-bold shadow-sm transition-colors shrink-0 whitespace-nowrap disabled:bg-stone-300 disabled:text-stone-500 disabled:cursor-not-allowed ${(partPix.REST || partLink.REST) ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
                  title={partPix.REST ? 'Mostrar QR PIX de novo (não cria nova cobrança)' : partLink.REST ? 'Abrir 2ª via (não cria nova cobrança)' : entradaBoletoValue <= 0 ? 'Sinal cobre toda a entrada — nao ha restante' : !entradaDueDate ? 'Defina a data de vencimento da entrada' : `Emitir entrada R$ ${fmtBRL(entradaBoletoValue)} (${restMethod})`}
                >
                  {emittingPart === 'REST' ? <Loader2 size={11} className="animate-spin" /> : partPix.REST ? '📱 Ver QR' : partLink.REST ? '📄 2ª via' : '💸 Emitir'}
                </button>
              )}
            </div>
          </div>

          {/* INICIO DAS PARCELAS */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-center pt-2 border-t border-blue-500/20">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-foreground">
                Parcelas começam em
              </p>
              <p className="text-[10px] text-muted-foreground">
                Data de vencimento da 1ª parcela. Próximas vencem a cada 30 dias.
              </p>
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0">1ª parcela:</span>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="date"
                value={installmentsStartDate}
                onChange={(e) => onChangeInstallmentsStartDate(e.target.value)}
                className="w-36 text-xs px-2 py-1.5 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
              />
            </div>
          </div>

          {/* Onda 14.59.2 — botoes movidos pra cada linha de cobranca acima.
              Aqui fica so a nota explicativa. */}
          {quoteId && canEmit && totalEntrada > 0 && (
            <p className="text-[10px] text-muted-foreground pt-2 border-t border-blue-500/20">
              Sinal e entrada são emitidos nos botões acima (idempotente: não re-emite se já existe).
              As parcelas começam na data definida e são geradas automaticamente ao aprovar — o Asaas escalona as demais a cada 30 dias.
            </p>
          )}

          {/* Onda 14.59 — Resultado da emissao */}
          {emitResult && (
            <div className={`p-2 rounded text-[11px] ${
              emitResult.ok
                ? 'bg-emerald-500/10 text-emerald-700 border border-emerald-500/30'
                : 'bg-red-500/10 text-red-700 border border-red-500/30'
            }`}>
              <p className="font-semibold">{emitResult.ok ? '✓ ' : '✗ '}{emitResult.msg}</p>
              {emitResult.ok && emitResult.charges && emitResult.charges.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {emitResult.charges.map((c: any) => (
                    <li key={c.id} className="opacity-80">
                      • {c.kind === 'SINAL' ? 'Sinal' : 'Entrada'}: R$ {fmtBRL(Number(c.amount))} ({c.billing_type})
                      {c.boleto_url && <a href={c.boleto_url} target="_blank" rel="noreferrer" className="ml-2 underline">[boleto]</a>}
                      {c.invoice_url && <a href={c.invoice_url} target="_blank" rel="noreferrer" className="ml-2 underline">[link]</a>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Resumo do plano */}
          {(signalValue > 0 || entradaDueDate || installmentsStartDate) && (
            <div className="mt-2 pt-2 border-t border-blue-500/20 text-[10px] text-muted-foreground space-y-0.5">
              <p>📋 <strong className="text-foreground">Plano configurado:</strong></p>
              {signalValue > 0 && (
                <p>
                  • Sinal: <strong className="text-foreground">R$ {fmtBRL(signalValue)}</strong>{' '}
                  ({signalMethod}, hoje)
                </p>
              )}
              {entradaBoletoValue > 0 && (
                <p>
                  • Entrada: <strong className="text-foreground">R$ {fmtBRL(entradaBoletoValue)}</strong>{' '}
                  (boleto{entradaDueDate ? `, vence ${entradaDueDate}` : ', vence amanhã'})
                </p>
              )}
              <p>
                • Parcelas: começam{' '}
                <strong className="text-foreground">
                  {installmentsStartDate || 'em 30 dias após a entrada'}
                </strong>
              </p>
            </div>
          )}
        </div>
      )}

      {/* Onda 15 (etapa 14) — Modal "profissional" do PIX (QR + copia-cola) */}
      {pixDialog && (
        <PixQrDialog
          qrCode={pixDialog.qrCode}
          copyPaste={pixDialog.copyPaste}
          amount={pixDialog.amount}
          invoiceUrl={pixDialog.invoiceUrl}
          title={pixDialog.kind === 'SIGNAL' ? 'Sinal via PIX' : 'Entrada via PIX'}
          subtitle="Escaneie o QR Code abaixo. Após o pagamento, a proposta é confirmada automaticamente."
          onClose={() => setPixDialog(null)}
        />
      )}
    </div>
  );
}

// ─── Onda 14.30 — Card "Contrato" no painel da proposta ─────────────
//
// Renderizado abaixo do Boleto. Permite o operador:
//   1. Escolher documentos extras pra incluir no contrato (TCLE/LGPD ja sao
//      core, sempre incluidos). Opcionais: USO_IMAGEM, GARANTIA, RESPONSAVEL_LEGAL,
//      AGENDAMENTO, RESCISAO
//   2. Pre-visualizar PDF do contrato (com os docs selecionados)
//   3. Criar contrato (vira DRAFT com selected_documents persistido)
//   4. Apos criado: mostra status atual + acoes (enviar via ClickSign,
//      marcar manualmente, cancelar)
//
// Estado:
//   - SEM CONTRATO: lista de checkboxes + botao "Criar contrato"
//   - COM CONTRATO DRAFT/SENT/etc: mini-status + botoes de acao
//   - COM CONTRATO SIGNED: confirmado, mostra timestamps
//   - COM CONTRATO SKIPPED/CANCELLED: estado terminal, opcao de criar novo

interface ContractDocument {
  id: string;
  label: string;
  description: string;
  /** Core (sempre incluido) ou opcional (operador escolhe) */
  core?: boolean;
  /** Onda 14.31 — agrupamento visual: GERAL | PROCEDIMENTO */
  category?: 'GERAL' | 'PROCEDIMENTO';
}

const CONTRACT_DOCUMENTS: ContractDocument[] = [
  // ── Core (sempre incluídos) ──
  { id: 'CONTRATO_PRINCIPAL', label: 'Contrato principal', description: 'qualificação, objeto, valor e cláusulas específicas', core: true },
  { id: 'TCLE', label: 'TCLE — Termo de Consentimento', description: 'consentimento livre e esclarecido sobre o tratamento', core: true },
  { id: 'LGPD', label: 'Termo LGPD', description: 'tratamento de dados pessoais e clínicos', core: true },

  // ── Termos gerais (opcionais) ──
  { id: 'USO_IMAGEM', label: 'Autorização de uso de imagem', description: 'fotos antes/depois, redes sociais, portfólio', category: 'GERAL' },
  { id: 'GARANTIA', label: 'Garantia estendida (24 meses)', description: 'cobertura ampliada de defeitos técnicos', category: 'GERAL' },
  { id: 'RESPONSAVEL_LEGAL', label: 'Responsável legal', description: 'paciente menor de idade ou incapaz', category: 'GERAL' },
  { id: 'AGENDAMENTO', label: 'Cláusula de agendamento e faltas', description: 'política de cancelamento e remarcação', category: 'GERAL' },
  { id: 'RESCISAO', label: 'Cláusula de rescisão antecipada', description: 'condições pra encerrar contrato antes do fim', category: 'GERAL' },

  // ── Termos por procedimento (Onda 14.31 — modelos da clínica) ──
  { id: 'CLAREAMENTO', label: 'Termo de Clareamento Dental', description: 'sensibilidade, sessões, manutenção do clareamento', category: 'PROCEDIMENTO' },
  { id: 'FACETAS_RESINA', label: 'Termo de Facetas de Resina', description: 'estética, longevidade, manutenção das facetas', category: 'PROCEDIMENTO' },
  { id: 'LAMINADOS_CERAMICOS', label: 'Termo de Laminados Cerâmicos / Lentes', description: 'desgaste mínimo, mock-up, garantia da cerâmica', category: 'PROCEDIMENTO' },
  { id: 'PROTESE', label: 'Termo de Prótese', description: 'adaptação, manutenção, ajustes pós-instalação', category: 'PROCEDIMENTO' },
  { id: 'ENDODONTIA_ADULTO', label: 'Termo de Endodontia (Canal) — Adulto', description: 'tratamento de canal e suas etapas', category: 'PROCEDIMENTO' },
  { id: 'ENDODONTIA_MENOR', label: 'Termo de Endodontia (Canal) — Paciente menor', description: 'tratamento de canal em paciente menor de idade', category: 'PROCEDIMENTO' },
  { id: 'EXTRACAO_ADULTO', label: 'Termo de Extração — Adulto', description: 'exodontia, riscos e cuidados pós-operatórios', category: 'PROCEDIMENTO' },
  { id: 'EXTRACAO_MENOR', label: 'Termo de Extração — Paciente menor', description: 'exodontia em paciente menor de idade', category: 'PROCEDIMENTO' },
  { id: 'IMPLANTE', label: 'Termo de Implante Dentário', description: 'etapas cirúrgicas, osseointegração, prótese definitiva', category: 'PROCEDIMENTO' },
  { id: 'RESTAURACAO', label: 'Termo de Restauração', description: 'restaurações estéticas e funcionais', category: 'PROCEDIMENTO' },
];

interface ContractMinimal {
  id: string;
  status: 'DRAFT' | 'SENT' | 'OPENED' | 'PATIENT_SIGNED' | 'SIGNED' | 'EXPIRED' | 'CANCELLED';
  skipped: boolean;
  template_type: string;
  selected_documents: string[];
  signing_url: string | null;
  sent_at: string | null;
  signed_at: string | null;
  cancelled_at: string | null;
}

function ContratoCard({ quoteId }: { quoteId: string }) {
  const [contract, setContract] = useState<ContractMinimal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(
    () => new Set(CONTRACT_DOCUMENTS.filter((d) => d.core).map((d) => d.id)),
  );
  // Onda 14.35 — Card colapsavel. Comeca recolhido pra nao poluir o painel
  // (operador pode passar bastante tempo configurando pagamento antes de
  // pensar em contrato). Clica no header pra expandir.
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<ContractMinimal | null>(`/quotes/${quoteId}/contract`);
      if (data) {
        setContract(data);
        // Sincroniza checkboxes com docs ja persistidos
        const persisted = Array.isArray(data.selected_documents) ? data.selected_documents : [];
        const coreIds = CONTRACT_DOCUMENTS.filter((d) => d.core).map((d) => d.id);
        setSelectedDocs(new Set([...coreIds, ...persisted]));
      } else {
        setContract(null);
      }
    } catch {
      // Sem contrato e estado valido (operador ainda nao criou)
      setContract(null);
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => { load(); }, [load]);

  const toggleDoc = (id: string) => {
    const doc = CONTRACT_DOCUMENTS.find((d) => d.id === id);
    if (doc?.core) return; // core nao pode ser desmarcado
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createContract = async () => {
    setBusy(true);
    try {
      // Envia apenas os extras (TCLE/LGPD/CONTRATO_PRINCIPAL ja sao incluidos
      // automaticamente no PDF — backend ignora se vierem aqui).
      const extras = Array.from(selectedDocs).filter(
        (id) => !CONTRACT_DOCUMENTS.find((d) => d.id === id)?.core,
      );
      const { data } = await api.post<ContractMinimal>(
        `/quotes/${quoteId}/contract`,
        { selected_documents: extras },
      );
      setContract(data);
      showSuccess('Contrato criado — pronto pra enviar');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao criar contrato');
    } finally {
      setBusy(false);
    }
  };

  const previewPdf = async (id: string) => {
    try {
      const res = await api.get(`/contracts/${id}/preview-pdf`, { responseType: 'blob' });
      const blob = new Blob([res.data], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao gerar PDF');
    }
  };

  const action = async (path: string) => {
    if (!contract) return;
    setBusy(true);
    try {
      const { data } = await api.post<ContractMinimal>(`/contracts/${contract.id}/${path}`, {});
      setContract(data);
      showSuccess('Contrato atualizado');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao atualizar contrato');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="mb-3 p-3 rounded-lg border border-border bg-muted/10 flex items-center text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin mr-2" />
        Carregando contrato...
      </div>
    );
  }

  // ── ESTADO: SEM CONTRATO — picker de documentos + criar ─────────
  if (!contract) {
    const extrasSelected = Array.from(selectedDocs).filter(
      (id) => !CONTRACT_DOCUMENTS.find((d) => d.id === id)?.core,
    ).length;
    const totalSelected = CONTRACT_DOCUMENTS.filter((d) => d.core).length + extrasSelected;
    return (
      <div className="mb-3 rounded-lg border border-border bg-card overflow-hidden">
        {/* Onda 14.35 — Header clicavel pra expandir/colapsar */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full px-3 py-2.5 flex items-center justify-between gap-2 hover:bg-accent/30 transition-colors text-left"
        >
          <p className="text-xs font-semibold flex items-center gap-1.5">
            <FileText size={13} className="text-amber-700" />
            Contrato de tratamento
            <span className="text-[10px] font-normal text-muted-foreground italic">
              · {expanded ? 'escolha os documentos pra assinatura' : 'clique pra escolher os documentos'}
            </span>
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] text-muted-foreground">
              {totalSelected} documentos selecionados
            </span>
            <ChevronDown
              size={14}
              className={`text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </div>
        </button>

        {/* Onda 14.35 — Conteudo so visivel quando expandido */}
        {!expanded ? null : (
        <div className="px-3 pb-3 pt-1 border-t border-border/40">

        {/* Onda 14.31 — Agrupado em 3 secoes: core (sempre incluso), termos
            gerais (opcionais) e termos por procedimento (modelos da clinica). */}
        {(['CORE', 'GERAL', 'PROCEDIMENTO'] as const).map((section) => {
          const docs = CONTRACT_DOCUMENTS.filter((d) =>
            section === 'CORE' ? d.core : d.category === section,
          );
          if (docs.length === 0) return null;
          const sectionLabel = {
            CORE: 'Sempre incluídos',
            GERAL: 'Termos gerais',
            PROCEDIMENTO: 'Termos por procedimento',
          }[section];
          return (
            <div key={section} className="mb-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1.5">
                {sectionLabel}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                {docs.map((doc) => {
                  const isChecked = selectedDocs.has(doc.id);
                  const isCore = !!doc.core;
                  return (
                    <label
                      key={doc.id}
                      className={`flex items-start gap-2 p-2 rounded border text-[11px] cursor-pointer transition-colors ${
                        isChecked
                          ? isCore
                            ? 'bg-muted/40 border-border opacity-80'
                            : 'bg-amber-500/5 border-amber-500/40'
                          : 'border-border bg-card hover:bg-accent/30'
                      } ${isCore ? 'cursor-not-allowed' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isCore || busy}
                        onChange={() => toggleDoc(doc.id)}
                        className="w-3.5 h-3.5 mt-0.5 rounded border-border accent-amber-600 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-foreground flex items-center gap-1.5 flex-wrap">
                          {doc.label}
                          {isCore && (
                            <span className="text-[9px] font-normal px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 uppercase tracking-wide">
                              sempre incluso
                            </span>
                          )}
                        </p>
                        <p className="text-muted-foreground leading-tight text-[10px]">{doc.description}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={createContract}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 inline-flex items-center gap-1.5 font-semibold"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
            Criar contrato
          </button>
        </div>
        </div>
        )}
      </div>
    );
  }

  // ── ESTADO: COM CONTRATO — mostra status + acoes ────────────────
  const statusLabel: Record<ContractMinimal['status'], { label: string; cls: string }> = {
    DRAFT: { label: 'Pronto pra enviar', cls: 'bg-muted text-muted-foreground' },
    SENT: { label: 'Aguardando paciente', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300' },
    OPENED: { label: 'Paciente abriu', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-950/30 dark:text-sky-300' },
    PATIENT_SIGNED: { label: 'Paciente assinou', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-950/30 dark:text-sky-300' },
    SIGNED: { label: 'Assinado por ambos', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' },
    EXPIRED: { label: 'Expirado', cls: 'bg-muted text-muted-foreground' },
    CANCELLED: { label: 'Cancelado', cls: 'bg-destructive/10 text-destructive' },
  };
  const status = contract.skipped
    ? { label: 'Pulado (operador dispensou)', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300' }
    : statusLabel[contract.status];
  const docsCount = (contract.selected_documents?.length ?? 0)
    + CONTRACT_DOCUMENTS.filter((d) => d.core).length;
  const isTerminal = contract.skipped || contract.status === 'SIGNED' || contract.status === 'CANCELLED' || contract.status === 'EXPIRED';

  return (
    <div className={`mb-3 p-3 rounded-lg border ${
      contract.status === 'SIGNED'
        ? 'border-emerald-500/40 bg-emerald-500/5'
        : contract.status === 'CANCELLED' || contract.status === 'EXPIRED'
        ? 'border-border bg-muted/20'
        : 'border-amber-500/40 bg-amber-500/5'
    }`}>
      <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
        <p className="text-xs font-semibold flex items-center gap-1.5">
          <FileText size={13} className="text-amber-700" />
          Contrato de tratamento
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${status.cls}`}>
            {status.label}
          </span>
        </p>
        <span className="text-[10px] text-muted-foreground">
          {docsCount} documentos
          {contract.sent_at && (
            <> · enviado {new Date(contract.sent_at).toLocaleDateString('pt-BR')}</>
          )}
        </span>
      </div>

      {/* Link do ClickSign se disponivel */}
      {contract.signing_url && (
        <div className="mb-2 p-1.5 bg-sky-500/5 border border-sky-500/30 rounded text-[10px] flex items-center gap-2">
          <Send size={10} className="text-sky-700 shrink-0" />
          <a
            href={contract.signing_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-700 hover:underline truncate flex-1"
            title={contract.signing_url}
          >
            {contract.signing_url}
          </a>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(contract.signing_url || '');
              showSuccess('Link copiado');
            }}
            className="px-1.5 py-0.5 rounded border border-sky-300 hover:bg-sky-100 shrink-0"
          >
            copiar
          </button>
        </div>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => previewPdf(contract.id)}
          className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent inline-flex items-center gap-1"
        >
          <Eye size={10} /> Pré-visualizar PDF
        </button>

        {!isTerminal && contract.status === 'DRAFT' && (
          <>
            <button
              type="button"
              onClick={() => action('send-clicksign')}
              disabled={busy}
              className="text-[11px] px-2 py-1 rounded bg-sky-600 text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1 font-medium"
            >
              <Send size={10} /> Enviar via ClickSign
            </button>
            <button
              type="button"
              onClick={() => action('send')}
              disabled={busy}
              className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1"
            >
              Manual
            </button>
          </>
        )}

        {!isTerminal && contract.status === 'PATIENT_SIGNED' && (
          <button
            type="button"
            onClick={() => action('sign-clinic')}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1 font-medium"
          >
            <Check size={10} /> Clínica assinar
          </button>
        )}

        {!isTerminal && contract.status !== 'DRAFT' && contract.status !== 'PATIENT_SIGNED' && (
          <button
            type="button"
            onClick={() => action('sign-patient')}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1"
          >
            Marcar paciente assinou
          </button>
        )}

        {!isTerminal && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Cancelar contrato atual? Você pode criar um novo depois.')) {
                action('cancel');
              }
            }}
            disabled={busy}
            className="ml-auto text-[11px] px-2 py-1 rounded border border-border hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 inline-flex items-center gap-1"
          >
            <X size={10} /> Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Painel inline: proposta selecionada com pagamento + acoes ──────
// Onda 9 — renderiza abaixo dos cards quando alguma versao esta selecionada.
// Reune items (top-4 + expand), opcoes de pagamento, resumo da oferta e acoes
// de negociacao (ajustar / contraproposta / enviar pro paciente).

function PropostaPainel({
  loading,
  detail,
  priority,
  activePaymentKey,
  onChangePayment,
  itemsExpanded,
  onToggleItems,
  onClose,
  onAjustar,
  onSend,
  sending,
  onSaveCounter,
  onOpenCreditCheck,
  onOpenCreditCheckForParcelas,
  onAddBonus,
  onApproveAndBill,
  onToggleRequiresCreditCheck,
  onChooseAsProposal,
  onUnchooseAsProposal,
}: {
  loading: boolean;
  detail: QuoteDetailLite | null;
  priority: Priority | null;
  activePaymentKey: string;
  onChangePayment: (key: string) => void;
  itemsExpanded: boolean;
  onToggleItems: () => void;
  onClose: () => void;
  onAjustar: () => void;
  onSend: () => void;
  sending: boolean;
  /** Onda 10 — abre dialog pra registrar a oferta atual como contraproposta */
  onSaveCounter: () => void;
  /** Onda 12 — abre dialog de credit-check do Financiamento Banco PASSOS */
  onOpenCreditCheck: () => void;
  /** Onda 14.4 — abre credit-check com N parcelas pre-selecionadas */
  onOpenCreditCheckForParcelas: (params: {
    installments: number;
    customDownPayment?: number;
    /** Onda 14.58 — sinal + datas customizadas */
    signalValue?: number;
    signalMethod?: 'PIX' | 'BOLETO' | 'CASH';
    entradaDueDate?: string;
    installmentsStartDate?: string;
  }) => void;
  /** Onda 13 — abre dialog pra adicionar bônus de fechamento */
  onAddBonus: () => void;
  /** Onda 14.5 — abre confirm + chama POST /quotes/:id/approve-and-bill */
  onApproveAndBill: (extras?: {
    customDownPayment?: number;
    customSignalValue?: number;
    customSignalMethod?: 'PIX' | 'BOLETO' | 'CASH';
    customEntradaDueDate?: string;
    customInstallmentsStartDate?: string;
  }) => void;
  /** Onda 14.26 — toggle "exige consulta de credito" no card de boleto.
   *  Quando false, parcelados aplicam direto sem credit-check. */
  onToggleRequiresCreditCheck?: (value: boolean) => void;
  /** Onda 14.33 — Marca esta proposta como "escolhida" pra aguardar
   *  decisao do paciente. So uma por paciente.
   *  Onda 14.38 — recebe payment_key + down_payment pra persistir a forma
   *  de pagamento + entrada apresentada (vai pro PDF do orcamento). */
  onChooseAsProposal?: (opts?: {
    payment_key?: string | null;
    down_payment?: number | null;
    signal_value?: number | null;
    signal_method?: string | null;
    entrada_due_date?: string | null;
    installments_start_date?: string | null;
  }) => void;
  /** Onda 14.33 — Desmarca a escolhida (volta ao estado neutro). */
  onUnchooseAsProposal?: () => void;
}) {
  // Onda 14.29 (fix) — Hooks DEVEM ser declarados antes de qualquer early return
  // (rules-of-hooks). Antes estavam apos `if (!detail) return null` e quebravam
  // o build na production.
  //
  // Entrada opcional (em R$). Operador digita um valor que abate do total
  // parcelavel. PIX e Boleto a vista ignoram. Cartao e Boleto parcelado
  // recalculam parcelas em cima de (total - entrada).
  //
  // Onda 14.56 — agora PERSISTE entre sessoes:
  //  1. Se a proposta foi marcada como escolhida, o backend salvou em
  //     chosen_down_payment. Restauramos esse valor ao carregar.
  //  2. Senao, restauramos do localStorage (operador digitou mas nao salvou
  //     ainda — comum quando o paciente esta pensando e o operador volta
  //     pra outra aba e depois retorna).
  //  3. Toda mudanca no campo grava em localStorage automatico.
  const [customDownPayment, setCustomDownPayment] = useState<number>(0);
  // Onda 14.58 — Sinal (parte da entrada paga no fechamento via PIX/Boleto)
  // + datas de vencimento configuraveis pra entrada e inicio das parcelas.
  // Persistencia: localStorage por quote_id (mesma logica do customDownPayment).
  const [customSignalValue, setCustomSignalValue] = useState<number>(0);
  const [customSignalMethod, setCustomSignalMethod] = useState<'PIX' | 'BOLETO' | 'CASH'>('PIX');
  const [customEntradaDueDate, setCustomEntradaDueDate] = useState<string>('');
  const [customInstallmentsStartDate, setCustomInstallmentsStartDate] = useState<string>('');
  // Onda 15 (etapa 8) — modais de parcelamento abertos pelos cards de Cartao
  // e Boleto. Clicar no card abre a "aba" de parcelas; ao escolher, o card
  // passa a expor a quantidade selecionada na propria face.
  const [cartaoModalOpen, setCartaoModalOpen] = useState(false);
  const [boletoModalOpen, setBoletoModalOpen] = useState(false);
  const detailIdRef = useRef<string | null>(null);

  // Restaura valor ao trocar de quote ou recarregar
  useEffect(() => {
    const currentDetailId = detail?.id ?? null;
    if (detailIdRef.current === currentDetailId) return;
    detailIdRef.current = currentDetailId;

    if (!currentDetailId) {
      setCustomDownPayment(0);
      setCustomSignalValue(0);
      setCustomEntradaDueDate('');
      setCustomInstallmentsStartDate('');
      return;
    }

    // 1) Banco (chosen_down_payment) tem prioridade — operador ja marcou como proposta
    const fromDb = Number(detail?.chosen_down_payment) || 0;
    if (fromDb > 0) {
      setCustomDownPayment(fromDb);
    } else {
      // 2) localStorage — operador digitou mas nao marcou
      try {
        const raw = localStorage.getItem(`quote_down_payment_${currentDetailId}`);
        const parsed = raw ? Number(raw) : 0;
        setCustomDownPayment(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
      } catch {
        setCustomDownPayment(0);
      }
    }

    // Onda 14.58 — Restaura sinal + datas.
    // Onda 15 (etapa 16.8) — Banco (campos chosen_*) tem prioridade sobre
    // localStorage, porque foi explicitamente salvo pelo operador via
    // "Salvar proposta" e persiste entre dispositivos/browsers.
    const dbSignalValue = Number(detail?.chosen_signal_value) || 0;
    const dbSignalMethod = detail?.chosen_signal_method;
    const dbEntradaDate = detail?.chosen_entrada_due_date;
    const dbInstStartDate = detail?.chosen_installments_start_date;
    const dbHasAny = dbSignalValue > 0 || dbSignalMethod || dbEntradaDate || dbInstStartDate;

    if (dbHasAny) {
      setCustomSignalValue(dbSignalValue);
      if (dbSignalMethod === 'PIX' || dbSignalMethod === 'BOLETO' || dbSignalMethod === 'CASH') {
        setCustomSignalMethod(dbSignalMethod);
      }
      // dbEntradaDate e dbInstStartDate vem como string ISO ("2026-06-21T00:...")
      // ou puro "2026-06-21". Pega so YYYY-MM-DD pra alimentar <input type="date">.
      setCustomEntradaDueDate(dbEntradaDate ? String(dbEntradaDate).slice(0, 10) : '');
      setCustomInstallmentsStartDate(dbInstStartDate ? String(dbInstStartDate).slice(0, 10) : '');
    } else {
      // Fallback pra localStorage (rascunho nao salvo ainda)
      try {
        const sigRaw = localStorage.getItem(`quote_signal_${currentDetailId}`);
        if (sigRaw) {
          const parsed = JSON.parse(sigRaw);
          if (parsed.value > 0) setCustomSignalValue(Number(parsed.value));
          if (parsed.method === 'PIX' || parsed.method === 'BOLETO' || parsed.method === 'CASH') {
            setCustomSignalMethod(parsed.method);
          }
          if (parsed.entradaDueDate) setCustomEntradaDueDate(String(parsed.entradaDueDate));
          if (parsed.installmentsStartDate) {
            setCustomInstallmentsStartDate(String(parsed.installmentsStartDate));
          }
        } else {
          setCustomSignalValue(0);
          setCustomEntradaDueDate('');
          setCustomInstallmentsStartDate('');
        }
      } catch {
        setCustomSignalValue(0);
      }
    }
  }, [
    detail?.id,
    detail?.chosen_down_payment,
    detail?.chosen_signal_value,
    detail?.chosen_signal_method,
    detail?.chosen_entrada_due_date,
    detail?.chosen_installments_start_date,
  ]);

  // Onda 14.58 — Persiste sinal + datas em localStorage (chave separada
  // do customDownPayment pra nao quebrar fluxo legado).
  useEffect(() => {
    const id = detail?.id;
    if (!id) return;
    try {
      const hasValue =
        customSignalValue > 0 || customEntradaDueDate || customInstallmentsStartDate;
      if (hasValue) {
        localStorage.setItem(
          `quote_signal_${id}`,
          JSON.stringify({
            value: customSignalValue,
            method: customSignalMethod,
            entradaDueDate: customEntradaDueDate,
            installmentsStartDate: customInstallmentsStartDate,
          }),
        );
      } else {
        localStorage.removeItem(`quote_signal_${id}`);
      }
    } catch {
      /* ignore */
    }
  }, [
    customSignalValue,
    customSignalMethod,
    customEntradaDueDate,
    customInstallmentsStartDate,
    detail?.id,
  ]);

  // Persiste no localStorage a cada mudanca (key escopada por quote id)
  useEffect(() => {
    const id = detail?.id;
    if (!id) return;
    try {
      if (customDownPayment > 0) {
        localStorage.setItem(`quote_down_payment_${id}`, String(customDownPayment));
      } else {
        localStorage.removeItem(`quote_down_payment_${id}`);
      }
    } catch {
      // localStorage cheio ou desabilitado — silencioso, nao bloqueia UX
    }
  }, [customDownPayment, detail?.id]);

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        Carregando proposta...
      </div>
    );
  }
  if (!detail) return null;

  const cfg = priority ? PRIORITY_CONFIG[priority] : null;
  const totalBruto = Number(detail.total_value);
  // Onda 11.1 — items aprovados in-place (approved_at != null) sao o que o
  // paciente ja topou e vai pagar. Proposta de pagamento e sobre esses items.
  // Pendentes ficam de fora (paciente ainda nao topou).
  const approvedItems = detail.items.filter((it) => !!it.approved_at);
  const pendingItems = detail.items.filter((it) => !it.approved_at);
  const approvedValue = approvedItems.reduce((acc, it) => acc + Number(it.total_price), 0);
  const pendingValue = pendingItems.reduce((acc, it) => acc + Number(it.total_price), 0);
  const hasPartialApproval = approvedItems.length > 0;
  // Base usada pra calcular formas de pagamento — usa o ja aprovado.
  const total = hasPartialApproval ? approvedValue : totalBruto;

  const options = buildPaymentOptions();
  // Onda 14.29 (fix) — removidos activeOption/activeCalc que sobraram da
  // Onda 14.28 (resumo "voce esta oferecendo" foi removido). Cada card de
  // pagamento (PIX/Cartao/Boleto) calcula seu proprio valor internamente.

  // Onda 11.1 — Ordena itens: aprovados primeiro (incluidos nesta proposta de
  // pagamento), pendentes depois (em aberto, nao incluidos).
  const itemsSorted = hasPartialApproval
    ? [...approvedItems, ...pendingItems]
    : detail.items;
  const topItems = itemsSorted.slice(0, 4);
  const remainingItems = itemsSorted.slice(4);
  const hasMore = remainingItems.length > 0;

  // Validade em dias (se valid_until existir).
  // Onda 14.29 (fix) — Date.now() no render dispara react-hooks/purity.
  // Uso aqui e legitimo (mostrar "X dias pra expirar" na UI). Em re-renders
  // normais nao causa flicker — `daysValid` so muda quando o dia vira.
  /* eslint-disable react-hooks/purity */
  const daysValid = detail.valid_until
    ? Math.max(0, Math.round((new Date(detail.valid_until).getTime() - Date.now()) / 86400000))
    : null;
  /* eslint-enable react-hooks/purity */

  return (
    <div className={`bg-card border-2 rounded-xl p-4 ${cfg?.selectedBorderCls || 'border-border'}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3 pb-3 border-b border-border">
        <div className="min-w-0 flex-1">
          <h3 className={`text-sm font-bold flex items-center gap-2 ${cfg?.iconCls || ''}`}>
            {cfg?.icon}
            {/* Onda 14.18 — adiciona o identificador unificado (#NNN) na frente
                do titulo da proposta pra operador localizar o mesmo orcamento
                nas outras abas. Antes mostrava so a priority. */}
            <span className="font-mono text-xs text-primary">
              {getQuoteNumberBadge(detail) || ''}
            </span>
            <span>
              Proposta — {cfg?.label || getQuoteDisplayName(detail) || 'sem prioridade'}
            </span>
          </h3>
          {/* Onda 14.18 — sub-titulo com o nome do orcamento (title) sempre
              visivel, abaixo do label de priority. */}
          <p className="text-[11px] text-foreground/80 mt-0.5 truncate" title={getQuoteDisplayName(detail)}>
            {getQuoteDisplayName(detail)}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {hasPartialApproval ? (
              <>
                <span className="text-emerald-700 font-semibold">
                  {approvedItems.length} aprovado{approvedItems.length === 1 ? '' : 's'}
                </span>
                {' · '}
                {pendingItems.length} em aberto
                {' · '}base R$ {fmtBRL(total)}
                {' '}<span className="text-muted-foreground">(do que foi aprovado)</span>
              </>
            ) : (
              <>
                {detail.items.length} {detail.items.length === 1 ? 'item' : 'itens'}
                {' · '}base R$ {fmtBRL(total)}
              </>
            )}
            {daysValid !== null && ` · validade ${daysValid} dia${daysValid === 1 ? '' : 's'}`}
          </p>
          {/* Banner: items ainda em aberto (nao incluidos nesta proposta) */}
          {hasPartialApproval && pendingItems.length > 0 && (
            <p className="text-[10px] text-amber-800 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-1 mt-1.5 inline-flex items-center gap-1.5">
              <AlertTriangle size={10} />
              <strong>R$ {fmtBRL(pendingValue)}</strong> em {pendingItems.length} item{pendingItems.length === 1 ? '' : 's'} ainda em aberto · fora desta proposta
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-1 -mr-1 -mt-1 shrink-0"
          aria-label="Fechar painel"
        >
          <X size={16} />
        </button>
      </div>

      {/* Onda 14.24 — Painel "Proximos passos" foi DESATIVADO em 14.24.1 (operador
          pediu pra remover do painel da proposta). Componente + backend continuam
          intactos pra reativar fácil: descomentar o bloco abaixo. Schema Contract
          + endpoints + ContractsService permanecem no projeto pra outros consumos
          futuros (Fase 3+). */}
      {/*
      {detail.status === 'ACCEPTED' && (
        <div className="mb-4">
          <ProximosPassosTimeline
            quoteId={detail.id}
            quoteTitle={getQuoteDisplayName(detail)}
            quoteTotal={Number(detail.total_value || 0)}
            quoteNumberBadge={getQuoteNumberBadge(detail) || undefined}
            onGenerateBilling={onApproveAndBill}
          />
        </div>
      )}
      */}

      {/* Items list — Onda 11.1: items aprovados ficam com check verde + opacity */}
      <div className="mb-4">
        <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          O que está incluído
        </p>
        <ul className="space-y-1">
          {(itemsExpanded ? itemsSorted : topItems).map((it) => {
            const isApproved = !!it.approved_at;
            // Onda 11.1 — quando ha aprovacao parcial, items pendentes ficam
            // sinalizados como "em aberto" (badge amber) mas totalmente legiveis.
            // Aprovados recebem check verde. Sem aprovacao parcial, tudo normal.
            const isOutOfProposal = hasPartialApproval && !isApproved;
            return (
              <li
                key={it.id}
                className="flex items-baseline justify-between text-xs py-1 border-b border-border/30 last:border-0"
              >
                <span className="text-foreground truncate pr-2 flex items-center gap-1.5">
                  {isApproved && hasPartialApproval && (
                    <Check size={11} className="text-emerald-600 shrink-0" aria-label="aprovado" />
                  )}
                  <span>{it.procedure.name}</span>
                  {it.notes && (
                    <span className="text-muted-foreground"> · {it.notes}</span>
                  )}
                  {isOutOfProposal && (
                    <span className="text-[9px] text-amber-700 font-semibold bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                      em aberto
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground tabular-nums shrink-0">
                  R$ {fmtBRL(Number(it.total_price))}
                </span>
              </li>
            );
          })}
        </ul>
        {hasMore && (
          <button
            type="button"
            onClick={onToggleItems}
            className="text-[11px] text-primary hover:underline mt-1.5"
          >
            {itemsExpanded
              ? '− mostrar menos'
              : `+ ${remainingItems.length} outros itens · clique pra expandir`}
          </button>
        )}
      </div>

      {/* Onda 15 (etapa 7) — Entrada opcional + datas foram movidas pra DENTRO
          da secao "Como o paciente quer pagar?" abaixo: so aparecem ao escolher
          Cartao parcelado ou Boleto financiado (PIX/avista nao usam entrada). */}

      {/* === Onda 15 — Comparativo "Como o paciente quer pagar?" ===
          3 cards lado a lado (PIX / Cartao / Boleto) pra apresentar ao paciente.
          Clicar seleciona a forma; entrada + parcelas aparecem abaixo so ao
          escolher Cartao/Boleto. */}
      {(() => {
        const pixOpt = options.avista[0];
        const pixCalc = pixOpt ? applyPaymentOption(total, pixOpt) : null;
        const cartaoOpt = options.cartao.find((o: any) => o.installments === 6);
        const cartaoCalc = cartaoOpt ? applyPaymentOption(total, cartaoOpt, customDownPayment) : null;
        const boletoOpt = options.parcelado.find((o: any) => o.installments === 10 && !o.isAVistaHighlight);
        const boletoCalc = boletoOpt ? applyPaymentOption(total, boletoOpt, customDownPayment) : null;
        const sel = !activePaymentKey
          ? null
          : activePaymentKey === 'pix'
          ? 'pix'
          : activePaymentKey.startsWith('cartao-')
          ? 'cartao'
          : (activePaymentKey === 'boleto-avista' || activePaymentKey.startsWith('parcelado-'))
          ? 'boleto'
          : null;
        // Onda 15 (etapa 8) — opcao REALMENTE selecionada (pra expor a
        // quantidade de parcelas na face do card). Default = comparacao 6x/10x.
        const activeCartaoOpt = options.cartao.find((o: any) => o.key === activePaymentKey);
        const cartaoDisplayOpt = activeCartaoOpt || cartaoOpt;
        const cartaoDisplayCalc = cartaoDisplayOpt ? applyPaymentOption(total, cartaoDisplayOpt, customDownPayment) : null;
        const activeBoletoOpt = options.parcelado.find((o: any) => o.key === activePaymentKey);
        const boletoDisplayOpt = activeBoletoOpt || boletoOpt;
        const boletoDisplayCalc = boletoDisplayOpt ? applyPaymentOption(total, boletoDisplayOpt, customDownPayment) : null;
        const requiresCC = detail.requires_credit_check !== false;
        return (
          <div className="mb-5">
            <p className="text-sm font-bold text-foreground mb-2">Como o paciente quer pagar?</p>
            {/* Onda 15 (etapa 8) — 3 cards. PIX seleciona direto. Cartao e
                Boleto ABREM a aba de parcelamento (modal) ao clicar; ao escolher,
                a face do card passa a expor a quantidade de parcelas selecionada. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-stretch">
              {/* PIX ou dinheiro */}
              {pixCalc && (
                <button type="button" onClick={() => onChangePayment(pixOpt.key)}
                  className={`text-left p-4 rounded-xl border-2 transition-colors ${
                    sel === 'pix'
                      ? 'border-emerald-500 bg-emerald-500/10'
                      : 'border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10'
                  }`}>
                  <p className="text-xs font-semibold text-foreground mb-1 flex items-center gap-2 flex-wrap">
                    PIX ou dinheiro
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-600 text-white">Melhor opção</span>
                    {sel === 'pix' && <Check size={12} className="text-emerald-600" />}
                  </p>
                  <p className="text-2xl font-extrabold tabular-nums text-emerald-700">R$ {fmtBRL(pixCalc.finalValue)}</p>
                  <p className="text-[11px] text-emerald-700 font-medium mt-1">↓ economiza R$ {fmtBRL(pixCalc.savedValue)} (-{pixOpt.discountPercent}%)</p>
                </button>
              )}

              {/* Cartão de crédito — clique abre a aba de parcelas */}
              {cartaoDisplayCalc && cartaoDisplayOpt && (
                <button type="button"
                  onClick={() => { if (sel !== 'cartao') onChangePayment(cartaoDisplayOpt.key); setCartaoModalOpen(true); }}
                  className={`text-left p-4 rounded-xl border-2 transition-colors ${
                    sel === 'cartao'
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-border bg-card hover:bg-accent/40'
                  }`}>
                  {sel === 'cartao' ? (
                    <>
                      <p className="text-xs font-semibold text-foreground mb-1 flex items-center gap-1.5">
                        <DollarSign size={13} className="text-blue-600" />
                        Cartão · {cartaoDisplayOpt.installments}x
                        <Check size={12} className="text-blue-600" />
                      </p>
                      {cartaoDisplayCalc.downPaymentValue > 0 && (
                        <p className="text-[10px] text-muted-foreground mb-0.5">entrada R$ {fmtBRL(cartaoDisplayCalc.downPaymentValue)} +</p>
                      )}
                      <p className="text-2xl font-extrabold tabular-nums text-blue-700">{cartaoDisplayOpt.installments}x de R$ {fmtBRL(cartaoDisplayCalc.installmentValue)}</p>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        total R$ {fmtBRL(cartaoDisplayCalc.finalValue)} · {cartaoDisplayCalc.extraInterest > 0 ? <span className="text-amber-700 font-semibold">+R$ {fmtBRL(cartaoDisplayCalc.extraInterest)} juros</span> : <span className="text-emerald-700 font-semibold">sem juros</span>} · <span className="text-blue-600 font-semibold">trocar ▾</span>
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-semibold text-foreground mb-1">Cartão de crédito</p>
                      <p className="text-2xl font-extrabold tabular-nums text-foreground">R$ {fmtBRL(cartaoDisplayCalc.finalValue)}</p>
                      <p className="text-[11px] text-muted-foreground mt-1">até 6x sem juros · clique pra escolher ▾</p>
                    </>
                  )}
                </button>
              )}

              {/* Boleto financiado — clique abre a aba de parcelas */}
              {boletoDisplayCalc && boletoDisplayOpt && (
                <button type="button"
                  onClick={() => setBoletoModalOpen(true)}
                  className={`text-left p-4 rounded-xl border-2 transition-colors ${
                    sel === 'boleto'
                      ? 'border-amber-500 bg-amber-500/10'
                      : 'border-border bg-card hover:bg-accent/40'
                  }`}>
                  {sel === 'boleto' ? (
                    boletoDisplayOpt.key === 'boleto-avista' ? (
                      <>
                        <p className="text-xs font-semibold text-foreground mb-1 flex items-center gap-1.5">
                          <Building2 size={13} className="text-amber-600" />
                          Boleto · à vista
                          <Check size={12} className="text-amber-600" />
                        </p>
                        <p className="text-2xl font-extrabold tabular-nums text-amber-700">R$ {fmtBRL(boletoDisplayCalc.finalValue)}</p>
                        <p className="text-[11px] text-muted-foreground mt-1">à vista · <span className="text-emerald-700 font-semibold">sem juros</span> · <span className="text-amber-700 font-semibold">trocar ▾</span></p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs font-semibold text-foreground mb-1 flex items-center gap-1.5">
                          <Building2 size={13} className="text-amber-600" />
                          Boleto · {boletoDisplayOpt.installments}x
                          <Check size={12} className="text-amber-600" />
                        </p>
                        {boletoDisplayCalc.downPaymentValue > 0 && (
                          <p className="text-[10px] text-muted-foreground mb-0.5">entrada R$ {fmtBRL(boletoDisplayCalc.downPaymentValue)} +</p>
                        )}
                        <p className="text-2xl font-extrabold tabular-nums text-amber-700">{boletoDisplayOpt.installments}x de R$ {fmtBRL(boletoDisplayCalc.installmentValue)}<span className="text-sm font-bold">/mês</span></p>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          total R$ {fmtBRL(boletoDisplayCalc.finalValue)}{boletoDisplayCalc.extraInterest > 0 ? <> · <span className="text-amber-700 font-semibold">+R$ {fmtBRL(boletoDisplayCalc.extraInterest)} juros</span></> : ''} · <span className="text-amber-700 font-semibold">trocar ▾</span>
                        </p>
                      </>
                    )
                  ) : (
                    <>
                      <p className="text-xs font-semibold text-foreground mb-1">Boleto financiado</p>
                      <p className="text-2xl font-extrabold tabular-nums text-amber-700">R$ {fmtBRL(boletoDisplayCalc.finalValue)}</p>
                      <p className="text-[11px] text-amber-700 mt-1">parcele em 1x a 24x · clique pra escolher ▾</p>
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Entrada + plano — abaixo, so ao escolher Cartao/Boleto.
                O SELETOR de parcelas vive na aba (modal) aberta pelo card. */}
            {(sel === 'cartao' || sel === 'boleto') && (
              <div className="mt-3 space-y-3">
                <DownPaymentInput
                  total={total}
                  value={customDownPayment}
                  onChange={setCustomDownPayment}
                />
                {customDownPayment > 0 && (
                  <SignalDatesInput
                    totalEntrada={customDownPayment}
                    signalValue={customSignalValue}
                    signalMethod={customSignalMethod}
                    entradaDueDate={customEntradaDueDate}
                    installmentsStartDate={customInstallmentsStartDate}
                    onChangeSignalValue={setCustomSignalValue}
                    onChangeSignalMethod={setCustomSignalMethod}
                    onChangeEntradaDueDate={setCustomEntradaDueDate}
                    onChangeInstallmentsStartDate={setCustomInstallmentsStartDate}
                    quoteId={detail.id}
                    canEmit={true}
                    installmentCount={sel === 'boleto' && boletoDisplayOpt && boletoDisplayOpt.key !== 'boleto-avista' ? boletoDisplayOpt.installments : undefined}
                    installmentValue={sel === 'boleto' && boletoDisplayOpt && boletoDisplayOpt.key !== 'boleto-avista' && boletoDisplayCalc ? boletoDisplayCalc.installmentValue : undefined}
                  />
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground mt-2">
              ⓘ Cartão e boleto: clique no card pra escolher as parcelas · a opção escolhida fica exposta na face do card.
            </p>

            {/* Abas de parcelamento (modais) abertas pelos cards de Cartao/Boleto */}
            {cartaoModalOpen && (
              <CartaoInstallmentsModal
                options={options.cartao}
                total={total}
                activePaymentKey={activePaymentKey}
                onSelect={(key) => { onChangePayment(key); setCartaoModalOpen(false); }}
                onClose={() => setCartaoModalOpen(false)}
                customDownPayment={customDownPayment}
              />
            )}
            {boletoModalOpen && (
              <BoletoInstallmentsModal
                options={options.parcelado}
                total={total}
                activePaymentKey={activePaymentKey}
                onSelect={(opt) => {
                  setBoletoModalOpen(false);
                  // Mesma logica do CardBoletoParcelado: a vista / VIP aplica
                  // direto; parcelado >= 2x abre a consulta de credito.
                  if (opt.key === 'boleto-avista' || !requiresCC) {
                    onChangePayment(opt.key);
                  } else {
                    onOpenCreditCheckForParcelas({
                      installments: opt.installments,
                      customDownPayment,
                      signalValue: customSignalValue,
                      signalMethod: customSignalMethod,
                      entradaDueDate: customEntradaDueDate,
                      installmentsStartDate: customInstallmentsStartDate,
                    });
                  }
                }}
                onClose={() => setBoletoModalOpen(false)}
                requiresCreditCheck={requiresCC}
                onToggleRequiresCreditCheck={onToggleRequiresCreditCheck}
                customDownPayment={customDownPayment}
              />
            )}
          </div>
        );
      })()}

      {/* Onda 15 (etapa 2) — Detalhe/ajuste da forma escolhida agora vive
          DENTRO da fileira comparativa acima (bloco "sel !== null"). Os
          antigos blocos duplicados (CardCartao/CardBoletoParcelado soltos
          aqui) foram removidos pra nao renderizar 2x a mesma coisa. */}

      {/* Onda 14.30 — Card de Contrato (abaixo do boleto). Operador escolhe
          quais documentos vao ser incluidos pra assinatura (TCLE/USO_IMAGEM/
          LGPD/GARANTIA/RESPONSAVEL_LEGAL/etc) e cria o contrato.
          Onda 14.34 — Agora aparece em DRAFT/SENT tambem (nao so ACCEPTED).
          Operador pode preparar o contrato durante a negociacao — assinatura
          NAO e mais obrigatoria pra aprovar/cobrar (gate desativado em 14.34). */}
      <ContratoCard quoteId={detail.id} />

      {/* Onda 14.28 — Removido: resumo "voce esta oferecendo" e botoes
          "Ajustar" / "Salvar contraproposta" (pedido do operador).
          Handlers onAjustar/onSaveCounter continuam disponiveis como props
          pra reativacao futura, mas sem botoes visiveis na UI. */}

      {/* Ações */}
      <div className="mt-4 pt-3 border-t border-border flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={onAddBonus}
          className="text-xs px-3 py-2 rounded-lg border border-amber-500/50 bg-amber-500/5 text-amber-800 hover:bg-amber-500/15 flex items-center gap-1.5"
          title="Segurar a proposta com bônus de fechamento"
        >
          <Gift size={12} />
          Adicionar bônus
        </button>

        {/* Onda 14.33 — Salvar proposta (aguardando decisão do paciente).
            Destaca esta proposta + esmaece as outras na lista de cards.
            Onda 14.38 — Persiste forma de pagamento ativa + entrada pra
            que o PDF mostre a oferta exata apresentada ao paciente. */}
        {!detail.is_chosen_proposal ? (
          <button
            type="button"
            onClick={() => onChooseAsProposal?.({
              payment_key: activePaymentKey || null,
              down_payment: customDownPayment > 0 ? customDownPayment : 0,
              // Onda 15 (etapa 16.8) — salva tambem o plano de cobranca
              // completo (sinal, metodo, datas) pra operador nao perder.
              signal_value: customSignalValue > 0 ? customSignalValue : null,
              signal_method: customSignalValue > 0 ? customSignalMethod : null,
              entrada_due_date: customEntradaDueDate || null,
              installments_start_date: customInstallmentsStartDate || null,
            })}
            className="text-xs px-3 py-2 rounded-lg border border-amber-500/50 bg-amber-500/5 text-amber-800 hover:bg-amber-500/15 flex items-center gap-1.5 ml-auto"
            title="Marca esta proposta como a escolhida — fica em destaque, demais ficam esmaecidas. Forma de pagamento e entrada atuais ficam salvos."
          >
            <Clock size={12} />
            Salvar proposta
          </button>
        ) : (
          <>
            {/* Onda 15 (etapa 16.8) — quando ja esta como "Aguardando paciente",
                permite RE-SALVAR (atualizar a config) sem desmarcar. */}
            <button
              type="button"
              onClick={() => onChooseAsProposal?.({
                payment_key: activePaymentKey || null,
                down_payment: customDownPayment > 0 ? customDownPayment : 0,
                signal_value: customSignalValue > 0 ? customSignalValue : null,
                signal_method: customSignalValue > 0 ? customSignalMethod : null,
                entrada_due_date: customEntradaDueDate || null,
                installments_start_date: customInstallmentsStartDate || null,
              })}
              className="text-xs px-3 py-2 rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-900 hover:bg-amber-500/20 flex items-center gap-1.5 ml-auto"
              title="Re-salva o plano de cobrança atual (sinal, datas, entrada, forma de pagamento) sem desmarcar"
            >
              <Clock size={12} />
              Salvar alterações
            </button>
            <button
              type="button"
              onClick={onUnchooseAsProposal}
              className="text-xs px-3 py-2 rounded-lg border border-amber-600 bg-amber-500 text-amber-950 hover:bg-amber-600 flex items-center gap-1.5 font-semibold"
              title="Desmarcar como escolhida (volta ao estado neutro)"
            >
              <Check size={12} />
              Aguardando paciente · desmarcar
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          className="text-xs px-3 py-2 rounded-lg border border-emerald-500/50 bg-emerald-500/5 text-emerald-800 hover:bg-emerald-500/15 disabled:opacity-60 disabled:cursor-wait flex items-center gap-1.5"
          title="Envia link da proposta pro paciente abrir e decidir"
        >
          {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Enviar pro paciente
        </button>
        {/* Onda 14.5 — Aprovar proposta + gerar cobranca real.
            Onda 15 (etapa 16) — passa estado da entrada/sinal/datas pro
            handler, pra dar suporte ao "parcelado com consulta dispensada"
            (chama apply-financing direto no parent). */}
        <button
          type="button"
          onClick={() => onApproveAndBill({
            customDownPayment,
            customSignalValue,
            customSignalMethod,
            customEntradaDueDate,
            customInstallmentsStartDate,
          })}
          className="text-xs px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center gap-1.5 font-semibold shadow-sm"
          title="Fecha o orçamento e gera cobrança PIX/Cartão/Boleto no Asaas"
        >
          <Check size={12} />
          Aprovar e cobrar
        </button>
      </div>

      {/* Onda 13 — Bônus de fechamento (ativos e expirados) */}
      <BonusesHistory notes={detail.notes} />

      {/* Onda 10 — Histórico de contrapropostas (parseado de notes) */}
      <CounterProposalsHistory notes={detail.notes} />
    </div>
  );
}

/** Onda 11.5 — Card de cartao de credito com dropdown inline pra escolher
 *  quantidade de parcelas (1x ate 12x). Estilo equivalente aos cards de
 *  "a vista". Click no card alterna dropdown; click numa parcela marca
 *  ativo + fecha dropdown. */
function CardCartao({
  options,
  total,
  activePaymentKey,
  onChangePayment,
  customDownPayment = 0,
}: {
  options: PaymentOption[];
  total: number;
  activePaymentKey: string;
  onChangePayment: (key: string) => void;
  /** Onda 14.29 — entrada opcional digitada pelo operador. Recalcula
   *  parcelas em cima de (total - entrada). Default 0 = sem entrada. */
  customDownPayment?: number;
}) {
  const [open, setOpen] = useState(false);
  // Detecta se ja ha cartao ativo. Senao, usa default 1x pra display.
  const active = options.find((o) => o.key === activePaymentKey);
  const display = active || options[0]; // 1x default pra preview
  const calc = applyPaymentOption(total, display, customDownPayment);
  const isSelected = !!active;

  return (
    <div className="flex flex-col">
      <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
        Cartão de crédito — 1x a 6x sem juros · 7x a 12x com juros PagBank
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex-1 p-4 rounded-lg border text-left transition-colors relative ${
          isSelected
            ? 'border-sky-500 bg-sky-500/10 ring-2 ring-sky-500/20'
            : 'border-border hover:bg-accent/40 hover:border-sky-300'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <DollarSign size={13} />
              {isSelected ? `Cartão · ${display.installments}x` : 'Cartão de crédito'}
            </p>
            {/* Onda 14.29 — quando ha entrada custom, mostra "entrada R$ X +" acima */}
            {calc.downPaymentValue > 0 && (
              <p className="text-[10px] text-muted-foreground mb-0.5">
                entrada R$ {fmtBRL(calc.downPaymentValue)} +
              </p>
            )}
            <p className="text-2xl font-bold tabular-nums text-sky-700">
              {display.installments}x de R$ {fmtBRL(calc.installmentValue)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              total R$ {fmtBRL(calc.finalValue)} ·{' '}
              {(display.interestRate ?? 0) === 0 ? (
                <span className="text-emerald-700 font-semibold">sem juros</span>
              ) : (
                <span className="text-amber-700 font-semibold">
                  +R$ {fmtBRL(calc.extraInterest)} juros
                </span>
              )}
            </p>
          </div>
          <span
            className={`text-muted-foreground transition-transform shrink-0 mt-0.5 ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          >
            <ChevronDown size={14} />
          </span>
        </div>
        {!isSelected && (
          <span className="absolute top-2 right-8 text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">
            clique pra escolher
          </span>
        )}
      </button>

      {/* Onda 12.4 — Modal overlay (era dropdown inline). UX premium estilo
          Mercado Pago / Asaas — ganha credibilidade do paciente */}
      {open && (
        <CartaoInstallmentsModal
          options={options}
          total={total}
          activePaymentKey={activePaymentKey}
          onSelect={(key) => {
            onChangePayment(key);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          customDownPayment={customDownPayment}
        />
      )}
    </div>
  );
}

/** Onda 12.4 — Modal premium pra escolher parcelas do cartao.
 *  Substitui o dropdown inline anterior. UX inspirado em Mercado Pago / Asaas:
 *  overlay grande centralizado, header destacado, tabela com mais "ar". */
function CartaoInstallmentsModal({
  options,
  total,
  activePaymentKey,
  onSelect,
  onClose,
  customDownPayment = 0,
}: {
  options: PaymentOption[];
  total: number;
  activePaymentKey: string;
  onSelect: (key: string) => void;
  onClose: () => void;
  /** Onda 14.29 — entrada opcional pra recalcular parcelas em cada linha */
  customDownPayment?: number;
}) {
  return (
    <ModalPortal>
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl max-w-4xl w-full overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header destacado com gradient sutil */}
        <div className="px-6 py-4 border-b border-border bg-gradient-to-r from-sky-500/10 to-sky-500/5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-lg bg-sky-500/15 flex items-center justify-center">
                  <DollarSign size={16} className="text-sky-700" />
                </div>
                <h3 className="text-base font-bold text-foreground">
                  Cartão de crédito
                </h3>
              </div>
              <p className="text-xs text-muted-foreground ml-10">
                Escolha em quantas vezes deseja parcelar
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1.5 -mr-1 hover:bg-accent/50 rounded-md transition-colors"
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          </div>

          {/* Bandeiras aceitas (placeholder via texto + ícones de cartão) */}
          <div className="flex items-center gap-2 mt-3 ml-10 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
              Aceitamos:
            </span>
            {['Visa', 'Mastercard', 'Hipercard', 'American Express', 'Elo'].map((b) => (
              <span
                key={b}
                className="text-[10px] px-2 py-0.5 rounded border border-border bg-card text-foreground font-medium"
              >
                {b}
              </span>
            ))}
          </div>
        </div>

        {/* Resumo do valor */}
        <div className="px-6 py-3 bg-muted/20 border-b border-border flex items-baseline justify-between gap-3">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            Valor total
          </span>
          <span className="text-lg font-bold tabular-nums text-foreground">
            R$ {fmtBRL(total)}
          </span>
        </div>

        {/* Cabeçalho da tabela.
            Onda 14.57 — coluna direita renomeada pra "Total no cartão" (era
            apenas "Total"). Valor mostrado agora exclui a entrada — mostra so a
            soma das parcelas. Antes incluia entrada e ficava artificialmente
            alto comparado ao Valor Total do tratamento. */}
        <div className="grid grid-cols-[80px_1fr_auto] gap-4 px-6 py-2 text-[10px] uppercase tracking-wide text-muted-foreground font-bold border-b border-border bg-muted/10">
          <span>Parcelas</span>
          <span>Valor de cada parcela</span>
          <span className="text-right">Total no cartão</span>
        </div>

        {/* Linhas */}
        <ul className="flex-1 min-h-0 overflow-y-auto">
          {options.map((opt) => {
            const isActive = activePaymentKey === opt.key;
            // Onda 14.29 — aplica entrada custom no calculo de cada linha
            const c = applyPaymentOption(total, opt, customDownPayment);
            const hasInterest = (opt.interestRate ?? 0) > 0;
            return (
              <li key={opt.key}>
                <button
                  type="button"
                  onClick={() => onSelect(opt.key)}
                  className={`w-full grid grid-cols-[80px_1fr_auto] gap-4 px-6 py-3 text-left transition-colors border-b border-border/40 last:border-0 ${
                    isActive
                      ? 'bg-sky-500/10 hover:bg-sky-500/15'
                      : 'hover:bg-accent/40'
                  }`}
                >
                  <span className={`text-base tabular-nums ${isActive ? 'font-bold text-sky-700' : 'font-medium text-foreground'}`}>
                    {opt.installments}x
                  </span>
                  <span className="text-sm tabular-nums">
                    {c.downPaymentValue > 0 && (
                      <span className="text-[10px] text-muted-foreground block leading-tight">
                        entrada R$ {fmtBRL(c.downPaymentValue)} +
                      </span>
                    )}
                    de{' '}
                    <strong className={isActive ? 'text-sky-700' : 'text-foreground'}>
                      R$ {fmtBRL(c.installmentValue)}
                    </strong>{' '}
                    {!hasInterest ? (
                      <span className="text-emerald-700 text-xs font-medium">sem juros</span>
                    ) : (
                      <span className="text-amber-700 text-xs font-medium">com juros</span>
                    )}
                  </span>
                  {/* Onda 14.57 — exibe apenas a soma das parcelas (sem
                      entrada). Antes era c.finalValue (entrada + parcelas)
                      e ficava artificialmente alto vs o Valor Total do topo. */}
                  <span className="text-sm tabular-nums text-right text-muted-foreground">
                    R$ {fmtBRL(c.finalValue - c.downPaymentValue)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Rodapé: segurança + nota de juros */}
        <div className="px-6 py-3 bg-muted/20 border-t border-border space-y-1">
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck size={11} className="text-emerald-700" />
            Pagamento processado de forma segura pelo Asaas + PagBank
          </p>
          <p className="text-[10px] text-muted-foreground">
            Taxa de juros 3,59% a.m. da PagBank aplicada nas parcelas de 7x a 12x.
          </p>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

/** Onda 11.8 — Card de boleto parcelado reclinavel. Por padrao colapsado pra
 *  nao ficar exposto ao paciente — abre apenas quando operador quer propor
 *  essa alternativa (prazo maior com entrada + juros).
 *  Onda 12 — agora abre dialog de credit-check ao inves de dropdown inline. */
function CardBoletoParcelado({
  options,
  total,
  activePaymentKey,
  onChangePayment,
  onOpenCreditCheckForParcelas,
  requiresCreditCheck,
  onToggleRequiresCreditCheck,
  customDownPayment = 0,
  customSignalValue,
  customSignalMethod,
  customEntradaDueDate,
  customInstallmentsStartDate,
}: {
  options: PaymentOption[];
  total: number;
  activePaymentKey: string;
  onChangePayment: (key: string) => void;
  /** Onda 14.4 — abre credit-check com N parcelas pre-selecionadas (>= 2x) */
  onOpenCreditCheckForParcelas: (params: {
    installments: number;
    customDownPayment?: number;
    /** Onda 14.58 — sinal + datas customizadas */
    signalValue?: number;
    signalMethod?: 'PIX' | 'BOLETO' | 'CASH';
    entradaDueDate?: string;
    installmentsStartDate?: string;
  }) => void;
  /** Onda 14.26 — quando true (default), parcelados >= 1x abrem credit-check.
   *  Quando false (cliente VIP / valor baixo), aplicam direto sem consulta. */
  requiresCreditCheck: boolean;
  /** Onda 14.26 — toggle persiste via PATCH /quotes/:id no parent. */
  onToggleRequiresCreditCheck?: (value: boolean) => void;
  /** Onda 14.29 — entrada opcional pra recalcular parcelas */
  customDownPayment?: number;
  /** Onda 14.58 — sinal + datas customizadas (opcionais) */
  customSignalValue?: number;
  customSignalMethod?: 'PIX' | 'BOLETO' | 'CASH';
  customEntradaDueDate?: string;
  customInstallmentsStartDate?: string;
}) {
  const [open, setOpen] = useState(false);
  const activeIdx = options.findIndex((o) => o.key === activePaymentKey);
  const isSelected = activeIdx >= 0;
  const active = isSelected ? options[activeIdx] : null;
  const activeCalc = active ? applyPaymentOption(total, active, customDownPayment) : null;

  const handleSelectInstallment = (opt: PaymentOption) => {
    setOpen(false);
    // Onda 14.25 — Boleto à vista (key=boleto-avista): aplica direto sem
    // credit-check (pagamento imediato, 10% desconto, sem risco).
    // Onda 14.26 — Quando requiresCreditCheck=false (toggle off pelo
    // operador), TODAS as opcoes aplicam direto sem consulta. Util pra
    // clientes VIP / valor baixo. Operador assume o risco.
    if (opt.key === 'boleto-avista' || !requiresCreditCheck) {
      onChangePayment(opt.key);
    } else {
      // Onda 14.56 — propaga a entrada custom pro CreditCheckDialog.
      // Onda 14.58 — tambem propaga sinal + datas pra dividir cobranca.
      onOpenCreditCheckForParcelas({
        installments: opt.installments,
        customDownPayment,
        signalValue: customSignalValue,
        signalMethod: customSignalMethod,
        entradaDueDate: customEntradaDueDate,
        installmentsStartDate: customInstallmentsStartDate,
      });
    }
  };

  return (
    <div className="mb-3">
      {/* Onda 14.26 — Toggle "Exigir consulta de credito ao parcelar".
          Quando off, parcelados aplicam direto sem credit-check (operador
          assume risco — util pra cliente VIP / valor baixo). */}
      {onToggleRequiresCreditCheck && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
          <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={requiresCreditCheck}
              onChange={(e) => onToggleRequiresCreditCheck(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-border accent-amber-600 cursor-pointer"
            />
            <span>
              Exigir consulta de crédito ao parcelar
              {!requiresCreditCheck && (
                <span className="text-amber-700 italic"> · operador assume risco</span>
              )}
            </span>
          </label>
          {!requiresCreditCheck && (
            <span className="text-[10px] text-amber-700 font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 shrink-0">
              consulta dispensada
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`w-full p-3 rounded-lg border text-left transition-colors relative ${
          isSelected
            ? 'border-amber-500 bg-amber-500/10'
            : 'border-border bg-muted/10 hover:bg-accent/40 hover:border-amber-300 border-dashed'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold flex items-center gap-1.5 mb-0.5">
              <Building2 size={11} className="text-amber-700" />
              Boleto · Financiamento Banco PASSOS
              {!isSelected && (
                <span className="text-[10px] font-normal text-muted-foreground italic ml-1">
                  (1x à vista sem juros · 2x-24x com juros)
                </span>
              )}
            </p>
            {isSelected && active && activeCalc ? (
              <>
                <p className="text-sm font-bold tabular-nums">
                  {active.installments}x{' '}
                  {activeCalc.downPaymentValue > 0
                    ? `· entrada R$ ${fmtBRL(activeCalc.downPaymentValue)} + R$ ${fmtBRL(activeCalc.installmentValue)}/mês`
                    : active.installments === 1
                    ? `· R$ ${fmtBRL(activeCalc.finalValue)} à vista`
                    : `· R$ ${fmtBRL(activeCalc.installmentValue)}/mês`}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  total R$ {fmtBRL(activeCalc.finalValue)}
                  {activeCalc.extraInterest > 0 && (
                    <> · +R$ {fmtBRL(activeCalc.extraInterest)} juros</>
                  )}
                  {active.installments === 1 && ' · sem juros'}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                clique para ver opções de 1x até 24x · 2x+ exige aprovação de crédito
              </p>
            )}
          </div>
          <span className="text-amber-700 shrink-0 mt-0.5">
            <ChevronDown size={14} />
          </span>
        </div>
      </button>

      {/* Onda 14.4 — Modal de tabela com 1x ate 24x, igual ao do cartao */}
      {open && (
        <BoletoInstallmentsModal
          options={options}
          total={total}
          activePaymentKey={activePaymentKey}
          onSelect={handleSelectInstallment}
          onClose={() => setOpen(false)}
          requiresCreditCheck={requiresCreditCheck}
          customDownPayment={customDownPayment}
        />
      )}
    </div>
  );
}

/** Onda 14.4 — Modal premium pra escolher parcelas do Boleto.
 *  Estilo igual ao CartaoInstallmentsModal. Click numa linha >= 2x dispara
 *  consulta de credito (Banco PASSOS). */
function BoletoInstallmentsModal({
  options,
  total,
  activePaymentKey,
  onSelect,
  onClose,
  requiresCreditCheck,
  onToggleRequiresCreditCheck,
  customDownPayment = 0,
}: {
  options: PaymentOption[];
  total: number;
  activePaymentKey: string;
  /** Onda 14.25 — agora recebe a opcao inteira pra distinguir boleto-avista
   *  (key especifica, sem credit-check) das demais. */
  onSelect: (opt: PaymentOption) => void;
  onClose: () => void;
  /** Onda 14.26 — quando false, exibe "consulta dispensada" em vez de
   *  "exige consulta" nas linhas parcelados. UI apenas — logica de
   *  application esta no handleSelectInstallment do CardBoletoParcelado. */
  requiresCreditCheck: boolean;
  /** Onda 15 (etapa 9) — toggle da consulta de credito agora vive DENTRO
   *  do modal do boleto (operador liga/desliga a exigencia aqui). */
  onToggleRequiresCreditCheck?: (value: boolean) => void;
  /** Onda 14.29 — entrada opcional pra recalcular parcelas em cada linha */
  customDownPayment?: number;
}) {
  // Onda 14.25 — Separa a opcao destacada (boleto a vista) das demais
  // (1x..24x parcelado). A primeira fica num bloco verde grande acima da
  // tabela, as outras seguem na lista normal com badge "exige consulta".
  const highlightOption = options.find((o) => o.isAVistaHighlight);
  const tableOptions = options.filter((o) => !o.isAVistaHighlight);
  // Onda 14.29 — Boleto a vista IGNORA entrada custom (pagamento imediato).
  const highlightCalc = highlightOption ? applyPaymentOption(total, highlightOption, 0) : null;
  const isHighlightActive = !!highlightOption && activePaymentKey === highlightOption.key;
  return (
    <ModalPortal>
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl max-w-5xl w-full overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header destacado com gradient amber */}
        <div className="px-6 py-4 border-b border-border bg-gradient-to-r from-amber-500/10 to-amber-500/5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-9 h-9 rounded-lg bg-amber-500/15 flex items-center justify-center">
                  <Building2 size={18} className="text-amber-700" />
                </div>
                <h3 className="text-base font-bold text-foreground">
                  Boleto · Financiamento Banco PASSOS
                </h3>
              </div>
              <p className="text-xs text-muted-foreground ml-11">
                Escolha em quantas parcelas deseja pagar
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1.5 -mr-1 hover:bg-accent/50 rounded-md transition-colors"
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex items-center gap-2 mt-3 ml-11 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
              Aceitamos:
            </span>
            {['Banco do Brasil', 'Bradesco', 'Itaú', 'Caixa', 'Santander'].map((b) => (
              <span
                key={b}
                className="text-[10px] px-2 py-0.5 rounded border border-border bg-card text-foreground font-medium"
              >
                {b}
              </span>
            ))}
          </div>
        </div>

        {/* Resumo do valor */}
        <div className="px-6 py-3 bg-muted/20 border-b border-border flex items-baseline justify-between gap-3">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            Valor total
          </span>
          <span className="text-lg font-bold tabular-nums text-foreground">
            R$ {fmtBRL(total)}
          </span>
        </div>

        {/* Onda 15 (etapa 9) — Opção de consulta de crédito dentro do modal.
            Operador liga/desliga a exigência aqui mesmo, antes de escolher as
            parcelas. Off = aplica direto sem consulta (operador assume risco). */}
        {onToggleRequiresCreditCheck && (
          <div className="px-6 py-3 border-b border-border flex items-center justify-between gap-3">
            <label className="text-xs font-medium text-foreground flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={requiresCreditCheck}
                onChange={(e) => onToggleRequiresCreditCheck(e.target.checked)}
                className="w-4 h-4 rounded border-border accent-amber-600 cursor-pointer"
              />
              <span>
                Exigir consulta de crédito ao parcelar
                {!requiresCreditCheck && <span className="text-amber-700 italic"> · operador assume risco</span>}
              </span>
            </label>
            {!requiresCreditCheck && (
              <span className="text-[10px] text-amber-700 font-semibold px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 shrink-0">
                consulta dispensada
              </span>
            )}
          </div>
        )}

        {/* Onda 14.25 — Boleto à vista destacado (verde, grande, separado).
            10% desconto, sem juros, sem consulta de credito — pagamento
            imediato. Aplicacao direta sem credit-check. */}
        {highlightOption && highlightCalc && (
          <button
            type="button"
            onClick={() => onSelect(highlightOption)}
            className={`m-4 p-4 rounded-lg border-2 text-left transition-all hover:shadow-md ${
              isHighlightActive
                ? 'border-emerald-500 bg-emerald-500/10 ring-2 ring-emerald-500/20'
                : 'border-emerald-500/50 bg-emerald-500/5 hover:bg-emerald-500/10'
            }`}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
                  <Check size={18} className="text-emerald-700" strokeWidth={2.5} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-lg font-bold text-emerald-800 dark:text-emerald-300">
                      Boleto à vista
                    </span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-600 text-white uppercase tracking-wide">
                      −{highlightOption.discountPercent}%
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 border border-emerald-500/30">
                      sem consulta
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Pagamento imediato · sem juros · economia de R$ {fmtBRL(highlightCalc.savedValue)}
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-0.5">
                  Total a pagar
                </div>
                <div className="text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                  R$ {fmtBRL(highlightCalc.finalValue)}
                </div>
                <div className="text-[11px] text-muted-foreground line-through tabular-nums">
                  R$ {fmtBRL(total)}
                </div>
              </div>
            </div>
            {isHighlightActive && (
              <div className="mt-2 pt-2 border-t border-emerald-500/30 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
                <Check size={11} strokeWidth={3} />
                Selecionado
              </div>
            )}
          </button>
        )}

        {/* Separador "ou parcele" */}
        {highlightOption && (
          <div className="px-6 -mt-2 mb-2 flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
              ou parcele com juros
            </span>
            <div className="flex-1 h-px bg-border" />
          </div>
        )}

        {/* Cabeçalho da tabela.
            Onda 14.57 — coluna direita mostra "Total dos boletos" (soma das
            parcelas sem entrada). Antes incluia entrada e ficava artificialmente
            alto comparado ao Valor Total do tratamento. Entrada segue visivel
            na linha do meio ("entrada R$ X +..."). */}
        <div className="grid grid-cols-[80px_1fr_auto] gap-4 px-6 py-2 text-[10px] uppercase tracking-wide text-muted-foreground font-bold border-b border-border bg-muted/10">
          <span>Parcelas</span>
          <span>Valor de cada parcela</span>
          <span className="text-right">Total dos boletos</span>
        </div>

        {/* Linhas — Onda 14.25: filtradas, sem boleto-avista (renderizado acima destacado) */}
        <ul className="flex-1 min-h-0 overflow-y-auto">
          {tableOptions.map((opt) => {
            const isActive = activePaymentKey === opt.key;
            // Onda 14.29 — entrada custom sobrescreve downPaymentPercent default
            const c = applyPaymentOption(total, opt, customDownPayment);
            const hasInterest = (opt.interestRate ?? 0) > 0;
            return (
              <li key={opt.key}>
                <button
                  type="button"
                  onClick={() => onSelect(opt)}
                  className={`w-full grid grid-cols-[80px_1fr_auto] gap-4 px-6 py-3 text-left transition-colors border-b border-border/40 last:border-0 ${
                    isActive
                      ? 'bg-amber-500/10 hover:bg-amber-500/15'
                      : 'hover:bg-accent/40'
                  }`}
                >
                  <span className={`text-base tabular-nums ${isActive ? 'font-bold text-amber-800' : 'font-medium text-foreground'}`}>
                    {opt.installments}x
                    {opt.sublabel && (
                      <span className="block text-[9px] text-muted-foreground font-medium uppercase tracking-wide">
                        {opt.sublabel}
                      </span>
                    )}
                  </span>
                  <span className="text-sm tabular-nums">
                    {c.downPaymentValue > 0 && (
                      <span className="text-[10px] text-muted-foreground block leading-tight">
                        entrada R$ {fmtBRL(c.downPaymentValue)} +
                      </span>
                    )}
                    de{' '}
                    <strong className={isActive ? 'text-amber-800' : 'text-foreground'}>
                      R$ {fmtBRL(c.installmentValue)}
                    </strong>{' '}
                    {hasInterest ? (
                      <span className="text-amber-700 text-xs font-medium">com juros</span>
                    ) : (
                      <span className="text-emerald-700 text-xs font-medium">sem juros</span>
                    )}
                    {/* Onda 14.26 — texto adapta conforme requires_credit_check
                        da venda: padrao mostra "exige consulta", quando dispensado
                        mostra "consulta dispensada" em verde. */}
                    {requiresCreditCheck ? (
                      <span className="block text-[10px] text-amber-700 italic mt-0.5">
                        exige consulta de crédito ⓘ
                      </span>
                    ) : (
                      <span className="block text-[10px] text-emerald-700 italic mt-0.5">
                        consulta dispensada · aplica direto
                      </span>
                    )}
                  </span>
                  {/* Onda 14.57 — exibe apenas a soma das parcelas (sem
                      entrada). Antes era c.finalValue (entrada + parcelas)
                      e ficava artificialmente alto vs o Valor Total do topo. */}
                  <span className="text-sm tabular-nums text-right text-muted-foreground">
                    R$ {fmtBRL(c.finalValue - c.downPaymentValue)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Rodapé */}
        <div className="px-6 py-3 bg-muted/20 border-t border-border space-y-1">
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck size={11} className="text-emerald-700" />
            Boletos emitidos via Asaas · Análise de crédito via Serasa Crediscore
          </p>
          <p className="text-[10px] text-muted-foreground">
            Boleto à vista: 10% de desconto, sem consulta · 1x (30 dias) a 24x: juros 1,5%/mês, exige consulta · entrada de 20% a partir de 12x
          </p>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

/** Onda 10 — renderiza historico de contrapropostas parseado de Quote.notes.
 *  Onda 11 — destaca a "última oferta" em card separado acima do historico. */
function CounterProposalsHistory({ notes }: { notes: string | null }) {
  const entries = useMemo(() => parseCounterProposals(notes), [notes]);
  if (entries.length === 0) return null;
  const [latest, ...older] = entries;
  return (
    <div className="mt-4 pt-3 border-t border-border space-y-3">
      {/* Onda 11 — Última oferta destacada */}
      <div className="bg-primary/5 border border-primary/30 rounded-md p-2.5">
        <p className="text-[10px] uppercase tracking-wide text-primary font-bold mb-1 flex items-center gap-1.5">
          <MessageSquare size={10} />
          última oferta registrada
          <span className="font-mono text-muted-foreground font-normal ml-auto">
            {latest.timestamp}
          </span>
        </p>
        <p className="text-xs text-foreground">{latest.body}</p>
      </div>

      {/* Histórico anterior (se houver mais de 1) */}
      {older.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <MessageSquare size={11} className="text-muted-foreground" />
            Anteriores ({older.length})
          </p>
          <ul className="space-y-1">
            {older.map((e, idx) => (
              <li
                key={`${e.timestamp}-${idx}`}
                className="text-[11px] text-muted-foreground px-2 py-1.5 rounded bg-muted/30 border border-border/40"
              >
                <span className="font-mono text-[10px] text-foreground/70 mr-2">
                  {e.timestamp}
                </span>
                <span className="text-foreground">{e.body}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Picker modal: atribui orcamento existente a slot vazio ──────
// Onda 8.1 — abre quando user clica num card vazio (Completo/Essencial/Urgente).
// Lista todos os quotes elegiveis (DRAFT/SENT) e destaca os "sem prioridade"
// no topo. Click em um → patch /quotes/:id { priority } no parent.

function QuotePicker({
  targetPriority,
  quotes,
  loading,
  onCancel,
  onSelect,
}: {
  targetPriority: Priority;
  quotes: QuoteListItem[];
  loading: boolean;
  onCancel: () => void;
  onSelect: (quoteId: string) => void;
}) {
  const cfg = PRIORITY_CONFIG[targetPriority];

  // Separa: 1) sem prioridade (alvo natural) 2) em outro slot (permite trocar)
  // 3) ja neste slot (filtra fora — nao faz sentido reatribuir pra mesmo lugar)
  const withoutPriority = quotes.filter((q) => !q.priority);
  const inOtherSlot = quotes.filter(
    (q) => q.priority && q.priority !== targetPriority,
  );

  const empty = withoutPriority.length === 0 && inOtherSlot.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-md w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h3 className="text-sm font-bold flex items-center gap-2">
              <span className={cfg.iconCls}>{cfg.icon}</span>
              Escolher orçamento — {cfg.label}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1">
              Selecione qual orçamento vai ser exibido no slot{' '}
              <span className={`font-semibold ${cfg.iconCls}`}>{cfg.label}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground p-1 -mr-1 -mt-1"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Lista */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {empty && (
            <div className="py-8 text-center">
              <Layers size={28} className="mx-auto text-muted-foreground/60 mb-2" />
              <p className="text-xs text-muted-foreground">
                Nenhum orçamento disponível pra atribuir.
              </p>
              <p className="text-[11px] text-muted-foreground italic mt-1">
                Crie um orçamento na aba <strong>Avaliação</strong> primeiro.
              </p>
            </div>
          )}

          {withoutPriority.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5 px-1">
                Sem prioridade ({withoutPriority.length})
              </p>
              <ul className="space-y-1.5">
                {withoutPriority.map((q) => (
                  <QuotePickerRow
                    key={q.id}
                    quote={q}
                    loading={loading}
                    onSelect={() => onSelect(q.id)}
                  />
                ))}
              </ul>
            </div>
          )}

          {inOtherSlot.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5 px-1">
                Em outro slot — mover pra {cfg.label}
              </p>
              <p className="text-[11px] text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-1.5 mb-2">
                ⚠ Cada orçamento tem só uma prioridade. Mover daqui vai{' '}
                <strong>esvaziar o slot atual</strong>.
              </p>
              <ul className="space-y-1.5">
                {inOtherSlot.map((q) => (
                  <QuotePickerRow
                    key={q.id}
                    quote={q}
                    loading={loading}
                    currentPriority={q.priority as Priority}
                    targetPriority={targetPriority}
                    onSelect={() => {
                      const fromLabel = PRIORITY_CONFIG[q.priority as Priority].label;
                      const toLabel = cfg.label;
                      const ok = window.confirm(
                        `Mover "${q.title || 'orçamento'}" de ${fromLabel} pra ${toLabel}?\n\nO slot ${fromLabel} vai ficar vazio.`,
                      );
                      if (ok) onSelect(q.id);
                    }}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

function QuotePickerRow({
  quote,
  loading,
  currentPriority,
  targetPriority,
  onSelect,
}: {
  quote: QuoteListItem;
  loading: boolean;
  currentPriority?: Priority;
  targetPriority?: Priority;
  onSelect: () => void;
}) {
  const total = Number(quote.total_value);
  const isMove = !!currentPriority && !!targetPriority;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={loading}
        className={`w-full text-left px-3 py-2 rounded-lg border disabled:opacity-50 disabled:cursor-wait flex items-center gap-3 transition-colors ${
          isMove
            ? 'border-amber-500/40 hover:bg-amber-500/10 hover:border-amber-500/70'
            : 'border-border hover:bg-accent/40 hover:border-primary/40'
        }`}
      >
        <DollarSign size={14} className="text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {quote.title || 'Orçamento sem nome'}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {quote._count?.items ?? 0} item(ns) ·{' '}
            {new Date(quote.created_at).toLocaleDateString('pt-BR')}
            {currentPriority && (
              <>
                {' · '}
                <span className={`font-semibold ${PRIORITY_CONFIG[currentPriority].iconCls}`}>
                  {PRIORITY_CONFIG[currentPriority].label}
                </span>
                {targetPriority && (
                  <>
                    {' → '}
                    <span className={`font-semibold ${PRIORITY_CONFIG[targetPriority].iconCls}`}>
                      {PRIORITY_CONFIG[targetPriority].label}
                    </span>
                  </>
                )}
              </>
            )}
          </p>
        </div>
        <p className="text-sm font-bold text-foreground shrink-0">
          R$ {total.toLocaleString('pt-BR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </p>
        {loading ? (
          <Loader2 size={14} className="animate-spin text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground shrink-0" />
        )}
      </button>
    </li>
  );
}

// ─── Dialog "+ Nova proposta" ──────────────────────────────────
// Onda 9 (original) — criava Quote DRAFT vazio + atribuia priority.
//
// Onda 14.23 — REESCRITO. Agora 2 steps:
//   Step 1: escolhe priority (so as RESTANTES — ocupadas filtradas)
//   Step 2: escolhe qual orcamento EXISTENTE atribuir essa priority
//
// Nao cria DRAFT vazio mais. Reusa orcamentos da aba Avaliacao. Versao
// Livre sempre aparece (ilimitada). Se nao ha orcamentos no paciente,
// mostra empty state com atalho pra aba Avaliacao.

function NewVersionDialog({
  existingPriorities,
  availableQuotes,
  loading,
  onCancel,
  onAttach,
  onGoToAvaliacao,
}: {
  existingPriorities: Set<Priority>;
  /** Onda 14.23 — orcamentos elegiveis pra atribuicao (DRAFT/SENT/ACCEPTED) */
  availableQuotes: QuoteListItem[];
  loading: boolean;
  onCancel: () => void;
  /** Onda 14.23 — atribui priority a um orcamento existente (PATCH). */
  onAttach: (quoteId: string, priority: Priority | null) => void;
  /** Onda 14.23 — atalho pra criar orcamento na aba Avaliacao. */
  onGoToAvaliacao: () => void;
}) {
  // Onda 14.23 — priorities canonicas RESTANTES (sem orcamento atribuido).
  // Versao livre sempre aparece (aceita variacoes ilimitadas).
  const remainingPriorities = PRIORITY_ORDER.filter((p) => !existingPriorities.has(p));
  const hasNoCanonicalLeft = remainingPriorities.length === 0;

  // Onda 14.23 — 2-step state. 'priority' = escolher categoria; 'quote' =
  // escolher orcamento dentro da categoria escolhida.
  // Onda 14.29 (fix) — quando nao ha priority canonica restante, ja inicia
  // no step 'quote' com Livre selecionada. Antes tinhamos um useEffect que
  // disparava setStep no mount — gerava "setState in effect" no lint.
  const [step, setStep] = useState<'priority' | 'quote'>(
    hasNoCanonicalLeft ? 'quote' : 'priority',
  );
  const [selectedPriority, setSelectedPriority] = useState<Priority | null>(null);

  const goToQuoteStep = (priority: Priority | null) => {
    setSelectedPriority(priority);
    setStep('quote');
  };
  const backToPriorityStep = () => {
    setSelectedPriority(null);
    setStep('priority');
  };

  // Onda 14.23 — quando ja chegou no step 2 com priority alvo selecionada,
  // monta lista ordenada de orcamentos pra atribuir:
  // 1. Quotes sem priority (priority=null) — candidatos mais naturais
  // 2. Quotes com OUTRA priority — pode override (com aviso visual)
  // 3. Quotes com a MESMA priority alvo — desabilitadas (ja estao la)
  const sortedQuotes = step === 'quote'
    ? [...availableQuotes].sort((a, b) => {
        // helper: 0 = sem priority, 1 = outra priority, 2 = mesma priority alvo (ja la)
        const rank = (q: QuoteListItem) => {
          if (!q.priority) return 0;
          if (q.priority === selectedPriority) return 2;
          return 1;
        };
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        // dentro do mesmo rank, mais recente primeiro
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
    : [];

  const cfgForSelected = selectedPriority
    ? PRIORITY_CONFIG[selectedPriority]
    : LIVRE_CONFIG;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-md w-full overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — adapta conforme step */}
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-start gap-2 min-w-0">
            {step === 'quote' && !hasNoCanonicalLeft && (
              <button
                type="button"
                onClick={backToPriorityStep}
                className="text-muted-foreground hover:text-foreground p-1 -ml-1 -mt-1 shrink-0"
                aria-label="Voltar"
                title="Voltar pra escolher a prioridade"
              >
                <ArrowLeft size={14} />
              </button>
            )}
            <div className="min-w-0">
              <h3 className="text-sm font-bold">Nova proposta</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {step === 'priority'
                  ? 'escolha a prioridade — só as que ainda não foram criadas aparecem'
                  : <>atribuir <span className={`font-semibold ${cfgForSelected.iconCls}`}>{cfgForSelected.label}</span> a qual orçamento?</>
                }
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground p-1 -mr-1 -mt-1 shrink-0"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — conteudo do step atual */}
        <div className="flex-1 overflow-y-auto">
          {step === 'priority' ? (
            <div className="p-3 space-y-2">
              {remainingPriorities.map((p) => {
                const cfg = PRIORITY_CONFIG[p];
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={loading}
                    onClick={() => goToQuoteStep(p)}
                    className={`w-full text-left p-3 rounded-lg border-2 transition-colors disabled:opacity-50 disabled:cursor-wait ${cfg.borderCls} ${cfg.bgCls} hover:shadow-sm`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cfg.iconCls}>{cfg.icon}</span>
                      <div className="min-w-0">
                        <p className={`text-sm font-bold ${cfg.iconCls}`}>{cfg.label}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{cfg.description}</p>
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* Versao Livre — sempre disponivel (aceita variacoes ilimitadas) */}
              <button
                type="button"
                disabled={loading}
                onClick={() => goToQuoteStep(null)}
                className={`w-full text-left p-3 rounded-lg border-2 transition-colors disabled:opacity-50 disabled:cursor-wait ${LIVRE_CONFIG.borderCls} ${LIVRE_CONFIG.bgCls} hover:shadow-sm`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={LIVRE_CONFIG.iconCls}>{LIVRE_CONFIG.icon}</span>
                  <div className="min-w-0">
                    <p className={`text-sm font-bold ${LIVRE_CONFIG.iconCls}`}>{LIVRE_CONFIG.label}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      extra sem prioridade — pra variações adicionais (Black Friday, cortesia, etc)
                    </p>
                  </div>
                </div>
              </button>

              {/* Hint quando todas priorities canonicas estao ocupadas */}
              {hasNoCanonicalLeft && (
                <p className="text-[11px] text-muted-foreground italic px-1 pt-1">
                  Urgente, Essencial e Completo já têm proposta. Pra criar mais variações, use Versão livre.
                </p>
              )}
            </div>
          ) : (
            // Step 2 — picker de orcamento
            <div className="p-3 space-y-2">
              {availableQuotes.length === 0 ? (
                // Empty state — sem orcamentos no paciente
                <div className="p-6 text-center">
                  <Layers size={28} className="mx-auto text-muted-foreground/60 mb-2" />
                  <p className="text-sm font-semibold mb-1">Nenhum orçamento criado ainda</p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Pra atribuir uma proposta, crie um orçamento primeiro na aba <strong>Avaliação</strong>.
                  </p>
                  <button
                    type="button"
                    onClick={onGoToAvaliacao}
                    className="text-xs font-semibold text-primary-foreground bg-primary px-3 py-1.5 rounded-lg hover:opacity-90 inline-flex items-center gap-1"
                  >
                    <ArrowLeft size={12} className="rotate-180" />
                    Ir para Avaliação
                  </button>
                </div>
              ) : (
                <>
                  {sortedQuotes.map((q) => {
                    const itemsCount = q._count?.items ?? 0;
                    const isAlreadyTarget =
                      (q.priority || null) === selectedPriority &&
                      q.visible_in_proposals !== false;
                    const currentPriorityLabel = q.priority
                      ? PRIORITY_CONFIG[q.priority as Priority]?.label
                      : (q.visible_in_proposals === false ? 'oculto' : 'sem prioridade');
                    const totalValue = Number(q.total_value || 0);

                    return (
                      <button
                        key={q.id}
                        type="button"
                        disabled={loading || isAlreadyTarget}
                        onClick={() => onAttach(q.id, selectedPriority)}
                        className={`w-full text-left p-3 rounded-lg border-2 transition-colors hover:shadow-sm ${
                          isAlreadyTarget
                            ? 'border-border bg-muted/30 opacity-60 cursor-not-allowed'
                            : `${cfgForSelected.borderCls} ${cfgForSelected.bgCls} hover:opacity-100`
                        } disabled:cursor-not-allowed`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] font-mono font-semibold text-primary">
                                {getQuoteNumberBadge(q) || '·'}
                              </span>
                              <span className="text-sm font-bold text-foreground truncate">
                                {getQuoteDisplayName(q)}
                              </span>
                              <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                {q.status}
                              </span>
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {itemsCount} {itemsCount === 1 ? 'item' : 'itens'}
                              {totalValue > 0 && ` · R$ ${fmtBRL(totalValue)}`}
                              {' · '}
                              <span className="italic">{currentPriorityLabel}</span>
                            </p>
                          </div>
                          {isAlreadyTarget ? (
                            <span className="text-[10px] font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-full shrink-0">
                              já é {cfgForSelected.label.toLowerCase()}
                            </span>
                          ) : q.priority && q.priority !== selectedPriority ? (
                            <span
                              className="text-[10px] font-semibold text-amber-700 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0"
                              title="Vai trocar a priority atual"
                            >
                              trocar
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}

                  {/* Atalho pra criar novo orcamento direto, caso operador
                      queira criar um do zero (em vez de reusar existente). */}
                  <button
                    type="button"
                    onClick={onGoToAvaliacao}
                    disabled={loading}
                    className="w-full text-center p-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:bg-accent/30 hover:text-foreground inline-flex items-center justify-center gap-1"
                  >
                    <Plus size={12} />
                    Criar novo orçamento na Avaliação
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Dialog "Salvar contraproposta" ──────────────────────────
// Onda 10 — registra a oferta atual (priority + forma de pagamento + valor
// final) como linha em Quote.notes. Operador pode anexar nota livre.

function CounterProposalDialog({
  priorityLabel,
  paymentLabel,
  finalValue,
  loading,
  onCancel,
  onSave,
}: {
  priorityLabel: string;
  paymentLabel: string;
  finalValue: number;
  loading: boolean;
  onCancel: () => void;
  onSave: (note?: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h3 className="text-sm font-bold flex items-center gap-2">
              <MessageSquare size={14} className="text-primary" />
              Salvar contraproposta
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              registra a oferta atual no histórico do orçamento — útil pra
              acompanhar negociações em andamento
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground p-1 -mr-1 -mt-1"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Resumo da oferta */}
          <div className="bg-muted/30 border border-border/60 rounded-md p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              oferta a registrar
            </p>
            <p className="text-sm font-bold text-foreground">
              {priorityLabel} em {paymentLabel}
            </p>
            <p className="text-lg font-bold text-emerald-700 tabular-nums">
              R$ {fmtBRL(finalValue)}
            </p>
          </div>

          {/* Nota livre */}
          <div>
            <label className="text-[11px] font-semibold text-foreground block mb-1">
              Nota (opcional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex: paciente vai pensar até sexta · pediu mais um desconto"
              disabled={loading}
              rows={3}
              className="w-full text-xs px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none disabled:opacity-50"
            />
            <p className="text-[10px] text-muted-foreground mt-1 italic">
              fica salvo junto com a oferta no histórico do orçamento
            </p>
          </div>
        </div>

        <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onSave(note.trim() || undefined)}
            disabled={loading}
            className="text-xs px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-wait flex items-center gap-1.5"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Dialog Financiamento Banco PASSOS — Onda 12 ─────────────
// Consulta de credito em tempo real (mock backend). 3 fases:
//   cadastro → consultando → resultado (approved/pending/denied)
// Em producao, substituir o endpoint mock por integracao Serasa Crediscore.

type CreditPhase = 'cadastro' | 'consultando' | 'resultado' | 'gerando' | 'boletos';

interface ApplyFinancingResult {
  quote_id: string;
  plan_id: string;
  total_financed: number;
  charges: Array<{
    kind: 'entrada' | 'parcelado';
    boleto_url: string | null;
    barcode: string | null;
    due_date: string;
    amount: number;
    installment_count?: number;
    installment_value?: number;
  }>;
}

// Onda 14.27 — Formatters reutilizados pelo CreditCheckDialog. Movidos pra
// fora do componente pra serem usaveis no useEffect de pre-preenchimento
// (nao depende de state).
function fmtCpf(v: string): string {
  const c = v.replace(/\D/g, '').slice(0, 11);
  return c
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function fmtTel(v: string): string {
  const c = v.replace(/\D/g, '').slice(0, 11);
  if (c.length <= 10) return c.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2');
  return c.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2');
}

function fmtCep(v: string): string {
  const c = v.replace(/\D/g, '').slice(0, 8);
  return c.replace(/(\d{5})(\d)/, '$1-$2');
}

function CreditCheckDialog({
  quoteId,
  patientId,
  valorTotal,
  initialInstallments,
  customDownPayment = 0,
  customSignalValue = 0,
  customSignalMethod = 'PIX',
  customEntradaDueDate = '',
  customInstallmentsStartDate = '',
  onCancel,
  onAppliedSuccess,
}: {
  /** Onda 12.2 — id do quote pra fechar via POST /quotes/:id/apply-financing */
  quoteId: string;
  /** Onda 14.27 — patient pra pre-preencher + salvar dados no cadastro */
  patientId: string;
  valorTotal: number;
  /** Onda 14.4 — parcelas pre-selecionadas (vem da tabela de boleto) */
  initialInstallments?: number;
  /** Onda 14.56 — entrada custom (R$) configurada pelo operador no painel. */
  customDownPayment?: number;
  /** Onda 14.58 — sinal + datas customizadas pra dividir a cobranca em
   *  sinal (PIX/Boleto hoje) + entrada (boleto na data X) + parcelas
   *  comecando em data Y. Quando vazios = comportamento legado (entrada
   *  unica + parcelas em 30 dias). */
  customSignalValue?: number;
  customSignalMethod?: 'PIX' | 'BOLETO' | 'CASH';
  customEntradaDueDate?: string;
  customInstallmentsStartDate?: string;
  onCancel: () => void;
  /** Onda 12.2 — chamado quando o fluxo completa (aceita + boletos gerados). */
  onAppliedSuccess: (parcelaKey: string) => void;
}) {
  const [phase, setPhase] = useState<CreditPhase>('cadastro');
  // Onda 14.4 — tipo relaxado pra number (era 12|18|24 hardcoded)
  const [parcelas, setParcelas] = useState<number>(initialInstallments ?? 18);
  const [result, setResult] = useState<CreditCheckResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyFinancingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMsg, setLoadingMsg] = useState('Consultando Serasa...');
  // Onda 14.27 — loading do pre-preenchimento
  const [loadingPatient, setLoadingPatient] = useState(true);

  // Form fields — Onda 14.27 expandido pra incluir RG + endereco completo
  const [cpf, setCpf] = useState('');
  const [rg, setRg] = useState('');
  const [nome, setNome] = useState('');
  const [dataNasc, setDataNasc] = useState('');
  const [renda, setRenda] = useState('');
  const [telefone, setTelefone] = useState('');
  const [profissao, setProfissao] = useState('');
  const [cep, setCep] = useState('');
  const [endereco, setEndereco] = useState('');
  const [numeroEndereco, setNumeroEndereco] = useState('');
  const [bairro, setBairro] = useState('');
  const [cidade, setCidade] = useState('');
  const [estado, setEstado] = useState('');

  // Onda 14.27 — Pre-preencher form com dados do paciente. Profissao e renda
  // nao vem do Patient (campos exclusivos do credit-check), entao ficam vazios
  // pra operador preencher na hora.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<{
          name?: string; cpf?: string; rg?: string; birth_date?: string;
          phone?: string; email?: string;
          address?: string; address_number?: string; neighborhood?: string;
          city?: string; state?: string; zip_code?: string;
        }>(`/patients/${patientId}`);
        if (cancelled) return;
        if (data.name) setNome(data.name);
        if (data.cpf) setCpf(fmtCpf(data.cpf));
        if (data.rg) setRg(data.rg);
        if (data.birth_date) setDataNasc(data.birth_date.substring(0, 10));
        if (data.phone) setTelefone(fmtTel(data.phone));
        if (data.address) setEndereco(data.address);
        if (data.address_number) setNumeroEndereco(data.address_number);
        if (data.neighborhood) setBairro(data.neighborhood);
        if (data.city) setCidade(data.city);
        if (data.state) setEstado(data.state);
        if (data.zip_code) setCep(fmtCep(data.zip_code));
      } catch {
        // Sem dados — operador preenche tudo manualmente
      } finally {
        if (!cancelled) setLoadingPatient(false);
      }
    })();
    return () => { cancelled = true; };
  }, [patientId]);

  // Calcula a parcela alvo baseado no prazo escolhido.
  // Onda 14.4 — entrada 20% so a partir de 12x (alinhado com buildPaymentOptions).
  const opt: PaymentOption = useMemo(() => ({
    key: `parcelado-${parcelas}x`,
    label: `${parcelas}x`,
    sublabel: '',
    discountPercent: 0,
    installments: parcelas,
    variant: 'parcelado',
    interestRate: 1.5,
    downPaymentPercent: parcelas >= 12 ? 20 : 0,
  }), [parcelas]);
  // Onda 14.56 — passa customDownPayment pra applyPaymentOption respeitar
  // a entrada que o operador configurou no painel. Antes este calculo ignorava
  // a entrada e gerava parcelas como se o valor cheio fosse financiado.
  const calc = applyPaymentOption(valorTotal, opt, customDownPayment);

  // Mensagens dinamicas durante consultando
  useEffect(() => {
    if (phase !== 'consultando' && phase !== 'gerando') return;
    const msgsConsulta = [
      'Consultando Serasa...',
      'Avaliando histórico de crédito...',
      'Calculando condições...',
    ];
    const msgsGerando = [
      'Aceitando proposta...',
      'Ativando plano de tratamento...',
      'Gerando boleto de entrada...',
      'Gerando boletos das parcelas...',
    ];
    const msgs = phase === 'consultando' ? msgsConsulta : msgsGerando;
    setLoadingMsg(msgs[0]);
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % msgs.length;
      setLoadingMsg(msgs[i]);
    }, 700);
    return () => clearInterval(id);
  }, [phase]);

  // Onda 14.27 — Auto-preenche endereco via API ViaCEP quando operador digita CEP completo
  const handleCepBlur = async () => {
    const cleanCep = cep.replace(/\D/g, '');
    if (cleanCep.length !== 8) return;
    // So preenche se nao tinha endereco antes — nao sobrescreve o que ja foi digitado
    if (endereco && cidade && estado) return;
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cleanCep}/json/`);
      const data = await res.json();
      if (data.erro) return;
      if (!endereco && data.logradouro) setEndereco(data.logradouro);
      if (!bairro && data.bairro) setBairro(data.bairro);
      if (!cidade && data.localidade) setCidade(data.localidade);
      if (!estado && data.uf) setEstado(data.uf);
    } catch {
      // Silencioso — operador preenche manual
    }
  };

  const fmtCurrency = (v: string) => v.replace(/\D/g, '');
  const rendaNum = Number(renda) / 100;

  // Onda 14.27 — campos minimos obrigatorios pra credit-check. Endereco e
  // RG ficam opcionais (a Serasa nao exige mas operador pode preencher
  // pra atualizar cadastro do paciente).
  const canSubmit = cpf.replace(/\D/g, '').length === 11
    && nome.trim().length >= 3
    && dataNasc.length === 10
    && rendaNum > 0
    && telefone.replace(/\D/g, '').length >= 10
    && profissao.trim().length >= 2;

  const submit = async () => {
    setError(null);
    setPhase('consultando');
    try {
      // Onda 14.27 — Antes da consulta, atualiza cadastro do paciente.
      // Usa endpoint /credit-check-data (nao exige role ADMIN — fluxo de
      // venda normal). Best-effort: se falhar, prossegue com a consulta
      // (dados salvos sao bonus, nao bloqueiam o fluxo principal).
      try {
        await api.patch(`/patients/${patientId}/credit-check-data`, {
          name: nome.trim(),
          cpf: cpf.replace(/\D/g, ''),
          rg: rg.trim() || null,
          birth_date: dataNasc,
          phone: telefone.replace(/\D/g, ''),
          address: endereco.trim() || null,
          address_number: numeroEndereco.trim() || null,
          neighborhood: bairro.trim() || null,
          city: cidade.trim() || null,
          state: estado.trim() || null,
          zip_code: cep.replace(/\D/g, '') || null,
        });
      } catch {
        // Silencioso — consulta segue mesmo se update do paciente falhar
      }

      const { data } = await api.post<CreditCheckResult>('/credit-check/simulate', {
        cpf: cpf.replace(/\D/g, ''),
        nome: nome.trim(),
        data_nascimento: dataNasc,
        renda_mensal: rendaNum,
        telefone: telefone.replace(/\D/g, ''),
        profissao: profissao.trim(),
        parcela_alvo: calc.installmentValue,
        parcelas,
        valor_total: valorTotal,
      });
      setResult(data);
      setPhase('resultado');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setError(e?.response?.data?.message || 'Erro ao consultar crédito');
      setPhase('cadastro');
    }
  };

  // Onda 12.2 — aplica o financiamento: aceita quote + gera boletos Asaas
  const apply = async () => {
    if (!result || result.status !== 'approved') return;
    setError(null);
    setPhase('gerando');
    // Onda 15 (etapa 16.1) — DTO do backend exige maxDecimalPlaces: 2 nos
    // valores monetarios. Price formula gera floats com muitas casas; arredondamos.
    const round2 = (n: number) => Math.round(n * 100) / 100;
    try {
      const { data } = await api.post<ApplyFinancingResult>(
        `/quotes/${quoteId}/apply-financing`,
        {
          down_payment_value: round2(calc.downPaymentValue),
          installment_count: parcelas,
          installment_value: round2(calc.installmentValue),
          decision_id: result.decision_id,
          source: result.source,
          // Onda 14.58 — sinal + datas customizadas. Backend gera boletos
          // separados conforme: sinal hoje + entrada (boleto na data X) +
          // parcelas comecando em data Y. Quando undefined, mantem o
          // comportamento legado (1 boleto de entrada + parcelas em 30d).
          ...(customSignalValue > 0 ? { signal_value: round2(customSignalValue), signal_method: customSignalMethod } : {}),
          ...(customEntradaDueDate ? { entrada_due_date: customEntradaDueDate } : {}),
          ...(customInstallmentsStartDate ? { installments_start_date: customInstallmentsStartDate } : {}),
        },
      );
      setApplyResult(data);
      setPhase('boletos');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setError(
        e?.response?.data?.message ||
        'Erro ao gerar boletos. Verifique se o Asaas esta configurado.',
      );
      setPhase('resultado');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      {/* Onda 14.27 — Modal centralizado (max-w-3xl, max-h-[90vh]) em vez
          de full-screen. Mais compacto, scroll interno se conteudo extenso. */}
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header compacto */}
        <div className="border-b border-border bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent shrink-0">
          <div className="px-5 py-3.5 flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
                <Building2 size={18} className="text-amber-700" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-foreground">
                  Financiamento Banco PASSOS
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Consulta de crédito em tempo real · Aprovação imediata
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="text-muted-foreground hover:text-foreground p-1.5 hover:bg-accent/50 rounded-md transition-colors shrink-0"
              aria-label="Fechar"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body — Onda 14.27: modal compacto, padding ajustado */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-4">
            {phase === 'cadastro' && (
              <>
                {/* Resumo da proposta — Onda 14.27: compacto */}
                <div className="bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/30 rounded-lg p-3 mb-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase tracking-wider text-amber-700 font-bold mb-0.5">
                        Proposta a financiar
                      </p>
                      <p className="text-xl font-bold tabular-nums leading-tight text-foreground">
                        {parcelas}x de R$ {fmtBRL(calc.installmentValue)}
                        <span className="text-xs font-normal text-muted-foreground"> /mês</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        entrada <strong className="text-foreground">R$ {fmtBRL(calc.downPaymentValue)}</strong>
                        {' · '}
                        <span className="opacity-75">total R$ {fmtBRL(valorTotal)}</span>
                      </p>
                    </div>
                    <div className="flex gap-1 shrink-0 flex-wrap">
                      {Array.from(new Set([parcelas, 12, 18, 24]))
                        .sort((a, b) => a - b)
                        .map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setParcelas(n)}
                          className={`text-xs px-2.5 py-1 rounded-md border transition-colors font-semibold ${
                            parcelas === n
                              ? 'border-amber-600 bg-amber-500/15 text-amber-800'
                              : 'border-border bg-card hover:bg-accent'
                          }`}
                        >
                          {n}x
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Form — Onda 14.27 expandido: identificacao + endereco completo */}
                <div className="bg-card border border-border rounded-lg p-4">
                  {loadingPatient ? (
                    <div className="py-8 flex items-center justify-center text-muted-foreground">
                      <Loader2 size={14} className="animate-spin mr-2" />
                      <span className="text-xs">Carregando dados do paciente...</span>
                    </div>
                  ) : (
                  <>
                  <p className="text-xs font-bold text-foreground mb-3 flex items-center gap-1.5">
                    <ShieldCheck size={13} className="text-emerald-700" />
                    Identificação
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                    <Field label="CPF">
                      <input
                        type="text"
                        value={cpf}
                        onChange={(e) => setCpf(fmtCpf(e.target.value))}
                        placeholder="000.000.000-00"
                        inputMode="numeric"
                        className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                      />
                    </Field>
                    <Field label="RG">
                      <input
                        type="text"
                        value={rg}
                        onChange={(e) => setRg(e.target.value)}
                        placeholder="00.000.000-0"
                        className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                      />
                    </Field>
                    <Field label="Nome completo">
                      <input
                        type="text"
                        value={nome}
                        onChange={(e) => setNome(e.target.value)}
                        placeholder="Como consta no CPF"
                        className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                      />
                    </Field>
                    <Field label="Data de nascimento">
                      <input
                        type="date"
                        value={dataNasc}
                        onChange={(e) => setDataNasc(e.target.value)}
                        className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                      />
                    </Field>
                    <Field label="Telefone">
                      <input
                        type="text"
                        value={telefone}
                        onChange={(e) => setTelefone(fmtTel(e.target.value))}
                        placeholder="(00) 00000-0000"
                        inputMode="numeric"
                        className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                      />
                    </Field>
                    <Field label="Profissão">
                      <input
                        type="text"
                        value={profissao}
                        onChange={(e) => setProfissao(e.target.value)}
                        placeholder="Ex: professor"
                        className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                      />
                    </Field>
                    <Field label="Renda mensal (R$)">
                      <input
                        type="text"
                        value={renda ? `R$ ${(Number(renda) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : ''}
                        onChange={(e) => setRenda(fmtCurrency(e.target.value))}
                        placeholder="R$ 0,00"
                        inputMode="numeric"
                        className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                      />
                    </Field>
                  </div>

                  {/* Onda 14.27 — Endereco completo. Auto-preenche via ViaCEP
                      ao digitar CEP completo (se campos estiverem vazios). */}
                  <p className="text-xs font-bold text-foreground mb-3 flex items-center gap-1.5">
                    <Building2 size={13} className="text-amber-700" />
                    Endereço
                    <span className="text-[10px] font-normal text-muted-foreground italic">
                      · CEP completo auto-preenche os demais campos
                    </span>
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
                    <div className="md:col-span-2">
                      <Field label="CEP">
                        <input
                          type="text"
                          value={cep}
                          onChange={(e) => setCep(fmtCep(e.target.value))}
                          onBlur={handleCepBlur}
                          placeholder="00000-000"
                          inputMode="numeric"
                          className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                        />
                      </Field>
                    </div>
                    <div className="md:col-span-4">
                      <Field label="Endereço">
                        <input
                          type="text"
                          value={endereco}
                          onChange={(e) => setEndereco(e.target.value)}
                          placeholder="Rua, avenida..."
                          className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                        />
                      </Field>
                    </div>
                    <div className="md:col-span-1">
                      <Field label="Número">
                        <input
                          type="text"
                          value={numeroEndereco}
                          onChange={(e) => setNumeroEndereco(e.target.value)}
                          placeholder="123"
                          className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                        />
                      </Field>
                    </div>
                    <div className="md:col-span-3">
                      <Field label="Bairro">
                        <input
                          type="text"
                          value={bairro}
                          onChange={(e) => setBairro(e.target.value)}
                          placeholder="Bairro"
                          className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                        />
                      </Field>
                    </div>
                    <div className="md:col-span-2">
                      <Field label="Cidade">
                        <input
                          type="text"
                          value={cidade}
                          onChange={(e) => setCidade(e.target.value)}
                          placeholder="Cidade"
                          className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                        />
                      </Field>
                    </div>
                    <div className="md:col-span-6 md:max-w-[100px]">
                      <Field label="UF">
                        <input
                          type="text"
                          value={estado}
                          onChange={(e) => setEstado(e.target.value.toUpperCase().slice(0, 2))}
                          placeholder="UF"
                          maxLength={2}
                          className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 uppercase"
                        />
                      </Field>
                    </div>
                  </div>

                  {error && (
                    <p className="mt-3 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                      {error}
                    </p>
                  )}
                  <p className="mt-3 text-[11px] text-muted-foreground flex items-center gap-1.5">
                    <ShieldCheck size={11} className="text-emerald-700" />
                    Dados criptografados pra Serasa · Atualizam o cadastro do paciente automaticamente
                  </p>
                  </>
                  )}
                </div>
              </>
            )}

            {(phase === 'consultando' || phase === 'gerando') && (
              <div className="py-20 flex flex-col items-center justify-center text-center">
                <div className="w-24 h-24 rounded-full bg-amber-500/10 flex items-center justify-center mb-6">
                  <Loader2 size={48} className="text-amber-600 animate-spin" />
                </div>
                <p className="text-xl font-bold text-foreground mb-2">{loadingMsg}</p>
                <p className="text-sm text-muted-foreground">
                  {phase === 'consultando' ? 'Isso leva poucos segundos.' : 'Criando boletos no Asaas...'}
                </p>
              </div>
            )}

            {phase === 'resultado' && result && (
              <>
                <ResultPanel
                  result={result}
                  parcelas={parcelas}
                  calc={calc}
                  onApply={apply}
                  onRetryWithMore={() => {
                    const next = parcelas === 12 ? 18 : parcelas === 18 ? 24 : 24;
                    setParcelas(next);
                    setResult(null);
                    setPhase('cadastro');
                  }}
                />
                {error && (
                  <p className="mt-4 max-w-md mx-auto text-sm text-red-700 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                    {error}
                  </p>
                )}
              </>
            )}

            {phase === 'boletos' && applyResult && (
              <BoletosResultPanel
                data={applyResult}
                parcelas={parcelas}
                onClose={() => {
                  onAppliedSuccess(`parcelado-${parcelas}x`);
                  onCancel();
                }}
              />
            )}
          </div>
        </div>

        {/* Footer compacto — Onda 14.27 */}
        {phase === 'cadastro' && (
          <div className="border-t border-border bg-muted/20 shrink-0">
            <div className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[10px] text-muted-foreground hidden md:flex items-center gap-1">
                <ShieldCheck size={11} className="text-emerald-700" />
                Conexão segura · Serasa Crediscore
              </p>
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={onCancel}
                  className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-accent font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSubmit}
                  className="text-xs px-4 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 font-semibold shadow-sm"
                >
                  <Search size={12} />
                  Consultar aprovação
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-semibold text-foreground block mb-1">{label}</label>
      {children}
    </div>
  );
}

/** Onda 12.1 — Selo da fonte da decisao + sumario Asaas (quando ha) */
function SourceBadge({ result }: { result: CreditCheckResult }) {
  const source = result.source || 'internal';
  if (source === 'serasa') {
    return (
      <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700 border border-blue-500/30 mb-3">
        <ShieldCheck size={10} />
        Validado por Serasa Crediscore
      </div>
    );
  }
  if (source === 'asaas_history' && result.asaas_summary?.is_recurring) {
    const rate = result.asaas_summary.on_time_rate;
    const count = result.asaas_summary.charges_count ?? 0;
    return (
      <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700 border border-blue-500/30 mb-3">
        <ShieldCheck size={10} />
        Cliente recorrente · {count} cobrança{count === 1 ? '' : 's'}
        {rate !== undefined && ` · ${Math.round(rate * 100)}% em dia`}
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground italic mb-3">
      análise interna · paciente novo (sem histórico)
    </div>
  );
}

function ResultPanel({
  result,
  parcelas,
  calc,
  onApply,
  onRetryWithMore,
}: {
  result: CreditCheckResult;
  parcelas: number;
  calc: ReturnType<typeof applyPaymentOption>;
  onApply: () => void;
  onRetryWithMore: () => void;
}) {
  if (result.status === 'approved') {
    return (
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-3">
          <ShieldCheck size={32} className="text-emerald-700" />
        </div>
        <p className="text-base font-bold text-emerald-700 mb-1">{result.message}</p>
        <SourceBadge result={result} />
        <p className="text-[11px] text-muted-foreground mb-4">
          decisão {result.decision_id} · comprometimento {Math.round(100 / result.ratio)}% da renda
        </p>
        <div className="bg-emerald-500/5 border border-emerald-500/30 rounded-md p-3 text-left space-y-1.5 mb-4">
          <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-bold">
            condições liberadas
          </p>
          <p className="text-sm font-bold">
            {parcelas}x · entrada R$ {fmtBRL(calc.downPaymentValue)} + R$ {fmtBRL(calc.installmentValue)}/mês
          </p>
          <p className="text-[11px] text-muted-foreground">
            total R$ {fmtBRL(calc.finalValue)} · juros {result.conditions?.juros_mes}%/mês
          </p>
        </div>
        <button
          type="button"
          onClick={onApply}
          className="w-full text-sm font-semibold px-4 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2"
        >
          <Check size={14} />
          Aplicar essa proposta
        </button>
      </div>
    );
  }

  if (result.status === 'pending') {
    return (
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto mb-3">
          <AlertTriangle size={32} className="text-amber-700" />
        </div>
        <p className="text-base font-bold text-amber-800 mb-1">{result.message}</p>
        <SourceBadge result={result} />
        <p className="text-[11px] text-muted-foreground mb-4">
          decisão {result.decision_id} · comprometimento {Math.round(100 / result.ratio)}% da renda
        </p>
        <div className="bg-amber-500/5 border border-amber-500/30 rounded-md p-3 text-left space-y-1.5 mb-3">
          <p className="text-[11px] text-foreground">
            <strong>Motivo:</strong> {result.motivo}
          </p>
          {result.suggestion && (
            <p className="text-[11px] text-muted-foreground">
              💡 {result.suggestion}
            </p>
          )}
        </div>
      </div>
    );
  }

  // denied
  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-full bg-red-500/15 flex items-center justify-center mx-auto mb-3">
        <XCircle size={32} className="text-red-700" />
      </div>
      <p className="text-base font-bold text-red-800 mb-1">{result.message}</p>
      <SourceBadge result={result} />
      <p className="text-[11px] text-muted-foreground mb-4">
        decisão {result.decision_id} · comprometimento {Math.round(100 / result.ratio)}% da renda
      </p>
      <div className="bg-red-500/5 border border-red-500/30 rounded-md p-3 text-left space-y-1.5 mb-3">
        <p className="text-[11px] text-foreground">
          <strong>Motivo:</strong> {result.motivo}
        </p>
        {result.suggestion && (
          <p className="text-[11px] text-muted-foreground">
            💡 {result.suggestion}
          </p>
        )}
      </div>
      {parcelas < 24 && (
        <button
          type="button"
          onClick={onRetryWithMore}
          className="text-xs font-semibold px-3 py-2 rounded-lg border border-amber-500 text-amber-700 hover:bg-amber-500/10 inline-flex items-center gap-1.5"
        >
          Tentar com prazo maior
        </button>
      )}
    </div>
  );
}

/** Onda 12.2 — Painel mostrando os boletos gerados (entrada + parcelado).
 *  Aparece apos o "Aplicar essa proposta" completar com sucesso. */
function BoletosResultPanel({
  data,
  parcelas,
  onClose,
}: {
  data: ApplyFinancingResult;
  parcelas: number;
  onClose: () => void;
}) {
  const entrada = data.charges.find((c) => c.kind === 'entrada');
  const parcelado = data.charges.find((c) => c.kind === 'parcelado');
  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-3">
        <ShieldCheck size={32} className="text-emerald-700" />
      </div>
      <p className="text-base font-bold text-emerald-700 mb-1">
        Boletos gerados com sucesso!
      </p>
      <p className="text-[11px] text-muted-foreground mb-4">
        plano ativado · total financiado R$ {fmtBRL(data.total_financed)}
      </p>

      <div className="space-y-2 text-left mb-4">
        {entrada && (
          <BoletoRow
            label="Entrada"
            sublabel={`1 boleto · vence ${new Date(entrada.due_date).toLocaleDateString('pt-BR')}`}
            amount={entrada.amount}
            url={entrada.boleto_url}
            barcode={entrada.barcode}
            tone="emerald"
          />
        )}
        {parcelado && (
          <BoletoRow
            label={`${parcelas}x parceladas`}
            sublabel={`${parcelas} boletos · primeiro vence ${new Date(parcelado.due_date).toLocaleDateString('pt-BR')}`}
            amount={parcelado.amount}
            url={parcelado.boleto_url}
            barcode={parcelado.barcode}
            tone="amber"
            installmentInfo={
              parcelado.installment_count && parcelado.installment_value
                ? `${parcelado.installment_count}x R$ ${fmtBRL(parcelado.installment_value)}`
                : undefined
            }
          />
        )}
      </div>

      <p className="text-[11px] text-muted-foreground italic mb-3">
        🔔 O Asaas vai enviar os boletos por email/WhatsApp pro paciente automaticamente.
      </p>

      <button
        type="button"
        onClick={onClose}
        className="w-full text-sm font-semibold px-4 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2"
      >
        <Check size={14} />
        Concluir
      </button>
    </div>
  );
}

function BoletoRow({
  label,
  sublabel,
  amount,
  url,
  barcode,
  tone,
  installmentInfo,
}: {
  label: string;
  sublabel: string;
  amount: number;
  url: string | null;
  barcode: string | null;
  tone: 'emerald' | 'amber';
  installmentInfo?: string;
}) {
  const borderCls = tone === 'emerald' ? 'border-emerald-500/30' : 'border-amber-500/30';
  const bgCls = tone === 'emerald' ? 'bg-emerald-500/5' : 'bg-amber-500/5';
  const textCls = tone === 'emerald' ? 'text-emerald-700' : 'text-amber-700';
  return (
    <div className={`p-3 rounded-md border ${borderCls} ${bgCls}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="min-w-0">
          <p className={`text-xs font-bold ${textCls}`}>{label}</p>
          <p className="text-[10px] text-muted-foreground">{sublabel}</p>
        </div>
        <p className="text-sm font-bold tabular-nums shrink-0">
          R$ {fmtBRL(amount)}
        </p>
      </div>
      {installmentInfo && (
        <p className="text-[10px] text-muted-foreground mb-1">
          {installmentInfo}
        </p>
      )}
      <div className="flex items-center gap-2 mt-2">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-md border ${borderCls} ${textCls} hover:bg-white inline-flex items-center gap-1`}
          >
            <Send size={10} />
            Abrir boleto
          </a>
        ) : (
          <span className="text-[10px] text-muted-foreground italic">
            URL do boleto será disponibilizada em alguns segundos
          </span>
        )}
        {barcode && (
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(barcode)}
            className="text-[10px] text-muted-foreground hover:text-foreground font-mono truncate"
            title="Clique pra copiar"
          >
            {barcode.slice(0, 20)}...
          </button>
        )}
      </div>
    </div>
  );
}

/** Onda 13 — Histórico de bônus de fechamento (ativos, expirando, expirados) */
function BonusesHistory({ notes }: { notes: string | null }) {
  const bonuses = useMemo(() => parseBonuses(notes), [notes]);
  if (bonuses.length === 0) return null;
  const active = bonuses.filter((b) => !b.expired);
  const expired = bonuses.filter((b) => b.expired);
  return (
    <div className="mt-4 pt-3 border-t border-border space-y-3">
      {/* Ativos (com destaque dourado) */}
      {active.map((b, idx) => {
        const tpl = BONUS_TEMPLATES.find((t) => t.type === b.type);
        return (
          <div
            key={`act-${idx}`}
            className={`border-2 rounded-md p-3 ${
              b.expiringSoon
                ? 'border-amber-500 bg-amber-500/10 ring-2 ring-amber-500/20'
                : 'border-amber-500/50 bg-amber-500/5'
            }`}
          >
            <p className="text-[10px] uppercase tracking-wide text-amber-700 font-bold mb-1 flex items-center gap-1.5">
              <Gift size={11} />
              {tpl?.label || b.type}
              {b.expiringSoon && (
                <span className="ml-auto text-[10px] font-bold text-amber-800 bg-amber-200/60 px-2 py-0.5 rounded-full animate-pulse">
                  ⚠ expira em {formatTimeUntil(b.validUntil)}
                </span>
              )}
              {!b.expiringSoon && (
                <span className="ml-auto font-mono font-normal text-muted-foreground">
                  válido até {b.validUntil.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </p>
            <p className="text-xs text-foreground">{b.body}</p>
          </div>
        );
      })}

      {/* Expirados (tachados) */}
      {expired.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5">
            <Gift size={11} />
            Bônus expirados ({expired.length})
          </p>
          <ul className="space-y-1">
            {expired.map((b, idx) => {
              const tpl = BONUS_TEMPLATES.find((t) => t.type === b.type);
              return (
                <li
                  key={`exp-${idx}`}
                  className="text-[11px] text-muted-foreground px-2 py-1.5 rounded bg-muted/30 border border-border/40 line-through opacity-70"
                >
                  <span className="font-mono text-[10px] text-foreground/60 mr-2">
                    Expirou em {b.validUntil.toLocaleDateString('pt-BR')}
                  </span>
                  <strong className="not-italic">{tpl?.label}:</strong> {b.body}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Formata "expira em Xh Ymin" pra contagem regressiva */
function formatTimeUntil(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms < 0) return 'expirado';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}min`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}min`;
}

/** Onda 13 — Dialog pra adicionar bônus de fechamento */
function BonusDialog({
  loading,
  onCancel,
  onSave,
}: {
  loading: boolean;
  onCancel: () => void;
  onSave: (data: {
    type: BonusType;
    description: string;
    valid_until: string;
    discount_percent_delta?: number;
  }) => void;
}) {
  const [type, setType] = useState<BonusType>('CORTESIA');
  const [description, setDescription] = useState('');
  const [validityChoice, setValidityChoice] = useState<'HOJE' | '48H' | '7D' | 'CUSTOM'>('48H');
  const [customDate, setCustomDate] = useState('');
  const [discountDelta, setDiscountDelta] = useState<string>('');

  const tpl = BONUS_TEMPLATES.find((t) => t.type === type)!;
  const needsDiscount = tpl.hasDiscountInput;

  // Calcula valid_until ISO
  const validUntilIso = (() => {
    const now = new Date();
    if (validityChoice === 'HOJE') {
      const d = new Date();
      d.setHours(23, 59, 0, 0);
      return d.toISOString();
    }
    if (validityChoice === '48H') {
      return new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
    }
    if (validityChoice === '7D') {
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }
    if (validityChoice === 'CUSTOM' && customDate) {
      const d = new Date(customDate);
      d.setHours(23, 59, 0, 0);
      return d.toISOString();
    }
    return '';
  })();

  const canSubmit =
    description.trim().length >= 3 &&
    validUntilIso &&
    (!needsDiscount || (Number(discountDelta) > 0 && Number(discountDelta) <= 100));

  const handleSave = () => {
    onSave({
      type,
      description: description.trim(),
      valid_until: validUntilIso,
      discount_percent_delta: needsDiscount ? Number(discountDelta) : undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-border bg-amber-500/5">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
              <Gift size={18} className="text-amber-700" />
            </div>
            <div>
              <h3 className="text-base font-bold">Bônus de fechamento</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Segura a proposta com um incentivo extra e prazo limitado
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground p-1 -mr-1 -mt-1"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Step 1: tipo de bônus */}
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">
              1. Tipo de bônus
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {BONUS_TEMPLATES.map((t) => {
                const isActive = type === t.type;
                return (
                  <button
                    key={t.type}
                    type="button"
                    onClick={() => {
                      setType(t.type);
                      // Pré-preenche description com placeholder por tipo
                      setDescription((prev) =>
                        prev && prev !== BONUS_TEMPLATES.find((bt) => prev.includes(bt.placeholder.slice(0, 20)))?.placeholder
                          ? prev
                          : '',
                      );
                    }}
                    className={`text-left p-2.5 rounded-lg border transition-colors flex items-start gap-2 ${
                      isActive
                        ? 'border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/20'
                        : 'border-border hover:bg-accent/40'
                    }`}
                  >
                    <span className={isActive ? 'text-amber-700' : 'text-muted-foreground'}>
                      {t.icon}
                    </span>
                    <div className="min-w-0">
                      <p className={`text-xs font-semibold ${isActive ? 'text-amber-800' : 'text-foreground'}`}>
                        {t.label}
                      </p>
                      <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                        {t.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Step 2: descrição + (opcional) % desconto */}
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">
              2. Descrição do bônus
            </p>
            {needsDiscount && (
              <div className="mb-2">
                <label className="text-[11px] font-semibold text-foreground block mb-1">
                  % de desconto extra (somado ao desconto atual)
                </label>
                <input
                  type="number"
                  value={discountDelta}
                  onChange={(e) => setDiscountDelta(e.target.value)}
                  min={0.1}
                  max={50}
                  step={0.5}
                  placeholder="Ex: 3"
                  className="w-32 text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                />
                <span className="text-xs text-muted-foreground ml-2">%</span>
                <p className="text-[10px] text-amber-700 italic mt-1">
                  ⚠ Esse valor será ADICIONADO ao desconto atual do orçamento e o total_value será recalculado
                </p>
              </div>
            )}
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tpl.placeholder}
              rows={3}
              className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-none"
            />
            <p className="text-[10px] text-muted-foreground italic mt-1">
              Esse texto será registrado no histórico do orçamento
            </p>
          </div>

          {/* Step 3: validade */}
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">
              3. Validade do bônus
            </p>
            <div className="flex gap-2 flex-wrap">
              {([
                { key: 'HOJE', label: 'Hoje 23:59' },
                { key: '48H', label: '48 horas' },
                { key: '7D', label: '7 dias' },
                { key: 'CUSTOM', label: 'Data customizada' },
              ] as const).map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setValidityChoice(c.key)}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                    validityChoice === c.key
                      ? 'border-amber-500 bg-amber-500/15 text-amber-800 font-semibold'
                      : 'border-border hover:bg-accent'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {validityChoice === 'CUSTOM' && (
              <input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                min={new Date().toISOString().slice(0, 10)}
                className="mt-2 text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30"
              />
            )}
            {validUntilIso && (
              <p className="text-[11px] text-muted-foreground mt-2">
                ⏰ Bônus válido até{' '}
                <strong className="text-foreground">
                  {new Date(validUntilIso).toLocaleString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </strong>
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSubmit || loading}
            className="text-xs px-4 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 font-semibold"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Gift size={12} />}
            Adicionar bônus
          </button>
        </div>
      </div>
    </div>
  );
}

/** Onda 14.5 — Modal de resultado de "Aprovar e cobrar". */
function ApproveBillResultDialog({
  result,
  onClose,
}: {
  result: {
    quote_id: string;
    plan_id: string;
    billing_type: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
    installment_count?: number;
    pix?: { qrCode: string; copyPaste: string; expirationDate: string } | null;
    boleto?: { url: string; barcode: string | null } | null;
    invoice_url?: string | null;
    is_existing?: boolean;
  };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyPasteCode = result.pix?.copyPaste || '';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border bg-emerald-500/10">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
              <ShieldCheck size={24} className="text-emerald-700" />
            </div>
            <div>
              <h3 className="text-base font-bold text-emerald-800">
                {result.is_existing
                  ? 'Cobrança existente (não foi criada nova)'
                  : 'Proposta aprovada e cobrança gerada!'}
              </h3>
              <p className="text-xs text-emerald-700 mt-1">
                {result.billing_type === 'PIX' && 'Pagamento via PIX'}
                {result.billing_type === 'CREDIT_CARD' &&
                  `Cartão de crédito · ${result.installment_count}x`}
                {result.billing_type === 'BOLETO' && 'Boleto bancário à vista'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Onda 14.11 — Aviso quando cobranca retornada e a JA EXISTENTE */}
          {result.is_existing && (
            <div className="bg-amber-500/10 border-2 border-amber-500/40 rounded-md p-3">
              <p className="text-xs font-semibold text-amber-800 mb-1">
                ⚠ Esta cobrança já existia pra este plano
              </p>
              <p className="text-[11px] text-amber-700">
                Em vez de criar uma cobrança duplicada, o sistema retornou a
                existente. Se quer gerar uma nova com forma de pagamento
                diferente, primeiro cancele esta no painel Asaas.
              </p>
            </div>
          )}
          {result.billing_type === 'PIX' && result.pix && (
            <>
              <div className="bg-muted/20 border border-border rounded-lg p-4 text-center">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-bold mb-2">
                  Escaneie o QR Code
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${result.pix.qrCode}`}
                  alt="QR Code PIX"
                  className="w-48 h-48 mx-auto rounded-md"
                />
                <p className="text-[10px] text-muted-foreground mt-2">
                  Válido até {new Date(result.pix.expirationDate).toLocaleString('pt-BR')}
                </p>
              </div>
              <div>
                <label className="text-[11px] font-semibold text-foreground block mb-1">
                  Ou cole o código PIX no app do banco:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={copyPasteCode}
                    readOnly
                    className="flex-1 text-xs px-3 py-2 rounded-md border border-border bg-muted/30 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(copyPasteCode);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="text-xs px-3 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 font-semibold"
                  >
                    {copied ? '✓ Copiado' : 'Copiar'}
                  </button>
                </div>
              </div>
            </>
          )}

          {result.billing_type === 'CREDIT_CARD' && result.invoice_url && (
            <div className="bg-sky-500/10 border border-sky-500/30 rounded-md p-4">
              <p className="text-xs font-semibold text-sky-800 mb-2">
                💳 Link de pagamento pro paciente
              </p>
              <p className="text-[11px] text-muted-foreground mb-3">
                Compartilhe esse link com o paciente. Ele vai preencher os dados
                do cartão em página segura do Asaas.
              </p>
              <a
                href={result.invoice_url}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center text-sm font-semibold px-4 py-3 rounded-lg bg-sky-600 text-white hover:bg-sky-700"
              >
                Abrir link de pagamento ↗
              </a>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(result.invoice_url!);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="block w-full text-center text-xs mt-2 px-3 py-2 rounded-md border border-sky-500/40 hover:bg-sky-500/10 font-medium"
              >
                {copied ? '✓ Link copiado' : 'Copiar link'}
              </button>
            </div>
          )}

          {result.billing_type === 'BOLETO' && result.boleto && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-4">
              <p className="text-xs font-semibold text-amber-800 mb-2">
                🧾 Boleto bancário gerado
              </p>
              <a
                href={result.boleto.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center text-sm font-semibold px-4 py-3 rounded-lg bg-amber-600 text-white hover:bg-amber-700"
              >
                Abrir boleto (PDF) ↗
              </a>
              {result.boleto.barcode && (
                <div className="mt-3">
                  <label className="text-[11px] font-semibold text-foreground block mb-1">
                    Código de barras:
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={result.boleto.barcode}
                      readOnly
                      className="flex-1 text-xs px-3 py-2 rounded-md border border-border bg-muted/30 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(result.boleto!.barcode!);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="text-xs px-3 py-2 rounded-md bg-amber-600 text-white hover:bg-amber-700 font-semibold"
                    >
                      {copied ? '✓ Copiado' : 'Copiar'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="bg-muted/20 border border-border rounded-md p-3 text-[11px] text-muted-foreground">
            🔔 O Asaas envia automaticamente por email/WhatsApp pro paciente.
            Você acompanha o status na aba <strong>Financeiro</strong> do paciente.
          </div>
        </div>

        <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-5 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-semibold flex items-center gap-1.5"
          >
            <Check size={14} />
            Concluir
          </button>
        </div>
      </div>
    </div>
  );
}
