'use client';

/**
 * F8 do laboratório — ficha do caso (QuoteLabCase) no orçamento de trabalho (aba
 * Orçamento), no trabalho aprovado (aba Trabalhos) e na venda rápida.
 *
 * Só o laboratório monta estes componentes (cada tela os põe atrás de `lab &&`); a
 * clínica não chega aqui. Todo texto vem de ../lab-caso-textos. Este é o ÚNICO arquivo
 * do web que nomeia o campo do paciente do caso: ele fica só no sistema e não vai para
 * PDF, cobrança, WhatsApp, e-mail nem log (nada aqui escreve no console).
 *
 * Rotas (todas da conta de laboratório, liberadas na política da API):
 *   - GET /patients/:id/lab-cases     — o caso efetivo de cada orçamento do cliente
 *                                       (UMA chamada por tela, para os selos);
 *   - GET /quotes/:id/lab-case        — a ficha de um orçamento (própria ou herdada);
 *   - PUT /quotes/:id/lab-case        — grava a ficha no orçamento pedido (upsert);
 *   - GET /lab/procedure-specs        — fichas técnicas dos serviços (prazo, material
 *                                       padrão, pede cor, tem prova), com cache no módulo;
 *   - GET /patients/:id/lab-profile   — dentistas solicitantes do cliente (sugestão).
 *
 * Datas sempre como texto 'AAAA-MM-DD' (formatarYmdBR, diasAte e hojeEmMaceio do
 * shared): nada de toLocaleDateString nem new Date(ymd), que mostram um dia a menos
 * no fuso de Maceió.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { AxiosRequestConfig } from 'axios';
import {
  CalendarClock, ChevronDown, ChevronUp, ClipboardList, ExternalLink, Loader2, Pencil, Save,
  ShieldCheck, TriangleAlert, X,
} from 'lucide-react';
import {
  CAMPOS_DO_CASO,
  LIMITES_DO_CASO,
  dataDoDia,
  decodeJwtPayload,
  diasAte,
  entregaSugerida,
  formatarYmdBR,
  hojeEmMaceio,
  isLab,
  linkDoEscaneamentoValido,
  type CasosDoClienteLabResposta,
  type FichaDoCasoLab,
  type FichaDoCasoLabResposta,
  type FichaTecnicaLab,
  type FichasTecnicasLabResposta,
  type PerfilDoClienteLabResposta,
} from '@crm/shared';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { btAgora, useBusinessType } from '@/lib/useBusinessType';
import { LAB_CASO } from '../lab-caso-textos';

// ─── Formato do formulário ───────────────────────────────────────────────────

/** Ficha do caso no formulário: os 8 campos como texto ('' = vazio); datas 'AAAA-MM-DD'. */
export type FichaDoCaso = { [K in keyof FichaDoCasoLab]: string };

export const FICHA_VAZIA: FichaDoCaso = Object.freeze({
  patient_ref: '',
  requested_by_name: '',
  shade: '',
  material: '',
  due_date: '',
  instructions: '',
  external_files_url: '',
  received_at: '',
});

/** Status do trabalho (TreatmentPlan) concluído: a contagem da entrega some. */
export const STATUS_DO_TRABALHO_CONCLUIDO = 'COMPLETED';

/**
 * Formulário → corpo do PUT: só os 8 campos, aparados; vazio vira null (limpa). Nunca
 * manda gravado, herdado_de, quote_id nem updated_at (a API recusa campo a mais).
 */
export function paraCorpo(f: FichaDoCaso): Partial<FichaDoCasoLab> {
  const corpo: Partial<FichaDoCasoLab> = {};
  for (const campo of CAMPOS_DO_CASO) {
    const v = typeof f?.[campo] === 'string' ? f[campo].trim() : '';
    corpo[campo] = v === '' ? null : v;
  }
  return corpo;
}

/** Resposta da API → formulário (null vira ''). */
function daResposta(r: Partial<FichaDoCasoLab> | null | undefined): FichaDoCaso {
  const f: FichaDoCaso = { ...FICHA_VAZIA };
  if (!r) return f;
  for (const campo of CAMPOS_DO_CASO) {
    const v = r[campo];
    f[campo] = typeof v === 'string' ? v : '';
  }
  f.due_date = f.due_date.slice(0, 10);
  f.received_at = f.received_at.slice(0, 10);
  return f;
}

function fichaVazia(f: FichaDoCaso | null | undefined): boolean {
  return !f || CAMPOS_DO_CASO.every((c) => !(f[c] ?? '').trim());
}

