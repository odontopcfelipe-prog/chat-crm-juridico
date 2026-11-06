'use client';

/**
 * Tela de IA da conta de laboratório: liga/desliga por chip, perfil por chip, horário,
 * robô dos administradores, teste de conversa e o custo da própria conta. Skill, chave,
 * preço e modelo são da plataforma e não aparecem aqui. A clínica não passa por este
 * arquivo (ver AiSettingsPage).
 */
import { useCallback, useEffect, useState } from 'react';
import { Bot, Clock, MessageCircle, Power, RotateCcw, Send, Wallet } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { AI_CHIP_PURPOSES, AI_REPLY_LENGTHS, WEEK_ROWS, apiErrorMessage, type AiChipPurpose, type AiReplyLength, type ClinicHours } from './clinic-hours';
import { LAB_IA_TELA as T } from './lab-ia-textos';

const CAMPO = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
const CARTAO = 'rounded-xl border border-border bg-card p-4 space-y-3';
const BOTAO = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50';

interface PerfilDoChip {
  assistantName: string;
  signature: boolean;
  replyLength: AiReplyLength;
  responseDelaySec: number | null;
  instructions: string;
  enabled?: boolean;
}

function moeda(usd: number, cotacao: number): string {
  const brl = (Number(usd) || 0) * (Number(cotacao) || 0);
  return brl.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function Chave({ ligada, desabilitada, aoMudar }: { ligada: boolean; desabilitada: boolean; aoMudar: () => void }) {
  return (
    <button
      type="button"
      onClick={aoMudar}
      disabled={desabilitada}
      className={`${BOTAO} border ${ligada ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' : 'border-border bg-muted/40 text-muted-foreground'}`}
    >
      <Power size={13} />
      {ligada ? T.desligar : T.ligar}
    </button>
  );
}

function CartaoDoChip({
  purpose,
  perfil,
  contaAtiva,
  aoSalvar,
}: {
  purpose: AiChipPurpose;
  perfil: PerfilDoChip;
  contaAtiva: boolean;
  aoSalvar: (p: PerfilDoChip) => void;
}) {
  const [form, setForm] = useState<PerfilDoChip>(perfil);
  const [salvando, setSalvando] = useState(false);
  useEffect(() => setForm(perfil), [perfil]);
  const canal = T.canais[purpose];

  const alternar = async () => {
    const proximo = !form.enabled;
    setSalvando(true);
    try {
      await api.post('/settings/ai-chip-toggle', { purpose, enabled: proximo });
      aoSalvar({ ...form, enabled: proximo });
    } catch (e) {
      showError(apiErrorMessage(e, T.erroSalvar));
    } finally {
      setSalvando(false);
    }
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      const { data } = await api.put(`/settings/ai-profile/chip/${purpose}`, {
        assistantName: form.assistantName,
        signature: form.signature,
        replyLength: form.replyLength,
        responseDelaySec: form.responseDelaySec,
        instructions: form.instructions,
      });
      aoSalvar({ ...form, ...data });
      showSuccess(T.salvo);
    } catch (e) {
      showError(apiErrorMessage(e, T.erroSalvar));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <section className={CARTAO}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {canal.nome}{' '}
            <span className={`ml-1 text-[11px] font-medium ${form.enabled ? 'text-emerald-600' : 'text-muted-foreground'}`}>
              {form.enabled ? T.ligada : T.desligada}
            </span>
          </h3>
          <p className="text-xs text-muted-foreground">{canal.ajuda}</p>
        </div>
        <Chave ligada={!!form.enabled} desabilitada={salvando || (!contaAtiva && !form.enabled)} aoMudar={alternar} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium">
          {T.nome}
          <input
            className={CAMPO}
            maxLength={40}
            placeholder={T.nomePlaceholder}
            value={form.assistantName}
            onChange={(e) => setForm({ ...form, assistantName: e.target.value })}
          />
        </label>
        <label className="space-y-1 text-xs font-medium">
          {T.tamanho}
          <select
            className={CAMPO}
            value={form.replyLength}
            onChange={(e) => setForm({ ...form, replyLength: e.target.value as AiReplyLength })}
          >
            {AI_REPLY_LENGTHS.map((t) => (
              <option key={t} value={t}>
                {T.tamanhos[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium">
          {T.espera}
          <input
            className={CAMPO}
            type="number"
            min={0}
            max={60}
            placeholder={T.esperaPlaceholder}
            value={form.responseDelaySec ?? ''}
            onChange={(e) => setForm({ ...form, responseDelaySec: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium">
          <input type="checkbox" checked={form.signature} onChange={(e) => setForm({ ...form, signature: e.target.checked })} />
          {T.assinatura}
        </label>
      </div>
      <label className="block space-y-1 text-xs font-medium">
        {T.instrucoes}
        <textarea
          className={CAMPO}
          rows={3}
          maxLength={2000}
          placeholder={T.instrucoesPlaceholder}
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
        />
      </label>
      <button type="button" onClick={salvar} disabled={salvando} className={`${BOTAO} bg-primary text-primary-foreground`}>
        {salvando ? T.salvando : T.salvar}
      </button>
    </section>
  );
}

function CartaoDoHorario({ inicial }: { inicial: ClinicHours | null }) {
  const [horas, setHoras] = useState<ClinicHours>(inicial ?? { days: {} });
  const [salvando, setSalvando] = useState(false);

  const salvar = async () => {
    setSalvando(true);
    try {
      await api.put('/settings/ai-profile/clinic', { hours: horas });
      showSuccess(T.salvo);
    } catch (e) {
      showError(apiErrorMessage(e, T.erroSalvar));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <section className={CARTAO}>
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Clock size={14} /> {T.horarioTitulo}
        </h3>
        <p className="text-xs text-muted-foreground">{T.horarioAjuda}</p>
      </div>
      <div className="space-y-2">
        {WEEK_ROWS.map(({ key, label }) => {
          const dia = horas.days[key];
          return (
            <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex w-24 items-center gap-1.5 font-medium">
                <input
                  type="checkbox"
                  checked={!!dia}
                  onChange={(e) =>
                    setHoras({
                      days: { ...horas.days, [key]: e.target.checked ? { open: '08:00', close: '18:00' } : null },
                    })
                  }
                />
                {label}
              </label>
              {dia ? (
                <>
                  <input
                    className="rounded-lg border border-border bg-background px-2 py-1"
                    type="time"
                    value={dia.open}
                    onChange={(e) => setHoras({ days: { ...horas.days, [key]: { ...dia, open: e.target.value } } })}
                  />
                  <span>{T.ate}</span>
                  <input
                    className="rounded-lg border border-border bg-background px-2 py-1"
                    type="time"
                    value={dia.close}
                    onChange={(e) => setHoras({ days: { ...horas.days, [key]: { ...dia, close: e.target.value } } })}
                  />
                </>
              ) : (
                <span className="text-muted-foreground">{T.fechado}</span>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" onClick={salvar} disabled={salvando} className={`${BOTAO} bg-primary text-primary-foreground`}>
        {salvando ? T.salvando : T.salvar}
      </button>
    </section>
  );
}

function CartaoDeTeste({ contaAtiva }: { contaAtiva: boolean }) {
  const [canal, setCanal] = useState<AiChipPurpose>('COMERCIAL');
  const [cliente, setCliente] = useState(false);
  const [texto, setTexto] = useState('');
  const [historico, setHistorico] = useState<{ from: 'patient' | 'ai'; text: string }[]>([]);
  const [esperando, setEsperando] = useState(false);
  const [passouEquipe, setPassouEquipe] = useState(false);

  const enviar = async () => {
    const msg = texto.trim();
    if (!msg || esperando) return;
    const proximo = [...historico, { from: 'patient' as const, text: msg }];
    setHistorico(proximo);
    setTexto('');
    setEsperando(true);
    setPassouEquipe(false);
    try {
      const { data } = await api.post('/settings/ai-test-chat', { purpose: canal, isClient: cliente, history: proximo }, { timeout: 95_000 });
      const baloes: string[] = Array.isArray(data?.bubbles) ? data.bubbles : [];
      setHistorico([...proximo, ...baloes.map((b) => ({ from: 'ai' as const, text: b }))]);
      setPassouEquipe(!!data?.handoff);
    } catch (e) {
      showError(apiErrorMessage(e, T.testeErro));
    } finally {
      setEsperando(false);
    }
  };

  return (
    <section className={CARTAO}>
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <MessageCircle size={14} /> {T.testeTitulo}
        </h3>
        <p className="text-xs text-muted-foreground">{T.testeAjuda}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5 font-medium">
          {T.testeCanal}
          <select
            className="rounded-lg border border-border bg-background px-2 py-1"
            value={canal}
            onChange={(e) => {
              setCanal(e.target.value as AiChipPurpose);
              setHistorico([]);
              setPassouEquipe(false);
            }}
          >
            {AI_CHIP_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {T.canais[p].nome}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 font-medium">
          <input type="checkbox" checked={cliente} onChange={(e) => setCliente(e.target.checked)} />
          {T.testeCliente}
        </label>
        <button
          type="button"
          onClick={() => {
            setHistorico([]);
            setPassouEquipe(false);
          }}
          className={`${BOTAO} border border-border text-muted-foreground`}
        >
          <RotateCcw size={12} /> {T.testeRecomecar}
        </button>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg bg-muted/30 p-3 text-sm">
        {historico.map((m, i) => (
          <div key={i} className={m.from === 'patient' ? 'text-right' : 'text-left'}>
            <span className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-1.5 ${m.from === 'patient' ? 'bg-primary/15' : 'bg-card border border-border'}`}>
              {m.text}
            </span>
          </div>
        ))}
        {esperando && <p className="text-xs text-muted-foreground">{T.testeEspera}</p>}
        {passouEquipe && <p className="text-xs font-medium text-amber-600">{T.testeEquipe}</p>}
      </div>
      <div className="flex gap-2">
        <input
          className={CAMPO}
          placeholder={T.testePlaceholder}
          value={texto}
          disabled={!contaAtiva || esperando}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void enviar();
          }}
        />
        <button type="button" onClick={enviar} disabled={!contaAtiva || esperando || !texto.trim()} className={`${BOTAO} bg-primary text-primary-foreground`}>
          <Send size={12} /> {T.testeEnviar}
        </button>
      </div>
    </section>
  );
}

export function LabIaPainel() {
  const [carregando, setCarregando] = useState(true);
  const [contaAtiva, setContaAtiva] = useState(false);
  const [perfis, setPerfis] = useState<Partial<Record<AiChipPurpose, PerfilDoChip>>>({});
  const [horas, setHoras] = useState<ClinicHours | null>(null);
  const [robo, setRobo] = useState(false);
  const [custos, setCustos] = useState<any>(null);

  const carregar = useCallback(async () => {
    try {
      const [config, perfil, custo] = await Promise.all([
        api.get('/settings/ai-config'),
        api.get('/settings/ai-profile'),
        api.get('/settings/ai-costs').catch(() => ({ data: null })),
      ]);
      setContaAtiva(config.data?.labIa?.contaAtiva === true);
      setRobo(config.data?.adminBotEnabled === true);
      setPerfis(perfil.data?.chips ?? {});
      setHoras(perfil.data?.clinic?.hours ?? null);
      setCustos(custo.data);
    } catch (e) {
      showError(apiErrorMessage(e, T.erroCarregar));
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => {
    void carregar();
  }, [carregar]);

  const alternarRobo = async () => {
    const proximo = !robo;
    try {
      await api.post('/settings/ai-config', { adminBotEnabled: proximo });
      setRobo(proximo);
    } catch (e) {
      showError(apiErrorMessage(e, T.erroSalvar));
    }
  };

  if (carregando) return <p className="p-6 text-sm text-muted-foreground">{T.carregando}</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-bold">
          <Bot size={18} /> {T.titulo}
        </h1>
        <p className="text-sm text-muted-foreground">{T.subtitulo}</p>
      </header>

      {!contaAtiva && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold">{T.semAssinaturaTitulo}</p>
          <p className="text-muted-foreground">{T.semAssinatura}</p>
        </div>
      )}

      <div>
        <h2 className="text-sm font-bold">{T.chipsTitulo}</h2>
        <p className="text-xs text-muted-foreground">{T.chipsAjuda}</p>
      </div>
      {AI_CHIP_PURPOSES.map((p) => {
        const perfil = perfis[p];
        return perfil ? (
          <CartaoDoChip key={p} purpose={p} perfil={perfil} contaAtiva={contaAtiva} aoSalvar={(novo) => setPerfis((s) => ({ ...s, [p]: novo }))} />
        ) : null;
      })}

      <CartaoDoHorario inicial={horas} />

      <section className={CARTAO}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{T.roboTitulo}</h3>
            <p className="text-xs text-muted-foreground">{T.roboAjuda}</p>
          </div>
          <Chave ligada={robo} desabilitada={!contaAtiva && !robo} aoMudar={alternarRobo} />
        </div>
      </section>

      <CartaoDeTeste contaAtiva={contaAtiva} />

      <section className={CARTAO}>
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Wallet size={14} /> {T.custoTitulo}
          </h3>
          <p className="text-xs text-muted-foreground">{T.custoAjuda}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">{T.custoHoje}</p>
            <p className="font-semibold">{moeda(custos?.today?.cost_usd, custos?.usd_to_brl)}</p>
            <p className="text-[11px] text-muted-foreground">
              {custos?.today?.calls ?? 0} {T.custoChamadas}
            </p>
          </div>
          <div className="rounded-lg bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">{T.custoMes}</p>
            <p className="font-semibold">{moeda(custos?.month?.cost_usd, custos?.usd_to_brl)}</p>
            <p className="text-[11px] text-muted-foreground">
              {custos?.month?.calls ?? 0} {T.custoChamadas}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
