'use client';

/**
 * Aba "Dentista" do Follow-up IA — Onda 5e v30 (Fase 25).
 *
 * Configura o RESUMO DIARIO disparado pros dentistas no inicio do dia,
 * listando os atendimentos agendados pra hoje (consolida em uma unica
 * mensagem, diferente dos lembretes por evento que vao pro paciente).
 *
 * Endpoints:
 *   GET  /calendar/dentist-daily-summary/config
 *   PUT  /calendar/dentist-daily-summary/config       (admin)
 *   POST /calendar/dentist-daily-summary/send-now     (admin — trigger manual)
 */

import { useEffect, useState } from 'react';
import { Bell, Send, Save, Loader2, Stethoscope, Info } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';

interface DentistDailySummaryConfig {
  enabled: boolean;
  send_at: string;
  channel: 'WHATSAPP' | 'PUSH';
  template: string;
}

const DEFAULT_TEMPLATE =
  'Bom dia, {nome}! 👋\n\n' +
  'Sua agenda hoje ({data}) tem {qtd} atendimento(s):\n\n' +
  '{agenda}\n\n' +
  'Tenha um excelente dia!';

export function DentistSummaryTab() {
  const role = useRole();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [config, setConfig] = useState<DentistDailySummaryConfig>({
    enabled: false,
    send_at: '07:00',
    channel: 'WHATSAPP',
    template: DEFAULT_TEMPLATE,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/calendar/dentist-daily-summary/config');
        if (!cancelled && res.data) {
          setConfig({
            enabled: !!res.data.enabled,
            send_at: res.data.send_at || '07:00',
            channel: res.data.channel === 'PUSH' ? 'PUSH' : 'WHATSAPP',
            template: res.data.template || DEFAULT_TEMPLATE,
          });
        }
      } catch (e: any) {
        showError(e?.response?.data?.message || 'Erro ao carregar config');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/calendar/dentist-daily-summary/config', config);
      showSuccess('Configuração salva');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleSendNow = async () => {
    if (!confirm('Enviar resumo agora pra todos os dentistas com atendimentos hoje?')) return;
    setSending(true);
    try {
      const res = await api.post('/calendar/dentist-daily-summary/send-now');
      const enviados = res.data?.results?.filter((r: any) => r.sent).length ?? 0;
      const total = res.data?.total ?? 0;
      showSuccess(`Disparado: ${enviados}/${total} dentistas receberam`);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao disparar');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" />
        Carregando...
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 p-6">
      {/* Cabecalho */}
      <div className="flex items-start gap-3">
        <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <Stethoscope size={22} className="text-emerald-600" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-bold text-foreground">Resumo diário pra dentistas</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Disparo único no início do dia listando os atendimentos agendados.
            Diferente dos lembretes por evento (que vão pro paciente), esse vai
            pro próprio dentista.
          </p>
        </div>
      </div>

      {/* Aviso info */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 text-xs text-blue-900 dark:text-blue-300">
        <Info size={14} className="shrink-0 mt-0.5" />
        <div>
          <strong>Como funciona:</strong> Pra cada dentista com atendimentos no dia,
          monta uma mensagem com todos os horários e nomes dos pacientes, e envia
          via WhatsApp ou notificação push. Dentistas sem atendimentos hoje
          ficam de fora (não recebem mensagem vazia).
        </div>
      </div>

      {/* Card de configuracao */}
      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        {/* Toggle Ativar */}
        <div className="flex items-center justify-between p-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Disparo automático</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Ativa o envio diário no horário configurado abaixo.
            </p>
          </div>
          <label className="inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
              disabled={!role.isAdmin}
              className="sr-only peer"
            />
            <div className="relative w-11 h-6 bg-muted peer-focus:ring-2 peer-focus:ring-emerald-500/40 rounded-full peer peer-checked:bg-emerald-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border after:border-border after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
          </label>
        </div>

        {/* Horario */}
        <div className="grid grid-cols-2 gap-4 p-4">
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
              Horário do disparo
            </label>
            <input
              type="time"
              value={config.send_at}
              onChange={(e) => setConfig((c) => ({ ...c, send_at: e.target.value }))}
              disabled={!role.isAdmin}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500/50 outline-none disabled:opacity-60"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              O cron roda a cada hora cheia — minutos são ignorados.
            </p>
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
              Canal
            </label>
            <select
              value={config.channel}
              onChange={(e) => setConfig((c) => ({ ...c, channel: e.target.value as 'WHATSAPP' | 'PUSH' }))}
              disabled={!role.isAdmin}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500/50 outline-none disabled:opacity-60"
            >
              <option value="WHATSAPP">WhatsApp (Evolution API)</option>
              <option value="PUSH">Push (notificação no app)</option>
            </select>
          </div>
        </div>

        {/* Template */}
        <div className="p-4">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
            Template da mensagem
          </label>
          <textarea
            value={config.template}
            onChange={(e) => setConfig((c) => ({ ...c, template: e.target.value }))}
            disabled={!role.isAdmin}
            rows={8}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500/50 outline-none font-mono disabled:opacity-60"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Variáveis disponíveis: <code className="px-1 py-0.5 rounded bg-muted">{'{nome}'}</code>{' '}
            (dentista), <code className="px-1 py-0.5 rounded bg-muted">{'{data}'}</code>,{' '}
            <code className="px-1 py-0.5 rounded bg-muted">{'{qtd}'}</code> (qtd atendimentos),{' '}
            <code className="px-1 py-0.5 rounded bg-muted">{'{agenda}'}</code> (lista
            multilinha com horário e paciente)
          </p>
        </div>
      </div>

      {/* Acoes */}
      {role.isAdmin && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={handleSendNow}
            disabled={sending}
            className="px-4 py-2 text-sm font-semibold text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-lg transition-colors inline-flex items-center gap-2 disabled:opacity-40 disabled:pointer-events-none"
            title="Dispara o resumo agora pra todos os dentistas com atendimentos hoje"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {sending ? 'Enviando…' : 'Enviar agora (teste)'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 text-sm font-bold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors shadow-md disabled:opacity-40 disabled:pointer-events-none inline-flex items-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Salvando…' : 'Salvar configuração'}
          </button>
        </div>
      )}

      {!role.isAdmin && (
        <div className="text-center text-xs text-muted-foreground py-4 border-t border-border">
          <Bell size={14} className="inline mr-1" />
          Configuração somente para administradores. Você visualiza, mas não pode editar.
        </div>
      )}
    </div>
  );
}
