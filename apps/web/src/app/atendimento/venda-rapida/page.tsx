'use client';

/**
 * Onda 17.32.68 — Venda Rápida (balcão sem avaliação).
 *
 * Estilo "Mercado Livre", em 2 telas:
 *  1. VENDA: grid de procedimentos prontos pra venda na hora; paciente, dentista e
 *     carrinho à direita.
 *  2. PAGAMENTO: "como o paciente vai pagar?" (PagamentoBalcao.tsx), uma pergunta por
 *     vez, com o resumo da venda ao lado. É nela que a venda fecha.
 *
 * Fase 0 — UMA chamada POST /venda-rapida/balcao. O servidor calcula o total, confere a
 * soma das formas, cria orçamento+plano+cobrança LOCAL e lança no caixa; se falhar no
 * meio, desfaz. client_request_id evita venda duplicada no retry. O PIX online (QR do
 * Asaas) não passa por aqui: é "cobrar depois", com outras regras, e fica em Propostas.
 *
 * Sem passar pelo fluxo de Avaliação/Propostas — pra vendas simples:
 * limpeza, clareamento, raspagem, extração simples, radiografia, etc.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Search, Plus, Minus, ShoppingCart, Zap, X,
  Sparkles, Droplet, Smile, Stethoscope, Scissors, Image as ImageIcon,
  CheckCircle2, AlertCircle, User as UserIcon,
  ArrowLeft, ArrowRight, UserPlus, Pencil, Check, ChevronDown, Package,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { OdontogramaPrancha, classificarProcedimento, type MarcaDente } from '@/components/odontograma/DenteReal';
import NewPatientModal from '../pacientes/components/NewPatientModal';
// F5 do laboratório — tipo de negócio da sessão (clínica × laboratório) e os textos
// de laboratório desta tela. Na clínica nada muda.
import { decodeJwtPayload, isLab, labAllowsRoute } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';
import { LAB_VENDA_RAPIDA } from './lab-venda-textos';
import './venda-skin.css';
import PagamentoBalcao from './PagamentoBalcao';
import {
  MAX_PARCELAS,
  PAGAMENTO_VAZIO,
  TEXTO_PENDENCIA,
  analisar,
  destinoDaForma,
  fecharPrimeira,
  fmtCentavos,
  paraPayments,
  rotuloLinha,
  textoFinalizar,
  type EstadoPagamento,
} from './pagamento-balcao';
// F8 do laboratório — ficha do caso da venda (opcional), gravada depois da venda.
import {
  FICHA_VAZIA,
  LabFichaDoCasoDaVenda,
  erroDaFicha,
  gravarFichaDaVenda,
  type FichaDoCaso,
} from '../pacientes/components/LabFichaDoCaso';

interface Procedure {
  id: string;
  name: string;
  base_price: number | string;
  duration_minutes: number;
  category: string | null;
  description: string | null;
  quick_sale?: boolean;
}

interface PatientOption {
  id: string;
  name: string;
  phone?: string | null;
  cpf?: string | null;
}

// Onda 17.40 — dentista responsável (entra na comissão dele). Vem de
// GET /users/lawyers (dentistas + admins com especialidade do tenant).
interface DentistOption {
  id: string;
  name: string;
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

// Quantas unidades um item vale: nº de dentes se houver, senão a quantidade.
const itemUnits = (it: CartItem) => (it.toothFdis.length > 0 ? it.toothFdis.length : it.quantity);

// Preço unitário efetivo: customizado (desconto) ou o de tabela.
const unitPriceOf = (it: CartItem) =>
  it.customPrice != null ? it.customPrice : Number(it.procedure.base_price);

// Mesmo teto do VendaBalcaoDto (@ArrayMaxSize) — POST /venda-rapida/balcao.
const MAX_ITENS_BALCAO = 60;

type LinhaRecebida = { rotulo: string; centavos: number; destino: string };

// Venda já enviada ao servidor. Fica no sessionStorage ANTES do POST e só sai com a
// resposta: se a resposta não chegar (ou der F5 no meio), a tela reenvia ESTE corpo, com
// a mesma chave, em vez de deixar montar de novo e duplicar a receita no caixa.
interface VendaEnviada {
  corpo: {
    patient_id: string;
    dentist_id: string;
    items: Array<{ procedure_id: string; quantity: number; tooth_fdi?: string; unit_price?: number }>;
    payments: ReturnType<typeof paraPayments>;
    expected_total: number;
    client_request_id: string;
  };
  pacienteNome: string;
  totalCentavos: number;
  linhas: LinhaRecebida[];
  baixarEstoque: boolean;
  ficha?: FichaDoCaso;
}

// Por usuário e conta: outra pessoa na mesma aba, ou o dono entrando em outra clínica, não
// herda a venda (nem o nome do paciente).
function chavePendente(): string {
  let dono = '';
  try {
    const sessao = decodeJwtPayload(window.localStorage.getItem('token') ?? '');
    dono = `${sessao?.sub ?? ''}:${sessao?.tenant_id ?? ''}`;
  } catch { /* sem token legível: chave sem dono */ }
  return `venda-rapida-pendente:${dono}`;
}

function lerPendente(): VendaEnviada | null {
  try {
    const salvo = window.sessionStorage.getItem(chavePendente());
    const venda = salvo ? JSON.parse(salvo) : null;
    return venda?.corpo?.client_request_id ? venda : null;
  } catch {
    return null;
  }
}

function guardarPendente(venda: VendaEnviada | null) {
  try {
    if (venda) window.sessionStorage.setItem(chavePendente(), JSON.stringify(venda));
    else window.sessionStorage.removeItem(chavePendente());
  } catch { /* navegador sem storage: a trava em memória continua valendo até o F5 */ }
}

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

// Onda 17.65 — quando o procedimento não tem categoria salva, deduz pelo NOME pra o
// card sair com ícone/cor/chip certos (em vez do genérico 😊). Categoria salva vence.
function tabForProcedure(p: { category?: string | null; name?: string | null }): string {
  const byCat = categoryToTab(p.category);
  if (byCat !== 'TODOS') return byCat;
  const n = (p.name || '').toLowerCase();
  if (/clareament|faceta|lente|harmoniza|botox|toxina|preenchiment|peeling|microagulha|bioestimul|fios? de pdo|lifting|skinbooster|gengivoplastia est/.test(n)) return 'ESTETICA';
  if (/cirurg|exodontia|extra[çc][aã]o|frenectomia|enxerto|levantamento de seio/.test(n)) return 'CIRURGIA';
  if (/radiograf|tomograf|raio.?-?x|documenta[çc][aã]o|escaneament|panor[âa]mic/.test(n)) return 'DIAGNOSTICO';
  if (/limpez|profilax|fl[úu]or|selante|preven/.test(n)) return 'PREVENCAO';
  return 'CLINICO';
}

function fmtBRL(v: number): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Preço no jeito de loja: grande, sem negrito, centavos pequenos em cima.
function Preco({ valor, className = 'text-2xl' }: { valor: number; className?: string }) {
  const [inteiro, centavos] = fmtBRL(valor).split(',');
  return (
    <span className={`inline-flex items-start font-normal tabular-nums leading-none text-foreground ${className}`}>
      <span>R$ {inteiro}</span>
      <span className="ml-0.5 mt-[0.1em] text-[0.5em] leading-none">{centavos}</span>
    </span>
  );
}

