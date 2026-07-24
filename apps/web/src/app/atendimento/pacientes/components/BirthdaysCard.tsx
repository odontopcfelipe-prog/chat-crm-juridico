'use client';

/**
 * BirthdaysCard — card que mostra aniversariantes do dia/semana/mês.
 *
 * Aparece no topo da lista de pacientes quando há aniversariantes hoje
 * ou na semana. Permite operador ligar/mandar parabéns rapidamente.
 * Tabs internas pra trocar entre períodos sem refresh.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cake, Phone, Loader2, ChevronRight } from 'lucide-react';
import api from '@/lib/api';
import { PatientAvatar } from '@/components/PatientAvatar';

interface Birthday {
  id: string;
  name: string;
  phone: string | null;
  birth_date: string;
  age_turning: number;
  avatar_url: string | null;
}

const PERIODS = [
  { v: 'today', l: 'Hoje' },
  { v: 'week',  l: 'Semana' },
  { v: 'month', l: 'Mês' },
] as const;

type Period = typeof PERIODS[number]['v'];

export default function BirthdaysCard() {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>('today');
  const [list, setList] = useState<Birthday[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<Birthday[]>(`/patients/birthdays?period=${period}`)
      .then((r) => { if (!cancelled) setList(r.data || []); })
      .catch(() => { if (!cancelled) setList([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  // Não renderiza se não tem ninguém em nenhum período (evita poluir a tela)
  // Mas se está carregando ainda, espera.
  // Heurística: se period=today e lista vazia, ainda mostra o card pra
  // usuário poder trocar pra "semana"/"mês".
  if (!loading && list.length === 0 && period === 'today') {
    return null;
  }

  const formatBirthDay = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <Cake size={18} className="text-pink-500" />
          <h3 className="text-sm font-semibold text-foreground">Aniversariantes</h3>
        </div>
        <div className="flex gap-1 bg-background border border-border rounded-lg p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.v}
              onClick={() => setPeriod(p.v)}
              className={`px-2.5 py-1 rounded text-xs font-medium ${
                period === p.v
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.l}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="py-3 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Carregando...
        </div>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Ninguém faz aniversário {period === 'week' ? 'esta semana' : 'este mês'}.
        </p>
      ) : (
        <ul className="space-y-1.5 max-h-64 overflow-y-auto">
          {list.map((p) => (
            <li
              key={p.id}
              onClick={() => router.push(`/atendimento/pacientes/${p.id}`)}
              className="flex items-center justify-between gap-3 p-2 rounded hover:bg-accent/50 cursor-pointer text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <PatientAvatar
                  patientId={p.id}
                  patientName={p.name}
                  avatarUrl={p.avatar_url}
                  size={28}
                  shape="circle"
                />
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    <span>{formatBirthDay(p.birth_date)}</span>
                    <span>•</span>
                    <span>{p.age_turning} anos</span>
                    {p.phone && (
                      <>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <Phone size={10} /> {p.phone}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <ChevronRight size={14} className="text-muted-foreground shrink-0" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