function mesmaFicha(a: FichaDoCaso, b: FichaDoCaso): boolean {
  return CAMPOS_DO_CASO.every((c) => (a[c] ?? '').trim() === (b[c] ?? '').trim());
}

/** Conferência antes do PUT (a API confere de novo). null = pode gravar. */
/**
 * Erro da ficha ou null, com as mesmas faixas da API (lab-fichas.service.ts): link
 * http/https, entrega de 2020 até 3 anos à frente e recebimento de 2020 até hoje
 * (datas em Maceió). A venda rápida confere antes de finalizar.
 */
export function erroDaFicha(f: FichaDoCaso): string | null {
  const link = f.external_files_url.trim();
  if (link && !linkDoEscaneamentoValido(link)) return LAB_CASO.erros.link;
  for (const d of [f.due_date, f.received_at]) if (d && !dataDoDia(d)) return LAB_CASO.erros.data;
  const hoje = hojeEmMaceio();
  const entregaMaxima = `${Number(hoje.slice(0, 4)) + 3}${hoje.slice(4)}`;
  if (f.due_date && (f.due_date < DATA_MINIMA || f.due_date > entregaMaxima)) return LAB_CASO.erros.entregaFora;
  if (f.received_at && (f.received_at < DATA_MINIMA || f.received_at > hoje)) return LAB_CASO.erros.recebidoFora;
  return null;
}

/** Piso das datas do caso (o mesmo da API). */
const DATA_MINIMA = '2020-01-01';

type ErroDaApi = { response?: { data?: { message?: unknown } } };
function mensagemDoErro(err: unknown, padrao: string): string {
  const m = (err as ErroDaApi)?.response?.data?.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (Array.isArray(m)) {
    const t = m.filter((x): x is string => typeof x === 'string').join(' ');
    if (t) return t;
  }
  return padrao;
}

/** 'AAAA-MM-DD' → 'dd/mm'. */
const diaEMes = (ymd: string | null | undefined) => formatarYmdBR(ymd).slice(0, 5);

// ─── Leituras com cache (limite de 100 chamadas por minuto por IP) ───────────

/** Leitura de fundo: sem o aviso global de permissão (a tela trata a falha). */
const EM_SEGUNDO_PLANO = { _silent401: true } as unknown as AxiosRequestConfig;
const VALIDADE_DO_CACHE_MS = 60_000;
const SEM_FICHAS: Record<string, FichaTecnicaLab> = {};
const SEM_DENTISTAS: string[] = [];

/** Conta da sessão (tenant do token): o cache de uma conta nunca serve a outra. */
function contaDaSessao(): string {
  try {
    if (typeof window === 'undefined') return '';
    const tid = decodeJwtPayload(window.localStorage.getItem('token'))?.tenant_id;
    return typeof tid === 'string' ? tid : '';
  } catch {
    return '';
  }
}

let fichasGuardadas: { conta: string; em: number; fichas: Record<string, FichaTecnicaLab> } | null = null;
let fichasEmVoo: { conta: string; promessa: Promise<Record<string, FichaTecnicaLab>> } | null = null;

function fichasDoCache(): Record<string, FichaTecnicaLab> | null {
  const conta = contaDaSessao();
  if (!fichasGuardadas || fichasGuardadas.conta !== conta) return null;
  return Date.now() - fichasGuardadas.em < VALIDADE_DO_CACHE_MS ? fichasGuardadas.fichas : null;
}

/** GET /lab/procedure-specs uma vez por minuto, com as chamadas simultâneas juntas. */
function carregarFichas(): Promise<Record<string, FichaTecnicaLab>> {
  const guardadas = fichasDoCache();
  if (guardadas) return Promise.resolve(guardadas);
  const conta = contaDaSessao();
  if (fichasEmVoo && fichasEmVoo.conta === conta) return fichasEmVoo.promessa;
  const promessa = api
    .get<FichasTecnicasLabResposta>('/lab/procedure-specs', EM_SEGUNDO_PLANO)
    .then(({ data }) => {
      const fichas = data?.fichas && typeof data.fichas === 'object' ? data.fichas : SEM_FICHAS;
      fichasGuardadas = { conta, em: Date.now(), fichas };
      return fichas;
    })
    .finally(() => {
      if (fichasEmVoo?.promessa === promessa) fichasEmVoo = null;
    });
  fichasEmVoo = { conta, promessa };
  return promessa;
}