export default function VendaRapidaPage() {
  const router = useRouter();
  // F5 do laboratório — sessão de laboratório: cliente, protético, serviços e
  // elementos no lugar dos nomes da clínica; sem categorias e sem o PIX online.
  // Na clínica `lab` é sempre false e a tela é a de sempre.
  const lab = isLab(useBusinessType());
  // Onda 17.39 — só quem tem `override_price` edita preço (dar desconto).
  const { hasPermission } = useUserPermissions();
  const canOverridePrice = hasPermission('override_price');
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [loadingProc, setLoadingProc] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<string>('TODOS');
  const [cart, setCart] = useState<CartItem[]>([]);

  // ─── Baixa de estoque (fase 2) ────────────────────────────────────────
  // A venda de balcão pode tirar do estoque o material que o procedimento
  // consome (cadastro Estoque → insumo por procedimento). Opcional POR VENDA:
  // o operador desmarca quando o material não saiu de fato (ex.: cortesia com
  // insumo do paciente). Só aparece quando há insumo cadastrado.
  type ConsumoItem = { product_id: string; name: string; unit: string; needed: number; current_stock: number; falta: number; custo_total: number | null; origens: string[] };
  const [consumo, setConsumo] = useState<{ items: ConsumoItem[]; custo_total: number; tem_falta: boolean; bloqueado: boolean; bloqueia_sem_saldo: boolean } | null>(null);
  const [baixarEstoque, setBaixarEstoque] = useState(true);

  // Recalcula o que sairia do estoque sempre que o carrinho muda (debounce).
  // Rodar ANTES de fechar evita o pior caso: descobrir que faltou material
  // depois de já ter cobrado o paciente.
  useEffect(() => {
    if (cart.length === 0) { setConsumo(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      const items = cart.flatMap((it) =>
        it.toothFdis.length > 0
          ? it.toothFdis.map(() => ({ procedure_id: it.procedure.id, quantity: 1 }))
          : [{ procedure_id: it.procedure.id, quantity: it.quantity }],
      );
      api.post('/inventory/consumption/preview', { items })
        .then((r) => { if (!cancelled) setConsumo(r.data?.items?.length ? r.data : null); })
        .catch(() => { if (!cancelled) setConsumo(null); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [cart]);

  const [patient, setPatient] = useState<PatientOption | null>(null);
  // F8 do laboratório — ficha do caso da venda. Fica FORA da chave da venda (saleKeyRef):
  // mexer na ficha não vira outra venda. Na clínica o estado existe, mas nunca é lido.
  const [fichaDoCaso, setFichaDoCaso] = useState<FichaDoCaso>(FICHA_VAZIA);
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState<PatientOption[]>([]);
  const [searchingPatient, setSearchingPatient] = useState(false);
  // Onda 17.37 — cadastrar paciente sem sair da venda: abre o modal, cria e
  // já seleciona pra "Vender para".
  const [showNewPatient, setShowNewPatient] = useState(false);
  // Onda 17.40 — dentista responsável pela venda (entra na comissão dele).
  const [dentists, setDentists] = useState<DentistOption[]>([]);
  const [dentistId, setDentistId] = useState<string>('');
  // As 2 telas da venda: monta a venda → recebe o pagamento.
  const [etapa, setEtapa] = useState<'venda' | 'pagamento'>('venda');
  const [pagamento, setPagamento] = useState<EstadoPagamento>(PAGAMENTO_VAZIO);
  // Total com que a forma foi escolhida. Se o carrinho mudar depois, a forma é limpa em
  // vez de o valor mudar sozinho: o cartão pode já ter passado na máquina.
  const totalDoPagamentoRef = useRef<number | null>(null);
  const [valorMudou, setValorMudou] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Trava síncrona do envio: `finishing` só vale no próximo render e um duplo clique chega antes.
  const enviandoRef = useRef(false);
  // Venda enviada sem resposta do servidor: a tela trava até reenviar ou conferir.
  const [pendente, setPendente] = useState<VendaEnviada | null>(null);
  const [successDialog, setSuccessDialog] = useState<{
    total: number;
    patientName: string;
    patientId: string;
    linhas: LinhaRecebida[];
    precisaValidar: boolean;
  } | null>(null);
  // Fase 0 — chave da venda de balcão (idempotência): reenviar o MESMO carrinho depois
  // de um timeout não vira 2 vendas. Mudou carrinho/paciente/dentista/pagamento → chave nova.
  const saleKeyRef = useRef<string | null>(null);
  useEffect(() => { saleKeyRef.current = null; }, [cart, patient, dentistId, pagamento]);

  // F5 com venda no ar: volta travado nela, em vez de deixar montar de novo às cegas.
  useEffect(() => { setPendente(lerPendente()); }, []);

  const paginaRef = useRef<HTMLDivElement>(null);
  const irAoTopo = () => paginaRef.current?.scrollTo({ top: 0 });

  // Item novo rola pra vista: o rodapé fixo do carrinho (Total + botão) cobriria a linha.
  const ultimoItemRef = useRef<HTMLLIElement>(null);
  const qtdLinhasRef = useRef(0);
  useEffect(() => {
    if (cart.length > qtdLinhasRef.current && window.matchMedia('(min-width: 1024px)').matches) {
      ultimoItemRef.current?.scrollIntoView({ block: 'nearest' });
    }
    qtdLinhasRef.current = cart.length;
  }, [cart.length]);

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

  // Onda 17.40 — carrega dentistas pro seletor de responsável (comissão). Clínica com
  // um dentista só já vem com ele marcado.
  useEffect(() => {
    api.get<any>('/users/lawyers')
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : (data?.data || []);
        const opcoes: DentistOption[] = list.map((d: any) => ({ id: d.id, name: d.name }));
        setDentists(opcoes);
        if (opcoes.length === 1) setDentistId(opcoes[0].id);
      })
      .catch(() => { /* silencioso — seletor fica vazio */ });
  }, []);

  // Busca paciente (debounced)
  useEffect(() => {
    // Onda 17.61 — busca já na 1ª letra (antes exigia 2+, e o usuário digitava "F"
    // e não acontecia nada). O debounce de 300ms abaixo segura o excesso de chamadas.
    if (!patientQuery.trim()) {
      setPatientResults([]);
      return;
    }
    setSearchingPatient(true);
    const id = setTimeout(() => {
      // Onda 17.61 — o backend filtra por ?search= (NÃO ?q=). Com ?q= o param era
      // ignorado e voltava a lista sem filtrar → a busca "não ia". Agora bate certo.
      api.get<PatientOption[] | { data: PatientOption[] }>(`/patients?search=${encodeURIComponent(patientQuery)}&limit=8`)
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
    // Onda XX — a Venda Rápida só mostra os procedimentos AUTORIZADOS (marcados
    // com o raio ⚡ na Tabela de Preços). Catálogo curado, não a lista inteira.
    let arr = procedures.filter((p) => p.quick_sale);
    if (tab !== 'TODOS') {
      arr = arr.filter((p) => tabForProcedure(p) === tab);
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

  // Quantos procedimentos autorizados em cada categoria (os cartões de atalho).
  const qtdPorTab = useMemo(() => {
    const qtd: Record<string, number> = { TODOS: 0 };
    for (const proc of procedures) {
      if (!proc.quick_sale) continue;
      qtd.TODOS += 1;
      const chave = tabForProcedure(proc);
      qtd[chave] = (qtd[chave] || 0) + 1;
    }
    return qtd;
  }, [procedures]);

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

  // Onda 18.x — define preço unitário custom. Agora aceita DESCONTO **ou
  // ACRÉSCIMO** (decisão do operador; ex.: aparelho ortô que vende acima da
  // tabela). null/<=0 reseta pro preço de tabela (base_price).
  const setItemPrice = (procId: string, v: number | null) => {
    setCart((prev) =>
      prev.map((it) => {
        if (it.procedure.id !== procId) return it;
        if (v == null || v <= 0) return { ...it, customPrice: null };
        return { ...it, customPrice: v };
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

  // Out/2026 — o seletor de dentes é a prancha do odontograma: mostra desenhado
  // em cada dente o que já está na venda (implante, faceta, restauração...).
  const marcasVenda = useMemo(() => {
    const m = new Map<string, MarcaDente[]>();
    for (const it of cart) {
      const tipos = classificarProcedimento(it.procedure.name, it.procedure.category);
      for (const fdi of it.toothFdis) {
        const lista = m.get(fdi) ?? [];
        for (const tipo of tipos) lista.push({ tipo, nome: it.procedure.name });
        m.set(fdi, lista);
      }
    }
    return m;
  }, [cart]);

  // Totais — item com dentes vale 1 unidade por dente
  const subtotal = useMemo(
    () => cart.reduce((sum, it) => sum + unitPriceOf(it) * itemUnits(it), 0),
    [cart],
  );
  // Onda 17.41 — Venda Rápida sempre a PREÇO CHEIO (decisão do dono): removido
  // o desconto à vista do PIX. Desconto manual por item (override_price) segue
  // valendo via unitPriceOf; aqui não há mais desconto por forma de pagamento.
  const total = subtotal;
  const totalCentavos = Math.round(total * 100);
  const analise = analisar(pagamento, totalCentavos);
  const estoqueTrava = baixarEstoque && !!consumo?.bloqueado;
  const dentistaDaVenda = dentists.find((d) => d.id === dentistId);

  // O que impede a venda, em português (em vez do 400 cru do ValidationPipe).
  const erroDaVenda = (): string | null => {
    if (!patient) return lab ? LAB_VENDA_RAPIDA.erros.semCliente : 'Selecione um paciente antes de finalizar';
    if (cart.length === 0) return lab ? LAB_VENDA_RAPIDA.erros.semServico : 'Adicione ao menos 1 procedimento';
    if (!dentistId) return lab ? LAB_VENDA_RAPIDA.erros.semResponsavel : 'Selecione o dentista responsável antes de finalizar';
    // F8 do laboratório — ficha do caso inválida (link, datas) trava antes de vender.
    const erroNaFicha = lab ? erroDaFicha(fichaDoCaso) : null;
    if (erroNaFicha) return erroNaFicha;
    // Cada dente conta 1 item no limite do servidor (VendaBalcaoDto).
    const qtdItens = cart.reduce((n, it) => n + (it.toothFdis.length > 0 ? it.toothFdis.length : 1), 0);
    if (qtdItens > MAX_ITENS_BALCAO) {
      return lab ? LAB_VENDA_RAPIDA.erros.maxItens(MAX_ITENS_BALCAO, qtdItens) : `A venda rápida aceita até ${MAX_ITENS_BALCAO} itens (cada dente conta 1) — este carrinho tem ${qtdItens}. Divida em duas vendas.`;
    }
    if (totalCentavos <= 0) return 'Venda sem valor: confira os itens do carrinho.';
    return null;
  };

  const irParaPagamento = () => {
    const erro = erroDaVenda();
    if (erro) {
      showError(erro);
      return;
    }
    const mudou = pagamento !== PAGAMENTO_VAZIO && totalDoPagamentoRef.current !== totalCentavos;
    if (mudou) setPagamento(PAGAMENTO_VAZIO);
    setValorMudou(mudou);
    totalDoPagamentoRef.current = totalCentavos;
    setEtapa('pagamento');
    irAoTopo();
  };

  const voltarParaVenda = () => {
    setEtapa('venda');
    setValorMudou(false);
    irAoTopo();
  };

  // Nova venda começa do zero: a próxima não herda paciente nem forma da anterior.
  const zerarVenda = () => {
    setCart([]);
    setPatient(null);
    setPatientQuery('');
    setPatientResults([]);
    setDentistId(dentists.length === 1 ? dentists[0].id : '');
    setPagamento(PAGAMENTO_VAZIO);
    totalDoPagamentoRef.current = null;
    setValorMudou(false);
    setBaixarEstoque(true);
    setEtapa('venda');
    if (lab) setFichaDoCaso(FICHA_VAZIA);
    irAoTopo();
  };

  // Envia (ou reenvia) a venda. O servidor recalcula o total, confere a soma das formas,
  // cria orçamento+plano+cobrança LOCAL e lança no caixa, cada forma na sua conta. Se algo
  // falhar no meio, ele desfaz: nada fica "recebido" fora do caixa.
  const enviarVenda = async (envio: VendaEnviada, reenvio = false) => {
    if (enviandoRef.current) return;
    enviandoRef.current = true;
    setFinishing(true);
    const avisarSemConfirmacao = () => showError('Ainda sem confirmação. A venda continua aqui: tente de novo em instantes.');
    try {
      // Payload EXATO do VendaBalcaoDto (o servidor recusa campo a mais).
      const { data: sale } = await api.post<any>('/venda-rapida/balcao', envio.corpo);
      // Reenvio com a 1ª tentativa ainda rodando no servidor: a cobrança existe, mas a receita
      // ainda não. Se o caixa dela falhar, a venda é desfeita: ainda não dá pra dizer que vendeu.
      if (reenvio && sale?.idempotent && !sale?.transaction_id) {
        setPendente(envio);
        avisarSemConfirmacao();
        return;
      }
      // Baixa do material no estoque. Idempotente por quote_id no backend, então um retry
      // desta tela não baixa duas vezes. Best-effort DE PROPÓSITO: a venda já existe e o
      // paciente já pagou — falhar a baixa aqui não pode desfazer a venda. Se der errado,
      // avisa pra alguém ajustar na mão.
      if (sale?.quote_id && envio.baixarEstoque) {
        try {
          await api.post('/inventory/consumption/commit', {
            quote_id: sale.quote_id,
            items: envio.corpo.items.map((i) => ({ procedure_id: i.procedure_id, quantity: i.quantity })),
            notes: 'Venda rápida (balcão)',
          });
        } catch (e: unknown) {
          const erroBaixa = e as { response?: { data?: { message?: string } } };
          showError(
            'A venda foi registrada, mas a baixa do estoque falhou: ' +
            (erroBaixa?.response?.data?.message || 'erro desconhecido') +
            ' — ajuste em Estoque → Movimentações.',
          );
        }
      }
      // F8 do laboratório — ficha do caso no orçamento que a venda criou (PUT upsert;
      // falhar não desfaz a venda: só avisa).
      if (lab && sale?.quote_id) await gravarFichaDaVenda(sale.quote_id, envio.ficha ?? FICHA_VAZIA);
      // Só sai da pendência aqui: F5 durante a baixa ou a ficha reenvia e completa (tudo idempotente).
      guardarPendente(null);
      setPendente(null);
      setSuccessDialog({
        total: Number(sale?.total) || envio.totalCentavos / 100,
        patientName: envio.pacienteNome,
        patientId: envio.corpo.patient_id,
        linhas: envio.linhas,
        precisaValidar: sale?.auto_validated === false,
      });
      saleKeyRef.current = null;
      zerarVenda();
      showSuccess('Venda finalizada!');
    } catch (err: any) {
      const status: number = Number(err?.response?.status) || 0;
      const semResposta = !err?.response || status >= 500 || status === 409 || status === 408 || status === 429;
      // No reenvio, só o 400 é recusa de verdade: o serviço confere a chave antes de validar. 401,
      // 403 e 404 vêm antes disso (API reiniciando, guard) e nada dizem sobre a 1ª tentativa.
      if (semResposta || (reenvio && status !== 400)) {
        // Rede/timeout, 5xx/52x (proxy/Cloudflare), 409 (a mesma venda em andamento), 408/429:
        // a venda PODE ter entrado. Trava a tela nela: o reenvio usa a mesma chave e devolve a
        // venda existente em vez de lançar outra receita no caixa.
        setPendente(envio);
        if (reenvio) avisarSemConfirmacao();
      } else {
        // O servidor recusou (4xx de regra/permissão) ou desfez a venda: nada ficou
        // registrado, a próxima tentativa é uma venda nova.
        guardarPendente(null);
        setPendente(null);
        saleKeyRef.current = null;
        const msg = err.response.data?.message || 'Erro ao finalizar venda';
        showError(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(', ') : 'Erro ao finalizar'));
      }
    } finally {
      enviandoRef.current = false;
      setFinishing(false);
    }
  };

  // O botão do resumo: fecha a primeira forma (quando divide) ou finaliza a venda.
  const acaoDoPagamento = () => {
    if (enviandoRef.current) return;
    if (analise.acao === 'CONTINUAR') {
      setPagamento(fecharPrimeira(pagamento, totalCentavos));
      return;
    }
    if (analise.acao !== 'FINALIZAR' || estoqueTrava) return;
    const erro = erroDaVenda();
    if (erro || !patient) {
      if (erro) showError(erro);
      return;
    }
    // Itens da venda: item com dentes vira 1 item POR dente (tooth_fdi), pra entrar no
    // odontograma/tratamento e a dentista validar dente a dente; sem dentes = por
    // quantidade (limpeza, clareamento). Desconto vai como unit_price (omitido = preço
    // de tabela); o backend bloqueia sem a permissão override_price.
    const items = cart.flatMap((it) => {
      const priceOverride = it.customPrice != null ? { unit_price: it.customPrice } : {};
      return it.toothFdis.length > 0
        ? it.toothFdis.map((fdi) => ({ procedure_id: it.procedure.id, quantity: 1, tooth_fdi: fdi, ...priceOverride }))
        : [{ procedure_id: it.procedure.id, quantity: it.quantity, ...priceOverride }];
    });
    if (!saleKeyRef.current) saleKeyRef.current = crypto.randomUUID();
    const envio: VendaEnviada = {
      corpo: {
        patient_id: patient.id,
        dentist_id: dentistId,
        items,
        payments: paraPayments(analise.linhas),
        expected_total: totalCentavos / 100,
        client_request_id: saleKeyRef.current,
      },
      pacienteNome: patient.name,
      totalCentavos,
      linhas: analise.linhas.map((l) => ({
        rotulo: rotuloLinha(l),
        centavos: l.centavos,
        destino: destinoDaForma(l.forma),
      })),
      baixarEstoque: baixarEstoque && !!consumo && consumo.items.length > 0,
      ...(lab ? { ficha: fichaDoCaso } : {}),
    };
    guardarPendente(envio);
    void enviarVenda(envio);
  };

  // Conferiu e a venda não entrou: libera a tela pra começar outra. Se entrou, o caminho é o
  // "Tentar de novo": devolve a mesma venda e completa a baixa do estoque, que depende da resposta.
  const descartarPendente = () => {
    guardarPendente(null);
    setPendente(null);
    saleKeyRef.current = null;
    zerarVenda();
  };

  const podeVerCaixa = hasPermission('operate_cash') && (!lab || labAllowsRoute('/atendimento/caixa'));
  const podeVerFicha = !lab || labAllowsRoute('/atendimento/pacientes');

  return (
    // h-full overflow-y-auto: o <main> do atendimento é overflow-hidden. Sem isso, em
    // tela pequena/estreita (layout empilhado, carrinho não-sticky) o botão do carrinho
    // caía abaixo da dobra e a página não rolava pra alcançá-lo.
    <div ref={paginaRef} className="vr-skin h-full overflow-y-auto">
      <header className="vr-faixa">
        <div className="mx-auto max-w-7xl px-6 pt-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex shrink-0 items-center gap-2">
              <Zap size={24} className="vr-marca" strokeWidth={2.5} />
              <h1 className="text-lg font-bold leading-none vr-marca">Venda rápida</h1>
            </div>
            {etapa === 'venda' && !pendente && (
              <div className="relative min-w-[240px] max-w-2xl flex-1">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={lab ? LAB_VENDA_RAPIDA.buscarServico : 'Buscar procedimento... (limpeza, clareamento, flúor)'}
                  className="vr-busca"
                />
                <Search size={18} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              </div>
            )}
            <ol aria-label="Etapas da venda" className="flex items-center gap-2 text-xs font-semibold sm:ml-auto">
              <li className="inline-flex items-center gap-1.5">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${etapa === 'venda' ? 'bg-foreground text-background' : 'bg-[#00a650] text-white'}`}>
                  {etapa === 'venda' ? '1' : <Check size={12} strokeWidth={3} />}
                </span>
                Venda
              </li>
              <li aria-hidden="true" className="h-px w-6 bg-foreground/30" />
              <li className={`inline-flex items-center gap-1.5 ${etapa === 'pagamento' ? '' : 'text-foreground/60'}`}>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${etapa === 'pagamento' ? 'bg-foreground text-background' : 'bg-foreground/10'}`}>2</span>
                Pagamento
              </li>
            </ol>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 pb-2 pt-2 text-xs">
            <button
              type="button"
              onClick={() => document.getElementById('vr-busca-paciente')?.focus()}
              className="inline-flex shrink-0 items-center gap-1.5 text-left"
            >
              <UserIcon size={15} className="text-foreground/60" />
              <span className="leading-tight">
                <span className="block text-[10px] text-foreground/60">Vender para</span>
                <span className="block max-w-[180px] truncate font-semibold">
                  {patient?.name || (lab ? LAB_VENDA_RAPIDA.informarCliente : 'Informe o paciente')}
                </span>
              </span>
            </button>
            <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold">
              {lab ? LAB_VENDA_RAPIDA.selo : 'Balcão · Sem avaliação'}
            </span>
            {lab ? (
              <p className="hidden min-w-0 flex-1 text-foreground/70 md:block">
                {LAB_VENDA_RAPIDA.subtitulo.antes}<strong>{LAB_VENDA_RAPIDA.subtitulo.destaque}</strong>{LAB_VENDA_RAPIDA.subtitulo.depois}
              </p>
            ) : (
            <p className="hidden min-w-0 flex-1 text-foreground/70 md:block">
              Venda um procedimento na hora: <strong>entra no tratamento do paciente</strong>{' '}
              — gera a cobrança e dispensa a avaliação. O dentista confirma a execução depois.
            </p>
            )}
            <button
              type="button"
              onClick={() => document.getElementById('vr-carrinho')?.scrollIntoView({ block: 'nearest' })}
              aria-label="Carrinho"
              className="relative ml-auto shrink-0"
            >
              <ShoppingCart size={20} />
              {cart.length > 0 && (
                <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  {cart.length}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      <div className="vr-conteudo">
      <div className="mx-auto max-w-7xl px-6 py-4">
      {pendente ? (
        <div role="alert" className="mx-auto max-w-xl rounded-xl border border-amber-500/40 bg-card p-6 shadow-sm">
          <div className="mb-3 flex items-center gap-3">
            <AlertCircle size={22} className="shrink-0 text-amber-600" />
            <h2 className="text-lg font-bold text-foreground">A venda ficou sem confirmação</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {lab
              ? LAB_VENDA_RAPIDA.semConfirmacao(fmtCentavos(pendente.totalCentavos), pendente.pacienteNome)
              : `Não chegou a resposta do servidor: a venda de R$ ${fmtCentavos(pendente.totalCentavos)} para ${pendente.pacienteNome} pode ter entrado.`}
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">Tentar de novo é seguro: a mesma venda não duplica no caixa e a baixa do estoque se completa.</p>
          <ul className="my-4 divide-y divide-border rounded-lg border border-border">
            {pendente.linhas.map((l, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="text-foreground">{l.rotulo}</span>
                <span className="font-semibold tabular-nums">R$ {fmtCentavos(l.centavos)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => void enviarVenda(pendente, true)}
              disabled={finishing}
              className="inline-flex flex-1 items-center justify-center gap-2 vr-botao px-4 py-2.5 text-sm disabled:opacity-60"
            >
              {finishing && <Loader2 size={14} className="animate-spin" />}
              Tentar de novo
            </button>
            {podeVerCaixa ? (
              <button
                type="button"
                onClick={() => router.push('/atendimento/caixa')}
                disabled={finishing}
                className="flex-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-accent/40 disabled:opacity-60"
              >
                Conferir no Caixa do dia
              </button>
            ) : podeVerFicha ? (
              <button
                type="button"
                onClick={() => router.push(`/atendimento/pacientes/${pendente.corpo.patient_id}?tab=financial`)}
                disabled={finishing}
                className="flex-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-accent/40 disabled:opacity-60"
              >
                {lab ? LAB_VENDA_RAPIDA.verFinanceiro : 'Conferir no Financeiro do paciente'}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={descartarPendente}
            disabled={finishing}
            className="mt-3 w-full text-center text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            Conferi e não entrou, começar outra venda
          </button>
        </div>
      ) : etapa === 'venda' ? (
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
        {/* COLUNA ESQUERDA — Procedimentos */}
        <div className="min-w-0">
          {/* Atalhos por categoria */}
          {!lab && (
          <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-3">
            {TABS.filter((t) => t.key === 'TODOS' || qtdPorTab[t.key]).map((t) => {
              const cfg = ICON_BY_TAB[t.key] || ICON_BY_TAB.TODOS;
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`group vr-card flex flex-col items-center p-3 transition-shadow hover:shadow-md ${tab === t.key ? 'ring-2 ring-primary' : ''}`}
                >
                  <span className="w-full text-left text-sm font-semibold text-foreground">{t.label}</span>
                  <span className={`my-2 flex h-12 w-12 items-center justify-center rounded-full ${cfg.bg}`}>
                    <cfg.Icon size={24} className={cfg.fg} />
                  </span>
                  <span className="vr-botao-claro w-full px-2 py-1 text-[11px]">Mostrar ({qtdPorTab[t.key] || 0})</span>
                </button>
              );
            })}
          </div>
          )}

          {/* Vitrine */}
          <section className="vr-card p-4">
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-lg font-semibold text-foreground">
                {lab ? LAB_VENDA_RAPIDA.vitrine : tab === 'TODOS' ? 'Procedimentos' : TABS.find((t) => t.key === tab)?.label}
              </h2>
              {!lab && tab !== 'TODOS' && (
                <button type="button" onClick={() => setTab('TODOS')} className="vr-link text-xs">Mostrar todos</button>
              )}
            </div>
            {loadingProc ? (
              <div className="py-16 flex items-center justify-center text-muted-foreground">
                <Loader2 size={18} className="animate-spin mr-2" />
                {lab ? LAB_VENDA_RAPIDA.carregando : 'Carregando procedimentos...'}
              </div>
            ) : filteredProcedures.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground px-6">
                {search.trim() || tab !== 'TODOS'
                  ? (lab ? LAB_VENDA_RAPIDA.nadaNaBusca : 'Nenhum procedimento autorizado nessa busca/categoria.')
                  : (lab ? LAB_VENDA_RAPIDA.nadaLiberado : 'Nenhum procedimento liberado pra Venda Rápida ainda. Vá em Configurações → Tabela de Preços e marque o ⚡ nos que devem aparecer aqui.')}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-3 gap-y-4 md:grid-cols-3 xl:grid-cols-4">
                {filteredProcedures.map((p) => {
                  const tabKey = lab ? 'TODOS' : tabForProcedure(p);
                  const iconCfg = ICON_BY_TAB[tabKey] || ICON_BY_TAB.TODOS;
                  const inCart = cart.find((it) => it.procedure.id === p.id);
                  const preco = Number(p.base_price);
                  return (
                    <button
                      type="button"
                      key={p.id}
                      onClick={() => addToCart(p)}
                      className={`group flex flex-col rounded-md p-2 text-left transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${inCart ? 'ring-2 ring-primary' : ''}`}
                    >
                      <span className="relative flex h-28 w-full items-center justify-center rounded-md bg-muted">
                        <iconCfg.Icon size={44} className={iconCfg.fg} strokeWidth={1.5} />
                        {inCart && (
                          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-[11px] font-bold text-primary-foreground">
                            <Check size={11} strokeWidth={3} /> {inCart.quantity}
                          </span>
                        )}
                      </span>
                      <span className="mb-1 mt-2 line-clamp-2 min-h-[2.5rem] text-sm leading-tight text-foreground">{p.name}</span>
                      <Preco valor={preco} />
                      {preco > 0 && (
                        <span className="mt-1 text-xs text-foreground">
                          {MAX_PARCELAS}x R$ {fmtBRL(preco / MAX_PARCELAS)}
                        </span>
                      )}
                      {!lab && p.duration_minutes && (
                        <span className="vr-verde mt-1 text-xs font-semibold">⏱ {p.duration_minutes} min</span>
                      )}
                      <span className="vr-botao-claro mt-2 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs">
                        <Plus size={12} strokeWidth={3} />
                        {inCart ? `Adicionar (${inCart.quantity})` : 'Adicionar'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* COLUNA DIREITA — Sidebar carrinho */}
        <aside className="vr-card p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto h-fit">
          {/* Paciente */}
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
              Vender para
            </p>
            {patient ? (
              <div className="border border-primary/30 bg-primary/5 rounded-lg p-3 flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-sm shrink-0">
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
                  title={lab ? LAB_VENDA_RAPIDA.trocarCliente : 'Trocar paciente'}
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
                    id="vr-busca-paciente"
                    type="text"
                    value={patientQuery}
                    onChange={(e) => setPatientQuery(e.target.value)}
                    placeholder={lab ? LAB_VENDA_RAPIDA.buscarCliente : 'Buscar paciente por nome/CPF...'}
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
                          <div className="w-7 h-7 rounded-full bg-muted text-muted-foreground flex items-center justify-center font-bold text-xs shrink-0">
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
                  <UserPlus size={15} />{lab ? LAB_VENDA_RAPIDA.cadastrarCliente : ' Cadastrar novo cliente'}
                </button>
                <p className="text-[10px] text-muted-foreground mt-1">{lab ? LAB_VENDA_RAPIDA.obrigatorioCliente : 'obrigatório para lançar no tratamento'}</p>
              </div>
            )}
          </div>

          {/* Onda 17.40 — Dentista responsável (a venda entra na comissão dele) */}
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
              {lab ? LAB_VENDA_RAPIDA.responsavel : 'Dentista responsável '}<span className="font-medium normal-case tracking-normal text-orange-500">· obrigatório</span>
            </p>
            {(() => {
              const sel = dentists.find((d) => d.id === dentistId);
              const initials = sel
                ? sel.name.replace(/^(dr|dra)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase()
                : '';
              return (
                <div className="relative">
                  {sel ? (
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[11px] font-bold pointer-events-none">
                      {initials}
                    </div>
                  ) : lab ? (
                    <UserIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  ) : (
                    <Stethoscope size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  )}
                  <select
                    value={dentistId}
                    onChange={(e) => setDentistId(e.target.value)}
                    className={`w-full pr-9 py-2.5 text-sm border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 appearance-none transition-colors ${
                      sel ? 'pl-11 font-semibold border-primary/40' : 'pl-9 border-border'
                    }`}
                  >
                    <option value="" disabled>{lab ? LAB_VENDA_RAPIDA.selecione : 'Selecione o dentista…'}</option>
                    {dentists.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <ChevronDown size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                </div>
              );
            })()}
            <p className="text-[10px] text-muted-foreground mt-1">
              {dentistId
                ? (lab ? LAB_VENDA_RAPIDA.responsavelOk : 'Os procedimentos ficam pendentes pra esse dentista confirmar a conclusão.')
                : (lab ? LAB_VENDA_RAPIDA.responsavelVazio : 'Escolha o dentista que fez o atendimento.')}
            </p>
          </div>

          {/* Carrinho */}
          <div id="vr-carrinho" className="mb-4 scroll-mt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1.5">
                <ShoppingCart size={13} /> Carrinho
                {cart.length > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-extrabold leading-none">{cart.length}</span>
                )}
              </p>
              {cart.length > 0 && (
                <button type="button" onClick={() => setCart([])} className="text-[11px] font-semibold text-muted-foreground hover:text-red-600 transition-colors">
                  limpar
                </button>
              )}
            </div>
            {cart.length === 0 ? (
              <div className="bg-muted/30 rounded-lg p-6 text-center text-sm text-muted-foreground">
                <ShoppingCart size={24} className="mx-auto mb-2 opacity-50" />
                {lab ? LAB_VENDA_RAPIDA.carrinhoVazio : 'Clique num procedimento para começar a venda'}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {cart.map((it, idx) => {
                  const hasTeeth = it.toothFdis.length > 0;
                  // Onda 17.65 — visual por categoria (ícone + cor + chip), igual aos cards da esquerda.
                  const tabKey = lab ? 'TODOS' : tabForProcedure(it.procedure);
                  const catMeta = ICON_BY_TAB[tabKey] || ICON_BY_TAB.TODOS;
                  const CatIcon = catMeta.Icon;
                  const catLabel = TABS.find((t) => t.key === tabKey)?.label || '';
                  const lineTotal = unitPriceOf(it) * itemUnits(it);
                  return (
                  <li key={it.procedure.id} ref={idx === cart.length - 1 ? ultimoItemRef : undefined} className="py-3 first:pt-0 scroll-mb-40">
                    <div className="flex items-start gap-2.5">
                      {/* Ícone da categoria */}
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${catMeta.bg} ${catMeta.fg}`}>
                        <CatIcon size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-bold text-foreground leading-snug break-words min-w-0">{it.procedure.name}</p>
                          <button
                            type="button"
                            onClick={() => removeFromCart(it.procedure.id)}
                            className="shrink-0 -mt-0.5 text-muted-foreground hover:text-red-600"
                            title="Remover"
                          >
                            <X size={15} />
                          </button>
                        </div>

                        {/* Tipo + dentes */}
                        <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                          {!lab && catLabel && (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${catMeta.bg} ${catMeta.fg}`}>{catLabel}</span>
                          )}
                          {it.toothFdis.map((fdi) => (
                            <span
                              key={fdi}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold border border-amber-300/60"
                            >
                              {fdi}
                              <button type="button" onClick={() => toggleTooth(it.procedure.id, fdi)} className="hover:text-red-600" title={lab ? LAB_VENDA_RAPIDA.removerElemento : 'Remover dente'}>
                                <X size={9} />
                              </button>
                            </span>
                          ))}
                          <button
                            type="button"
                            onClick={() => setToothPickerFor(toothPickerFor === it.procedure.id ? null : it.procedure.id)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-dashed border-border text-[10px] font-medium text-muted-foreground hover:border-primary hover:text-primary"
                          >
                            <Smile size={11} /> {hasTeeth ? (lab ? LAB_VENDA_RAPIDA.elementos : 'Dentes') : (lab ? LAB_VENDA_RAPIDA.addElemento : '+ Dente (opcional)')}
                          </button>
                        </div>

                        {/* Onda 17.66 — unitário numa linha; stepper + total noutra (carrinho estreito
                            quebrava quando admin tem o PriceTag editável + stepper + total na mesma linha) */}
                        <div className="mt-2.5 space-y-1.5">
                          <div className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-1 flex-wrap">
                            <span className="shrink-0">unitário</span>
                            {canOverridePrice ? (
                              <PriceTag
                                base={Number(it.procedure.base_price)}
                                value={unitPriceOf(it)}
                                onChange={(v) => setItemPrice(it.procedure.id, v)}
                              />
                            ) : (
                              <span>R$ {fmtBRL(unitPriceOf(it))}</span>
                            )}
                            {hasTeeth && (lab ? (
                              <span className="text-muted-foreground/70">{LAB_VENDA_RAPIDA.porElemento(itemUnits(it))}</span>
                            ) : (
                              <span className="text-muted-foreground/70">× {itemUnits(it)} dente{itemUnits(it) > 1 ? 's' : ''}</span>
                            ))}
                          </div>
                          <div className="flex items-center gap-2">
                            {!hasTeeth && (
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => changeQty(it.procedure.id, -1)}
                                  className="w-6 h-6 rounded-md border border-border bg-card hover:bg-accent/40 flex items-center justify-center"
                                >
                                  <Minus size={11} />
                                </button>
                                <span className="w-6 text-center text-xs font-bold tabular-nums">{it.quantity}</span>
                                <button
                                  type="button"
                                  onClick={() => changeQty(it.procedure.id, 1)}
                                  className="w-6 h-6 rounded-md border border-border bg-card hover:bg-accent/40 flex items-center justify-center"
                                >
                                  <Plus size={11} />
                                </button>
                              </div>
                            )}
                            <span className="ml-auto shrink-0 text-base font-extrabold tabular-nums text-foreground">R$ {fmtBRL(lineTotal)}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {toothPickerFor === it.procedure.id && (
                      <ToothPicker
                        titulo={it.procedure.name}
                        selected={it.toothFdis}
                        marcas={marcasVenda}
                        onToggle={(fdi) => toggleTooth(it.procedure.id, fdi)}
                        kidMode={toothKidMode}
                        onKidMode={setToothKidMode}
                        onClose={() => setToothPickerFor(null)}
                        lab={lab}
                      />
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* F8 do laboratório — ficha do caso (opcional), gravada depois da venda */}
          {lab && (
            <LabFichaDoCasoDaVenda
              valor={fichaDoCaso}
              onChange={setFichaDoCaso}
              clienteId={patient?.id}
              servicoIds={cart.map((it) => it.procedure.id)}
            />
          )}

          {/* Total + botão fixos no rodapé do painel — sempre visíveis, mesmo com muitos procedimentos. */}
          <div className="lg:sticky lg:bottom-0 bg-card -mx-4 px-4 -mb-4 pb-4 pt-3 border-t border-border">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-bold">Total</span>
              <Preco valor={total} />
            </div>
            <button
              type="button"
              onClick={irParaPagamento}
              disabled={!patient || cart.length === 0 || !dentistId}
              className="vr-botao w-full text-sm px-4 py-3.5 inline-flex items-center justify-center gap-2"
            >
              {!patient ? (
                <>
                  <AlertCircle size={14} />
                  {lab ? LAB_VENDA_RAPIDA.cta.cliente : 'Selecione um paciente'}
                </>
              ) : cart.length === 0 ? (
                <>
                  <ShoppingCart size={14} />
                  {lab ? LAB_VENDA_RAPIDA.cta.servicos : 'Adicione procedimentos'}
                </>
              ) : !dentistId ? (
                <>
                  <AlertCircle size={14} />
                  {lab ? LAB_VENDA_RAPIDA.cta.responsavel : 'Selecione o dentista'}
                </>
              ) : (
                <>
                  Ir para o pagamento
                  <ArrowRight size={16} strokeWidth={3} />
                </>
              )}
            </button>
          </div>
        </aside>
      </div>
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
        <div className="min-w-0">
          <button
            type="button"
            onClick={voltarParaVenda}
            disabled={finishing}
            className="vr-link mb-3 inline-flex items-center gap-1.5 text-sm font-semibold disabled:opacity-50"
          >
            <ArrowLeft size={15} /> Voltar para a venda
          </button>
          <PagamentoBalcao
            valor={pagamento}
            onChange={(p) => { setPagamento(p); setValorMudou(false); }}
            totalCentavos={totalCentavos}
            valorMudou={valorMudou}
            bloqueado={finishing}
            lab={lab}
          />
        </div>

        {/* Resumo da venda: não se edita aqui. Pra mudar o carrinho, "Voltar para a venda". */}
        <aside className="vr-card p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto h-fit">
          <p className="mb-3 text-sm font-bold text-foreground">Resumo da venda</p>
          <dl className="space-y-1 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{lab ? LAB_VENDA_RAPIDA.pagamento.resumoCliente : 'Paciente'}</dt>
              <dd className="min-w-0 truncate font-semibold text-foreground">{patient?.name}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{lab ? LAB_VENDA_RAPIDA.pagamento.resumoResponsavel : 'Dentista'}</dt>
              <dd className="min-w-0 truncate font-semibold text-foreground">{dentistaDaVenda?.name}</dd>
            </div>
          </dl>

          <ul className="my-3 max-h-48 space-y-1.5 overflow-y-auto border-t border-border pt-3">
            {cart.map((it) => (
              <li key={it.procedure.id} className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0 text-foreground">
                  {it.procedure.name}
                  {itemUnits(it) > 1 && <span className="text-muted-foreground"> × {itemUnits(it)}</span>}
                </span>
                <span className="shrink-0 tabular-nums">R$ {fmtBRL(unitPriceOf(it) * itemUnits(it))}</span>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm font-bold">Total</span>
            <Preco valor={total} />
          </div>

          <div className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
            {analise.linhas.map((l, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <span className="min-w-0 text-muted-foreground">{rotuloLinha(l)}</span>
                <span className="shrink-0 font-semibold tabular-nums">R$ {fmtCentavos(l.centavos)}</span>
              </div>
            ))}
            {analise.faltaCentavos > 0 ? (
              <div className="flex items-center justify-between gap-3 font-semibold">
                <span>Falta receber</span>
                <span className="tabular-nums text-amber-700">R$ {fmtCentavos(analise.faltaCentavos)}</span>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 font-semibold vr-verde">
                <CheckCircle2 size={14} /> Tudo recebido
              </p>
            )}
          </div>

          <fieldset disabled={finishing} className="mt-3 min-w-0 border-0 p-0 m-0">
          {/* Baixa de estoque — só quando o procedimento tem insumo cadastrado */}
          {consumo && (
            <div className={`border rounded-xl px-3 py-2.5 mb-3 ${
              consumo.tem_falta
                ? 'border-amber-500/40 bg-amber-500/10'
                : 'border-border bg-muted/20'
            }`}>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={baixarEstoque}
                  onChange={(e) => setBaixarEstoque(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                    <Package size={12} />
                    Dar baixa no estoque
                  </span>
                  <span className="block text-[10px] text-muted-foreground mt-0.5">
                    {consumo.custo_total > 0
                      ? `custo do material: R$ ${fmtBRL(consumo.custo_total)}`
                      : (lab ? LAB_VENDA_RAPIDA.material : 'material consumido por estes procedimentos')}
                  </span>
                </span>
              </label>
              {baixarEstoque && (
                <ul className="mt-2 space-y-1 pl-6">
                  {consumo.items.map((i) => (
                    <li key={i.product_id} className="text-[11px] flex items-center justify-between gap-2">
                      <span className="truncate text-foreground">
                        {i.needed}{i.unit} · {i.name}
                      </span>
                      <span className={`shrink-0 tabular-nums ${i.falta > 0 ? 'text-amber-700 font-semibold' : 'text-muted-foreground'}`}>
                        {i.falta > 0 ? `faltam ${i.falta}${i.unit}` : `saldo ${i.current_stock}${i.unit}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {baixarEstoque && consumo.bloqueado && (
                <p className="mt-2 text-[10px] text-red-600 font-semibold pl-6">
                  {lab ? LAB_VENDA_RAPIDA.bloqueiaSemSaldo : 'Esta clínica bloqueia saída sem saldo — dê entrada no produto, ou desmarque a baixa pra fechar a venda mesmo assim.'}
                </p>
              )}
            </div>
          )}
          </fieldset>

          <button
            type="button"
            onClick={acaoDoPagamento}
            disabled={finishing || analise.acao === null || (analise.acao === 'FINALIZAR' && estoqueTrava)}
            className="mt-3 vr-botao w-full text-sm px-4 py-3.5 inline-flex items-center justify-center gap-2"
          >
            {finishing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Finalizando...
              </>
            ) : analise.pendencia ? (
              <>
                <AlertCircle size={14} />
                {TEXTO_PENDENCIA[analise.pendencia]}
              </>
            ) : analise.acao === 'CONTINUAR' ? (
              <>
                Continuar
                <ArrowRight size={16} strokeWidth={3} />
              </>
            ) : estoqueTrava ? (
              <>
                <AlertCircle size={14} />
                Falta material no estoque
              </>
            ) : (
              <>
                <Check size={16} strokeWidth={3} />
                {textoFinalizar(analise.linhas)}
              </>
            )}
          </button>

          <div className="mt-3 text-[10px] text-muted-foreground flex items-start gap-1.5">
            <CheckCircle2 size={11} className="shrink-0 mt-0.5" />
            <p className="leading-snug">
              {lab ? (
                <>
                  {LAB_VENDA_RAPIDA.rodape.antes}<strong>{LAB_VENDA_RAPIDA.pendentes}</strong>{LAB_VENDA_RAPIDA.rodape.depois}
                </>
              ) : (
                <>
                  Ao finalizar: registra o recebimento no caixa e lança os procedimentos
                  no tratamento como <strong>pendentes</strong> — o dentista confirma a
                  conclusão de cada um depois.
                </>
              )}
            </p>
          </div>
        </aside>
      </div>
      )}
      </div>
      </div>

      {/* Onda 17.32.70 — Dialog de sucesso */}
      {successDialog && (
        <SuccessDialog
          data={successDialog}
          onClose={() => setSuccessDialog(null)}
          onGoToPatient={() => {
            router.push(`/atendimento/pacientes/${successDialog.patientId}?tab=financial`);
          }}
          lab={lab}
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

/** Onda 17.32.70 — Dialog de sucesso pos-venda: o que foi recebido e onde caiu cada valor. */
function SuccessDialog({
  data,
  onClose,
  onGoToPatient,
  lab,
}: {
  data: {
    total: number;
    patientName: string;
    linhas: LinhaRecebida[];
    precisaValidar: boolean;
  };
  onClose: () => void;
  onGoToPatient: () => void;
  /** F5 do laboratório: textos do laboratório e "Ver na ficha" só com a ficha liberada. */
  lab?: boolean;
}) {
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
        <div className="bg-[#00a650] text-white px-6 py-4 flex items-center justify-between gap-3 shrink-0">
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
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Onde caiu cada valor</p>
          <ul className="mb-4 divide-y divide-border rounded-lg border border-border">
            {data.linhas.map((l, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-bold tabular-nums text-foreground">R$ {fmtCentavos(l.centavos)}</span>
                  <span className="text-muted-foreground"> · {l.rotulo}</span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 font-semibold vr-verde">
                  <ArrowRight size={13} /> {l.destino}
                </span>
              </li>
            ))}
          </ul>
          {lab ? (
            <p className="text-sm text-muted-foreground">
              {LAB_VENDA_RAPIDA.sucesso.texto.antes}<strong>{LAB_VENDA_RAPIDA.pendentes}</strong>{LAB_VENDA_RAPIDA.sucesso.texto.depois}
            </p>
          ) : (
          <p className="text-sm text-muted-foreground">
            Pagamento registrado e lançado no financeiro do paciente. Os
            procedimentos entram no tratamento como <strong>pendentes</strong> —
            o dentista confirma a conclusão de cada um.
          </p>
          )}
          {data.precisaValidar && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-800">
              <AlertCircle size={14} className="mt-px shrink-0" />
              {lab ? LAB_VENDA_RAPIDA.sucesso.validar : 'Esta venda passa pelo Validar do Financeiro antes de liberar o tratamento.'}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-6 py-4 border-t border-border bg-muted/30 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="vr-botao-claro flex-1 text-sm px-3 py-2 inline-flex items-center justify-center gap-1.5"
          >
            <Zap size={14} />
            Nova venda
          </button>
          {(!lab || labAllowsRoute('/atendimento/pacientes')) && (
          <button
            type="button"
            onClick={onGoToPatient}
            className="vr-botao flex-1 text-sm px-3 py-2 inline-flex items-center justify-center gap-1.5"
          >
            Ver na ficha
            <ArrowRight size={14} />
          </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Onda 17.38 — Seletor de dente (FDI), referência da avaliação ──────────
// Grade compacta no padrão do odontograma: arcada superior em cima, inferior
// embaixo, numeração FDI. Multi-seleção (clica pra marcar/desmarcar). Toggle
// Adulto/Infantil. Some os dentes selecionados em dourado, igual à avaliação.
// Out/2026 — virou a prancha do odontograma (fundo vinho, dentes realistas) com o
// que já está na venda desenhado nos dentes; os deste item ficam em âmbar. Abre
// por cima (a coluna do carrinho é estreita demais pra prancha inteira).
function ToothPicker({
  titulo,
  selected,
  marcas,
  onToggle,
  kidMode,
  onKidMode,
  onClose,
  lab,
}: {
  titulo: string;
  selected: string[];
  marcas: Map<string, MarcaDente[]>;
  onToggle: (fdi: string) => void;
  kidMode: boolean;
  onKidMode: (v: boolean) => void;
  onClose: () => void;
  /** F5 do laboratório: elementos do serviço no lugar dos dentes do procedimento. */
  lab?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-label={lab ? LAB_VENDA_RAPIDA.seletor.aria(titulo) : `Dentes — ${titulo}`}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-[680px] rounded-2xl border border-border bg-card p-4 shadow-2xl">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{lab ? LAB_VENDA_RAPIDA.seletor.titulo : 'Dentes do procedimento'}</p>
          <p className="truncate text-sm font-semibold text-foreground">{titulo}</p>
        </div>
        <div className="inline-flex shrink-0 rounded-md border border-border overflow-hidden text-[11px] font-semibold">
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
      </div>
      <div className="overflow-x-auto">
        <div className="flex justify-center min-w-max">
          <OdontogramaPrancha
            infantil={kidMode}
            altura={58}
            marcas={marcas}
            selecionados={new Set(selected)}
            onToggle={onToggle}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          {lab ? LAB_VENDA_RAPIDA.seletor.dica : 'Clique nos dentes do procedimento. Cada dente vira 1 item no tratamento.'}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="h-9 shrink-0 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          {lab ? LAB_VENDA_RAPIDA.seletor.pronto(selected.length) : 'Pronto'}{!lab && selected.length > 0 ? ` · ${selected.length} dente${selected.length === 1 ? '' : 's'}` : ''}
        </button>
      </div>
      </div>
    </div>
  );
}

// ─── Editor de preço unitário (desconto OU acréscimo) ──────────────────────
// Só renderizado pra quem tem a permissão `override_price`. Clica no preço →
// input inline. Onda 18.x — aceita valor ACIMA ou ABAIXO da tabela (ex.: ortô
// que vende mais caro). Mostra a tabela riscada quando muda (verde=desconto,
// âmbar=acréscimo). O backend revalida.
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
  const raised = value > base + 0.001;
  const changed = discounted || raised;

  // Abre o campo VAZIO (preço atual fica no placeholder). Assim, no celular,
  // digitar o novo valor substitui em vez de anexar ao texto pré-preenchido.
  const open = () => {
    setDraft('');
    setEditing(true);
  };
  const commit = () => {
    const raw = draft.trim();
    if (raw === '') {
      // Vazio = não mexe (evita zerar um preço custom só por abrir e fechar).
      setEditing(false);
      return;
    }
    // Parse tolerante ao formato BR. Regra: o ÚLTIMO separador é o decimal.
    // - "1.800,00" -> vírgula é decimal, ponto é milhar -> 1800
    // - "350.00"   -> ponto seguido de 1-2 casas = decimal -> 350 (antes virava 35000!)
    // - "1.200"    -> ponto seguido de 3 casas = milhar -> 1200
    // - "1800"     -> 1800
    const cleaned = raw.replace(/[^\d.,]/g, '');
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    let normalized: string;
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
      const decimals = cleaned.length - lastDot - 1;
      normalized = decimals <= 2
        ? cleaned.replace(/,/g, '')       // ponto é decimal
        : cleaned.replace(/[.,]/g, '');   // ponto é milhar
    } else {
      normalized = cleaned;
    }
    const n = Number(normalized);
    if (isFinite(n) && n > 0) onChange(n); // aceita acima OU abaixo da tabela
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
        {changed && (
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
      title="Alterar preço (desconto ou acréscimo)"
    >
      {changed && <span className="line-through text-muted-foreground/50">R$ {fmtBRL(base)}</span>}
      <span
        className={`border-b border-dashed border-muted-foreground/40 ${
          discounted ? 'font-semibold text-emerald-700'
            : raised ? 'font-semibold text-amber-700' : ''
        }`}
      >
        R$ {fmtBRL(value)}
      </span>
      <Pencil size={11} className="opacity-60 group-hover/price:opacity-100" />
    </button>
  );
}
