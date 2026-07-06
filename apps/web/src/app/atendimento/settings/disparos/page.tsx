'use client';

// Onda 17.56 — Central de Disparos (Fase 1, visual — skill "disparos-lembretes").
// Lista AGRUPADA por categoria (não abas). Princípio do skill: "configura aqui,
// opera no Operacional". On/off + métricas dos 5 disparos backed vêm de
// /followup/operacional; os 3 lembretes (1 dia/1h/15 min) são SEPARADOS e cada
// um liga/desliga a própria antecedência via /calendar/reminders/config. Os
// demais aparecem do catálogo como "Em breve". Clicar abre o editor existente.
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft, Loader2, ChevronRight, CalendarClock, Heart, Cake, TrendingUp, Stethoscope, Bot, Wrench, Receipt,
  Briefcase, Wallet,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import {
  CATEGORIAS, DISPAROS, SETORES, CATEGORIA_SETOR,
  type DisparoCategoria, type DisparoItem, type OperacionalKey, type Setor,
} from './disparos.config';
import { DEFAULT_COBRANCA_TEMPLATES, DEFAULT_CONFIRMACAO_PAGAMENTO } from '@crm/shared';
import { RemindersConfigModal } from '../../followup/components/RemindersConfigModal';
import { PosAtendimentoTab } from '../../followup/components/PosAtendimentoTab';
import { DentistSummaryTab } from '../../followup/components/DentistSummaryTab';
import { ConfirmacaoEditor } from './ConfirmacaoEditor';
import { MensagemEditor } from './MensagemEditor';
import { AniversarioEditor } from './AniversarioEditor';
import { TesteEnvio } from './TesteEnvio';

const CAT_ICON: Record<DisparoCategoria, typeof CalendarClock> = {
  agendamento: CalendarClock,
  financeiro: Receipt,
  pos_consulta: Heart,
  datas: Cake,
  recuperacao: TrendingUp,
  clinico: Stethoscope,
};

const SETOR_ICON: Record<Setor, typeof CalendarClock> = {
  comercial: Briefcase,
  clinica: Stethoscope,
  financeiro: Wallet,
};

interface OperacionalData {
  confirmacao?: { enabled: boolean };
  lembrete?: { enabled: boolean };
  pos?: { enabled: boolean };
  dentista?: { enabled: boolean };
  aniversario?: { enabled: boolean };
  reagendamento?: { enabled: boolean };
  // Onda 18.16 — cobrança (flat, casa com enabledOf: op[operacionalKey].enabled)
  boleto_1d_antes?: { enabled: boolean };
  boleto_no_dia?: { enabled: boolean };
  boleto_atraso_1d?: { enabled: boolean };
  boleto_atraso_15d?: { enabled: boolean };
  boleto_atraso_30d?: { enabled: boolean };
  confirmacao_pagamento?: { enabled: boolean };
}
interface Antecedencia { minutes_before: number; channel: string }
interface ReminderConfig { default_antecedencias: Antecedencia[]; templates: Record<string, string> }
// Onda 17.61 — config das 3 mensagens de aniversário (clássica/desejo/presente).
interface BirthdayCfg { enabled?: boolean; message2_enabled?: boolean; message3_enabled?: boolean }
const BIRTHDAY_FIELD: Record<1 | 2 | 3, keyof BirthdayCfg> = { 1: 'enabled', 2: 'message2_enabled', 3: 'message3_enabled' };

