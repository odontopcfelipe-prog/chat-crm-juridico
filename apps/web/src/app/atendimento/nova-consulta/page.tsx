'use client';

/**
 * Out/2026 — Nova consulta (card do painel do dentista).
 *
 * Dois passos: escolher o paciente (os de hoje na agenda dele + busca entre os
 * pacientes DELE — o backend já restringe) e, escolhido, SÓ a avaliação: o mesmo
 * OdontogramaTab da ficha (odontograma + plano clínico), sem as outras abas.
 * Sem valores e sem a etapa de proposta: o plano não mostra preço pra ninguém e,
 * sem manage_proposals, não há link pra Orçamentos — a recepção apresenta os
 * valores ao paciente. O que é adicionado já fica salvo (não há "salvar" no fim).
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, Info, Loader2, Search, Stethoscope } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useTenant } from '@/lib/useTenant';
import { tenantAccent } from '@/lib/tenant-accent';
import { PatientAvatar } from '@/components/PatientAvatar';
import './nova-consulta.css';

// O Next exige as opções do dynamic() como objeto literal.
const OdontogramaTab = dynamic(() => import('@/app/atendimento/pacientes/components/OdontogramaTab'), {
  ssr: false,
  loading: () => (
    <div className="nc-loading"><Loader2 size={16} className="animate-spin" /> Carregando a avaliação…</div>
  ),
});

const PATIENT_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];
const TYPE_LABEL: Record<string, string> = {
  CONSULTA: 'Consulta', PROCEDIMENTO: 'Procedimento', RETORNO: 'Retorno', ORTODONTIA: 'Ortodontia',
};

interface PacienteResumo {
  id: string;
  name: string | null;
  avatar_url?: string | null;
  lead?: { profile_picture_url?: string | null } | null;
}

interface AgendaEvent {
  id: string;
  type: string;
  status: string;
  start_at: string;
  patient?: { id: string; name: string; avatar_url?: string | null } | null;
  lead?: { id: string; name: string | null } | null;
  appointment_type?: { name?: string | null } | null;
}

/** Id do usuário logado (JWT) — a agenda de hoje é a DELE. */
function myUserId(): string | null {
  try {
    const t = localStorage.getItem('token') || '';
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (p?.sub || p?.id || null) as string | null;
  } catch {
    return null;
  }
}

