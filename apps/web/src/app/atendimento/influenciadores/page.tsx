'use client';

/**
 * Influenciadores — hub de marketing (parcerias + mensagens automáticas).
 *
 * Container com 4 tabs:
 *  - Lista        → CRUD de influenciadores (cadastro original)
 *  - Templates    → biblioteca de textos com variáveis {{nome}} etc
 *  - Agendamentos → campanhas (ONCE / RECURRING + filtros + manual)
 *  - Histórico    → log de envios (read-only, paginado)
 *
 * Acesso restrito a ADMIN (gated no backend + guard de UI).
 * Deep-link via ?tab=templates|schedules|history (default = lista).
 */
import { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Megaphone, Users, FileText, Calendar, History, Loader2 } from 'lucide-react';
import { useRole } from '@/lib/useRole';
import { ListTab } from './_tabs/list-tab';
import { TemplatesTab } from './_tabs/templates-tab';
import { SchedulesTab } from './_tabs/schedules-tab';
import { HistoryTab } from './_tabs/history-tab';

type TabKey = 'lista' | 'templates' | 'schedules' | 'history';

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
  { key: 'lista',     label: 'Influenciadores', icon: Users },
  { key: 'templates', label: 'Templates',       icon: FileText },
  { key: 'schedules', label: 'Agendamentos',    icon: Calendar },
  { key: 'history',   label: 'Histórico',       icon: History },
];

export default function InfluencersPage() {
  return (
    <Suspense fallback={
      <div className="p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    }>
      <InfluencersPageInner />
    </Suspense>
  );
}

function InfluencersPageInner() {
  const perms = useRole();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Tab inicial vinda da URL — fallback: lista
  const tabFromUrl = (searchParams.get('tab') as TabKey) || 'lista';
  const initialTab: TabKey = TABS.some(t => t.key === tabFromUrl) ? tabFromUrl : 'lista';
  const [tab, setTab] = useState<TabKey>(initialTab);

  // Sincroniza tab → URL (sem recarregar), útil pra compartilhar link / voltar
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === 'lista') params.delete('tab');
    else params.set('tab', tab);
    const qs = params.toString();
    router.replace(`/atendimento/influenciadores${qs ? `?${qs}` : ''}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  if (!perms.isAdmin) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-amber-700 dark:text-amber-300">
          <p className="font-semibold mb-1">Acesso restrito</p>
          <p className="text-sm">O cadastro de influenciadores é restrito a administradores.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="w-full p-4 md:p-6">

        {/* ─── Header ─── */}
        <header className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <Megaphone size={20} strokeWidth={2.2} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Influenciadores</h1>
            <p className="text-xs text-muted-foreground">
              Cadastro de parcerias + mensagens automáticas via WhatsApp
            </p>
          </div>
        </header>

        {/* ─── Tabs ─── */}
        <div className="border-b border-border mb-5 -mx-1 overflow-x-auto no-scrollbar">
          <nav className="flex gap-1 px-1">
            {TABS.map(t => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    active
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                  }`}
                >
                  <Icon size={15} strokeWidth={active ? 2.5 : 2} /> {t.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* ─── Tab content ─── */}
        {tab === 'lista'     && <ListTab />}
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'schedules' && <SchedulesTab />}
        {tab === 'history'   && <HistoryTab />}
      </div>
    </div>
  );
}
