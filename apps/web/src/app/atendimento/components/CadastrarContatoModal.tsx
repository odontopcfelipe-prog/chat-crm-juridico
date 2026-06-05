'use client';

/**
 * Onda 17.32.59 — Modal compacto pra "cadastrar contato" dentro da
 * conversa. Atualiza o lead EXISTENTE com nome, email, origem, tags —
 * nao cria duplicata.
 *
 * Use case: msg WhatsApp chegou de numero nao salvo (lead.name = phone).
 * Operador clica "📇 Cadastrar" e preenche os dados pra organizar a
 * carteira sem precisar trocar de pagina.
 */
import { useState, useEffect } from 'react';
import { X, Loader2, UserPlus, IdCard, Mail, Tag as TagIcon, Compass } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void; // callback pra refresh do header/lista
  leadId: string;
  // valores atuais (pra pre-preencher)
  currentName?: string | null;
  currentEmail?: string | null;
  currentOrigin?: string | null;
  currentTags?: string[];
  currentPhone?: string | null;
}

// Sugestoes comuns de origem pra autocompletar
const ORIGIN_SUGGESTIONS = [
  'Indicacao',
  'Instagram',
  'Google',
  'WhatsApp',
  'Facebook',
  'TikTok',
  'Evento',
  'Telefone',
];