/** Fichas técnicas dos serviços da conta, por procedure_id. Sem laboratório, nenhuma chamada. */
export function useFichasDosServicos(lab: boolean): Record<string, FichaTecnicaLab> {
  // 1º quadro: o tipo da sessão vem do token (o hook do tipo ainda pode estar na hidratação).
  const ativo = lab || isLab(btAgora());
  const [fichas, setFichas] = useState<Record<string, FichaTecnicaLab>>(() => (ativo && fichasDoCache()) || SEM_FICHAS);
  useEffect(() => {
    if (!ativo) return;
    let cancelado = false;
    carregarFichas()
      .then((f) => {
        if (!cancelado) setFichas(f);
      })
      .catch(() => {
        // Sem fichas: a ficha do caso fica sem sugestão de entrega e de material.
      });
    return () => {
      cancelado = true;
    };
  }, [ativo]);
  return fichas;
}

const dentistasGuardados = new Map<string, { em: number; lista: string[] }>();
const dentistasEmVoo = new Map<string, Promise<string[]>>();

/** Dentistas solicitantes do cliente (GET /patients/:id/lab-profile), com cache curto. */
function carregarDentistas(clienteId: string): Promise<string[]> {
  const chave = `${contaDaSessao()}|${clienteId}`;
  const guardado = dentistasGuardados.get(chave);
  if (guardado && Date.now() - guardado.em < VALIDADE_DO_CACHE_MS) return Promise.resolve(guardado.lista);
  const emVoo = dentistasEmVoo.get(chave);
  if (emVoo) return emVoo;
  const promessa = api
    .get<PerfilDoClienteLabResposta>(`/patients/${encodeURIComponent(clienteId)}/lab-profile`, EM_SEGUNDO_PLANO)
    .then(({ data }) => {
      const lista = Array.isArray(data?.requesting_dentists)
        ? data.requesting_dentists.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
        : SEM_DENTISTAS;
      dentistasGuardados.set(chave, { em: Date.now(), lista });
      return lista;
    })
    .finally(() => {
      dentistasEmVoo.delete(chave);
    });
  dentistasEmVoo.set(chave, promessa);
  return promessa;
}

function useDentistasDoCliente(ativo: boolean, clienteId: string | null | undefined): string[] {
  const [carregado, setCarregado] = useState<{ clienteId: string; lista: string[] } | null>(null);
  useEffect(() => {
    if (!ativo || !clienteId) return;
    let cancelado = false;
    carregarDentistas(clienteId)
      .then((lista) => {
        if (!cancelado) setCarregado({ clienteId, lista });
      })
      .catch(() => {
        // Sem perfil (ou sem permissão): o campo fica sem sugestão.
      });
    return () => {
      cancelado = true;
    };
  }, [ativo, clienteId]);
  // Lista de outro cliente (troca na venda rápida) não vale para este.
  return ativo && clienteId && carregado?.clienteId === clienteId ? carregado.lista : SEM_DENTISTAS;
}

/**
 * Caso efetivo (próprio ou herdado) de cada orçamento do cliente, por quote_id. UMA
 * chamada a GET /patients/:id/lab-cases por tela, e só no laboratório: com lab=false
 * (clínica) nenhuma requisição.
 */
export function useCasosDoCliente(
  lab: boolean,
  patientId: string | null | undefined,
): { casos: Record<string, FichaDoCasoLabResposta>; recarregar: () => void } {
  // 1º quadro: o tipo da sessão vem do token (o hook do tipo ainda pode estar na hidratação).
  const ativo = lab || isLab(btAgora());
  const [casos, setCasos] = useState<Record<string, FichaDoCasoLabResposta>>({});
  const [versao, setVersao] = useState(0);
  useEffect(() => {
    if (!ativo || !patientId) return;
    let cancelado = false;
    api
      .get<CasosDoClienteLabResposta>(`/patients/${encodeURIComponent(patientId)}/lab-cases`, EM_SEGUNDO_PLANO)
      .then(({ data }) => {
        if (cancelado) return;
        const mapa: Record<string, FichaDoCasoLabResposta> = {};
        for (const c of Array.isArray(data?.casos) ? data.casos : []) {
          if (c && typeof c.quote_id === 'string') mapa[c.quote_id] = c;
        }
        setCasos(mapa);
      })
      .catch(() => {
        // Sem a lista: os selos não aparecem; a ficha de cada orçamento carrega sozinha.
      });
    return () => {
      cancelado = true;
    };
  }, [ativo, patientId, versao]);
  const recarregar = useCallback(() => setVersao((v) => v + 1), []);
  return { casos, recarregar };
}