/** Dia de Maceió (YYYY-MM-DD) — modelo naive-UTC da agenda. */
function maceioTodayStr(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// useSearchParams exige Suspense no build do Next.
export default function NovaConsultaPage() {
  return (
    <Suspense fallback={null}>
      <NovaConsulta />
    </Suspense>
  );
}

function NovaConsulta() {
  const router = useRouter();
  const pacienteId = useSearchParams().get('paciente');
  const tenant = useTenant();
  const accent = useMemo(() => tenantAccent(tenant?.theme_color), [tenant?.theme_color]);

  return (
    <div className="h-full overflow-y-auto nc" style={{ '--nc-accent': accent } as CSSProperties}>
      {pacienteId ? (
        <Avaliacao
          key={pacienteId}
          pacienteId={pacienteId}
          onTrocar={() => router.push('/atendimento/nova-consulta')}
          onConcluir={() => {
            toast.success('Avaliação salva. A recepção cuida dos valores e da proposta.');
            router.push('/atendimento/dashboard');
          }}
        />
      ) : (
        <EscolherPaciente
          onVoltar={() => router.push('/atendimento/dashboard')}
          onEscolher={(id) => router.push(`/atendimento/nova-consulta?paciente=${encodeURIComponent(id)}`)}
        />
      )}
    </div>
  );
}

// ─── Passo 1: quem vai ser avaliado ─────────────────────────────────────────

function EscolherPaciente({ onVoltar, onEscolher }: { onVoltar: () => void; onEscolher: (id: string) => void }) {
  const [hoje, setHoje] = useState<AgendaEvent[] | null>(null);
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState<PacienteResumo[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    const day = maceioTodayStr();
    const me = myUserId();
    api.get<AgendaEvent[]>('/calendar/events', {
      params: { start: `${day}T00:00:00.000Z`, end: `${day}T23:59:59.999Z`, ...(me ? { userId: me } : {}) },
    })
      .then(({ data }) => {
        const vistos = new Set<string>();
        const lista = (Array.isArray(data) ? data : [])
          .filter((e) => PATIENT_TYPES.includes(e.type) && e.status !== 'CANCELADO')
          .sort((a, b) => a.start_at.localeCompare(b.start_at))
          // Um paciente com 2 horários no dia aparece uma vez só.
          .filter((e) => {
            const k = e.patient?.id ?? `lead:${e.lead?.id ?? e.id}`;
            if (vistos.has(k)) return false;
            vistos.add(k);
            return true;
          });
        setHoje(lista);
      })
      .catch(() => setHoje([]));
  }, []);

  const buscar = useCallback(async (q: string) => {
    const reqId = ++reqRef.current;
    setBuscando(true);
    try {
      const r = await api.get('/patients', { params: { search: q, status: 'ACTIVE', limit: 12 } });
      if (reqId !== reqRef.current) return;
      setAchados(Array.isArray(r.data) ? r.data : r.data?.data || []);
    } catch {
      if (reqId === reqRef.current) setAchados([]);
    } finally {
      if (reqId === reqRef.current) setBuscando(false);
    }
  }, []);

  useEffect(() => {
    const q = busca.trim();
    if (q.length < 2) {
      reqRef.current++;
      setAchados(null);
      setBuscando(false);
      return;
    }
    const t = setTimeout(() => buscar(q), 250);
    return () => clearTimeout(t);
  }, [busca, buscar]);

  return (
    <div className="nc-wrap">
      <button type="button" className="nc-back" onClick={onVoltar}>
        <ArrowLeft size={15} /> Início
      </button>

      <header className="nc-hero">
        <div className="nc-hero-glow" aria-hidden="true" />
        <div className="nc-hero-row">
          <span className="nc-hero-ico"><Stethoscope size={22} /></span>
          <div className="min-w-0">
            <p className="nc-eyebrow">Nova consulta</p>
            <h1>Quem você vai avaliar?</h1>
            <p className="nc-hero-sub">
              Escolha o paciente e monte a avaliação no odontograma. Valores e proposta ficam com a recepção.
            </p>
          </div>
        </div>
      </header>

      <section className="nc-card">
        <h2 className="nc-card-title">Na sua agenda hoje</h2>
        {hoje === null ? (
          <div className="nc-loading"><Loader2 size={16} className="animate-spin" /> Carregando…</div>
        ) : hoje.length === 0 ? (
          <p className="nc-empty">Nenhum paciente na sua agenda hoje.</p>
        ) : (
          <ul className="nc-list">
            {hoje.map((ev) => {
              const nome = ev.patient?.name || ev.lead?.name || 'Paciente';
              const tipo = ev.appointment_type?.name || TYPE_LABEL[ev.type] || 'Consulta';
              return (
                <li key={ev.id}>
                  <button
                    type="button"
                    className="nc-row"
                    disabled={!ev.patient}
                    onClick={() => ev.patient && onEscolher(ev.patient.id)}
                  >
                    <span className="nc-time">{hhmm(ev.start_at)}</span>
                    <PatientAvatar
                      patientId={ev.patient?.id ?? ev.lead?.id ?? ev.id}
                      patientName={nome}
                      avatarUrl={ev.patient?.avatar_url ?? null}
                      size={36}
                      shape="circle"
                    />
                    <span className="nc-who">
                      <span className="nc-name">{nome}</span>
                      <span className="nc-sub">{ev.patient ? tipo : 'Sem ficha ainda — a recepção cadastra'}</span>
                    </span>
                    {ev.patient && <ArrowRight size={16} className="nc-go" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="nc-card">
        <h2 className="nc-card-title">Buscar entre os seus pacientes</h2>
        <label className="nc-search">
          <Search size={16} />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Nome ou CPF do paciente…"
            autoComplete="off"
          />
          {buscando && <Loader2 size={15} className="animate-spin" />}
        </label>
        {achados === null ? (
          <p className="nc-empty">Digite pelo menos 2 letras do nome.</p>
        ) : achados.length === 0 && !buscando ? (
          <p className="nc-empty">
            Nenhum paciente seu com esse nome. Paciente novo? Peça à recepção para cadastrar e agendar com você.
          </p>
        ) : (
          <ul className="nc-list">
            {achados.map((p) => (
              <li key={p.id}>
                <button type="button" className="nc-row" onClick={() => onEscolher(p.id)}>
                  <PatientAvatar
                    patientId={p.id}
                    patientName={p.name || 'Paciente'}
                    avatarUrl={p.avatar_url ?? null}
                    fallbackPhotoUrl={p.lead?.profile_picture_url ?? null}
                    size={36}
                    shape="circle"
                  />
                  <span className="nc-who">
                    <span className="nc-name">{p.name || 'Paciente sem nome'}</span>
                  </span>
                  <ArrowRight size={16} className="nc-go" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─── Passo 2: só a avaliação ────────────────────────────────────────────────

function Avaliacao({ pacienteId, onTrocar, onConcluir }: {
  pacienteId: string;
  onTrocar: () => void;
  onConcluir: () => void;
}) {
  const [paciente, setPaciente] = useState<PacienteResumo | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    api.get<PacienteResumo>(`/patients/${pacienteId}`)
      .then(({ data }) => setPaciente(data))
      .catch(() => setErro(true));
  }, [pacienteId]);

  if (erro) {
    return (
      <div className="nc-wrap">
        <button type="button" className="nc-back" onClick={onTrocar}><ArrowLeft size={15} /> Escolher paciente</button>
        <section className="nc-card">
          <p className="nc-empty">Não encontramos esse paciente entre os seus. Escolha outro.</p>
        </section>
      </div>
    );
  }

  const nome = paciente?.name || 'Paciente';
  return (
    <div className="nc-wrap is-wide">
      <button type="button" className="nc-back" onClick={onTrocar}>
        <ArrowLeft size={15} /> Trocar paciente
      </button>

      <header className="nc-hero">
        <div className="nc-hero-glow" aria-hidden="true" />
        <div className="nc-hero-row is-patient">
          <div className="nc-hero-who">
            {paciente ? (
              <PatientAvatar
                patientId={paciente.id}
                patientName={nome}
                avatarUrl={paciente.avatar_url ?? null}
                fallbackPhotoUrl={paciente.lead?.profile_picture_url ?? null}
                size={54}
                shape="circle"
              />
            ) : (
              <span className="nc-hero-ico"><Stethoscope size={22} /></span>
            )}
            <div className="min-w-0">
              <p className="nc-eyebrow">Nova consulta · Avaliação</p>
              <h1 className="truncate">{paciente ? nome : 'Carregando…'}</h1>
            </div>
          </div>
          <button type="button" className="nc-done" onClick={onConcluir} disabled={!paciente}>
            <Check size={16} /> Concluir avaliação
          </button>
        </div>
      </header>

      <p className="nc-note">
        <Info size={15} />
        <span>
          Monte o plano clínico: dentes, procedimentos e prioridades — fica salvo ao adicionar.
          Sem valores: a recepção apresenta os valores e a proposta ao paciente.
        </span>
      </p>

      {paciente && (
        <div className="nc-eval bg-background text-foreground border border-border">
          <OdontogramaTab patientId={paciente.id} patientName={nome} />
        </div>
      )}
    </div>
  );
}
