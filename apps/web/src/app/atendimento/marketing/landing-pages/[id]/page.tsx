'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, ExternalLink, Plus, Trash2 } from 'lucide-react';
import api from '@/lib/api';

interface LPContent {
  hero: {
    title: string;
    subtitle: string;
    ctaText: string;
    ctaLink?: string;
    bgImage?: string;
  };
  steps: { title: string; description: string }[];
  faq: { question: string; answer: string }[];
  footer: {
    address?: string;
    email?: string;
    phones: string[];
    social: { instagram?: string; facebook?: string; linkedin?: string };
  };
}

const DEFAULT_CONTENT: LPContent = {
  hero: {
    title: 'Advocacia Especializada em Direito Trabalhista',
    subtitle: 'Protegendo seus direitos com agilidade e transparência. Fale com um especialista hoje mesmo.',
    ctaText: 'Falar com Especialista',
    ctaLink: 'https://wa.me/5582996390799',
    bgImage: '',
  },
  steps: [
    { title: 'Entre em Contato', description: 'Envie uma mensagem no WhatsApp explicando seu caso.' },
    { title: 'Análise Gratuita', description: 'Nossa equipe analisará sua situação sem custo.' },
    { title: 'Solução Jurídica', description: 'Apresentamos a melhor estratégia para seu caso.' },
  ],
  faq: [
    { question: 'Como funciona a consulta?', answer: 'A consulta é 100% online via WhatsApp ou vídeo chamada.' },
  ],
  footer: {
    phones: ['82 99639-0799'],
    email: 'contato@andrelustosa.com.br',
    address: 'Atendimento Digital em Todo o Brasil',
    social: { instagram: 'https://instagram.com/andrelustosaadvogados', facebook: '', linkedin: '' },
  },
};

interface PageProps {
  params: Promise<{ id: string }>;
}

type Tab = 'hero' | 'steps' | 'faq' | 'footer' | 'config';

