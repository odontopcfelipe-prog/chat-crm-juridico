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
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

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
}

// Onda 17.32.69 — Boleto removido (venda balcao raramente pede boleto;
// quando precisar parcelar, usar o fluxo normal de Avaliacao/Propostas).
type BillingType = 'PIX' | 'CREDIT_CARD';

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
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [loadingProc, setLoadingProc] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<string>('TODOS');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState<PatientOption[]>([]);
  const [searchingPatient, setSearchingPatient] = useState(false);
  const [billingType, setBillingType] = useState<BillingType>('PIX');
  const [installments, setInstallments] = useState<number>(1);
  const [finishing, setFinishing] = useState(false);

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
  const addToCart = (p: Procedure) => {
    setCart((prev) => {
      const existing = prev.find((it) => it.procedure.id === p.id);
      if (existing) {
        return prev.map((it) =>
          it.procedure.id === p.id ? { ...it, quantity: it.quantity + 1 } : it,
        );
      }
      return [...prev, { procedure: p, quantity: 1 }];
    });
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

  // Totais
  const subtotal = useMemo(
    () => cart.reduce((sum, it) => sum + Number(it.procedure.base_price) * it.quantity, 0),
    [cart],
  );
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
      const payload = {
        patient_id: patient.id,
        items: cart.map((it) => ({
          procedure_id: it.procedure.id,
          quantity: it.quantity,
        })),
        payment: {
          billing_type: billingType,
          value: total,
          installment_count: billingType === 'CREDIT_CARD' ? installments : undefined,
          discount_percent: billingType === 'PIX' ? 10 : 0,
        },
      };
      const { data } = await api.post<any>('/commercial/venda-rapida', payload);
      showSuccess(`Venda finalizada! Cobrança ${data?.charge?.external_id || ''} gerada.`);
      // Redireciona pra aba financeiro do paciente
      router.push(`/atendimento/pacientes/${patient.id}?tab=financial`);
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
                {cart.map((it) => (
                  <li key={it.procedure.id} className="bg-muted/30 rounded-lg p-2.5 flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-foreground truncate">{it.procedure.name}</p>
                      <p className="text-[10px] text-muted-foreground tabular-nums">
                        R$ {fmtBRL(Number(it.procedure.base_price))} × {it.quantity}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
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
                      <button
                        type="button"
                        onClick={() => removeFromCart(it.procedure.id)}
                        className="w-6 h-6 rounded text-muted-foreground hover:text-red-600 ml-1 flex items-center justify-center"
                        title="Remover"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </li>
                ))}
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
                { key: 'PIX' as BillingType, label: 'PIX ou dinheiro', sub: 'à vista · −10%', Icon: DollarSign },
                { key: 'CREDIT_CARD' as BillingType, label: 'Cartão de crédito', sub: 'até 6x sem juros', Icon: CreditCard },
              ]).map((m) => {
                const isActive = billingType === m.key;
                return (
                  <button
                    key={m.key}
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
    </div>
  );
}