export default function CentralDisparosPage() {
  const { isAdmin } = useRole();
  const [op, setOp] = useState<OperacionalData | null>(null);
  const [cfg, setCfg] = useState<ReminderConfig | null>(null);
  const [birthday, setBirthday] = useState<BirthdayCfg | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fixingPhones, setFixingPhones] = useState(false);
  // Onda 17.59 — texto ATUAL do editor aberto (reportado por RemindersConfigModal/
  // MensagemEditor) pro "Enviar teste" testar o que está na tela, sem precisar salvar.
  const [liveText, setLiveText] = useState<string | undefined>(undefined);
  // Some o texto vivo ao trocar de disparo (evita vazar o texto de um editor pro outro).
  useEffect(() => { setLiveText(undefined); }, [openId]);

  const load = useCallback(async () => {
    const [opRes, cfgRes, bdRes] = await Promise.allSettled([
      api.get<OperacionalData>('/followup/operacional'),
      api.get<ReminderConfig>('/calendar/reminders/config'),
      api.get<BirthdayCfg>('/calendar/birthday-greeting/config'),
    ]);
    if (opRes.status === 'fulfilled') setOp(opRes.value.data);
    if (cfgRes.status === 'fulfilled') setCfg(cfgRes.value.data);
    if (bdRes.status === 'fulfilled') setBirthday(bdRes.value.data);
    if (opRes.status === 'rejected' && cfgRes.status === 'rejected') {
      showError('Falha ao carregar os disparos');
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // on/off de um disparo: lembrete = presença da antecedência; aniversário = campo
  // da config das 3 mensagens; resto = Operacional
  const enabledOf = (d: DisparoItem): boolean => {
    if (d.antecedenciaMin != null) {
      return !!cfg?.default_antecedencias?.some((a) => a.minutes_before === d.antecedenciaMin);
    }
    if (d.birthdayMsg != null) {
      return !!birthday?.[BIRTHDAY_FIELD[d.birthdayMsg]];
    }
    return d.operacionalKey && op ? !!(op as any)[d.operacionalKey]?.enabled : false;
  };

  const toggleOperacional = async (k: OperacionalKey, enabled: boolean) => {
    setSaving(k);
    setOp((d) => (d ? { ...d, [k]: { ...(d as any)[k], enabled } } : d));
    try {
      await api.patch('/followup/operacional/toggle', { which: k, enabled });
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível salvar — revertendo');
      setOp((d) => (d ? { ...d, [k]: { ...(d as any)[k], enabled: !enabled } } : d));
    } finally {
      setSaving(null);
    }
  };

  // Liga/desliga UM lembrete = adiciona/remove sua antecedência da config (preserva templates)
  const toggleLembrete = async (min: number, enabled: boolean) => {
    if (!cfg) return;
    const before = cfg;
    const list = cfg.default_antecedencias.filter((a) => a.minutes_before !== min);
    if (enabled) list.push({ minutes_before: min, channel: 'WHATSAPP' });
    list.sort((a, b) => b.minutes_before - a.minutes_before);
    const next: ReminderConfig = { ...cfg, default_antecedencias: list };
    setSaving(`ant_${min}`);
    setCfg(next); // otimista
    try {
      const r = await api.put('/calendar/reminders/config', next);
      if (r.data) setCfg(r.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível salvar — revertendo');
      setCfg(before);
    } finally {
      setSaving(null);
    }
  };

  // Liga/desliga UMA das 3 mensagens de aniversário (campo enabled/message2_enabled/
  // message3_enabled na config) — cada uma independente.
  const toggleBirthday = async (msg: 1 | 2 | 3, enabled: boolean) => {
    const field = BIRTHDAY_FIELD[msg];
    setSaving(`bd_${msg}`);
    setBirthday((b) => ({ ...(b || {}), [field]: enabled })); // otimista
    try {
      const r = await api.put<BirthdayCfg>('/calendar/birthday-greeting/config', { [field]: enabled });
      if (r.data) setBirthday(r.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível salvar — revertendo');
      setBirthday((b) => ({ ...(b || {}), [field]: !enabled }));
    } finally {
      setSaving(null);
    }
  };

  const toggle = (d: DisparoItem, enabled: boolean) => {
    if (d.antecedenciaMin != null) return toggleLembrete(d.antecedenciaMin, enabled);
    if (d.birthdayMsg != null) return toggleBirthday(d.birthdayMsg, enabled);
    if (d.operacionalKey) return toggleOperacional(d.operacionalKey, enabled);
  };

  // Adiciona o +55 nos telefones já salvos sem código de país (pacientes antigos).
  const fixPhones = async () => {
    setFixingPhones(true);
    try {
      const r = await api.post('/patients/backfill-phone-ddi');
      const { patients = 0, leads = 0 } = r.data || {};
      showSuccess(`Telefones corrigidos: ${patients} paciente(s) e ${leads} contato(s) ganharam o +55. Agora os disparos entregam pra eles.`);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao corrigir os telefones');
    } finally {
      setFixingPhones(false);
    }
  };

  // ── Editor (clicou num disparo configurável) — reusa os painéis do Follow-up ──
  const openItem = DISPAROS.find((d) => d.id === openId) || null;
  if (openItem && openItem.editor) {
    // lembrete individual: edita só o texto da sua faixa (1 dia→24h, 1h→1h, 15min→<1h)
    const tplKey: 'consulta_confirmacao' | 'consulta_24h' | 'consulta_1h' | 'consulta_15min' | undefined =
      openItem.antecedenciaMin == null ? undefined
        : openItem.antecedenciaMin >= 2880 ? 'consulta_confirmacao'
        : openItem.antecedenciaMin >= 1440 ? 'consulta_24h'
        : openItem.antecedenciaMin >= 60 ? 'consulta_1h'
        : 'consulta_15min';
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button
          type="button"
          onClick={() => { setOpenId(null); load(); }}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground mb-5"
        >
          <ArrowLeft size={16} /> Voltar aos disparos
        </button>
        {openItem.editor === 'reminders' && <RemindersConfigModal open embedded onClose={() => {}} onlyTemplate={tplKey} itemLabel={openItem.nome} onCurrentTextChange={setLiveText} />}
        {openItem.editor === 'confirmacao' && <ConfirmacaoEditor />}
        {openItem.editor === 'pos' && <PosAtendimentoTab />}
        {openItem.editor === 'dentista' && <DentistSummaryTab />}
        {openItem.editor === 'reagendamento' && (
          <MensagemEditor
            titulo="Mensagem de re-agendamento"
            descricao="Enviada ao paciente quando o horário da consulta muda. Use as variáveis abaixo — o sistema substitui pelos dados reais."
            endpoint="/calendar/appointment-rescheduled/config"
            usaLocal
            variaveis={[
              { key: 'nome', desc: 'Primeiro nome do paciente' },
              { key: 'dentista', desc: 'Profissional' },
              { key: 'data', desc: 'Nova data (DD/MM)' },
              { key: 'hora', desc: 'Novo horário' },
              { key: 'local', desc: 'Endereço da clínica' },
            ]}
            preview={{ nome: 'Felipe', dentista: 'Dra. Suellen', data: '22/06', hora: '15:00' }}
            onCurrentTextChange={setLiveText}
          />
        )}
        {openItem.editor === 'aniversario' && (
          <AniversarioEditor which={openItem.birthdayMsg || 1} onCurrentTextChange={setLiveText} />
        )}
        {openItem.editor === 'cobranca' && openItem.operacionalKey === 'confirmacao_pagamento' && (
          <MensagemEditor
            titulo={openItem.nome}
            descricao="Enviada ao paciente pelo chip Financeiro quando um pagamento é confirmado (automático). Edite e Salve — o robô passa a usar este texto. Deixe em branco pra voltar ao padrão."
            endpoint="/followup/cobranca-template/confirmacao_pagamento"
            variaveis={[
              { key: 'nome', desc: 'Primeiro nome do paciente' },
              { key: 'valor', desc: 'Valor pago (ex.: R$ 350,00)' },
              { key: 'descricao', desc: 'Descrição do pagamento (já vem com parênteses, ou vazio)' },
            ]}
            preview={{ nome: 'Felipe', valor: 'R$ 350,00', descricao: ' (Pix recebido)' }}
            onCurrentTextChange={setLiveText}
            defaultText={DEFAULT_CONFIRMACAO_PAGAMENTO}
          />
        )}
        {openItem.editor === 'cobranca' && openItem.operacionalKey !== 'confirmacao_pagamento' && (
          <MensagemEditor
            titulo={openItem.nome}
            descricao="Enviada ao paciente pelo chip Financeiro quando a cobrança chega neste estágio. Edite o texto e clique em Salvar — o robô passa a usar exatamente esta mensagem. Deixe em branco pra voltar ao texto padrão."
            endpoint={`/followup/cobranca-template/${openItem.operacionalKey}`}
            variaveis={[
              { key: 'nome', desc: 'Primeiro nome do paciente' },
              { key: 'valor', desc: 'Valor da parcela (ex.: R$ 350,00)' },
              { key: 'data', desc: 'Vencimento (DD/MM)' },
              { key: 'link', desc: 'Link do boleto/pix pra pagar' },
            ]}
            preview={{ nome: 'Felipe', valor: 'R$ 350,00', data: '05/07', link: 'https://cobranca.exemplo/boleto' }}
            onCurrentTextChange={setLiveText}
            defaultText={(DEFAULT_COBRANCA_TEMPLATES as Record<string, string>)[openItem.operacionalKey || ''] || ''}
          />
        )}
        <TesteEnvio disparo={openItem.id} text={liveText} />
      </div>
    );
  }

  const configuraveis = DISPAROS.filter((d) => !d.emBreve && (d.operacionalKey || d.antecedenciaMin != null || d.birthdayMsg != null));
  const ativos = configuraveis.filter((d) => enabledOf(d)).length;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Bot size={20} className="text-primary" /> Disparos
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure aqui as mensagens automáticas. Ligar/desligar geral e métricas detalhadas
            ficam no painel Operacional.
          </p>
          <button
            type="button"
            onClick={fixPhones}
            disabled={fixingPhones}
            className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Adiciona o +55 nos telefones de pacientes antigos que estão sem código de país, pra os disparos entregarem."
          >
            {fixingPhones ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
            Corrigir telefones antigos (adicionar +55)
          </button>
        </div>
        <span className="text-xs font-semibold text-muted-foreground bg-muted/50 border border-border rounded-full px-3 py-1.5 whitespace-nowrap">
          {ativos} de {configuraveis.length} ativos
        </span>
      </div>

      {loading ? (
        <div className="py-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin mr-2" /> Carregando…
        </div>
      ) : (
        <div className="space-y-8">
          {SETORES.map((setor) => {
            // Categorias deste setor que têm ao menos 1 disparo no catálogo.
            const cats = CATEGORIAS
              .filter((c) => CATEGORIA_SETOR[c.id] === setor.id)
              .filter((c) => DISPAROS.some((d) => d.categoria === c.id));
            if (cats.length === 0) return null;
            const SetorIcon = SETOR_ICON[setor.id];
            // Setor com 1 categoria só (Comercial/Financeiro) não repete o subtítulo.
            const showCatHeaders = cats.length > 1;
            return (
              <div key={setor.id} className="space-y-3">
                {/* Cabeçalho do SETOR = chip + ênfase do fallback pra Clínica */}
                <div
                  className="flex items-start gap-2.5 rounded-xl border px-4 py-3"
                  style={{ borderColor: setor.color + '33', backgroundColor: setor.color + '0D' }}
                >
                  <span
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                    style={{ backgroundColor: setor.color + '1A', color: setor.color }}
                  >
                    <SetorIcon size={16} />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold" style={{ color: setor.color }}>{setor.label}</span>
                      <span
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border"
                        style={{ borderColor: setor.color + '55', color: setor.color }}
                      >
                        chip {setor.chip}
                      </span>
                      {setor.principal && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                          principal
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{setor.nota}</p>
                  </div>
                </div>

                {cats.map((cat) => {
                  const itens = DISPAROS.filter((d) => d.categoria === cat.id);
                  const CatIcon = CAT_ICON[cat.id];
                  return (
              <section key={cat.id}>
                {showCatHeaders && (
                <h2 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: cat.color }}>
                  {cat.label}
                </h2>
                )}
                <div className="rounded-xl border border-border divide-y divide-border overflow-hidden bg-card">
                  {itens.map((d) => {
                    const clickable = !!d.editor && !d.emBreve;
                    const hasToggle = (!!d.operacionalKey || d.antecedenciaMin != null || d.birthdayMsg != null) && !d.emBreve;
                    const on = enabledOf(d);
                    const savingThis = saving === d.operacionalKey || saving === `ant_${d.antecedenciaMin}` || saving === `bd_${d.birthdayMsg}`;
                    return (
                      <div
                        key={d.id}
                        className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                          clickable ? 'hover:bg-accent/40 cursor-pointer' : ''
                        } ${d.emBreve ? 'opacity-60' : ''}`}
                        onClick={clickable ? () => setOpenId(d.id) : undefined}
                      >
                        <span
                          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                          style={{ backgroundColor: cat.color + '1A', color: cat.color }}
                        >
                          <CatIcon size={16} />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-foreground">{d.nome}</span>
                            {d.tags.map((t) => (
                              <span key={t} className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                {t}
                              </span>
                            ))}
                            {d.emBreve && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                Em breve
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                            {d.gatilho} · {d.canal}
                          </div>
                        </div>
                        {hasToggle && (
                          <label
                            className={`inline-flex items-center ${isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                            onClick={(e) => e.stopPropagation()}
                            title={!isAdmin ? 'Apenas ADMIN pode ligar/desligar' : on ? 'Desligar' : 'Ligar'}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={savingThis || !isAdmin}
                              onChange={(e) => toggle(d, e.target.checked)}
                              className="sr-only peer"
                            />
                            <div className="relative w-9 h-5 bg-muted rounded-full peer peer-focus:ring-2 peer-focus:ring-emerald-500/40 peer-checked:bg-emerald-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border after:border-border after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-4" />
                          </label>
                        )}
                        {/* slot fixo da seta — reservado sempre, pra os toggles alinharem */}
                        <span className="w-4 shrink-0 flex items-center justify-center">
                          {clickable && <ChevronRight size={16} className="text-muted-foreground" />}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
