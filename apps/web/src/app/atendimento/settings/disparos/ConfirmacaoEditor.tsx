'use client';

// Onda 17.56 — editor da mensagem de "Confirmação de agendamento". O liga/desliga
// fica no toggle da linha (painel Operacional); aqui edita-se só o TEXTO, salvo em
// /calendar/appointment-confirmation/config (GlobalSetting). O worker scheduler aplica.
import { useEffect, useState } from 'react';
import { Loader2, Save, MessageSquare, Eye, Variable, Send } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

const VARIABLES = [
  { key: 'nome', desc: 'Primeiro nome do paciente' },
  { key: 'nome_completo', desc: 'Nome inteiro' },
  { key: 'dentista', desc: 'Dra. Suellen' },
  { key: 'data', desc: '06/05' },
  { key: 'hora', desc: '14:00' },
  { key: 'local', desc: 'Endereço da consulta' },
];

const PREVIEW: Record<string, string> = {
  nome: 'Felipe', nome_completo: 'Felipe Passos', dentista: 'Dra. Suellen',
  data: '06/05', hora: '14:00', local: 'Rua das Acácias, 123 — Sala 4',
};

function applyPreview(t: string): string {
  const localLine = PREVIEW.local ? `📍 ${PREVIEW.local}\n` : '';
  return t
    .replace(/\{local_line\}/g, localLine)
    .replace(/\{(\w+)\}/g, (_m, k) => PREVIEW[k] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function ConfirmacaoEditor() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.get('/calendar/appointment-confirmation/config')
      .then((r) => setTemplate(r.data?.template || ''))
      .catch((e: any) => showError(e?.response?.data?.message || 'Falha ao carregar a mensagem'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/calendar/appointment-confirmation/config', { template });
      if (r.data?.template != null) setTemplate(r.data.template);
      showSuccess('Mensagem da confirmação salva');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      await api.post('/calendar/appointment-confirmation/send-test', { phone: testPhone });
      showSuccess('Teste enviado — confira o WhatsApp desse número');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao enviar o teste');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="border-b border-border px-5 py-4 flex items-center gap-2">
        <MessageSquare size={16} className="text-primary" />
        <h2 className="text-base font-bold">Mensagem da confirmação</h2>
      </div>
      <div className="p-5 space-y-4">
        <p className="text-[11px] text-muted-foreground">
          Enviada ~24h antes da consulta, pedindo a confirmação do paciente. Use as variáveis
          abaixo (o sistema substitui pelos dados reais).
        </p>

        {/* Variáveis */}
        <div className="p-3 rounded-xl bg-muted/30 border border-border">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
            <Variable size={11} /> Variáveis disponíveis
          </div>
          <div className="flex flex-wrap gap-1.5">
            {VARIABLES.map((v) => (
              <span
                key={v.key}
                title={v.desc}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono bg-primary/10 text-primary border border-primary/20"
              >
                {`{${v.key}}`}
              </span>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2 italic">
            💡 Use <code className="bg-muted/50 px-1 rounded">{'{local_line}'}</code> em vez de{' '}
            <code>{'{local}'}</code> — já adiciona o 📍 e a quebra de linha.
          </p>
        </div>

        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={5}
          maxLength={1500}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
          placeholder="Texto da mensagem com variáveis…"
        />
        <div className="text-[10px] text-muted-foreground">{template.length}/1500 caracteres</div>

        {/* Preview */}
        <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
            <Eye size={11} /> Preview (como o paciente vai receber)
          </div>
          <div className="text-xs text-foreground whitespace-pre-wrap">
            {applyPreview(template) || <em className="text-muted-foreground">(mensagem vazia)</em>}
          </div>
        </div>

        {/* Testar entrega */}
        <div className="pt-3 border-t border-border">
          <div className="text-[11px] font-bold text-foreground mb-1.5">🧪 Testar entrega no WhatsApp</div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="Seu WhatsApp com DDD (ex.: 82999998888)"
              className="flex-1 min-w-[180px] px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            <button
              onClick={sendTest}
              disabled={testing || !testPhone.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold border border-border rounded-lg hover:bg-accent transition-colors disabled:opacity-50"
            >
              {testing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Enviar teste
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Manda a mensagem (com dados de exemplo) pro número acima — pra você ver se chega.
            Precisa do WhatsApp da clínica conectado.
          </p>
        </div>

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
