'use client';

import { useCallback, useEffect, useState } from 'react';
import { Building2, Loader2, Plus, X, Edit2, Trash2, Users, MapPin } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Clinic {
  id: string;
  name: string;
  short_name: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  email: string | null;
  cnpj: string | null;
  type: string;
  brand_color: string | null;
  is_franchise: boolean;
  active: boolean;
  _count?: { user_clinics: number };
}

const TYPE_LABEL: Record<string, string> = {
  DENTAL: 'Odontológica',
  AESTHETIC: 'Estética',
  MIXED: 'Mista',
};

export default function ClinicsSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [editing, setEditing] = useState<Clinic | null>(null);
  const [openModal, setOpenModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Clinic[]>('/clinics');
      setClinics(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar unidades');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const archive = async (id: string, name: string) => {
    if (!confirm(`Arquivar a unidade "${name}"?`)) return;
    try {
      await api.delete(`/clinics/${id}`);
      showSuccess('Unidade arquivada');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Building2 size={26} className="text-primary" /> Unidades / Salas
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cadastre as unidades da sua rede ou franquia. Cada usuario pode ter
            acesso a multiplas unidades com permissoes diferentes.
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setOpenModal(true); }}
          className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={16} /> Nova unidade
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : clinics.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Building2 size={28} className="mx-auto mb-2 opacity-50" />
          <p>Nenhuma unidade cadastrada.</p>
          <p className="text-xs mt-1">Para clinicas com 1 endereco apenas, este cadastro e opcional.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {clinics.map((c) => (
            <div key={c.id} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  {c.brand_color && (
                    <span
                      className="inline-block w-4 h-4 rounded border border-border"
                      style={{ backgroundColor: c.brand_color }}
                    />
                  )}
                  <h3 className="font-semibold text-foreground">{c.name}</h3>
                </div>
                <div className="flex gap-1 items-center">
                  {c.is_franchise && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-700 border border-purple-500/20">
                      Franquia
                    </span>
                  )}
                  {!c.active && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      Inativa
                    </span>
                  )}
                </div>
              </div>

              <div className="text-xs text-muted-foreground space-y-1">
                <p><span className="opacity-60">Tipo:</span> {TYPE_LABEL[c.type] || c.type}</p>
                {c.short_name && <p><span className="opacity-60">Sigla:</span> {c.short_name}</p>}
                {(c.city || c.state) && (
                  <p className="flex items-center gap-1">
                    <MapPin size={10} /> {[c.city, c.state].filter(Boolean).join(' / ')}
                  </p>
                )}
                {c.phone && <p>{c.phone}</p>}
                {c.cnpj && <p>CNPJ: {c.cnpj}</p>}
              </div>

              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Users size={11} /> {c._count?.user_clinics ?? 0} usuario(s)
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => { setEditing(c); setOpenModal(true); }}
                    className="p-1.5 rounded hover:bg-accent"
                    title="Editar"
                  >
                    <Edit2 size={14} />
                  </button>
                  {c.active && (
                    <button
                      onClick={() => archive(c.id, c.name)}
                      className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                      title="Arquivar"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {openModal && (
        <ClinicModal
          clinic={editing}
          onClose={() => { setOpenModal(false); setEditing(null); }}
          onSaved={() => { setOpenModal(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function ClinicModal({
  clinic, onClose, onSaved,
}: { clinic: Clinic | null; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(clinic?.name || '');
  const [shortName, setShortName] = useState(clinic?.short_name || '');
  const [type, setType] = useState(clinic?.type || 'MIXED');
  const [city, setCity] = useState(clinic?.city || '');
  const [state, setState] = useState(clinic?.state || '');
  const [phone, setPhone] = useState(clinic?.phone || '');
  const [email, setEmail] = useState(clinic?.email || '');
  const [cnpj, setCnpj] = useState(clinic?.cnpj || '');
  const [brandColor, setBrandColor] = useState(clinic?.brand_color || '#F58220');
  const [isFranchise, setIsFranchise] = useState(clinic?.is_franchise || false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { showError('Nome obrigatorio'); return; }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        short_name: shortName.trim() || undefined,
        type,
        city: city.trim() || undefined,
        state: state.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        cnpj: cnpj.trim() || undefined,
        brand_color: brandColor,
        is_franchise: isFranchise,
      };
      if (clinic) {
        await api.patch(`/clinics/${clinic.id}`, payload);
        showSuccess('Unidade atualizada');
      } else {
        await api.post('/clinics', payload);
        showSuccess('Unidade cadastrada');
      }
      onSaved();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Building2 size={20} className="text-primary" /> {clinic ? 'Editar unidade' : 'Nova unidade'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium mb-1">Nome *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder="Centro SP, Moema, Copacabana RJ..."
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Sigla</label>
              <input
                type="text"
                value={shortName}
                onChange={(e) => setShortName(e.target.value)}
                placeholder="SP-CT"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Tipo</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="MIXED">Mista</option>
                <option value="DENTAL">Odontologica</option>
                <option value="AESTHETIC">Estetica</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium mb-1">Cidade</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">UF</label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                maxLength={2}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm uppercase focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Telefone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">CNPJ</label>
              <input
                type="text"
                value={cnpj}
                onChange={(e) => setCnpj(e.target.value)}
                placeholder="00.000.000/0000-00"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Cor da marca</label>
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="h-9 w-16 rounded border border-border cursor-pointer"
                />
                <input
                  type="text"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <input
              type="checkbox"
              checked={isFranchise}
              onChange={(e) => setIsFranchise(e.target.checked)}
              className="accent-amber-500"
            />
            <span>Esta unidade e uma franquia (com royalties e dono proprio)</span>
          </label>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {clinic ? 'Atualizar' : 'Cadastrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
