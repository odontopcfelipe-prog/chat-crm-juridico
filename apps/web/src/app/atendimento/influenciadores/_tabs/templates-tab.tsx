'use client';

/**
 * Aba "Templates" — biblioteca de textos reutilizáveis pelos agendamentos.
 * Suporta variáveis: {{nome}}, {{handle}}, {{cupom}}, {{plataforma}}, {{nicho}}.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Loader2, Pencil, Trash2, FileText, Eye } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ModalBase from '@/components/ModalBase';
import { inputCls, Field } from './ui-shared';

export interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

const VARS = [
  { k: 'nome', desc: 'nome do influenciador' },
  { k: 'handle', desc: '@ principal' },
  { k: 'cupom', desc: 'cupom cadastrado' },
  { k: 'plataforma', desc: 'Instagram/TikTok/...' },
  { k: 'nicho', desc: 'nicho cadastrado' },
];

const EXAMPLE_PREVIEW = {
  nome: 'Ana Silva',
  handle: 'anaodonto',
  cupom: 'ANA10',
  plataforma: 'INSTAGRAM',
  nicho: 'odonto',
};

function interpolatePreview(body: string): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return (EXAMPLE_PREVIEW as any)[key] ?? '';
  });
}

export function TemplatesTab() {
  const [items, setItems] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<MessageTemplate | null>(null);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<MessageTemplate[]>('/influencers/templates');
      setItems(Array.isArray(data) ? data : []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar templates');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setBody('');
    setModalOpen(true);
  };

  const openEdit = (t: MessageTemplate) => {
    setEditing(t);
    setName(t.name);
    setBody(t.body);
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) { showError('Nome é obrigatório'); return; }
    if (!body.trim()) { showError('Corpo da mensagem é obrigatório'); return; }
    setSaving(true);
    try {
      const payload = { name: name.trim(), body };
      if (editing) {
        await api.patch(`/influencers/templates/${editing.id}`, payload);
        showSuccess('Template atualizado');
      } else {
        await api.post('/influencers/templates', payload);
        showSuccess('Template criado');
      }
      setModalOpen(false);
      fetchList();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (t: MessageTemplate) => {
    if (!confirm(`Remover template "${t.name}"?`)) return;
    try {
      await api.delete(`/influencers/templates/${t.id}`);
      showSuccess('Template removido');
      fetchList();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  const insertVar = (k: string) => {
    setBody(b => `${b}{{${k}}}`);
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-xs text-muted-foreground">
          Textos reutilizáveis pelos agendamentos. Use variáveis pra personalizar por destinatário.
        </p>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 text-sm font-medium shadow-sm"
        >
          <Plus size={16} strokeWidth={2.5} /> Novo template
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 bg-card border border-dashed border-border rounded-xl">
          <FileText size={36} className="mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mb-1">Nenhum template criado ainda.</p>
          <button
            onClick={openCreate}
            className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 text-xs font-medium"
          >
            <Plus size={14} /> Criar primeiro
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(t => (
            <div key={t.id} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="font-semibold text-foreground">{t.name}</h3>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEdit(t)}
                    className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent"
                    title="Editar"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(t)}
                    className="p-1.5 rounded-lg text-destructive hover:bg-destructive/10"
                    title="Remover"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans bg-background border border-border rounded-lg p-3 max-h-32 overflow-y-auto">
                {t.body}
              </pre>
            </div>
          ))}
        </div>
      )}

      <ModalBase
        open={modalOpen}
        onClose={() => !saving && setModalOpen(false)}
        title={editing ? 'Editar template' : 'Novo template'}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setModalOpen(false)}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim() || !body.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 text-sm font-medium disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {editing ? 'Salvar' : 'Criar'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label="Nome do template *">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="ex: Lembrete semanal de postagem"
              className={inputCls}
            />
          </Field>

          <Field
            label="Corpo da mensagem *"
            hint="Use variáveis entre chaves duplas — elas serão substituídas no envio."
          >
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={6}
              placeholder={`Oi {{nome}}!\n\nLembrete da semana — bora postar usando o cupom {{cupom}}? 🚀`}
              className={`${inputCls} resize-y font-mono`}
            />
          </Field>

          <div>
            <p className="text-xs font-medium text-foreground mb-2">Inserir variável:</p>
            <div className="flex flex-wrap gap-1.5">
              {VARS.map(v => (
                <button
                  key={v.k}
                  type="button"
                  onClick={() => insertVar(v.k)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-accent text-accent-foreground text-[11px] font-mono hover:opacity-80"
                  title={v.desc}
                >
                  {`{{${v.k}}}`}
                </button>
              ))}
            </div>
          </div>

          {body.trim() && (
            <div className="pt-3 border-t border-border">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                <Eye size={12} /> Pré-visualização (exemplo: Ana Silva)
              </p>
              <div className="bg-background border border-border rounded-lg p-3 text-sm text-foreground whitespace-pre-wrap">
                {interpolatePreview(body)}
              </div>
            </div>
          )}
        </div>
      </ModalBase>
    </div>
  );
}