/**
 * Grava a ficha do caso da venda rápida no orçamento que a venda de balcão criou (PUT
 * é upsert: repetir não duplica). Ficha vazia não grava. Nunca lança: se falhar, avisa
 * que a venda ficou registrada e devolve false.
 */
export async function gravarFichaDaVenda(quoteId: string, ficha: FichaDoCaso): Promise<boolean> {
  try {
    if (!quoteId || fichaVazia(ficha)) return false;
    await api.put(`/quotes/${encodeURIComponent(quoteId)}/lab-case`, paraCorpo(ficha));
    return true;
  } catch {
    showError(LAB_CASO.erros.vendaSemFicha);
    return false;
  }
}

// ─── Componentes ─────────────────────────────────────────────────────────────

const ENTRADA =
  'w-full px-3 py-2 text-sm rounded-lg border border-border bg-card text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70 disabled:cursor-not-allowed';
const BOTAO_PEQUENO =
  'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-semibold text-primary hover:bg-primary/10';

function Campo({
  id,
  rotulo,
  largo = false,
  children,
}: {
  id: string;
  rotulo: string;
  largo?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={largo ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
      <label htmlFor={id} className="block text-[11px] font-semibold text-muted-foreground mb-1">
        {rotulo}
      </label>
      {children}
    </div>
  );
}

function Sugestao({ texto, rotulo, onUsar }: { texto: string; rotulo: string; onUsar: () => void }) {
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="min-w-0 flex-1">{texto}</span>
      <button type="button" onClick={onUsar} className={BOTAO_PEQUENO}>
        {rotulo}
      </button>
    </div>
  );
}

/**
 * Formulário da ficha do caso (controlado). Grade de 2 colunas (1 no celular, ou
 * sempre 1 com `compacto`). A entrega prometida é SUGERIDA pelo maior prazo dos
 * serviços, com botão Usar: nunca é preenchida sozinha.
 */
