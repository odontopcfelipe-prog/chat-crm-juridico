'use client';

// Campanha MANUAL — Central de Disparos › setor › "Campanha manual".
// Rascunho (nome, setor/chip, público por filtro, texto, até 3 fotos/áudios) → teste no
// próprio número → iniciar agora ou agendar → acompanhar (pausar/retomar/cancelar).
// O envio segue o ritmo seguro dos automáticos (1 paciente a cada 3–7 min no chip).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Plus, Loader2, Send, Pause, Play, X, Trash2, ImageIcon, Mic, Users, Megaphone, Save, Paperclip, Film,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import {
  CAMPANHA_MAX_MIDIAS, CAMPANHA_MAX_TEXTO, CAMPANHA_SETORES, CAMPANHA_SETOR_LABEL, CAMPANHA_STATUS_LABEL,
  CAMPANHA_VARIAVEIS, planejarEnvio, renderCampanhaTexto,
  type CampanhaFiltros, type CampanhaSetor, type CampanhaStatus,
} from '@crm/shared';

interface Resumo {
  id: string; name: string; setor: CampanhaSetor; status: CampanhaStatus; total: number;
  sent_count: number; failed_count: number; skipped_count: number;
  scheduled_for: string | null; started_at: string | null; completed_at: string | null; created_at: string; pause_reason: string | null;
}
interface Midia { id: string; kind: 'image' | 'audio' | 'video'; mime_type: string; size: number; original_name: string | null; position: number }
interface Detalhe extends Resumo { text: string; filters_json: CampanhaFiltros | null; media: Midia[]; contagem: Record<string, number> }
interface Previa {
  total: number; recebem: number; fora: { motivo: string; n: number }[]; amostra: { nome: string | null; telefone: string | null }[];
  acimaDoLimite: boolean; limite: number; estimativa: string;
}
interface Item { id: string; name: string | null; phone: string; status: string; reason: string | null; sent_at: string | null }

