'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, Eye, MessageCircle, Plus, Pencil, Trash2, BarChart2, X } from 'lucide-react';
import api from '@/lib/api';

interface LandingPage {
  id: string;
  title: string;
  slug: string;
  is_published: boolean;
  whatsapp_number?: string;
  gtm_id?: string;
  views_count: number;
  clicks_count: number;
  created_at: string;
}

interface Analytics {
  total_views: number;
  total_clicks: number;
  conversion_rate: string;
  by_source: { source: string; medium: string | null; campaign: string | null; views: number; clicks: number }[];
  by_day: { date: string; views: number; clicks: number }[];
}

export default function LandingPagesManager() {
  const router = useRouter();
  const [pages, setPages] = useState<LandingPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyticsPageId, setAnalyticsPageId] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  useEffect(() => {
    fetchPages();
  }, []);

  async function fetchPages() {
    try {
      const res = await api.get('/landing-pages');
      setPages(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function togglePublish(page: LandingPage) {
    await api.patch(`/landing-pages/${page.id}`, { is_published: !page.is_published });
    setPages((prev) =>
      prev.map((p) => (p.id === page.id ? { ...p, is_published: !p.is_published } : p)),
    );
  }

  async function deletePage(id: string) {
    if (!confirm('Deletar esta landing page? Esta ação não pode ser desfeita.')) return;
    await api.delete(`/landing-pages/${id}`);
    setPages((prev) => prev.filter((p) => p.id !== id));
  }

  async function openAnalytics(id: string) {
    if (analyticsPageId === id) { setAnalyticsPageId(null); setAnalytics(null); return; }
    setAnalyticsPageId(id);
    setAnalyticsLoading(true);
    try {
      const res = await api.get(`/landing-pages/${id}/analytics`);
      setAnalytics(res.data);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  const maxViews = analytics?.by_day ? Math.max(...analytics.by_day.map((d) => d.views), 1) : 1;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-foreground">Landing Pages</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Gerencie suas páginas de captura e monitore o desempenho
          </p>
        </div>
        <button
          onClick={() => router.push('/atendimento/marketing/landing-pages/new')}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity"
        >
          <Plus size={16} />
          Nova Landing Page
        </button>
      </div>

      {loading && (
        <div className="text-center py-16 text-muted-foreground">Carregando...</div>
      )}

      {!loading && pages.length === 0 && (
        <div className="text-center py-20 border-2 border-dashed border-border rounded-2xl">
          <p className="text-muted-foreground font-medium">Nenhuma landing page criada ainda.</p>
          <button
            onClick={() => router.push('/atendimento/marketing/landing-pages/new')}
            className="mt-4 px-4 py-2 rounded-xl bg-primary/10 text-primary font-semibold text-sm hover:bg-primary/20 transition-colors"
          >
            Criar primeira LP
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {pages.map((page) => {
          const convRate =
            page.views_count > 0
              ? ((page.clicks_count / page.views_count) * 100).toFixed(1)
              : '0.0';
          const isShowingAnalytics = analyticsPageId === page.id;

          return (
            <div
              key={page.id}
              className="border border-border bg-card rounded-2xl overflow-hidden flex flex-col"
            >
              {/* Card header */}
              <div className="p-5 border-b border-border/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-foreground truncate">{page.title}</h3>
                    <span className="inline-flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${page.is_published ? 'bg-emerald-500' : 'bg-amber-500'}`}
                      />
                      {page.is_published ? 'Publicada' : 'Rascunho'}
                    </span>
                  </div>
                  {page.is_published && (
                    <a
                      href={`/lp/${page.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                      title="Ver online"
                    >
                      <ExternalLink size={15} />
                    </a>
                  )}
                </div>
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-3 divide-x divide-border/50 bg-muted/20">
                <div className="p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mb-0.5">
                    Views
                  </p>
                  <p className="text-xl font-black text-foreground flex items-center justify-center gap-1">
                    <Eye size={14} className="text-muted-foreground" />
                    {page.views_count}
                  </p>
                </div>
                <div className="p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mb-0.5">
                    WhatsApp
                  </p>
                  <p className="text-xl font-black text-emerald-500 flex items-center justify-center gap-1">
                    <MessageCircle size={14} />
                    {page.clicks_count}
                  </p>
                </div>
                <div className="p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mb-0.5">
                    Conversão
                  </p>
                  <p className="text-xl font-black text-primary">{convRate}%</p>
                </div>
              </div>

              {/* Slug */}
              <div className="px-5 py-2 border-t border-border/50">
                <span className="text-[11px] text-muted-foreground font-mono bg-muted/40 px-2 py-0.5 rounded">
                  /lp/{page.slug}
                </span>
              </div>

              {/* Analytics panel */}
              {isShowingAnalytics && (
                <div className="border-t border-border/50 p-4 bg-muted/10">
                  {analyticsLoading ? (
                    <p className="text-xs text-muted-foreground text-center animate-pulse py-2">
                      Carregando analytics...
                    </p>
                  ) : analytics ? (
                    <div className="space-y-4">
                      {/* 7-day chart */}
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                          Últimos 7 dias
                        </p>
                        <div className="flex items-end gap-1 h-16">
                          {analytics.by_day.map((d) => (
                            <div key={d.date} className="flex-1 flex flex-col items-center gap-0.5">
                              <div
                                className="w-full bg-primary/60 rounded-sm transition-all"
                                style={{ height: `${(d.views / maxViews) * 48}px`, minHeight: d.views > 0 ? '2px' : '0' }}
                                title={`${d.date}: ${d.views} views`}
                              />
                              <span className="text-[8px] text-muted-foreground">
                                {d.date.slice(5)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Source breakdown */}
                      {analytics.by_source.length > 0 && (
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                            Origem do tráfego
                          </p>
                          <div className="space-y-1.5">
                            {analytics.by_source.map((s, i) => (
                              <div key={i} className="flex items-center justify-between text-xs">
                                <span className="text-foreground font-medium capitalize">
                                  {s.source === 'google_ads' ? '🎯 Google Ads' : s.source === 'organico' ? '🌱 Orgânico' : `📌 ${s.source}`}
                                  {s.campaign && <span className="text-muted-foreground ml-1">({s.campaign})</span>}
                                </span>
                                <span className="text-muted-foreground">
                                  {s.views}v · {s.clicks}c
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              )}

              {/* Actions */}
              <div className="p-4 border-t border-border/50 flex items-center gap-2 mt-auto">
                <button
                  onClick={() => openAnalytics(page.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    isShowingAnalytics
                      ? 'bg-primary/15 text-primary'
                      : 'bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {isShowingAnalytics ? <X size={13} /> : <BarChart2 size={13} />}
                  Analytics
                </button>
                <button
                  onClick={() => router.push(`/atendimento/marketing/landing-pages/${page.id}`)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <Pencil size={13} />
                  Editar
                </button>
                <button
                  onClick={() => togglePublish(page)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ml-auto ${
                    page.is_published
                      ? 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
                      : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
                  }`}
                >
                  {page.is_published ? 'Despublicar' : 'Publicar'}
                </button>
                <button
                  onClick={() => deletePage(page.id)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  title="Deletar"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