export function CadastrarContatoModal({
  open,
  onClose,
  onSaved,
  leadId,
  currentName,
  currentEmail,
  currentOrigin,
  currentTags,
  currentPhone,
}: Props) {
  // Detecta se o "name" atual eh so o telefone (lead nao nomeado).
  // Quando for, deixa o campo vazio pra forcar o operador a colocar nome real.
  const isPhonePlaceholder = currentName && currentPhone &&
    currentName.replace(/\D/g, '') === currentPhone.replace(/\D/g, '');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [origin, setOrigin] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset form ao abrir
  useEffect(() => {
    if (!open) return;
    setName(isPhonePlaceholder ? '' : (currentName || ''));
    setEmail(currentEmail || '');
    setOrigin(currentOrigin || '');
    setTagsText((currentTags || []).join(', '));
    setSaving(false);
  }, [open, isPhonePlaceholder, currentName, currentEmail, currentOrigin, currentTags]);

  // Onda 17.32.61 — 3 acoes explicitas no footer:
  //   1. saveOnly   = atualiza so dados do Lead (aba Leads)
  //   2. asPatient  = salva + cria Patient (aba Leads + lista de Pacientes)
  //   3. asClient   = salva + cria Patient + promove a Cliente (aba Clientes)
  type SaveMode = 'lead-only' | 'patient' | 'client';
  const [pendingMode, setPendingMode] = useState<SaveMode | null>(null);

  const runSave = async (mode: SaveMode) => {
    if (!name.trim()) {
      showError('Nome eh obrigatorio');
      return;
    }
    setSaving(true);
    setPendingMode(mode);
    try {
      const tags = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const payload: any = { name: name.trim() };
      if (email.trim()) payload.email = email.trim();
      if (origin.trim()) payload.origin = origin.trim();
      if (tags.length > 0) payload.tags = tags;
      // 1. Atualiza Lead (sempre roda)
      await api.patch(`/leads/${leadId}`, payload);
      // 2. Se for paciente ou cliente, cria Patient
      if (mode === 'patient' || mode === 'client') {
        try {
          await api.post(`/leads/${leadId}/ensure-patient`);
        } catch (ensureErr: any) {
          const ensureMsg = ensureErr?.response?.data?.message;
          showError(`Paciente nao foi criado: ${typeof ensureMsg === 'string' ? ensureMsg : 'dados insuficientes'}`);
          return; // nao prossegue pra Cliente se Patient falhou
        }
      }
      // 3. Se for cliente, promove
      if (mode === 'client') {
        try {
          await api.post(`/leads/${leadId}/promote-to-client`);
        } catch (promoteErr: any) {
          const promoteMsg = promoteErr?.response?.data?.message;
          showError(`Promocao a cliente falhou: ${typeof promoteMsg === 'string' ? promoteMsg : 'erro'}`);
          return;
        }
      }
      // Mensagens distintas por modo
      const messages: Record<SaveMode, string> = {
        'lead-only': 'Contato salvo (Lead)',
        'patient': 'Contato salvo e adicionado em Pacientes',
        'client': 'Contato promovido a Cliente',
      };
      showSuccess(messages[mode]);
      onSaved?.();
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro ao salvar contato';
      showError(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(', ') : 'Erro ao salvar'));
    } finally {
      setSaving(false);
      setPendingMode(null);
    }
  };

  // Submit padrao do form (Enter) = salvar so Lead
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runSave('lead-only');
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-violet-500/5 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-400 flex items-center justify-center">
              <UserPlus size={16} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-foreground">
                {isPhonePlaceholder ? 'Cadastrar contato' : 'Editar contato'}
              </h2>
              {currentPhone && (
                <p className="text-[11px] text-muted-foreground truncate">{currentPhone}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {/* Nome */}
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
              <IdCard size={10} /> Nome *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              placeholder="ex: Maria Silva"
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            />
          </div>

          {/* Email */}
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
              <Mail size={10} /> Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="(opcional)"
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            />
          </div>

          {/* Origem */}
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
              <Compass size={10} /> Origem
            </label>
            <input
              type="text"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              list="origin-suggestions"
              placeholder="(opcional) ex: Indicacao, Instagram..."
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            />
            <datalist id="origin-suggestions">
              {ORIGIN_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>

          {/* Tags */}
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
              <TagIcon size={10} /> Tags
            </label>
            <input
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="(opcional) separadas por virgula, ex: vip, retorno"
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            />
          </div>

          {/* Aviso de fluxo — explica os 3 botoes do footer */}
          <div className="text-[11px] text-muted-foreground bg-muted/30 border border-border rounded-md px-3 py-2 mt-2 space-y-1">
            <p><strong>Salvar</strong>: so atualiza dados do Lead (continua na aba "Leads").</p>
            <p><strong>Tornar Paciente</strong>: adiciona em <strong>/pacientes</strong> sem virar cliente.</p>
            <p><strong>Tornar Cliente</strong>: cria paciente + move pra aba "Clientes" no WhatsApp.</p>
          </div>
        </div>

        {/* Footer — 3 acoes principais */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-muted/30 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-sm font-semibold px-3 py-2 rounded-md border border-border bg-card text-foreground hover:bg-accent/40 transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          {/* Salvar (so Lead) — submit do form (Enter no input dispara isso) */}
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="text-sm font-semibold px-3 py-2 rounded-md border border-border bg-card text-foreground hover:bg-accent/40 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            title="So atualiza dados do Lead (nao cria paciente)"
          >
            {pendingMode === 'lead-only' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <UserPlus size={12} />
            )}
            Salvar
          </button>
          {/* Tornar Paciente — salva + cria Patient */}
          <button
            type="button"
            onClick={() => runSave('patient')}
            disabled={saving || !name.trim()}
            className="text-sm font-bold px-3 py-2 rounded-md bg-sky-600 hover:bg-sky-700 text-white transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5 flex-1 min-w-[140px]"
            title="Salva dados do Lead e cria Paciente em /atendimento/pacientes"
          >
            {pendingMode === 'patient' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <UserPlus size={14} />
            )}
            Tornar Paciente
          </button>
          {/* Tornar Cliente — salva + cria Patient + promove */}
          <button
            type="button"
            onClick={() => runSave('client')}
            disabled={saving || !name.trim()}
            className="text-sm font-bold px-3 py-2 rounded-md bg-violet-600 hover:bg-violet-700 text-white transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5 flex-1 min-w-[140px]"
            title="Salva + cria Paciente + promove a Cliente (move pra aba Clientes do WhatsApp)"
          >
            {pendingMode === 'client' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <UserPlus size={14} />
            )}
            Tornar Cliente
          </button>
        </div>
      </form>
    </div>
  );
}
