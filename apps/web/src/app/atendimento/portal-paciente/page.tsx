'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Smartphone, Search, Loader2, ExternalLink, Send, Eye, AlertCircle, CheckCircle, Phone, Calendar, FileText, Wallet, Clock,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Patient {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: string;
}

interface PatientList {
  patients: Patient[];
  total: number;
}

interface MagicLinkResp {
  link: string;
  token: string;
  expires_at: string;
  patient: { id: string; name: string; phone: string | null; email: string | null };
  dispatch: { status: 'SENT' | 'SKIPPED' | 'FAILED'; reason?: string };
}

export default function PortalPacienteAdminPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get<PatientList>('/patients?limit=200&order=name')
      .then(({ data }) => { if (alive) setPatients(data.patients || []); })
      .catch((err) => showError(err?.response?.data?.message || 'Erro ao carregar pacientes'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.phone || '').toLowerCase().includes(q) ||
        (p.email || '').toLowerCase().includes(q),
    );
  }, [patients, search]);

  const openPortalAs = async (patient: Patient) => {
    if (acting) return;
    setActing(patient.id);
    try {
      // channel='MANUAL' nao dispara WhatsApp; backend gera token+link normalmente
      const { data } = await api.post<MagicLinkResp>('/portal/magic-link', {
        patient_id: patient.id,
        channel: 'MANUAL',
        purpose: 'GENERIC',
      });
      window.open(data.link, '_blank', 'noopener,noreferrer');
      showSuccess(`Portal aberto como ${patient.name.split(' ')[0]}`);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao abrir portal');
    } finally {
      setActing(null);
    }
  };

  const sendByWhatsApp = async (patient: Patient, purpose: 'GENERIC' | 'ANAMNESE' = 'GENERIC') => {
    if (acting) return;
    if (!patient.phone) {
      showError('Paciente sem telefone — nao da pra mandar via WhatsApp');
      return;
    }
    if (!confirm(`Enviar link do portal${purpose === 'ANAMNESE' ? ' (anamnese)' : ''} para ${patient.name} via WhatsApp?`)) return;
    setActing(patient.id);
    try {
      const { data } = await api.post<MagicLinkResp>('/portal/magic-link', {
        patient_id: patient.id,
        channel: 'WHATSAPP',
        purpose,
      });
      if (data.dispatch.status === 'SENT') {
        showSuccess('Link enviado pelo WhatsApp');
      } else {
        showError(data.dispatch.reason || 'Falha ao enviar — link gerado mesmo assim');
      }
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao enviar link');
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Smartphone size={24} className="text-primary" /> Portal do Paciente
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Visualize como o portal aparece para o paciente, ou envie um link de acesso via WhatsApp.
        </p>
      </div>

      {/* Resumo do que existe no portal */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold mb-3">O que o paciente acessa</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <FeatureCard Icon={Calendar}   label="Agendamentos" desc="Confirmar / cancelar" />
          <FeatureCard Icon={Clock}      label="Histórico"    desc="Linha do tempo" />
          <FeatureCard Icon={Wallet}     label="Parcelas"     desc="Aberto / atraso / pago" />
          <FeatureCard Icon={FileText}   label="Anamnese"     desc="Preencher c/ selfie" />
          <FeatureCard Icon={CheckCircle} label="Início"      desc="Resumo geral" />
        </div>
      </div>

      {/* Busca + lista */}
      <div className="bg-card border border-border rounded-xl">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar paciente por nome, telefone ou email..."
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {filtered.length} de {patients.length}
          </span>
        </div>

        {loading ? (
          <div className="py-12 flex items-center justify-center text-muted-foreground">
            <Loader2 size={18} className="animate-spin mr-2" /> Carregando...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center">
            <AlertCircle size={28} className="mx-auto text-muted-foreground/60 mb-2" />
            <p className="text-sm text-muted-foreground">
              {patients.length === 0 ? 'Nenhum paciente cadastrado.' : 'Nenhum paciente encontrado.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.slice(0, 100).map((p) => (
              <li key={p.id} className="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-accent/30">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-2">
                    {p.phone && (
                      <span className="flex items-center gap-1">
                        <Phone size={10} /> {p.phone}
                      </span>
                    )}
                    {p.email && <span className="truncate">{p.email}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => openPortalAs(p)}
                    disabled={acting === p.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                    title="Abre o portal autenticado como este paciente em nova aba"
                  >
                    {acting === p.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Eye size={12} />
                    )}
                    Visualizar como
                    <ExternalLink size={10} />
                  </button>
                  <button
                    onClick={() => sendByWhatsApp(p, 'GENERIC')}
                    disabled={!p.phone || acting === p.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-emerald-500/30 text-emerald-700 text-xs font-medium hover:bg-emerald-500/10 disabled:opacity-40"
                    title={p.phone ? 'Enviar link do portal via WhatsApp' : 'Paciente sem telefone'}
                  >
                    <Send size={12} /> Enviar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {filtered.length > 100 && (
          <p className="text-[10px] text-muted-foreground text-center py-2 border-t border-border">
            Mostrando 100 de {filtered.length} — refine a busca para ver mais
          </p>
        )}
      </div>

      <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
        <p className="font-medium mb-1">Como funciona</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li><strong>Visualizar como</strong>: gera um link mágico de acesso e abre o portal numa nova aba autenticado como o paciente. Útil pra ver exatamente o que ele vê.</li>
          <li><strong>Enviar</strong>: dispara o link via WhatsApp pro paciente acessar do celular dele.</li>
          <li>Cada link é de uso único e expira em 7 dias.</li>
        </ul>
      </div>
    </div>
  );
}

function FeatureCard({
  Icon, label, desc,
}: { Icon: typeof Smartphone; label: string; desc: string }) {
  return (
    <div className="bg-background border border-border rounded-lg p-2 text-center">
      <Icon size={16} className="mx-auto mb-1 text-primary" />
      <p className="text-[11px] font-semibold">{label}</p>
      <p className="text-[10px] text-muted-foreground">{desc}</p>
    </div>
  );
}
