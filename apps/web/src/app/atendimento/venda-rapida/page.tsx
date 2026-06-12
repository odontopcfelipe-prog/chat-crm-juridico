'use client';

/**
 * Onda 17.32.68 — Venda Rápida (balcão sem avaliação).
 *
 * Estilo "Mercado Livre": grid de procedimentos prontos pra venda na hora,
 * carrinho à direita, selector de paciente + forma de pagamento, botão
 * Finalizar. Ao confirmar, faz POST /commercial/venda-rapida que cria
 * Quote+Plan+Charge em 1 chamada atômica.
 *
 * Sem passar pelo fluxo de Avaliação/Propostas — pra vendas simples:
 * limpeza, clareamento, raspagem, extração simples, radiografia, etc.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Search, Plus, Minus, ShoppingCart, Zap, X,
  Sparkles, Droplet, Smile, Stethoscope, Scissors, Image as ImageIcon,
  CheckCircle2, AlertCircle, User as UserIcon, CreditCard, DollarSign,
  Copy, ExternalLink, ArrowRight, UserPlus, Pencil, Check,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import NewPatientModal from '../pacientes/components/NewPatientModal';

interface Procedure {
  id: string;
  name: string;
  base_price: number | string;
  duration_minutes: number;
  category: string | null;
  description: string | null;
}

interface PatientOption {
  id: string;
  name: string;
  phone?: string | null;
  cpf?: string | null;
}

interface CartItem {
  procedure: Procedure;
  quantity: number;
  // Onda 17.38 — dentes (FDI) do procedimento. Vazio = procedimento sem dente
  // (limpeza, clareamento de arcada). Com dentes = 1 unidade por dente (entra
  // no odontograma/tratamento pra a dentista validar o que foi feito).
  toothFdis: string[];
  // Onda 17.39 — preço unitário customizado (desconto). null = usa base_price.
  // Só editável por quem tem a permissão `override_price`; o backend trava
  // preço abaixo da tabela sem a permissão.
  customPrice: number | null;
}

// Onda 17.38 — numeração FDI, igual à avaliação/odontograma. Layout anatômico:
// arcada superior em cima (18→11 | 21→28), inferior embaixo.
const FDI_PERMANENT_ROWS: string[][] = [
  ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28'],
  ['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'],
];
const FDI_DECIDUOUS_ROWS: string[][] = [
  ['55', '54', '53', '52', '51', '61', '62', '63', '64', '65'],
  ['85', '84', '83', '82', '81', '71', '72', '73', '74', '75'],
];

// Quantas unidades um item vale: nº de dentes se houver, senão a quantidade.
const itemUnits = (it: CartItem) => (it.toothFdis.length > 0 ? it.toothFdis.length : it.quantity);

// Preço unitário efetivo: customizado (desconto) ou o de tabela.
const unitPriceOf = (it: CartItem) =>
  it.customPrice != null ? it.customPrice : Number(it.procedure.base_price);

// Onda 17.32.69 — Boleto removido (venda balcao raramente pede boleto;
// quando precisar parcelar, usar o fluxo normal de Avaliacao/Propostas).
// Onda 17.32.71 — CASH (especie/dinheiro) separado de PIX. Backend
// trata CASH como PIX + receiveInCash (marca como ja paga).
// Onda 17.37 — formas "recebido na clínica" (CASH/CLINIC_CARD/CLINIC_PIX) NÃO
// passam pelo Asaas online: registram a cobranca como JA RECEBIDA (receive-in-
// cash) e entram no financeiro do paciente pra prestacao de contas. PIX/CARTAO
// continuam gerando cobranca online via Asaas.
type BillingType = 'PIX' | 'CREDIT_CARD' | 'CASH' | 'CLINIC_CARD' | 'CLINIC_PIX';

// Rotulo do metodo recebido na clinica — vai no titulo do orcamento pra
// aparecer no Financeiro do paciente.
const CLINIC_METHOD_LABEL: Record<string, string> = {
  CASH: 'Espécie',
  CLINIC_CARD: 'Maquineta (clínica)',
  CLINIC_PIX: 'PIX da clínica',
};
const isClinicReceived = (t: BillingType) =>
  t === 'CASH' || t === 'CLINIC_CARD' || t === 'CLINIC_PIX';

// Mapeia categoria do Procedure -> grupo de tab (UI). Tabs reduzem a
// fadiga de escolha do operador (4-6 botoes em vez de 20+ categorias).
const CATEGORY_TO_TAB: Record<string, string> = {
  PROFILAXIA: 'PREVENCAO',
  DENTISTICA: 'CLINICO',
  ENDODONTIA: 'CLINICO',
  PERIODONTIA: 'CLINICO',
  ORTODONTIA: 'CLINICO',
  IMPLANTE: 'CIRURGIA',
  PROTESE: 'CIRURGIA',
  CIRURGIA: 'CIRURGIA',
  ESTETICA_DENTAL: 'ESTETICA',
  HOF: 'ESTETICA',
  TOXINA_BOTULINICA: 'ESTETICA',
  PREENCHIMENTO_AH: 'ESTETICA',
  BIOESTIMULADOR: 'ESTETICA',
  FIOS_PDO: 'ESTETICA',
  PEELING_QUIMICO: 'ESTETICA',
  MICROAGULHAMENTO: 'ESTETICA',
  LASER: 'ESTETICA',
  RADIOFREQUENCIA: 'ESTETICA',
};

const TABS = [
  { key: 'TODOS', label: 'Todos' },
  { key: 'PREVENCAO', label: 'Prevenção' },
  { key: 'ESTETICA', label: 'Estética' },
  { key: 'CLINICO', label: 'Clínico' },
  { key: 'CIRURGIA', label: 'Cirurgia' },
  { key: 'DIAGNOSTICO', label: 'Diagnóstico' },
];

// Icone visual por tab (decorativo nos cards)
const ICON_BY_TAB: Record<string, { Icon: any; bg: string; fg: string }> = {
  PREVENCAO: { Icon: Droplet, bg: 'bg-emerald-500/15', fg: 'text-emerald-700' },
  ESTETICA: { Icon: Sparkles, bg: 'bg-violet-500/15', fg: 'text-violet-700' },
  CLINICO: { Icon: Stethoscope, bg: 'bg-blue-500/15', fg: 'text-blue-700' },
  CIRURGIA: { Icon: Scissors, bg: 'bg-amber-500/15', fg: 'text-amber-700' },
  DIAGNOSTICO: { Icon: ImageIcon, bg: 'bg-orange-500/15', fg: 'text-orange-700' },
  TODOS: { Icon: Smile, bg: 'bg-muted', fg: 'text-muted-foreground' },
};

function categoryToTab(cat?: string | null): string {
  if (!cat) return 'TODOS';
  return CATEGORY_TO_TAB[cat] || 'TODOS';
}

function fmtBRL(v: number): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function VendaRapidaPage() {
  const router = useRouter();
  // Onda 17.39 — só quem tem `override_price` edita preço (dar desconto).
  const { hasPermission } = useUserPermissions();
  const canOverridePrice = hasPermission('override_price');
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [loadingProc, setLoadingProc] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<string>('TODOS');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState<PatientOption[]>([]);
  const [searchingPatient, setSearchingPatient] = useState(false);
  // Onda 17.37 — cadastrar paciente sem sair da venda: abre o modal, cria e
  // já seleciona pra "Vender para".
  const [showNewPatient, setShowNewPatient] = useState(false);
  const [billingType, setBillingType] = useState<BillingType>('PIX');
  const [installments, setInstallments] = useState<number>(1);
  const [finishing, setFinishing] = useState(false);
  // Onda 17.32.70 — Dialog de sucesso com QR PIX ou link de cartao
  const [successDialog, setSuccessDialog] = useState<{
    billingType: BillingType;
    total: number;
    patientName: string;
    patientId: string;
    pixQrCode?: string | null;     // base64 da imagem
    pixCopyPaste?: string | null;  // payload Pix
    invoiceUrl?: string | null;    // url Asaas (cartao)
    boletoUrl?: string | null;     // pdf boleto (nao usado mas mantido pra extensao)
  } | null>(null);

  // Carrega procedimentos
  useEffect(() => {
    api.get<Procedure[] | { data: Procedure[] }>('/procedures')
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : (data?.data || []);
        setProcedures(list);
      })
      .catch(() => showError('Falha ao carregar procedimentos'))
      .finally(() => setLoadingProc(false));
  }, []);

  // Busca paciente (debounced)
  useEffect(() => {
    if (!patientQuery.trim() || patientQuery.length < 2) {
      setPatientResults([]);
      return;
    }
    setSearchingPatient(true);
    const id = setTimeout(() => {
      api.get<PatientOption[] | { data: PatientOption[] }>(`/patients?q=${encodeURIComponent(patientQuery)}&limit=8`)
        .then(({ data }) => {
          const list = Array.isArray(data) ? data : (data?.data || []);
          setPatientResults(list);
        })
        .catch(() => { /* silencioso */ })
        .finally(() => setSearchingPatient(false));
    }, 300);
    return () => clearTimeout(id);
  }, [patientQuery]);

  // Filtra procedimentos por tab + search
  const filteredProcedures = useMemo(() => {
    let arr = procedures;
    if (tab !== 'TODOS') {
      arr = arr.filter((p) => categoryToTab(p.category) === tab);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      arr = arr.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q),
      );
    }
    return arr.slice(0, 60); // limita render — operador busca pra refinar
  }, [procedures, tab, search]);

  // Carrinho helpers
  const [toothPickerFor, setToothPickerFor] = useState<string | null>(null);
  const [toothKidMode, setToothKidMode] = useState(false);

  const addToCart = (p: Procedure) => {
    setCart((prev) => {
      const existing = prev.find((it) => it.procedure.id === p.id);
      if (existing) {
        // Item com dentes não incrementa quantity (a contagem é por dente)
        if (existing.toothFdis.length > 0) return prev;
        return prev.map((it) =>
          it.procedure.id === p.id ? { ...it, quantity: it.quantity + 1 } : it,
        );
      }
      return [...prev, { procedure: p, quantity: 1, toothFdis: [], customPrice: null }];
    });
  };

  // Onda 17.39 — define preço unitário (desconto). null/≥base reseta pro de
  // tabela; clampa em [0, base] (só desconto, nunca acima da tabela).
  const setItemPrice = (procId: string, v: number | null) => {
    setCart((prev) =>
      prev.map((it) => {
        if (it.procedure.id !== procId) return it;
        const base = Number(it.procedure.base_price);
        if (v == null || v >= base) return { ...it, customPrice: null };
        return { ...it, customPrice: Math.max(0, v) };
      }),
    );
  };

  // Marca/desmarca um dente FDI no item
  const toggleTooth = (procId: string, fdi: string) => {
    setCart((prev) =>
      prev.map((it) =>
        it.procedure.id === procId
          ? {
              ...it,
              toothFdis: it.toothFdis.includes(fdi)
                ? it.toothFdis.filter((t) => t !== fdi)
                : [...it.toothFdis, fdi],
            }
          : it,
      ),
    );
  };

  const changeQty = (id: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((it) =>
          it.procedure.id === id
            ? { ...it, quantity: Math.max(0, it.quantity + delta) }
            : it,
        )
        .filter((it) => it.quantity > 0),
    );
  };

  const removeFromCart = (id: string) => {
    setCart((prev) => prev.filter((it) => it.procedure.id !== id));
  };

  // Totais — item com dentes vale 1 unidade por dente
  const subtotal = useMemo(
    () => cart.reduce((sum, it) => sum + unitPriceOf(it) * itemUnits(it), 0),
    [cart],
  );
  // Onda 17.37 — desconto à vista só no PIX online (Asaas). As formas recebidas
  // na clínica (espécie/maquineta/PIX clínica) vão a preço cheio (decisão do
  // dono do produto: maquineta tem taxa, e o caixa fica sem divergência).
  const avistaDiscount = billingType === 'PIX' ? subtotal * 0.10 : 0;
  const total = subtotal - avistaDiscount;

  // Finaliza venda
  const handleFinish = async () => {
    if (!patient) {
      showError('Selecione um paciente antes de finalizar');
      return;
    }
    if (cart.length === 0) {
      showError('Adicione ao menos 1 procedimento');
      return;
    }
    setFinishing(true);
    try {
      // Onda 17.32.72 — Em vez de POST /commercial/venda-rapida (rota
      // nova que depende de deploy do API), faz 2-3 chamadas em
      // sequencia usando endpoints que JA EXISTEM:
      //   1. POST /commercial/patients/:id/quotes   (cria Quote+items)
      //   2. POST /quotes/:id/approve-and-bill       (aprova + cobra)
      //   3. POST /payment-gateway/charges/asaas/:asaasId/receive-in-cash
      //      (so pra CASH — marca como recebida em dinheiro)
      //
      // Funciona imediatamente, sem depender de rebuild do API.

      // 1. Cria Quote (com items)
      const discountPercent = billingType === 'PIX' ? 10 : 0;
      const clinicReceived = isClinicReceived(billingType);
      // Método recebido na clínica vai no título → aparece no Financeiro do
      // paciente (prestação de contas: "como" foi pago).
      const title = clinicReceived
        ? `Venda rápida · ${CLINIC_METHOD_LABEL[billingType]}`
        : 'Venda rápida';
      const { data: quoteData } = await api.post<any>(
        `/patients/${patient.id}/quotes`,
        {
          title,
          // Onda 17.38 — item com dentes vira 1 item POR dente (tooth_fdi),
          // pra entrar no odontograma/tratamento e a dentista validar dente a
          // dente. Sem dentes = item por quantidade (limpeza, clareamento).
          items: cart.flatMap((it) => {
            // Onda 17.39 — desconto vai como unit_price (omitido = preço de
            // tabela). O backend bloqueia se o usuário não tiver override_price.
            const priceOverride = it.customPrice != null ? { unit_price: it.customPrice } : {};
            return it.toothFdis.length > 0
              ? it.toothFdis.map((fdi) => ({
                  procedure_id: it.procedure.id,
                  quantity: 1,
                  tooth_fdi: fdi,
                  ...priceOverride,
                }))
              : [{ procedure_id: it.procedure.id, quantity: it.quantity, ...priceOverride }];
          }),
          discount_percent: discountPercent,
          notes: clinicReceived
            ? `Venda rapida — recebido na clinica: ${CLINIC_METHOD_LABEL[billingType]}`
            : 'Venda rapida (balcao sem avaliacao)',
        },
      );
      const quoteId = quoteData?.id || quoteData?.quote?.id;
      if (!quoteId) throw new Error('Falha ao criar orcamento');

      // 2. approveAndBill — cria charge. Recebido na clínica usa PIX como tipo
      // (Asaas só aceita PIX/BOLETO/CREDIT_CARD) e é marcado como recebido no
      // passo 3 — não gera cobrança online.
      const { data: billData } = await api.post<any>(
        `/quotes/${quoteId}/approve-and-bill`,
        {
          billing_type: clinicReceived ? 'PIX' : billingType,
          value: total,
          installment_count: billingType === 'CREDIT_CARD' ? installments : undefined,
        },
      );

      // 3. Recebido na clínica — receiveInCash imediato registra como pago e
      // joga no financeiro do paciente (espécie, maquineta ou PIX da clínica).
      const asaasId = billData?.charge?.external_id;
      if (clinicReceived && asaasId) {
        try {
          await api.post(`/payment-gateway/charges/asaas/${asaasId}/receive-in-cash`);
        } catch (e: any) {
          console.warn('[VENDA-RAPIDA] receiveInCash falhou:', e?.message);
          // Nao bloqueia — operador pode marcar manualmente depois
        }
      }

      // Onda 17.32.70 — Dialog de sucesso
      setSuccessDialog({
        billingType,
        total,
        patientName: patient.name,
        patientId: patient.id,
        pixQrCode: billData?.pix?.qrCode || null,
        pixCopyPaste: billData?.pix?.copyPaste || null,
        invoiceUrl: billData?.invoice_url || null,
        boletoUrl: billData?.boleto?.url || null,
      });
      setCart([]);
      showSuccess('Venda finalizada!');
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro ao finalizar venda';
      showError(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(', ') : 'Erro ao finalizar'));
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center shadow-md">
            <Zap size={20} className="text-white" strokeWidth={2.5} />
          </div>
          <h1 className="text-2xl font-extrabold text-foreground">Venda rápida</h1>
          <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-1 rounded border border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400">
            Balcão · Sem avaliação
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Venda um procedimento na hora e <strong className="text-emerald-700 dark:text-emerald-400">já entra no tratamento do paciente</strong>{' '}
          — gera a cobrança e dispensa o fluxo de avaliação.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
        {/* COLUNA ESQUERDA — Procedimentos */}
        <div>
          {/* Busca */}
          <div className="relative mb-3">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar procedimento... (limpeza, clareamento, flúor)"
              className="w-full pl-10 pr-3 py-3 text-sm border border-border rounded-xl bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-orange-500/30"
            />
          </div>
          {/* Tabs */}
          <div className="flex gap-2 mb-4 flex-wrap">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`text-xs font-semibold px-4 py-2 rounded-lg border transition-colors ${
                  tab === t.key
                    ? 'bg-foreground text-background border-foreground'
                    : 'border-border bg-card text-foreground hover:bg-accent/40'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* Grid de procedimentos */}
          {loadingProc ? (
            <div className="py-16 flex items-center justify-center text-muted-foreground">
              <Loader2 size={18} className="animate-spin mr-2" />
              Carregando procedimentos...
            </div>
          ) : filteredProcedures.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground bg-card border border-dashed border-border rounded-xl">
              Nenhum procedimento encontrado nessa categoria.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {filteredProcedures.map((p) => {
                const tabKey = categoryToTab(p.category);
                const iconCfg = ICON_BY_TAB[tabKey] || ICON_BY_TAB.TODOS;
                const inCart = cart.find((it) => it.procedure.id === p.id);
                return (
                  <div
                    key={p.id}
                    className={`bg-card border rounded-xl p-4 transition-all hover:shadow-md ${
                      inCart ? 'border-orange-500/40 ring-2 ring-orange-500/20' : 'border-border'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg ${iconCfg.bg} flex items-center justify-center mb-3`}>
                      <iconCfg.Icon size={18} className={iconCfg.fg} />
                    </div>
                    {p.category && (
                      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">
                        {(TABS.find((t) => t.key === tabKey)?.label || p.category).toUpperCase()}
                      </p>
                    )}
                    <p className="text-sm font-bold text-foreground mb-1 line-clamp-2">{p.name}</p>
                    {p.duration_minutes && (
                      <p className="text-[11px] text-muted-foreground mb-2">⏱ {p.duration_minutes} min</p>
                    )}
                    <p className="text-lg font-extrabold text-foreground tabular-nums mb-3">
                      R$ {fmtBRL(Number(p.base_price))}
                    </p>
                    <button
                      type="button"
                      onClick={() => addToCart(p)}
                      className="w-full text-xs font-bold px-3 py-2 rounded-md border-2 border-orange-500/30 bg-orange-500/5 hover:bg-orange-500/10 text-orange-700 dark:text-orange-400 transition-colors inline-flex items-center justify-center gap-1.5"
                    >
                      <Plus size={12} strokeWidth={3} />
                      {inCart ? `Adicionar (${inCart.quantity})` : 'Adicionar'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* COLUNA DIREITA — Sidebar carrinho */}
        <aside className="bg-card border border-border rounded-xl p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto h-fit">
          {/* Paciente */}
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
              Vender para
            </p>
            {patient ? (
              <div className="border border-emerald-500/30 bg-emerald-500/5 rounded-lg p-3 flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-700 flex items-center justify-center font-bold text-sm shrink-0">
                  {patient.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-foreground truncate">{patient.name}</p>
                  {patient.phone && (
                    <p className="text-[11px] text-muted-foreground truncate">{patient.phone}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => { setPatient(null); setPatientQuery(''); }}
                  className="p-1 rounded-md hover:bg-accent/40 text-muted-foreground shrink-0"
                  title="Trocar paciente"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="relative">
                <div className="border border-dashed border-border rounded-lg p-3 flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                    <UserIcon size={14} />
                  </div>
                  <input
                    type="text"
                    value={patientQuery}
                    onChange={(e) => setPatientQuery(e.target.value)}
                    placeholder="Buscar paciente por nome/CPF..."
                    className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground/60"
                  />
                  {searchingPatient && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
                </div>
                {patientResults.length > 0 && (
                  <ul className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl max-h-64 overflow-auto">
                    {patientResults.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => { setPatient(p); setPatientResults([]); setPatientQuery(''); }}
                          className="w-full text-left px-3 py-2 hover:bg-accent/40 flex items-center gap-2"
                        >
                          <div className="w-7 h-7 rounded-full bg-muted text-muted-foreground flex items-center justify-center font-bold text-xs">
                            {p.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate">{p.name}</p>
                            {p.phone && <p className="text-[10px] text-muted-foreground truncate">{p.phone}</p>}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Cadastrar paciente sem sair da venda */}
                <button
                  type="button"
                  onClick={() => setShowNewPatient(true)}
                  className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 text-sm font-medium"
                >
                  <UserPlus size={15} /> Cadastrar novo paciente
                </button>
                <p className="text-[10px] text-muted-foreground mt-1">obrigatório para lançar no tratamento</p>
              </div>
            )}
          </div>

          {/* Carrinho */}
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
              Carrinho ({cart.length})
            </p>
            {cart.length === 0 ? (
              <div className="bg-muted/30 rounded-lg p-6 text-center text-sm text-muted-foreground">
                <ShoppingCart size={24} className="mx-auto mb-2 opacity-50" />
                Clique num procedimento para começar a venda
              </div>
            ) : (
              <ul className="space-y-2">
                {cart.map((it) => {
                  const hasTeeth = it.toothFdis.length > 0;
                  return (
                  <li key={it.procedure.id} className="bg-muted/30 rounded-lg p-2.5">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-foreground truncate">{it.procedure.name}</p>
                        <div className="text-[10px] text-muted-foreground tabular-nums flex items-center gap-1 flex-wrap">
                          {canOverridePrice ? (
                            <PriceTag
                              base={Number(it.procedure.base_price)}
                              value={unitPriceOf(it)}
                              onChange={(v) => setItemPrice(it.procedure.id, v)}
                            />
                          ) : (
                            <span>R$ {fmtBRL(unitPriceOf(it))}</span>
                          )}
                          <span>× {itemUnits(it)}</span>
                          {hasTeeth && <span>({it.toothFdis.length} dente{it.toothFdis.length > 1 ? 's' : ''})</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Quantidade só quando NÃO há dentes (com dentes, a contagem é por dente) */}
                        {!hasTeeth && (
                          <>
                            <button
                              type="button"
                              onClick={() => changeQty(it.procedure.id, -1)}
                              className="w-6 h-6 rounded border border-border bg-card hover:bg-accent/40 flex items-center justify-center"
                            >
                              <Minus size={10} />
                            </button>
                            <span className="w-5 text-center text-xs font-bold tabular-nums">{it.quantity}</span>
                            <button
                              type="button"
                              onClick={() => changeQty(it.procedure.id, 1)}
                              className="w-6 h-6 rounded border border-border bg-card hover:bg-accent/40 flex items-center justify-center"
                            >
                              <Plus size={10} />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => removeFromCart(it.procedure.id)}
                          className="w-6 h-6 rounded text-muted-foreground hover:text-red-600 ml-1 flex items-center justify-center"
                          title="Remover"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>

                    {/* Onda 17.38 — dentes do item (chips + abrir seletor FDI) */}
                    <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                      {it.toothFdis.map((fdi) => (
                        <span
                          key={fdi}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 text-[10px] font-bold border border-amber-300/60"
                        >
                          {fdi}
                          <button type="button" onClick={() => toggleTooth(it.procedure.id, fdi)} className="hover:text-red-600" title="Remover dente">
                            <X size={9} />
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        onClick={() => setToothPickerFor(toothPickerFor === it.procedure.id ? null : it.procedure.id)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-dashed border-border text-[10px] font-medium text-muted-foreground hover:border-primary hover:text-primary"
                      >
                        <Smile size={11} /> {hasTeeth ? 'Dentes' : 'Dente (opcional)'}
                      </button>
                    </div>

                    {toothPickerFor === it.procedure.id && (
                      <ToothPicker
                        selected={it.toothFdis}
                        onToggle={(fdi) => toggleTooth(it.procedure.id, fdi)}
                        kidMode={toothKidMode}
                        onKidMode={setToothKidMode}
                        onClose={() => setToothPickerFor(null)}
                      />
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Forma de pagamento */}
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
              Forma de pagamento
            </p>
            <div className="space-y-1.5">
              {([
                // Onda 17.37 — 2 grupos: online (Asaas) e recebido na clínica.
                { group: 'Cobrar online (Asaas)', key: 'PIX' as BillingType, label: 'PIX', sub: 'QR Asaas · −10%', Icon: DollarSign },
                { group: 'Cobrar online (Asaas)', key: 'CREDIT_CARD' as BillingType, label: 'Cartão', sub: 'link Asaas · até 6x', Icon: CreditCard },
                { group: 'Recebido na clínica', key: 'CASH' as BillingType, label: 'Espécie', sub: 'dinheiro em mãos', Icon: DollarSign },
                { group: 'Recebido na clínica', key: 'CLINIC_CARD' as BillingType, label: 'Maquineta (clínica)', sub: 'cartão na máquina da clínica', Icon: CreditCard },
                { group: 'Recebido na clínica', key: 'CLINIC_PIX' as BillingType, label: 'PIX da clínica', sub: 'chave PIX da clínica', Icon: DollarSign },
              ]).map((m, idx, arr) => {
                const isActive = billingType === m.key;
                const showHeader = idx === 0 || arr[idx - 1].group !== m.group;
                return (
                  <div key={m.key}>
                    {showHeader && (
                      <p className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground/70 mb-1 mt-2 first:mt-0">
                        {m.group}
                      </p>
                    )}
                  <button
                    type="button"
                    onClick={() => setBillingType(m.key)}
                    className={`w-full text-left p-2.5 rounded-lg border-2 transition-colors flex items-center gap-2 ${
                      isActive
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-border bg-card hover:bg-accent/40'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
                      isActive ? 'bg-emerald-500/20 text-emerald-700' : 'bg-muted text-muted-foreground'
                    }`}>
                      <m.Icon size={14} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-foreground">{m.label}</p>
                      <p className="text-[10px] text-muted-foreground">{m.sub}</p>
                    </div>
                    {isActive && <CheckCircle2 size={14} className="text-emerald-600 shrink-0" />}
                  </button>
                  </div>
                );
              })}
            </div>
            {billingType === 'CREDIT_CARD' && (
              <div className="mt-2">
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 block">
                  Parcelas
                </label>
                <select
                  value={installments}
                  onChange={(e) => setInstallments(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-border rounded-md bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                >
                  {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
                    <option key={n} value={n}>{n}× de R$ {fmtBRL(total / n)}{n <= 6 ? ' sem juros' : ''}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Total */}
          <div className="border-t border-border pt-3 mb-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-semibold tabular-nums">R$ {fmtBRL(subtotal)}</span>
            </div>
            {billingType === 'PIX' && avistaDiscount > 0 && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-emerald-700 dark:text-emerald-400">Desconto à vista</span>
                <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                  − R$ {fmtBRL(avistaDiscount)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <span className="text-sm font-bold">Total</span>
              <span className="text-xl font-extrabold tabular-nums">R$ {fmtBRL(total)}</span>
            </div>
          </div>

          {/* CTA */}
          <button
            type="button"
            onClick={handleFinish}
            disabled={finishing || !patient || cart.length === 0}
            className="w-full text-sm font-bold px-4 py-3 rounded-lg bg-orange-600 hover:bg-orange-700 text-white transition-colors disabled:bg-muted disabled:text-muted-foreground inline-flex items-center justify-center gap-2"
          >
            {finishing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Finalizando...
              </>
            ) : !patient ? (
              <>
                <AlertCircle size={14} />
                Selecione um paciente
              </>
            ) : cart.length === 0 ? (
              <>
                <ShoppingCart size={14} />
                Adicione procedimentos
              </>
            ) : (
              <>
                <Zap size={14} strokeWidth={3} />
                Finalizar venda · R$ {fmtBRL(total)}
              </>
            )}
          </button>

          {/* Footnote */}
          <div className="mt-3 text-[10px] text-emerald-700 dark:text-emerald-400 flex items-start gap-1.5">
            <CheckCircle2 size={11} className="shrink-0 mt-0.5" />
            <p className="leading-snug">
              Ao finalizar: gera a cobrança no Asaas, lança os procedimentos no
              tratamento do paciente e libera o agendamento.
            </p>
          </div>
        </aside>
      </div>

      {/* Onda 17.32.70 — Dialog de sucesso (QR PIX ou link cartao) */}
      {successDialog && (
        <SuccessDialog
          data={successDialog}
          onClose={() => setSuccessDialog(null)}
          onGoToPatient={() => {
            router.push(`/atendimento/pacientes/${successDialog.patientId}?tab=financial`);
          }}
        />
      )}

      {/* Onda 17.37 — Cadastro de paciente sem sair da venda: ao criar, já
          seleciona o paciente em "Vender para" e fecha o modal. */}
      {showNewPatient && (
        <NewPatientModal
          onClose={() => setShowNewPatient(false)}
          onCreated={(p: any) => {
            setPatient({ id: p.id, name: p.name, phone: p.phone ?? null, cpf: p.cpf ?? null });
            setPatientQuery('');
            setPatientResults([]);
            setShowNewPatient(false);
            showSuccess(`${p.name} selecionado para a venda`);
          }}
        />
      )}
    </div>
  );
}

/** Onda 17.32.70 — Dialog de sucesso pos-venda. Mostra QR PIX ou link
 *  do cartao em tela grande pra operador mostrar pro paciente direto. */
function SuccessDialog({
  data,
  onClose,
  onGoToPatient,
}: {
  data: {
    billingType: BillingType;
    total: number;
    patientName: string;
    pixQrCode?: string | null;
    pixCopyPaste?: string | null;
    invoiceUrl?: string | null;
  };
  onClose: () => void;
  onGoToPatient: () => void;
}) {
  const handleCopy = async () => {
    if (!data.pixCopyPaste) return;
    try {
      await navigator.clipboard.writeText(data.pixCopyPaste);
      showSuccess('Pix Copia e Cola copiado!');
    } catch {
      showError('Nao foi possivel copiar');
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[95vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 text-white px-6 py-4 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
              <CheckCircle2 size={20} strokeWidth={2.5} />
            </div>
            <div>
              <h2 className="text-lg font-extrabold">Venda finalizada!</h2>
              <p className="text-xs text-white/80">
                {data.patientName} · R$ {data.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-md hover:bg-white/20 transition-colors"
            title="Fechar"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6">
          {isClinicReceived(data.billingType) ? (
            <div className="text-center py-4">
              <div className="w-20 h-20 rounded-full bg-emerald-500/15 text-emerald-700 flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 size={48} strokeWidth={2} />
              </div>
              <p className="text-lg font-extrabold text-foreground mb-1">
                Recebido na clínica · {CLINIC_METHOD_LABEL[data.billingType]}
              </p>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Pagamento registrado como recebido e lançado no financeiro do
                paciente. Os procedimentos já aparecem no tratamento.
              </p>
            </div>
          ) : data.billingType === 'PIX' && data.pixQrCode ? (
            <div className="text-center">
              <p className="text-sm font-bold text-foreground mb-1">
                Mostre o QR Code abaixo pro paciente
              </p>
              <p className="text-xs text-muted-foreground mb-4">
                Ele abre o app do banco, aponta a câmera e paga.
              </p>
              {/* Onda 17.32.74 — Logo PIX oficial (BCB) acima do QR code
                  pra reforco visual (paciente reconhece o pagamento PIX
                  imediatamente). SVG inline com cor #32BCAD do BCB. */}
              <div className="bg-white p-4 rounded-xl inline-block border-4 border-emerald-500">
                <div className="flex items-center justify-center gap-2 mb-3">
                  <PixLogo />
                </div>
                <img
                  src={`data:image/png;base64,${data.pixQrCode}`}
                  alt="QR Code PIX"
                  className="w-64 h-64 sm:w-80 sm:h-80"
                />
              </div>
              {/* Pix Copia e Cola */}
              {data.pixCopyPaste && (
                <div className="mt-4">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
                    Ou use o Pix Copia e Cola
                  </p>
                  <div className="bg-muted/30 border border-border rounded-md p-3 flex items-center gap-2">
                    <code className="text-[11px] text-foreground truncate flex-1 font-mono text-left">
                      {data.pixCopyPaste}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="text-xs font-bold px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1.5 shrink-0"
                    >
                      <Copy size={12} />
                      Copiar
                    </button>
                  </div>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-4">
                Pagamento confirmado automaticamente via webhook do Asaas.
              </p>
            </div>
          ) : data.billingType === 'CREDIT_CARD' && data.invoiceUrl ? (
            <div className="text-center py-4">
              <div className="w-16 h-16 rounded-full bg-sky-500/15 text-sky-700 flex items-center justify-center mx-auto mb-3">
                <CreditCard size={32} />
              </div>
              <p className="text-sm font-bold text-foreground mb-1">
                Link do cartão gerado
              </p>
              <p className="text-xs text-muted-foreground mb-4 max-w-sm mx-auto">
                Abra o link abaixo pra paciente pagar com cartão de crédito (até 6× sem juros).
              </p>
              <a
                href={data.invoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-bold px-4 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white"
              >
                <ExternalLink size={14} />
                Abrir link de pagamento
              </a>
            </div>
          ) : (
            <div className="text-center py-6">
              <CheckCircle2 size={32} className="mx-auto mb-2 text-emerald-600" />
              <p className="text-sm font-bold text-foreground mb-1">Cobrança gerada</p>
              <p className="text-xs text-muted-foreground">
                Veja os detalhes na ficha financeira do paciente.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-6 py-4 border-t border-border bg-muted/30 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 text-sm font-semibold px-3 py-2 rounded-md border border-border bg-card text-foreground hover:bg-accent/40 transition-colors inline-flex items-center justify-center gap-1.5"
          >
            <Zap size={14} />
            Nova venda
          </button>
          <button
            type="button"
            onClick={onGoToPatient}
            className="flex-1 text-sm font-bold px-3 py-2 rounded-md bg-foreground text-background hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-1.5"
          >
            Ver na ficha
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Onda 17.32.74 — Logo PIX oficial do Banco Central (SVG inline).
 *
 * Cor #32BCAD (turquesa do PIX). Reproduz o losango caracteristico
 * com 4 pontos brancos nos vertices + a palavra "pix" em font
 * minuscula. Usado acima do QR code pra que o paciente reconheca
 * instantaneamente que e um pagamento PIX.
 */
function PixLogo() {
  return (
    <div className="inline-flex items-center gap-3">
      <svg viewBox="0 0 100 100" className="w-9 h-9" aria-label="Logo PIX">
        {/* Losango central */}
        <g fill="#32BCAD">
          {/* Forma do diamante: 4 triangulos ao redor de um quadrado central */}
          <path d="M50 10 L70 30 L50 50 L30 30 Z" />
          <path d="M70 30 L90 50 L70 70 L50 50 Z" />
          <path d="M50 50 L70 70 L50 90 L30 70 Z" />
          <path d="M30 30 L50 50 L30 70 L10 50 Z" />
        </g>
        {/* Pontos brancos nos vertices */}
        <g fill="white">
          <circle cx="50" cy="10" r="2.5" />
          <circle cx="90" cy="50" r="2.5" />
          <circle cx="50" cy="90" r="2.5" />
          <circle cx="10" cy="50" r="2.5" />
        </g>
      </svg>
      <div className="flex flex-col leading-none">
        <span className="text-3xl font-light text-gray-600 lowercase tracking-tight">pix</span>
        <span className="text-[8px] text-gray-400 mt-0.5">powered by Banco Central</span>
      </div>
    </div>
  );
}

// ─── Onda 17.38 — Seletor de dente (FDI), referência da avaliação ──────────
// Grade compacta no padrão do odontograma: arcada superior em cima, inferior
// embaixo, numeração FDI. Multi-seleção (clica pra marcar/desmarcar). Toggle
// Adulto/Infantil. Some os dentes selecionados em dourado, igual à avaliação.
function ToothPicker({
  selected,
  onToggle,
  kidMode,
  onKidMode,
  onClose,
}: {
  selected: string[];
  onToggle: (fdi: string) => void;
  kidMode: boolean;
  onKidMode: (v: boolean) => void;
  onClose: () => void;
}) {
  const rows = kidMode ? FDI_DECIDUOUS_ROWS : FDI_PERMANENT_ROWS;
  return (
    <div className="mt-2 rounded-lg border border-border bg-card p-2 shadow-inner">
      <div className="flex items-center justify-between mb-1.5">
        <div className="inline-flex rounded-md border border-border overflow-hidden text-[10px] font-semibold">
          <button
            type="button"
            onClick={() => onKidMode(false)}
            className={`px-2 py-0.5 ${!kidMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/40'}`}
          >
            Adulto
          </button>
          <button
            type="button"
            onClick={() => onKidMode(true)}
            className={`px-2 py-0.5 ${kidMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/40'}`}
          >
            Infantil
          </button>
        </div>
        <button type="button" onClick={onClose} className="text-[10px] text-muted-foreground hover:text-foreground font-medium">
          Fechar
        </button>
      </div>
      <div className="space-y-1">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap justify-center gap-0.5">
            {row.map((fdi) => {
              const on = selected.includes(fdi);
              return (
                <button
                  key={fdi}
                  type="button"
                  onClick={() => onToggle(fdi)}
                  className={`w-6 h-6 rounded text-[10px] font-bold tabular-nums border transition-colors ${
                    on
                      ? 'bg-amber-400 border-amber-500 text-amber-950'
                      : 'bg-background border-border text-muted-foreground hover:border-primary hover:text-primary'
                  }`}
                >
                  {fdi}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="text-[9px] text-muted-foreground mt-1.5 text-center">
        Clique nos dentes do procedimento. Cada dente vira 1 item no tratamento.
      </p>
    </div>
  );
}

// ─── Onda 17.39 — Editor de preço unitário (desconto) ──────────────────────
// Só renderizado pra quem tem a permissão `override_price`. Clica no preço →
// input inline. Clampa em [0, base] (só desconto: nunca acima da tabela).
// Mostra o preço de tabela riscado quando há desconto. O backend revalida.
function PriceTag({
  base,
  value,
  onChange,
}: {
  base: number;
  value: number;
  onChange: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const discounted = value < base - 0.001;

  // Abre o campo VAZIO (preço atual fica no placeholder). Assim, no celular,
  // digitar o novo valor substitui em vez de anexar ao texto pré-preenchido.
  const open = () => {
    setDraft('');
    setEditing(true);
  };
  const commit = () => {
    const raw = draft.trim();
    if (raw === '') {
      // Vazio = não mexe (evita zerar um desconto só por abrir e fechar).
      setEditing(false);
      return;
    }
    // aceita "1.800,00" ou "1800" — tira separador de milhar, vírgula vira ponto
    const n = Number(raw.replace(/\./g, '').replace(',', '.'));
    if (isFinite(n) && n > 0) onChange(n); // setItemPrice clampa em [0, tabela]
    setEditing(false);
  };
  const resetTable = () => {
    onChange(null);
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="text-muted-foreground">R$</span>
        <input
          autoFocus
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={commit}
          placeholder={value.toFixed(2).replace('.', ',')}
          className="w-20 px-1.5 py-1 text-[11px] border border-primary/60 rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          className="text-emerald-600 hover:text-emerald-700"
          title="Aplicar"
        >
          <Check size={13} />
        </button>
        {discounted && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={resetTable}
            className="text-[9px] underline text-muted-foreground hover:text-foreground"
            title="Voltar ao preço de tabela"
          >
            tabela
          </button>
        )}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className="group/price inline-flex items-center gap-1 hover:text-primary"
      title="Alterar preço (dar desconto)"
    >
      {discounted && <span className="line-through text-muted-foreground/50">R$ {fmtBRL(base)}</span>}
      <span
        className={`border-b border-dashed border-muted-foreground/40 ${
          discounted ? 'font-semibold text-emerald-700 dark:text-emerald-400' : ''
        }`}
      >
        R$ {fmtBRL(value)}
      </span>
      <Pencil size={11} className="opacity-60 group-hover/price:opacity-100" />
    </button>
  );
}