export function LabFichaDoCaso({
  valor,
  onChange,
  clienteId,
  servicoIds,
  somenteLeitura = false,
  compacto = false,
}: {
  valor: FichaDoCaso;
  onChange: (f: FichaDoCaso) => void;
  clienteId?: string | null;
  servicoIds: readonly string[];
  somenteLeitura?: boolean;
  compacto?: boolean;
}) {
  const lab = isLab(useBusinessType());
  const ativo = lab || isLab(btAgora());
  const base = useId();
  const fichas = useFichasDosServicos(ativo);
  const dentistas = useDentistasDoCliente(ativo, clienteId);
  const chaveDosServicos = servicoIds.join('|');

  const { pedeCor, materialPadrao, sugestao } = useMemo(() => {
    const doTrabalho = (chaveDosServicos ? chaveDosServicos.split('|') : [])
      .map((id) => fichas[id])
      .filter((f): f is FichaTecnicaLab => !!f);
    const materiais = new Set(
      doTrabalho.map((f) => (f.default_material ?? '').trim()).filter((m) => m !== ''),
    );
    return {
      pedeCor: doTrabalho.some((f) => f.needs_shade),
      materialPadrao: materiais.size === 1 ? Array.from(materiais)[0] : null,
      sugestao: entregaSugerida(doTrabalho.map((f) => f.lead_time_days), hojeEmMaceio()),
    };
  }, [fichas, chaveDosServicos]);

  const mudar = (campo: keyof FichaDoCaso, v: string) => onChange({ ...valor, [campo]: v });
  const link = valor.external_files_url.trim();
  const linkValido = linkDoEscaneamentoValido(link);
  const idDaLista = `${base}-dentistas`;

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <ShieldCheck size={12} className="shrink-0 mt-0.5 text-emerald-600" />
        {LAB_CASO.privacidade}
      </p>
      <div className={`grid gap-3 ${compacto ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
        <Campo id={`${base}-ref`} rotulo={LAB_CASO.campos.pacienteDoCaso}>
          <input
            id={`${base}-ref`}
            value={valor.patient_ref}
            onChange={(e) => mudar('patient_ref', e.target.value)}
            maxLength={LIMITES_DO_CASO.patient_ref}
            placeholder={LAB_CASO.campos.pacienteDoCasoExemplo}
            disabled={somenteLeitura}
            autoComplete="off"
            className={ENTRADA}
          />
        </Campo>
        <Campo id={`${base}-dentista`} rotulo={LAB_CASO.campos.dentista}>
          <input
            id={`${base}-dentista`}
            value={valor.requested_by_name}
            onChange={(e) => mudar('requested_by_name', e.target.value)}
            maxLength={LIMITES_DO_CASO.requested_by_name}
            placeholder={LAB_CASO.campos.dentistaExemplo}
            disabled={somenteLeitura}
            list={dentistas.length > 0 ? idDaLista : undefined}
            autoComplete="off"
            className={ENTRADA}
          />
          {dentistas.length > 0 && (
            <datalist id={idDaLista}>
              {dentistas.map((nome) => (
                <option key={nome} value={nome} />
              ))}
            </datalist>
          )}
        </Campo>

        <Campo id={`${base}-cor`} rotulo={LAB_CASO.campos.cor}>
          <input
            id={`${base}-cor`}
            value={valor.shade}
            onChange={(e) => mudar('shade', e.target.value)}
            maxLength={LIMITES_DO_CASO.shade}
            placeholder={LAB_CASO.campos.corExemplo}
            disabled={somenteLeitura}
            autoComplete="off"
            className={ENTRADA}
          />
          {pedeCor && !valor.shade.trim() && (
            <p className="mt-1 flex items-start gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              <TriangleAlert size={12} className="shrink-0 mt-0.5" />
              {LAB_CASO.campos.corPedida}
            </p>
          )}
        </Campo>
        <Campo id={`${base}-material`} rotulo={LAB_CASO.campos.material}>
          <input
            id={`${base}-material`}
            value={valor.material}
            onChange={(e) => mudar('material', e.target.value)}
            maxLength={LIMITES_DO_CASO.material}
            placeholder={LAB_CASO.campos.materialExemplo}
            disabled={somenteLeitura}
            autoComplete="off"
            className={ENTRADA}
          />
          {!somenteLeitura && materialPadrao && valor.material.trim() !== materialPadrao && (
            <Sugestao
              texto={LAB_CASO.campos.materialSugerido(materialPadrao)}
              rotulo={LAB_CASO.campos.usarSugestao}
              onUsar={() => mudar('material', materialPadrao)}
            />
          )}
        </Campo>

        <Campo id={`${base}-entrega`} rotulo={LAB_CASO.campos.entrega}>
          <input
            id={`${base}-entrega`}
            type="date"
            min="2020-01-01"
            value={valor.due_date}
            onChange={(e) => mudar('due_date', e.target.value)}
            disabled={somenteLeitura}
            className={ENTRADA}
          />
          {!somenteLeitura && sugestao && valor.due_date !== sugestao.data && (
            <Sugestao
              texto={LAB_CASO.campos.sugestao(formatarYmdBR(sugestao.data), sugestao.dias)}
              rotulo={LAB_CASO.campos.usarSugestao}
              onUsar={() => mudar('due_date', sugestao.data)}
            />
          )}
        </Campo>
        <Campo id={`${base}-recebido`} rotulo={LAB_CASO.campos.recebido}>
          <div className="flex items-center gap-2">
            <input
              id={`${base}-recebido`}
              type="date"
              min={DATA_MINIMA}
              max={hojeEmMaceio()}
              value={valor.received_at}
              onChange={(e) => mudar('received_at', e.target.value)}
              disabled={somenteLeitura}
              className={ENTRADA}
            />
            {!somenteLeitura && (
              <button type="button" onClick={() => mudar('received_at', hojeEmMaceio())} className={BOTAO_PEQUENO}>
                {LAB_CASO.campos.hoje}
              </button>
            )}
          </div>
        </Campo>

        <Campo id={`${base}-link`} rotulo={LAB_CASO.campos.link} largo={!compacto}>
          <div className="flex items-center gap-2">
            <input
              id={`${base}-link`}
              type="url"
              inputMode="url"
              value={valor.external_files_url}
              onChange={(e) => mudar('external_files_url', e.target.value)}
              maxLength={LIMITES_DO_CASO.external_files_url}
              placeholder={LAB_CASO.campos.linkExemplo}
              disabled={somenteLeitura}
              autoComplete="off"
              className={ENTRADA}
            />
            {linkValido && (
              <a href={link} target="_blank" rel="noopener noreferrer" className={BOTAO_PEQUENO}>
                {LAB_CASO.campos.abrirLink}
                <ExternalLink size={11} />
              </a>
            )}
          </div>
          {link !== '' && !linkValido && (
            <p className="mt-1 text-[11px] font-medium text-red-600 dark:text-red-400">{LAB_CASO.erros.link}</p>
          )}
        </Campo>

        <Campo id={`${base}-instrucoes`} rotulo={LAB_CASO.campos.instrucoes} largo={!compacto}>
          <textarea
            id={`${base}-instrucoes`}
            value={valor.instructions}
            onChange={(e) => mudar('instructions', e.target.value)}
            maxLength={LIMITES_DO_CASO.instructions}
            placeholder={LAB_CASO.campos.instrucoesExemplo}
            disabled={somenteLeitura}
            rows={3}
            className={`${ENTRADA} resize-y`}
          />
        </Campo>
      </div>
    </div>
  );
}

/**
 * Ficha do caso de um orçamento de trabalho (aba Orçamento). Carrega ao abrir; sem
 * ficha própria, mostra a herdada do orçamento de origem. Editável em rascunho e
 * enviado por quem monta o orçamento (`podeEditar`).
 */
export function LabFichaDoCasoDoOrcamento({
  quoteId,
  clienteId,
  servicoIds,
  podeEditar,
  aoSalvar,
}: {
  quoteId: string;
  clienteId: string;
  servicoIds: readonly string[];
  podeEditar: boolean;
  aoSalvar?: () => void;
}) {
  const lab = isLab(useBusinessType());
  const ativo = lab || isLab(btAgora());
  const [ficha, setFicha] = useState<FichaDoCaso>(FICHA_VAZIA);
  const [gravada, setGravada] = useState<FichaDoCaso>(FICHA_VAZIA);
  const [herdadoDe, setHerdadoDe] = useState<string | null>(null);
  // De qual orçamento veio a última leitura (e se falhou). Outro orçamento = carregando.
  const [carga, setCarga] = useState<{ quoteId: string; erro: boolean } | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!ativo || !quoteId) return;
    let cancelado = false;
    api
      .get<FichaDoCasoLabResposta>(`/quotes/${encodeURIComponent(quoteId)}/lab-case`, EM_SEGUNDO_PLANO)
      .then(({ data }) => {
        if (cancelado) return;
        const f = daResposta(data);
        setFicha(f);
        setGravada(f);
        setHerdadoDe(typeof data?.herdado_de === 'string' ? data.herdado_de : null);
        setCarga({ quoteId, erro: false });
      })
      .catch(() => {
        if (!cancelado) setCarga({ quoteId, erro: true });
      });
    return () => {
      cancelado = true;
    };
  }, [ativo, quoteId]);

  const estado: 'carregando' | 'pronto' | 'erro' =
    !carga || carga.quoteId !== quoteId ? 'carregando' : carga.erro ? 'erro' : 'pronto';
  const mudou = !mesmaFicha(ficha, gravada);

  const salvar = async () => {
    if (salvando || !podeEditar || estado !== 'pronto') return;
    const erro = erroDaFicha(ficha);
    if (erro) {
      showError(erro);
      return;
    }
    setSalvando(true);
    try {
      const { data } = await api.put<FichaDoCasoLabResposta>(
        `/quotes/${encodeURIComponent(quoteId)}/lab-case`,
        paraCorpo(ficha),
      );
      const f = daResposta(data);
      setFicha(f);
      setGravada(f);
      setHerdadoDe(null);
      showSuccess(LAB_CASO.salvo);
      aoSalvar?.();
    } catch (err) {
      showError(mensagemDoErro(err, LAB_CASO.erros.salvar));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <section className="mx-4 my-3 rounded-xl border border-border bg-background/40">
      <header className="px-3 py-2 flex items-center gap-2 border-b border-border">
        <ClipboardList size={14} className="text-primary" />
        <h4 className="text-sm font-semibold text-foreground">{LAB_CASO.titulo}</h4>
      </header>
      <div className="p-3 space-y-3">
        {estado === 'carregando' ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            {LAB_CASO.carregando}
          </p>
        ) : estado === 'erro' ? (
          <p className="text-xs font-medium text-red-600 dark:text-red-400">{LAB_CASO.erros.carregar}</p>
        ) : (
          <>
            {herdadoDe && (
              <p className="text-[11px] text-blue-700 dark:text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded-lg px-2.5 py-1.5">
                {LAB_CASO.herdado}
              </p>
            )}
            <LabFichaDoCaso
              valor={ficha}
              onChange={setFicha}
              clienteId={clienteId}
              servicoIds={servicoIds}
              somenteLeitura={!podeEditar}
            />
            {podeEditar && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={salvar}
                  disabled={salvando || (!mudou && !herdadoDe)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {salvando ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  {salvando ? LAB_CASO.salvando : LAB_CASO.salvar}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const SELO = 'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border';
const SELO_NEUTRO = `${SELO} text-foreground bg-card border-border`;

/**
 * Ficha do caso de um trabalho aprovado (aba Trabalhos): selos e o botão Editar, que
 * abre o formulário ali mesmo. Quem pode editar sai das permissões aqui dentro
 * (manage_proposals ou create_evaluation), para a aba da clínica não ganhar hook.
 */
export function LabCasoDoTrabalho({
  quoteId,
  clienteId,
  caso,
  servicoIds,
  concluido,
  aoSalvar,
}: {
  quoteId: string;
  clienteId: string;
  caso: FichaDoCasoLabResposta | null;
  servicoIds: readonly string[];
  concluido: boolean;
  aoSalvar?: () => void;
}) {
  const lab = isLab(useBusinessType());
  const ativo = lab || isLab(btAgora());
  const { hasPermission } = useUserPermissions();
  const podeEditar = hasPermission('manage_proposals') || hasPermission('create_evaluation');
  const fichas = useFichasDosServicos(ativo);
  const [editando, setEditando] = useState(false);
  const [abrindo, setAbrindo] = useState(false);
  const [ficha, setFicha] = useState<FichaDoCaso>(FICHA_VAZIA);
  const [salvando, setSalvando] = useState(false);

  const atual = useMemo(() => daResposta(caso), [caso]);
  const chaveDosServicos = servicoIds.join('|');
  const comProva = useMemo(
    () => (chaveDosServicos ? chaveDosServicos.split('|') : []).some((id) => fichas[id]?.has_tryin === true),
    [fichas, chaveDosServicos],
  );

  // caso null = a lista dos casos ainda não chegou (ou falhou): sem selos nem "vazia".
  const vazio = fichaVazia(atual);
  if (!editando && vazio && !comProva && !podeEditar) return null;

  /**
   * O formulário parte da ficha lida AGORA do orçamento (GET /quotes/:id/lab-case): o
   * PUT manda o formulário inteiro, e partir de uma lista velha ou vazia limparia campos.
   */
  const abrir = async () => {
    if (abrindo) return;
    setAbrindo(true);
    try {
      const { data } = await api.get<FichaDoCasoLabResposta>(
        `/quotes/${encodeURIComponent(quoteId)}/lab-case`,
        EM_SEGUNDO_PLANO,
      );
      setFicha(daResposta(data));
      setEditando(true);
    } catch {
      showError(LAB_CASO.erros.carregar);
    } finally {
      setAbrindo(false);
    }
  };

  const salvar = async () => {
    if (salvando || !podeEditar) return;
    const erro = erroDaFicha(ficha);
    if (erro) {
      showError(erro);
      return;
    }
    setSalvando(true);
    try {
      await api.put<FichaDoCasoLabResposta>(`/quotes/${encodeURIComponent(quoteId)}/lab-case`, paraCorpo(ficha));
      showSuccess(LAB_CASO.salvo);
      setEditando(false);
      aoSalvar?.();
    } catch (err) {
      showError(mensagemDoErro(err, LAB_CASO.erros.salvar));
    } finally {
      setSalvando(false);
    }
  };

  if (editando) {
    return (
      <div className="px-4 py-3 border-b border-border bg-background/40 space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardList size={14} className="text-primary" />
          <h4 className="text-sm font-semibold text-foreground flex-1">{LAB_CASO.titulo}</h4>
          <button
            type="button"
            onClick={() => setEditando(false)}
            className="p-1 rounded-full text-muted-foreground hover:bg-accent"
            aria-label={LAB_CASO.fechar}
            title={LAB_CASO.fechar}
          >
            <X size={14} />
          </button>
        </div>
        <LabFichaDoCaso valor={ficha} onChange={setFicha} clienteId={clienteId} servicoIds={servicoIds} />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditando(false)}
            className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-accent"
          >
            {LAB_CASO.fechar}
          </button>
          <button
            type="button"
            onClick={salvar}
            disabled={salvando}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {salvando ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {salvando ? LAB_CASO.salvando : LAB_CASO.salvar}
          </button>
        </div>
      </div>
    );
  }

  const hoje = hojeEmMaceio();
  const faltam = atual.due_date ? diasAte(atual.due_date, hoje) : null;
  const link = atual.external_files_url.trim();

  return (
    <div className="px-4 py-2.5 border-b border-border bg-background/40 flex items-center gap-1.5 flex-wrap">
      <ClipboardList size={13} className="text-primary shrink-0" />
      {caso && vazio && <span className="text-[11px] text-muted-foreground">{LAB_CASO.vazio}</span>}
      {atual.patient_ref && <span className={SELO_NEUTRO}>{LAB_CASO.resumo.pacienteDoCaso(atual.patient_ref)}</span>}
      {atual.requested_by_name && <span className={SELO_NEUTRO}>{LAB_CASO.resumo.dentista(atual.requested_by_name)}</span>}
      {atual.shade && <span className={SELO_NEUTRO}>{LAB_CASO.resumo.cor(atual.shade)}</span>}
      {atual.material && <span className={SELO_NEUTRO}>{LAB_CASO.resumo.material(atual.material)}</span>}
      {atual.due_date && (
        <span
          className={`${SELO} ${
            !concluido && faltam !== null && faltam < 0
              ? 'text-red-700 dark:text-red-400 bg-red-500/10 border-red-500/30'
              : 'text-violet-700 dark:text-violet-300 bg-violet-500/10 border-violet-500/30'
          }`}
        >
          <CalendarClock size={11} />
          {LAB_CASO.resumo.entrega(diaEMes(atual.due_date))}
          {!concluido && faltam !== null && (
            <span className="font-semibold">
              {' · '}
              {faltam > 0
                ? LAB_CASO.resumo.faltam(faltam)
                : faltam === 0
                  ? LAB_CASO.resumo.entregaHoje
                  : LAB_CASO.resumo.atrasada(-faltam)}
            </span>
          )}
        </span>
      )}
      {atual.received_at ? (
        <span className={`${SELO} text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30`}>
          {LAB_CASO.resumo.recebido(formatarYmdBR(atual.received_at))}
        </span>
      ) : (
        !vazio &&
        !concluido && (
          <span className={`${SELO} text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/30`}>
            {LAB_CASO.resumo.aguardando}
          </span>
        )
      )}
      {comProva && <span className={`${SELO} text-sky-700 dark:text-sky-400 bg-sky-500/10 border-sky-500/30`}>{LAB_CASO.resumo.comProva}</span>}
      {linkDoEscaneamentoValido(link) && (
        <a href={link} target="_blank" rel="noopener noreferrer" className={`${SELO} text-primary bg-primary/10 border-primary/30 hover:underline`}>
          {LAB_CASO.resumo.escaneamento}
          <ExternalLink size={11} />
        </a>
      )}
      {podeEditar && (
        <button
          type="button"
          onClick={abrir}
          disabled={abrindo}
          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-[11px] font-semibold hover:bg-accent disabled:opacity-60"
        >
          {abrindo ? <Loader2 size={11} className="animate-spin" /> : <Pencil size={11} />}
          {LAB_CASO.editar}
        </button>
      )}
    </div>
  );
}

/** Selo 'Entrega dd/mm' no card fechado do orçamento (só com entrega prometida). */
export function LabSeloDoCaso({ caso }: { caso: { due_date: string | null } | null | undefined }) {
  const dia = diaEMes(caso?.due_date);
  if (!dia) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border text-violet-700 bg-violet-500/10 border-violet-500/30">
      <CalendarClock size={10} />
      {LAB_CASO.resumo.entrega(dia)}
    </span>
  );
}

/**
 * Ficha do caso da venda rápida (recolhível, opcional). A tela grava depois da venda,
 * com gravarFichaDaVenda(quote_id, ficha).
 */
export function LabFichaDoCasoDaVenda({
  valor,
  onChange,
  clienteId,
  servicoIds,
}: {
  valor: FichaDoCaso;
  onChange: (f: FichaDoCaso) => void;
  clienteId?: string | null;
  servicoIds: readonly string[];
}) {
  const [aberto, setAberto] = useState(() => !fichaVazia(valor));
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setAberto((a) => !a)}
        aria-expanded={aberto}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-dashed border-border text-[11px] font-bold text-muted-foreground hover:border-primary hover:text-primary"
      >
        <span className="inline-flex items-center gap-1.5">
          <ClipboardList size={13} />
          {aberto ? LAB_CASO.venda.recolher : LAB_CASO.venda.abrir}
        </span>
        {aberto ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {aberto && (
        <div className="mt-2 rounded-lg border border-border p-3">
          <LabFichaDoCaso compacto valor={valor} onChange={onChange} clienteId={clienteId} servicoIds={servicoIds} />
        </div>
      )}
    </div>
  );
}
