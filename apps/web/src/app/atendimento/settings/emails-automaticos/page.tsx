'use client';

/**
 * Onda 17.32.181 — Configurações → E-mails automáticos (estilo Nuvemshop).
 *
 * Cada clínica liga/desliga e edita o conteúdo dos e-mails enviados
 * automaticamente aos pacientes (cobrança gerada, pagamento confirmado,
 * consulta agendada). O envio sai em nome da clínica, com Responder-Para
 * no e-mail cadastrado em Identidade da clínica.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Mail, Loader2, Save, CheckCircle2, AlertCircle, Send, RotateCcw,
  ChevronDown, ChevronUp, Building2,
} from 'lucide-react';
import api from '@/lib/api';
import { isLab } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';
import {
  LAB_EMAILS_TOPO, LAB_EMAILS_REMETENTE, LAB_EMAILS_AVISOS, LAB_EMAILS_ACOES, LAB_EMAILS_RODAPE,
} from './lab-emails-textos';

interface EventVariable { name: string; label: string; sample: string }
interface EmailEvent {
  key: string;
  label: string;
  description: string;
  variables: EventVariable[];
  enabled: boolean;
  subject: string;
  body: string;
  is_customized: boolean;
}

export default function EmailsAutomaticosPage() {
  const lab = isLab(useBusinessType());
  const [events, setEvents] = useState<EmailEvent[]>([]);
  const [clinic, setClinic] = useState<{ name: string; email: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testedKey, setTestedKey] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.get<EmailEvent[]>('/email-automation');
      setEvents(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || (lab ? LAB_EMAILS_ACOES.carregarErro : 'Não foi possível carregar.'));
    } finally {
      setLoading(false);
    }
    // Remetente exibido no topo (nome + e-mail de resposta da clínica)
    api.get<{ name: string; email: string | null }>('/tenants/me')
      .then((r) => setClinic({ name: r.data.name, email: r.data.email }))
      .catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const patchLocal = (key: string, changes: Partial<EmailEvent>) =>
    setEvents((list) => list.map((ev) => (ev.key === key ? { ...ev, ...changes } : ev)));

  const toggle = async (ev: EmailEvent) => {
    const enabled = !ev.enabled;
    patchLocal(ev.key, { enabled });
    try {
      await api.patch(`/email-automation/${ev.key}`, { enabled });
    } catch (e: any) {
      patchLocal(ev.key, { enabled: ev.enabled }); // rollback
      setError(e?.response?.data?.message || (lab ? LAB_EMAILS_ACOES.salvarErro : 'Falha ao salvar.'));
    }
  };

  const save = async (ev: EmailEvent) => {
    setSavingKey(ev.key);
    setError('');
    try {
      await api.patch(`/email-automation/${ev.key}`, { subject: ev.subject, body: ev.body });
      patchLocal(ev.key, { is_customized: true });
      setSavedKey(ev.key);
      setTimeout(() => setSavedKey((k) => (k === ev.key ? null : k)), 2500);
    } catch (e: any) {
      setError(e?.response?.data?.message || (lab ? LAB_EMAILS_ACOES.salvarErro : 'Falha ao salvar.'));
    } finally {
      setSavingKey(null);
    }
  };

  const reset = async (ev: EmailEvent) => {
    if (!confirm(lab ? LAB_EMAILS_ACOES.restaurarConfirma : 'Restaurar o texto padrão do sistema pra este e-mail?')) return;
    try {
      await api.post(`/email-automation/${ev.key}/reset`);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.message || (lab ? LAB_EMAILS_ACOES.restaurarErro : 'Falha ao restaurar.'));
    }
  };

  const sendTest = async (ev: EmailEvent) => {
    setTestingKey(ev.key);
    setError('');
    try {
      await api.post(`/email-automation/${ev.key}/test`);
      setTestedKey(ev.key);
      setTimeout(() => setTestedKey((k) => (k === ev.key ? null : k)), 4000);
    } catch (e: any) {
      setError(e?.response?.data?.message || (lab ? LAB_EMAILS_ACOES.testeErro : 'Falha ao enviar o teste.'));
    } finally {
      setTestingKey(null);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm bg-muted/30 border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors';

  return (
    <div className="flex-1 flex flex-col pt-8 overflow-hidden bg-background">
      <header className="px-8 mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
          <Mail size={22} className="text-violet-500" />
          {lab ? LAB_EMAILS_TOPO.titulo : 'E-mails automáticos'}
        </h1>
        <p className="text-[13px] text-muted-foreground mt-1">
          {lab ? (
            <>
              {LAB_EMAILS_TOPO.explicacaoAntes}<b>{LAB_EMAILS_TOPO.explicacaoNegrito}</b>{LAB_EMAILS_TOPO.explicacaoDepois}
            </>
          ) : (
            <>
              Mensagens enviadas automaticamente aos seus pacientes, em nome da clínica.
              As respostas chegam no e-mail cadastrado em <b>Identidade da clínica</b>.
            </>
          )}
        </p>
        {lab && (
          <p className="text-[12px] text-muted-foreground mt-2 max-w-3xl">
            {LAB_EMAILS_AVISOS.desligadoPadrao} {LAB_EMAILS_AVISOS.automaticos}
          </p>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-8 pb-8 space-y-4">
        {/* Remetente destes e-mails (separado dos e-mails do sistema) */}
        <div className="bg-violet-500/5 border border-violet-500/20 rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 border border-violet-500/20">
              <Building2 size={18} className="text-violet-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-wider text-violet-500 mb-1">
                {lab ? LAB_EMAILS_REMETENTE.titulo : 'Remetente destes e-mails'}
              </p>
              <p className="text-sm text-foreground">
                {lab ? LAB_EMAILS_REMETENTE.enviadoEmNomeDe : 'Enviado em nome de '}<b>{clinic?.name || (lab ? LAB_EMAILS_REMETENTE.nomePadrao : 'sua clínica')}</b>
                {clinic?.email ? (
                  <>{lab ? LAB_EMAILS_REMETENTE.respostasAntes : ' · respostas dos pacientes chegam em '}<b>{clinic.email}</b></>
                ) : null}
              </p>
              {!clinic?.email && clinic && (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-600">
                  <AlertCircle size={13} />
                  {lab ? LAB_EMAILS_REMETENTE.semEmailAntes : 'Sua clínica ainda não tem e-mail cadastrado — as respostas dos pacientes não terão destino.'}
                  <Link href="/atendimento/settings/identidade" className="font-bold underline">
                    {lab ? LAB_EMAILS_REMETENTE.semEmailLink : 'Cadastrar em Identidade da clínica'}
                  </Link>
                </p>
              )}
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {lab ? (
                  <>{LAB_EMAILS_REMETENTE.exclusivosAntes}<b>{LAB_EMAILS_REMETENTE.exclusivosNegrito}</b>{LAB_EMAILS_REMETENTE.exclusivosDepois}</>
                ) : (
                  <>
                    Estes e-mails são <b>exclusivos pros seus pacientes</b> (cobrança, pagamento, agendamento).
                    Os e-mails do sistema — confirmação de acesso da equipe e redefinição de senha — são
                    separados e enviados pela plataforma Odonto System.
                  </>
                )}
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-600">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-12 justify-center text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" /> {lab ? LAB_EMAILS_ACOES.carregando : 'Carregando…'}
          </div>
        ) : (
          events.map((ev) => {
            const open = openKey === ev.key;
            return (
              <div key={ev.key} className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                {/* Cabeçalho do evento */}
                <div className="flex items-center gap-3 p-5">
                  {/* Toggle liga/desliga */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={ev.enabled}
                    onClick={() => toggle(ev)}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ${
                      ev.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/25'
                    }`}
                    title={lab
                      ? (ev.enabled ? LAB_EMAILS_ACOES.ativadoTitulo : LAB_EMAILS_ACOES.desativadoTitulo)
                      : (ev.enabled ? 'Ativado — clique pra desativar' : 'Desativado — clique pra ativar')}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
                        ev.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[14px] font-bold text-foreground">{ev.label}</h2>
                      {ev.is_customized && (
                        <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold text-violet-500 border border-violet-500/20">
                          {lab ? LAB_EMAILS_ACOES.personalizado : 'Personalizado'}
                        </span>
                      )}
                      {!ev.enabled && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                          {lab ? LAB_EMAILS_ACOES.desligado : 'Desativado'}
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-muted-foreground mt-0.5">{ev.description}</p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setOpenKey(open ? null : ev.key)}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                  >
                    {open ? (lab ? LAB_EMAILS_ACOES.fechar : 'Fechar') : (lab ? LAB_EMAILS_ACOES.editar : 'Editar conteúdo')}
                    {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                </div>

                {/* Editor */}
                {open && (
                  <div className="border-t border-border bg-muted/10 p-5 space-y-4">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-muted-foreground">{lab ? LAB_EMAILS_ACOES.assunto : 'Assunto'}</label>
                      <input
                        type="text"
                        value={ev.subject}
                        onChange={(e) => patchLocal(ev.key, { subject: e.target.value })}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-muted-foreground">{lab ? LAB_EMAILS_ACOES.conteudo : 'Conteúdo'}</label>
                      <textarea
                        value={ev.body}
                        onChange={(e) => patchLocal(ev.key, { body: e.target.value })}
                        rows={8}
                        className={inputCls + ' font-mono text-[13px] leading-relaxed'}
                      />
                    </div>

                    {/* Variáveis disponíveis */}
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {lab ? LAB_EMAILS_ACOES.variaveis : 'Variáveis disponíveis (clique pra copiar)'}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {ev.variables.map((v) => (
                          <button
                            key={v.name}
                            type="button"
                            onClick={() => navigator.clipboard?.writeText(`{{${v.name}}}`)}
                            title={`${v.label} — ex: ${v.sample}`}
                            className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-2 py-1 font-mono text-[11px] text-violet-600 dark:text-violet-400 hover:bg-violet-500/15 transition-colors"
                          >
                            {'{{'}{v.name}{'}}'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Ações */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => save(ev)}
                        disabled={savingKey === ev.key}
                        className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
                      >
                        {savingKey === ev.key ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        {savingKey === ev.key ? (lab ? LAB_EMAILS_ACOES.salvando : 'Salvando…') : (lab ? LAB_EMAILS_ACOES.salvar : 'Salvar')}
                      </button>
                      <button
                        type="button"
                        onClick={() => sendTest(ev)}
                        disabled={testingKey === ev.key}
                        className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-xs font-bold text-foreground transition-colors hover:bg-muted/40 disabled:opacity-50"
                        title={lab ? LAB_EMAILS_ACOES.testeTitulo : 'Envia este e-mail com dados de exemplo pro seu próprio e-mail'}
                      >
                        {testingKey === ev.key ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                        {testingKey === ev.key ? (lab ? LAB_EMAILS_ACOES.testando : 'Enviando…') : (lab ? LAB_EMAILS_ACOES.testeBotao : 'Enviar teste pra mim')}
                      </button>
                      {ev.is_customized && (
                        <button
                          type="button"
                          onClick={() => reset(ev)}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <RotateCcw size={12} />
                          {lab ? LAB_EMAILS_ACOES.restaurar : 'Restaurar padrão'}
                        </button>
                      )}
                      {savedKey === ev.key && (
                        <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600">
                          <CheckCircle2 size={13} /> {lab ? LAB_EMAILS_ACOES.salvo : 'Salvo'}
                        </span>
                      )}
                      {testedKey === ev.key && (
                        <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600">
                          <CheckCircle2 size={13} /> {lab ? LAB_EMAILS_ACOES.testeEnviado : 'Teste enviado — confira sua caixa de entrada'}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}

        {!loading && (
          <p className="text-[11px] text-muted-foreground pt-2">
            {lab ? (
              <>
                💡 {LAB_EMAILS_RODAPE.antes}<code className="font-mono">{LAB_EMAILS_RODAPE.exemplo}</code>{LAB_EMAILS_RODAPE.depois}
              </>
            ) : (
              <>
                💡 Os e-mails só são enviados pra pacientes que têm e-mail no cadastro.
                Variáveis como <code className="font-mono">{'{{paciente_nome}}'}</code> são
                substituídas automaticamente pelos dados reais na hora do envio.
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