export default function LPEditor({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const isNew = id === 'new';

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('hero');

  const [title, setTitle] = useState('Nova Landing Page');
  const [slug, setSlug] = useState('');
  const [isPublished, setIsPublished] = useState(false);
  const [whatsappNumber, setWhatsappNumber] = useState('+5582996390799');
  const [gtmId, setGtmId] = useState('');
  const [content, setContent] = useState<LPContent>(DEFAULT_CONTENT);

  useEffect(() => {
    if (!isNew) loadPage();
  }, [id]);

  async function loadPage() {
    try {
      const res = await api.get(`/landing-pages/${id}`);
      const p = res.data;
      setTitle(p.title);
      setSlug(p.slug);
      setIsPublished(p.is_published);
      setWhatsappNumber(p.whatsapp_number || '');
      setGtmId(p.gtm_id || '');
      setContent(p.content || DEFAULT_CONTENT);
    } catch {
      router.push('/atendimento/marketing/landing-pages');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        title,
        slug,
        is_published: isPublished,
        whatsapp_number: whatsappNumber,
        gtm_id: gtmId,
        content,
      };
      if (isNew) {
        await api.post('/landing-pages', payload);
        router.push('/atendimento/marketing/landing-pages');
      } else {
        await api.patch(`/landing-pages/${id}`, payload);
        alert('Salvo com sucesso!');
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      alert('Erro: ' + (err.response?.data?.message || 'tente novamente'));
    } finally {
      setSaving(false);
    }
  }

  const updateHero = (field: keyof LPContent['hero'], value: string) =>
    setContent((c) => ({ ...c, hero: { ...c.hero, [field]: value } }));

  const updateStep = (i: number, field: 'title' | 'description', value: string) =>
    setContent((c) => {
      const steps = [...c.steps];
      steps[i] = { ...steps[i], [field]: value };
      return { ...c, steps };
    });

  const addStep = () =>
    setContent((c) => ({ ...c, steps: [...c.steps, { title: '', description: '' }] }));

  const removeStep = (i: number) =>
    setContent((c) => ({ ...c, steps: c.steps.filter((_, idx) => idx !== i) }));

  const updateFaq = (i: number, field: 'question' | 'answer', value: string) =>
    setContent((c) => {
      const faq = [...c.faq];
      faq[i] = { ...faq[i], [field]: value };
      return { ...c, faq };
    });

  const addFaq = () =>
    setContent((c) => ({ ...c, faq: [...c.faq, { question: '', answer: '' }] }));

  const removeFaq = (i: number) =>
    setContent((c) => ({ ...c, faq: c.faq.filter((_, idx) => idx !== i) }));

  const updateFooter = (field: keyof Omit<LPContent['footer'], 'social' | 'phones'>, value: string) =>
    setContent((c) => ({ ...c, footer: { ...c.footer, [field]: value } }));

  const updateSocial = (field: keyof LPContent['footer']['social'], value: string) =>
    setContent((c) => ({
      ...c,
      footer: { ...c.footer, social: { ...c.footer.social, [field]: value } },
    }));

  const tabs: { id: Tab; label: string }[] = [
    { id: 'hero', label: 'Hero' },
    { id: 'steps', label: 'Passos' },
    { id: 'faq', label: 'FAQ' },
    { id: 'footer', label: 'Rodapé' },
    { id: 'config', label: 'Configurações' },
  ];

  const inputClass =
    'w-full px-3 py-2.5 rounded-xl border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all';

  const labelClass = 'block text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5';

  if (loading) {
    return <div className="p-8 text-muted-foreground animate-pulse">Carregando...</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/atendimento/marketing/landing-pages')}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="font-black text-foreground">{isNew ? 'Nova Landing Page' : title}</h1>
            {!isNew && slug && (
              <span className="text-[11px] text-muted-foreground font-mono">/lp/{slug}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isNew && isPublished && slug && (
            <a
              href={`/lp/${slug}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-muted-foreground border border-border hover:text-foreground transition-colors"
            >
              <ExternalLink size={14} />
              Preview
            </a>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            <Save size={15} />
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-6 pt-4 border-b border-border bg-card shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm font-semibold rounded-t-lg transition-colors ${
              activeTab === t.id
                ? 'bg-background border border-b-background border-border text-foreground -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-5">

          {/* Hero tab */}
          {activeTab === 'hero' && (
            <>
              <div>
                <label className={labelClass}>Título Principal</label>
                <textarea
                  rows={3}
                  value={content.hero.title}
                  onChange={(e) => updateHero('title', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Subtítulo</label>
                <textarea
                  rows={3}
                  value={content.hero.subtitle}
                  onChange={(e) => updateHero('subtitle', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Texto do Botão CTA</label>
                <input
                  value={content.hero.ctaText}
                  onChange={(e) => updateHero('ctaText', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Link do CTA (URL ou WhatsApp)</label>
                <input
                  value={content.hero.ctaLink || ''}
                  onChange={(e) => updateHero('ctaLink', e.target.value)}
                  placeholder="https://wa.me/5582996390799"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Imagem de Fundo (URL)</label>
                <input
                  value={content.hero.bgImage || ''}
                  onChange={(e) => updateHero('bgImage', e.target.value)}
                  placeholder="https://..."
                  className={inputClass}
                />
              </div>
            </>
          )}

          {/* Steps tab */}
          {activeTab === 'steps' && (
            <>
              {content.steps.map((step, i) => (
                <div key={i} className="border border-border rounded-xl p-4 space-y-3 bg-card">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                      Passo {i + 1}
                    </span>
                    <button
                      onClick={() => removeStep(i)}
                      className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div>
                    <label className={labelClass}>Título</label>
                    <input
                      value={step.title}
                      onChange={(e) => updateStep(i, 'title', e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Descrição</label>
                    <textarea
                      rows={2}
                      value={step.description}
                      onChange={(e) => updateStep(i, 'description', e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              ))}
              <button
                onClick={addStep}
                className="w-full py-3 border-2 border-dashed border-border rounded-xl text-sm font-semibold text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors flex items-center justify-center gap-2"
              >
                <Plus size={16} />
                Adicionar Passo
              </button>
            </>
          )}

          {/* FAQ tab */}
          {activeTab === 'faq' && (
            <>
              {content.faq.map((item, i) => (
                <div key={i} className="border border-border rounded-xl p-4 space-y-3 bg-card">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                      FAQ {i + 1}
                    </span>
                    <button
                      onClick={() => removeFaq(i)}
                      className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div>
                    <label className={labelClass}>Pergunta</label>
                    <input
                      value={item.question}
                      onChange={(e) => updateFaq(i, 'question', e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Resposta</label>
                    <textarea
                      rows={3}
                      value={item.answer}
                      onChange={(e) => updateFaq(i, 'answer', e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              ))}
              <button
                onClick={addFaq}
                className="w-full py-3 border-2 border-dashed border-border rounded-xl text-sm font-semibold text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors flex items-center justify-center gap-2"
              >
                <Plus size={16} />
                Adicionar Pergunta
              </button>
            </>
          )}

          {/* Footer tab */}
          {activeTab === 'footer' && (
            <>
              <div>
                <label className={labelClass}>Endereço</label>
                <input
                  value={content.footer.address || ''}
                  onChange={(e) => updateFooter('address', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>E-mail</label>
                <input
                  value={content.footer.email || ''}
                  onChange={(e) => updateFooter('email', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Instagram URL</label>
                <input
                  value={content.footer.social.instagram || ''}
                  onChange={(e) => updateSocial('instagram', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Facebook URL</label>
                <input
                  value={content.footer.social.facebook || ''}
                  onChange={(e) => updateSocial('facebook', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>LinkedIn URL</label>
                <input
                  value={content.footer.social.linkedin || ''}
                  onChange={(e) => updateSocial('linkedin', e.target.value)}
                  className={inputClass}
                />
              </div>
            </>
          )}

          {/* Config tab */}
          {activeTab === 'config' && (
            <>
              <div>
                <label className={labelClass}>Nome da Página</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Slug (URL)</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground shrink-0">/lp/</span>
                  <input
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))}
                    placeholder="minha-pagina"
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Número WhatsApp</label>
                <input
                  value={whatsappNumber}
                  onChange={(e) => setWhatsappNumber(e.target.value)}
                  placeholder="+5582996390799"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Google Tag Manager ID</label>
                <input
                  value={gtmId}
                  onChange={(e) => setGtmId(e.target.value)}
                  placeholder="GTM-XXXXXXX"
                  className={inputClass}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Insira seu ID do GTM para rastrear conversões no Google Ads e GA4.
                </p>
              </div>
              <div className="border border-border rounded-xl p-4 bg-card flex items-center justify-between">
                <div>
                  <p className="font-semibold text-foreground text-sm">Página Publicada</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {isPublished ? 'Visível em /lp/' + slug : 'Rascunho — não visível ao público'}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPublished}
                  onClick={() => setIsPublished((v) => !v)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none ${
                    isPublished ? 'bg-emerald-500' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
                      isPublished ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