const SETOR_COR: Record<CampanhaSetor, string> = { CLINICA: '#2D7FF9', COMERCIAL: '#F26C1B', FINANCEIRO: '#10B981' };
const STATUS_CLS: Record<CampanhaStatus, string> = {
  RASCUNHO: 'bg-muted text-muted-foreground',
  AGENDADA: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  ENVIANDO: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  PAUSADA: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  CONCLUIDA: 'bg-primary/10 text-primary',
  CANCELADA: 'bg-red-500/10 text-red-600 dark:text-red-400',
};
const ITEM_LABEL: Record<string, { label: string; cls: string }> = {
  PENDENTE: { label: 'na fila', cls: 'text-muted-foreground' },
  ENVIANDO: { label: 'enviando', cls: 'text-sky-600' },
  ENVIADO: { label: 'enviado', cls: 'text-emerald-600 dark:text-emerald-400' },
  FALHOU: { label: 'falhou', cls: 'text-red-500' },
  PULADO: { label: 'pulado', cls: 'text-amber-600' },
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Maceio' }) : '—');
const lerUrl = () => {
  if (typeof window === 'undefined') return { setor: null as string | null, id: null as string | null };
  const q = new URLSearchParams(window.location.search);
  return { setor: q.get('setor'), id: q.get('id') };
};
const gravarUrl = (setor: string | null, id: string | null) => {
  const q = new URLSearchParams();
  if (setor) q.set('setor', setor);
  if (id) q.set('id', id);
  window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
};

export default function CampanhasPage() {
  const { isAdmin } = useRole();
  const [setor, setSetor] = useState<CampanhaSetor | null>(null);
  const [lista, setLista] = useState<Resumo[] | null>(null);
  const [abertaId, setAbertaId] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);

  useEffect(() => {
    const u = lerUrl();
    if (u.setor && (CAMPANHA_SETORES as readonly string[]).includes(u.setor)) setSetor(u.setor as CampanhaSetor);
    if (u.id) setAbertaId(u.id);
  }, []);

  const carregar = useCallback(async () => {
    try {
      const r = await api.get<Resumo[]>('/campanhas', { params: setor ? { setor } : {} });
      setLista(r.data || []);
    } catch (e: any) {
      setLista([]);
      showError(e?.response?.data?.message || 'Falha ao carregar as campanhas');
    }
  }, [setor]);
  useEffect(() => { if (!abertaId) carregar(); }, [carregar, abertaId]);

  const abrir = (id: string | null) => { setAbertaId(id); gravarUrl(setor, id); };

  const nova = async () => {
    setCriando(true);
    try {
      const r = await api.post<Detalhe>('/campanhas', { setor: setor || 'CLINICA', name: 'Nova campanha' });
      abrir(r.data.id);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível criar a campanha');
    } finally {
      setCriando(false);
    }
  };

  if (!isAdmin) {
    return <div className="p-6 max-w-3xl mx-auto text-sm text-muted-foreground">Só o ADM da clínica cria e envia campanhas.</div>;
  }
  if (abertaId) return <CampanhaAberta id={abertaId} onVoltar={() => abrir(null)} />;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <Link href="/atendimento/settings/disparos" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft size={16} /> Voltar aos disparos
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><Megaphone size={20} className="text-primary" /> Campanhas manuais</h1>
          <p className="text-[12px] text-muted-foreground mt-1 max-w-2xl">
            Envio avulso pra um grupo de pacientes, pelo chip do setor escolhido, com texto, fotos e áudio. Sai no ritmo seguro
            (1 paciente a cada 3–7 min, seg–sáb 9h–18h, fora de feriado) e pula quem pediu pra não receber.
          </p>
        </div>
        <button
          onClick={nova}
          disabled={criando}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {criando ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Nova campanha
        </button>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {([null, ...CAMPANHA_SETORES] as (CampanhaSetor | null)[]).map((s) => (
          <button
            key={s ?? 'todos'}
            onClick={() => { setSetor(s); gravarUrl(s, null); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${setor === s ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground hover:text-foreground'}`}
          >
            {s ? CAMPANHA_SETOR_LABEL[s] : 'Todos os setores'}
          </button>
        ))}
      </div>

      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        {lista === null ? (
          <div className="py-10 flex justify-center text-muted-foreground"><Loader2 size={18} className="animate-spin" /></div>
        ) : lista.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">Nenhuma campanha ainda. Clique em “Nova campanha”.</div>
        ) : (
          <div className="divide-y divide-border">
            {lista.map((c) => {
              const feitos = c.sent_count + c.failed_count + c.skipped_count;
              return (
                <button key={c.id} onClick={() => abrir(c.id)} className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-accent/40">
                  <span className="w-2 h-8 rounded-full shrink-0" style={{ backgroundColor: SETOR_COR[c.setor] }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold truncate">{c.name}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_CLS[c.status]}`}>{CAMPANHA_STATUS_LABEL[c.status]}</span>
                      <span className="text-[10px] text-muted-foreground">chip {CAMPANHA_SETOR_LABEL[c.setor]}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {c.status === 'RASCUNHO' ? `criada ${fmt(c.created_at)}` : `${feitos}/${c.total} · ${c.sent_count} enviados${c.failed_count ? ` · ${c.failed_count} falhas` : ''}${c.skipped_count ? ` · ${c.skipped_count} pulados` : ''}`}
                      {c.status === 'AGENDADA' && c.scheduled_for ? ` · começa ${fmt(c.scheduled_for)}` : ''}
                      {c.status === 'PAUSADA' && c.pause_reason ? ` · ${c.pause_reason}` : ''}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CampanhaAberta({ id, onVoltar }: { id: string; onVoltar: () => void }) {
  const [c, setC] = useState<Detalhe | null>(null);
  const carregar = useCallback(async () => {
    try {
      const r = await api.get<Detalhe>(`/campanhas/${id}`);
      setC(r.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Campanha não encontrada');
      onVoltar();
    }
  }, [id, onVoltar]);
  useEffect(() => { carregar(); }, [carregar]);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <button type="button" onClick={onVoltar} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft size={16} /> Voltar às campanhas
      </button>
      {!c ? (
        <div className="py-12 flex justify-center text-muted-foreground"><Loader2 size={18} className="animate-spin" /></div>
      ) : c.status === 'RASCUNHO' ? (
        <Editor c={c} setC={setC} onExcluida={onVoltar} />
      ) : (
        <Acompanhamento c={c} setC={setC} recarregar={carregar} />
      )}
    </div>
  );
}

// ─── Rascunho ───────────────────────────────────────────────────────────────

function Editor({ c, setC, onExcluida }: { c: Detalhe; setC: (d: Detalhe) => void; onExcluida: () => void }) {
  const [name, setName] = useState(c.name);
  const [setor, setSetor] = useState<CampanhaSetor>(c.setor);
  const [text, setText] = useState(c.text);
  const [filtros, setFiltros] = useState<CampanhaFiltros>(c.filters_json || {});
  const [tags, setTags] = useState<{ id: string; name: string; color?: string | null }[]>([]);
  const [dentistas, setDentistas] = useState<{ id: string; name: string }[]>([]);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [carregandoPrevia, setCarregandoPrevia] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [enviandoArquivo, setEnviandoArquivo] = useState(false);
  const [telefoneTeste, setTelefoneTeste] = useState('');
  const [testando, setTestando] = useState(false);
  const [quando, setQuando] = useState<'agora' | 'agendar'>('agora');
  const [agendarPara, setAgendarPara] = useState('');
  const [iniciando, setIniciando] = useState(false);
  const inputArquivo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get('/patient-tags').then((r) => setTags(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    api.get('/users/lawyers').then((r) => setDentistas(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  // Prévia do público (com folga pra não chamar a cada tecla).
  useEffect(() => {
    const t = setTimeout(async () => {
      setCarregandoPrevia(true);
      try {
        const r = await api.post<Previa>('/campanhas/publico/previa', { filters: filtros });
        setPrevia(r.data);
      } catch {
        setPrevia(null);
      } finally {
        setCarregandoPrevia(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [filtros]);

  const salvar = async (silencioso = false): Promise<boolean> => {
    setSalvando(true);
    try {
      const r = await api.patch(`/campanhas/${c.id}`, { name, setor, text, filters: filtros });
      setC({ ...c, ...r.data, media: c.media, contagem: c.contagem });
      if (!silencioso) showSuccess('Rascunho salvo');
      return true;
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao salvar');
      return false;
    } finally {
      setSalvando(false);
    }
  };

  const anexar = async (files: FileList | null) => {
    if (!files?.length) return;
    setEnviandoArquivo(true);
    let media = c.media;
    try {
      for (const file of Array.from(files)) {
        if (media.length >= CAMPANHA_MAX_MIDIAS) { showError(`Máximo de ${CAMPANHA_MAX_MIDIAS} anexos`); break; }
        const fd = new FormData();
        fd.append('file', file);
        const r = await api.post<Midia>(`/campanhas/${c.id}/midias`, fd, { timeout: 120000 });
        media = [...media, r.data];
        setC({ ...c, media });
      }
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao anexar');
    } finally {
      setEnviandoArquivo(false);
      if (inputArquivo.current) inputArquivo.current.value = '';
    }
  };

  const removerAnexo = async (mid: string) => {
    try {
      await api.delete(`/campanhas/${c.id}/midias/${mid}`);
      setC({ ...c, media: c.media.filter((m) => m.id !== mid) });
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao remover');
    }
  };

  const testar = async () => {
    if (!(await salvar(true))) return;
    setTestando(true);
    try {
      const r = await api.post(`/campanhas/${c.id}/teste`, { telefone: telefoneTeste }, { timeout: 180000 });
      showSuccess(r.data?.avisos?.length ? `Enviado, com aviso: ${r.data.avisos.join('; ')}` : 'Teste enviado — confira no WhatsApp');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'O teste não saiu');
    } finally {
      setTestando(false);
    }
  };

  const iniciar = async () => {
    if (!(await salvar(true))) return;
    if (quando === 'agendar' && !agendarPara) { showError('Escolha a data e a hora'); return; }
    const n = previa?.recebem ?? 0;
    const msg = quando === 'agendar'
      ? `Agendar a campanha "${name}" pra ${n} paciente(s), pelo chip ${CAMPANHA_SETOR_LABEL[setor]}, a partir de ${new Date(agendarPara).toLocaleString('pt-BR')}?`
      : `Começar agora a campanha "${name}" pra ${n} paciente(s), pelo chip ${CAMPANHA_SETOR_LABEL[setor]}?\n\nSai no ritmo seguro (${previa?.estimativa || ''}). Dá pra pausar ou cancelar depois.`;
    if (!window.confirm(msg)) return;
    setIniciando(true);
    try {
      const r = await api.post<Detalhe>(`/campanhas/${c.id}/iniciar`, {
        agendar_para: quando === 'agendar' ? new Date(agendarPara).toISOString() : null,
      }, { timeout: 120000 });
      showSuccess(quando === 'agendar' ? 'Campanha agendada' : 'Campanha iniciada');
      setC(r.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível iniciar');
    } finally {
      setIniciando(false);
    }
  };

  const excluir = async () => {
    if (!window.confirm('Excluir este rascunho?')) return;
    try {
      await api.delete(`/campanhas/${c.id}`);
      onExcluida();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao excluir');
    }
  };

  const passos = useMemo(
    () => planejarEnvio(renderCampanhaTexto(text, { nome: 'Ana', nome_completo: 'Ana Souza', clinica: 'sua clínica' }),
      c.media.map((m) => ({ id: m.id, tipo: m.kind, posicao: m.position }))),
    [text, c.media],
  );
  const toggleTag = (tid: string) =>
    setFiltros((f) => {
      const atual = f.tagIds || [];
      return { ...f, tagIds: atual.includes(tid) ? atual.filter((x) => x !== tid) : [...atual, tid] };
    });

  return (
    <div className="space-y-4">
      <Bloco titulo="1. Campanha">
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-[12px] font-semibold space-y-1">
            <span>Nome (só pra você identificar)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg" />
          </label>
          <div className="text-[12px] font-semibold space-y-1">
            <span>Setor (chip que envia)</span>
            <div className="flex gap-1.5">
              {CAMPANHA_SETORES.map((s) => (
                <button key={s} type="button" onClick={() => setSetor(s)}
                  className={`flex-1 px-2 py-2 rounded-lg text-xs font-semibold border ${setor === s ? 'text-white' : 'bg-background border-border text-muted-foreground'}`}
                  style={setor === s ? { backgroundColor: SETOR_COR[s], borderColor: SETOR_COR[s] } : undefined}>
                  {CAMPANHA_SETOR_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Bloco>

      <Bloco titulo="2. Quem recebe (pacientes)" icone={<Users size={15} className="text-primary" />}>
        <div className="space-y-3 text-[12px]">
          <div>
            <div className="font-semibold mb-1">Tags (qualquer uma)</div>
            {tags.length === 0 ? <div className="text-muted-foreground">Nenhuma tag cadastrada.</div> : (
              <div className="flex gap-1.5 flex-wrap">
                {tags.map((t) => {
                  const on = filtros.tagIds?.includes(t.id);
                  return (
                    <button key={t.id} type="button" onClick={() => toggleTag(t.id)}
                      className={`px-2 py-1 rounded-full border text-[11px] font-semibold ${on ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border text-muted-foreground'}`}>
                      {t.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="font-semibold">Situação</span>
              <select value={filtros.atividade || ''} onChange={(e) => setFiltros((f) => ({ ...f, atividade: (e.target.value || null) as any }))}
                className="w-full px-2 py-2 bg-background border border-border rounded-lg">
                <option value="">Todos (menos arquivados)</option>
                <option value="ACTIVE">Ativos (atendidos nos últimos 12 meses)</option>
                <option value="INACTIVE">Inativos (+12 meses sem atendimento)</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-semibold">Sem visita há (meses)</span>
              <input type="number" min={1} max={120} value={filtros.semVisitaMeses ?? ''} placeholder="qualquer"
                onChange={(e) => setFiltros((f) => ({ ...f, semVisitaMeses: e.target.value ? Number(e.target.value) : null }))}
                className="w-full px-2 py-2 bg-background border border-border rounded-lg" />
            </label>
            <label className="space-y-1">
              <span className="font-semibold">Dentista</span>
              <select value={filtros.dentistaId || ''} onChange={(e) => setFiltros((f) => ({ ...f, dentistaId: e.target.value || null }))}
                className="w-full px-2 py-2 bg-background border border-border rounded-lg">
                <option value="">Qualquer</option>
                {dentistas.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          </div>
          <div className="flex gap-4 flex-wrap">
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={!!filtros.comTratamentoAtivo} onChange={(e) => setFiltros((f) => ({ ...f, comTratamentoAtivo: e.target.checked }))} />
              Com tratamento em andamento
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={!!filtros.aniversariantesDoMes} onChange={(e) => setFiltros((f) => ({ ...f, aniversariantesDoMes: e.target.checked }))} />
              Aniversariantes do mês
            </label>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            {carregandoPrevia && !previa ? <Loader2 size={14} className="animate-spin" /> : previa ? (
              <div className="space-y-1.5">
                <div className="text-sm">
                  <b className="text-foreground">{previa.recebem}</b> paciente(s) recebem
                  {previa.fora.length > 0 && <span className="text-muted-foreground"> · fora: {previa.fora.map((f) => `${f.n} ${f.motivo}`).join(', ')}</span>}
                  {previa.recebem > 0 && <span className="text-muted-foreground"> · leva {previa.estimativa}</span>}
                  {carregandoPrevia && <Loader2 size={12} className="inline animate-spin ml-2" />}
                </div>
                {previa.acimaDoLimite && (
                  <div className="text-red-500 font-semibold">Acima do limite de {previa.limite} por campanha — refine os filtros.</div>
                )}
                {previa.amostra.length > 0 && (
                  <div className="text-[11px] text-muted-foreground">
                    Ex.: {previa.amostra.slice(0, 8).map((a) => a.nome).filter(Boolean).join(', ')}{previa.recebem > 8 ? '…' : ''}
                  </div>
                )}
              </div>
            ) : <span className="text-muted-foreground">Não foi possível calcular agora.</span>}
          </div>
        </div>
      </Bloco>

      <Bloco titulo="3. Mensagem">
        <div className="space-y-3">
          <div className="flex gap-3 flex-wrap text-[11px]">
            {CAMPANHA_VARIAVEIS.map((v) => (
              <span key={v.key} className="text-muted-foreground">
                <code className="font-mono text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">{`{${v.key}}`}</code> {v.desc}
              </span>
            ))}
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} maxLength={CAMPANHA_MAX_TEXTO}
            placeholder="Oi, {nome}! Aqui é da equipe {clinica}…"
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg resize-y" />
          <div className="text-[10px] text-muted-foreground">{text.length}/{CAMPANHA_MAX_TEXTO} caracteres</div>
        </div>
      </Bloco>

      <Bloco titulo={`4. Fotos, vídeos e áudio (até ${CAMPANHA_MAX_MIDIAS})`} icone={<Paperclip size={15} className="text-primary" />}>
        <div className="space-y-3">
          <div className="flex gap-3 flex-wrap">
            {c.media.map((m) => <AnexoCard key={m.id} campanhaId={c.id} m={m} onRemover={() => removerAnexo(m.id)} />)}
            {c.media.length < CAMPANHA_MAX_MIDIAS && (
              <button type="button" onClick={() => inputArquivo.current?.click()} disabled={enviandoArquivo}
                className="w-32 h-32 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground hover:bg-accent/40 disabled:opacity-50">
                {enviandoArquivo ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                Foto, vídeo ou áudio
              </button>
            )}
          </div>
          <input ref={inputArquivo} type="file" multiple className="hidden"
            accept="image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/ogg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/webm"
            onChange={(e) => anexar(e.target.files)} />
          <p className="text-[11px] text-muted-foreground">Fotos JPG/PNG/WEBP até 5 MB · vídeo MP4 até 16 MB (o .MOV do iPhone: compartilhe como MP4) · áudio MP3/OGG/M4A/WAV até 16 MB (chega como mensagem de voz).</p>
        </div>
      </Bloco>

      <Bloco titulo="Como o paciente recebe" icone={<Megaphone size={15} className="text-primary" />}>
        {passos.length === 0 ? <div className="text-[12px] text-muted-foreground">Escreva a mensagem ou anexe uma foto/áudio.</div> : (
          <div className="space-y-2">
            {passos.map((p, i) => (
              <div key={i} className="max-w-md rounded-xl bg-emerald-500/5 border border-emerald-500/20 px-3 py-2 text-xs whitespace-pre-wrap">
                {p.tipo === 'texto' && p.texto}
                {p.tipo === 'image' && (<><div className="flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400 mb-1"><ImageIcon size={12} /> Foto {c.media.filter((m) => m.kind === 'image').findIndex((m) => m.id === p.midiaId) + 1}</div>{p.legenda}</>)}
                {p.tipo === 'video' && (<><div className="flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400 mb-1"><Film size={12} /> Vídeo {c.media.filter((m) => m.kind === 'video').findIndex((m) => m.id === p.midiaId) + 1}</div>{p.legenda}</>)}
                {p.tipo === 'audio' && <span className="flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400"><Mic size={12} /> Mensagem de voz</span>}
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">Exemplo com a paciente “Ana”. Cada paciente recebe com o próprio nome.</p>
          </div>
        )}
      </Bloco>

      <Bloco titulo="5. Teste e envio">
        <div className="space-y-4 text-[12px]">
          <div className="flex gap-2 items-end flex-wrap">
            <label className="space-y-1">
              <span className="font-semibold">Mandar um teste pro número</span>
              <input value={telefoneTeste} onChange={(e) => setTelefoneTeste(e.target.value)} placeholder="82 99999-8888"
                className="w-48 px-3 py-2 bg-background border border-border rounded-lg" />
            </label>
            <button type="button" onClick={testar} disabled={testando || telefoneTeste.replace(/\D/g, '').length < 10}
              className="inline-flex items-center gap-1.5 px-3 py-2 font-semibold border border-border rounded-lg hover:bg-accent disabled:opacity-50">
              {testando ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Enviar teste
            </button>
          </div>
          <div className="space-y-2">
            <div className="flex gap-4">
              <label className="inline-flex items-center gap-1.5"><input type="radio" checked={quando === 'agora'} onChange={() => setQuando('agora')} /> Começar agora</label>
              <label className="inline-flex items-center gap-1.5"><input type="radio" checked={quando === 'agendar'} onChange={() => setQuando('agendar')} /> Agendar</label>
              {quando === 'agendar' && (
                <input type="datetime-local" value={agendarPara} onChange={(e) => setAgendarPara(e.target.value)}
                  className="px-2 py-1 bg-background border border-border rounded-lg" />
              )}
            </div>
            <p className="text-muted-foreground">A lista de quem recebe é fechada ao iniciar. Envia seg–sáb 9h–18h, fora de feriado; dá pra pausar ou cancelar.</p>
          </div>
          <div className="flex gap-2 justify-between flex-wrap">
            <button type="button" onClick={excluir} className="inline-flex items-center gap-1.5 px-3 py-2 text-red-500 hover:bg-red-500/10 rounded-lg">
              <Trash2 size={13} /> Excluir rascunho
            </button>
            <div className="flex gap-2">
              <button type="button" onClick={() => salvar()} disabled={salvando}
                className="inline-flex items-center gap-1.5 px-4 py-2 font-semibold border border-border rounded-lg hover:bg-accent disabled:opacity-50">
                {salvando ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Salvar rascunho
              </button>
              <button type="button" onClick={iniciar} disabled={iniciando || !previa?.recebem || !!previa?.acimaDoLimite}
                className="inline-flex items-center gap-1.5 px-4 py-2 font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
                {iniciando ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {quando === 'agendar' ? 'Agendar campanha' : 'Iniciar campanha'}
              </button>
            </div>
          </div>
        </div>
      </Bloco>
    </div>
  );
}

function AnexoCard({ campanhaId, m, onRemover }: { campanhaId: string; m: Midia; onRemover: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    let criada: string | null = null;
    api.get(`/campanhas/${campanhaId}/midias/${m.id}/arquivo`, { responseType: 'blob' })
      .then((r) => { if (vivo) { criada = URL.createObjectURL(r.data); setUrl(criada); } })
      .catch(() => {});
    return () => { vivo = false; if (criada) URL.revokeObjectURL(criada); };
  }, [campanhaId, m.id]);
  return (
    <div className="relative w-32 h-32 rounded-xl border border-border overflow-hidden bg-muted/30 flex items-center justify-center">
      {m.kind === 'video'
        ? (url ? <video src={url} controls muted playsInline className="w-full h-full object-cover bg-black" /> : <Film size={20} className="text-muted-foreground" />)
        : m.kind === 'image'
        ? (url ? <img src={url} alt={m.original_name || 'foto'} className="w-full h-full object-cover" /> : <ImageIcon size={20} className="text-muted-foreground" />)
        : (
          <div className="flex flex-col items-center gap-1 px-2 w-full">
            <Mic size={20} className="text-primary" />
            <span className="text-[10px] text-muted-foreground truncate w-full text-center">{m.original_name || 'áudio'}</span>
            {url && <audio src={url} controls className="w-full h-7" />}
          </div>
        )}
      <button type="button" onClick={onRemover} title="Remover"
        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-background/90 border border-border flex items-center justify-center hover:bg-red-500 hover:text-white">
        <X size={12} />
      </button>
    </div>
  );
}

// ─── Acompanhamento ─────────────────────────────────────────────────────────

function Acompanhamento({ c, setC, recarregar }: { c: Detalhe; setC: (d: Detalhe) => void; recarregar: () => Promise<void> }) {
  const [itens, setItens] = useState<Item[] | null>(null);
  const [filtro, setFiltro] = useState<string>('');
  const [acao, setAcao] = useState<string | null>(null);

  const carregarItens = useCallback(async () => {
    try {
      const r = await api.get<Item[]>(`/campanhas/${c.id}/itens`, { params: filtro ? { status: filtro } : {} });
      setItens(r.data || []);
    } catch {
      setItens([]);
    }
  }, [c.id, filtro]);
  useEffect(() => { carregarItens(); }, [carregarItens]);
  // Enquanto envia, atualiza sozinho a cada 30 s.
  useEffect(() => {
    if (c.status !== 'ENVIANDO' && c.status !== 'AGENDADA') return;
    const t = setInterval(() => { recarregar(); carregarItens(); }, 30000);
    return () => clearInterval(t);
  }, [c.status, recarregar, carregarItens]);

  const fazer = async (qual: 'pausar' | 'retomar' | 'cancelar') => {
    if (qual === 'cancelar' && !window.confirm('Cancelar a campanha? Quem ainda não recebeu não recebe mais.')) return;
    setAcao(qual);
    try {
      const r = await api.post<Detalhe>(`/campanhas/${c.id}/${qual}`);
      setC(r.data);
      carregarItens();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível');
    } finally {
      setAcao(null);
    }
  };

  const feitos = c.sent_count + c.failed_count + c.skipped_count;
  const pct = c.total ? Math.round((feitos / c.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-bold">{c.name}</h1>
            <div className="text-[12px] text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_CLS[c.status]}`}>{CAMPANHA_STATUS_LABEL[c.status]}</span>
              chip {CAMPANHA_SETOR_LABEL[c.setor]}
              {c.status === 'AGENDADA' && c.scheduled_for && <> · começa {fmt(c.scheduled_for)}</>}
              {c.started_at && <> · iniciada {fmt(c.started_at)}</>}
              {c.completed_at && <> · terminou {fmt(c.completed_at)}</>}
            </div>
            {c.status === 'PAUSADA' && c.pause_reason && <div className="text-[12px] text-amber-600 font-semibold mt-1">{c.pause_reason}</div>}
          </div>
          <div className="flex gap-2">
            {(c.status === 'ENVIANDO' || c.status === 'AGENDADA') && (
              <button onClick={() => fazer('pausar')} disabled={!!acao} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-border rounded-lg hover:bg-accent disabled:opacity-50">
                {acao === 'pausar' ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />} Pausar
              </button>
            )}
            {c.status === 'PAUSADA' && (
              <button onClick={() => fazer('retomar')} disabled={!!acao} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg disabled:opacity-50">
                {acao === 'retomar' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Retomar
              </button>
            )}
            {(c.status === 'ENVIANDO' || c.status === 'AGENDADA' || c.status === 'PAUSADA') && (
              <button onClick={() => fazer('cancelar')} disabled={!!acao} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-500 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">
                {acao === 'cancelar' ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} Cancelar
              </button>
            )}
          </div>
        </div>
        <div>
          <div className="h-2 rounded-full bg-muted overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {feitos}/{c.total} · <b className="text-emerald-600 dark:text-emerald-400">{c.sent_count} enviados</b>
            {c.failed_count ? <> · <b className="text-red-500">{c.failed_count} falhas</b></> : null}
            {c.skipped_count ? <> · {c.skipped_count} pulados</> : null}
          </div>
        </div>
        {c.text && <div className="text-xs whitespace-pre-wrap rounded-xl bg-muted/30 border border-border p-3">{c.text}</div>}
        {c.media.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            Anexos: {c.media.map((m) => (m.kind === 'image' ? '📷 foto' : m.kind === 'video' ? '🎬 vídeo' : '🎙️ áudio')).join(' · ')}
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        <div className="border-b border-border px-5 py-3 flex items-center gap-1.5 flex-wrap">
          {[['', 'Todos'], ['PENDENTE', 'Na fila'], ['ENVIADO', 'Enviados'], ['FALHOU', 'Falhas'], ['PULADO', 'Pulados']].map(([k, l]) => (
            <button key={k} onClick={() => setFiltro(k)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold ${filtro === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}>
              {l}{k && c.contagem?.[k] ? ` (${c.contagem[k]})` : ''}
            </button>
          ))}
        </div>
        {itens === null ? (
          <div className="py-8 flex justify-center text-muted-foreground"><Loader2 size={16} className="animate-spin" /></div>
        ) : itens.length === 0 ? (
          <div className="px-5 py-6 text-[12px] text-muted-foreground">Ninguém aqui.</div>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto divide-y divide-border">
            {itens.map((it) => {
              const st = ITEM_LABEL[it.status] || ITEM_LABEL.PENDENTE;
              return (
                <div key={it.id} className="px-5 py-2 flex items-center gap-3 text-[12px]">
                  <span className="font-semibold truncate min-w-0 flex-1">{it.name || '(sem nome)'}</span>
                  <span className="text-muted-foreground tabular-nums hidden sm:inline">{it.phone}</span>
                  {it.reason && <span className="text-[10px] text-muted-foreground truncate max-w-[14rem]" title={it.reason}>{it.reason}</span>}
                  <span className="text-muted-foreground tabular-nums w-20 text-right">{it.sent_at ? fmt(it.sent_at) : ''}</span>
                  <span className={`font-semibold w-16 text-right ${st.cls}`}>{st.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Bloco({ titulo, icone, children }: { titulo: string; icone?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="border-b border-border px-5 py-3 flex items-center gap-2">
        {icone}
        <h2 className="text-sm font-bold">{titulo}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
