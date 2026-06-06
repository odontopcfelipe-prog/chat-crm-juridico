/**
 * Onda 17.32.90 — Landing page do Odonto System (SaaS).
 *
 * Server Component puro: nada de useState/useEffect, renderiza HTML
 * estatico no servidor (otimo pra SEO + first paint). As animacoes
 * vivem em LandingInteractions.tsx (ilha client).
 */
import Link from 'next/link';
import { LandingInteractions } from './LandingInteractions';

// ─── Icones inline (SVG, sem dep externa) ─────────────────────
const IcoChat = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const IcoMoney = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="1" x2="12" y2="23" />
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
);
const IcoCal = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);
const IcoDoc = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </svg>
);
const IcoHeart = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </svg>
);
const IcoChart = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="20" x2="12" y2="10" />
    <line x1="18" y1="20" x2="18" y2="4" />
    <line x1="6" y1="20" x2="6" y2="16" />
  </svg>
);
const IcoCheck = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const IcoArrow = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </svg>
);

// ─── Marquee items ─────────────────────────────────────────────
const MARQUEE = [
  'WhatsApp Evolution',
  'Cobrança Asaas',
  'PIX automático',
  'Boleto + Cartão',
  'ClickSign integrado',
  'Asaas Tap (presencial)',
  'IA pra atendimento',
  'Agenda inteligente',
  'Anamnese digital',
  'Prontuário completo',
  'Relatórios financeiros',
];

// ─── Planos ────────────────────────────────────────────────────
const PLANS = [
  {
    name: 'Starter',
    desc: 'Pra clínicas pequenas começando',
    price: 199,
    featured: false,
    features: [
      'Até 5 usuários',
      'Até 300 pacientes',
      '1 WhatsApp conectado',
      'Cobranças Asaas',
      'Agenda + prontuário',
    ],
  },
  {
    name: 'Pro',
    desc: 'Pra clínicas em crescimento',
    price: 399,
    featured: true,
    features: [
      'Tudo do Starter',
      'Até 20 usuários',
      'Até 3000 pacientes',
      '3 WhatsApps conectados',
      'ClickSign integrado',
      'Relatórios avançados',
    ],
  },
  {
    name: 'Enterprise',
    desc: 'Pra redes e franquias',
    price: 999,
    featured: false,
    features: [
      'Tudo do Pro',
      'Usuários ilimitados',
      'Pacientes ilimitados',
      'Até 10 WhatsApps',
      'Multi-unidade',
      'Suporte prioritário',
    ],
  },
];

// ─── FAQ ───────────────────────────────────────────────────────
const FAQ = [
  {
    q: 'Como funciona o teste grátis de 14 dias?',
    a: 'Você cria a conta sem cartão de crédito, libera o sistema inteiro por 14 dias e só decide o plano se quiser continuar. Depois do trial, escolhe o plano que cabe na operação — sem multa, sem fidelidade.',
  },
  {
    q: 'Preciso ter conta Asaas pra cobrar pacientes?',
    a: 'Sim — a cobrança automática (PIX, boleto e cartão) usa o Asaas como gateway. A conta é grátis pra abrir, e o Asaas já é integrado: você cola a chave e cobra em segundos. Se preferir, pode operar sem isso e gerar cobranças manuais.',
  },
  {
    q: 'O WhatsApp do meu paciente vai pra plataforma de quem?',
    a: 'Cada clínica conecta seu próprio número via Evolution API. As conversas ficam no seu tenant, isoladas. Outros tenants não veem nada do seu — nem nossa equipe acessa sem autorização.',
  },
  {
    q: 'E se eu quiser migrar depois?',
    a: 'Você é dono dos seus dados. A qualquer momento exportamos pacientes, agenda, financeiro e prontuário em CSV/PDF pra você levar. Sem cláusula de retenção.',
  },
  {
    q: 'Posso trocar de plano sem perder dados?',
    a: 'Sim. Trocar de Starter pra Pro ou de Pro pra Enterprise é 1 clique. Limites de uso aumentam imediatamente; o que já tá lá fica.',
  },
];

// ─── Componente principal ─────────────────────────────────────
export function OdontoLanding() {
  return (
    <div className="odlp">
      {/* ── Header ───────────────────────────────────────────── */}
      <header className="od-header">
        <div className="od-container od-header-inner">
          <Link href="/lp" className="od-logo" aria-label="Odonto System">
            <span className="od-logo-dot" />
            <span>ODONTO SYSTEM</span>
          </Link>
          <nav className="od-nav" aria-label="Principal">
            <a href="#features">Funcionalidades</a>
            <a href="#planos">Planos</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="od-header-cta">
            <Link href="/atendimento/login" className="od-btn od-btn-ghost">
              Entrar
            </Link>
            <Link href="/cadastrar" className="od-btn od-btn-primary">
              Começar grátis <IcoArrow />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="od-hero">
        <div className="od-container od-hero-grid">
          <div data-reveal>
            <span className="od-badge">
              <span className="od-badge-dot" />
              14 dias grátis · sem cartão
            </span>
            <h1>
              O sistema completo<br />
              pra sua clínica <em>odontológica</em>.
            </h1>
            <p>
              Pacientes, agenda, WhatsApp, cobrança Asaas, contratos
              digitais e relatórios — tudo num lugar, na mão da sua equipe.
            </p>
            <div className="od-hero-ctas">
              <Link href="/cadastrar" className="od-btn od-btn-primary od-btn-large">
                Começar grátis <IcoArrow />
              </Link>
              <Link href="/atendimento/login" className="od-btn od-btn-ghost od-btn-large">
                Já sou cliente
              </Link>
            </div>
            <div className="od-hero-trust">
              <span><strong>+10 anos</strong> de odontologia digital</span>
              <span>·</span>
              <span>Sem fidelidade</span>
              <span>·</span>
              <span>Dados seus</span>
            </div>
          </div>

          {/* Visual à direita (mockup com gráfico) */}
          <div className="od-hero-visual" data-reveal style={{ ['--od-delay' as string]: '150ms' }}>
            <div className="od-visual-card od-visual-card-big">
              <span className="od-visual-tag">Faturamento · 7d</span>
              <div className="od-visual-bar">
                <svg viewBox="0 0 320 88" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id="odlpLineGrad" x1="0" x2="1">
                      <stop offset="0" stopColor="#C8FF3D" stopOpacity="0.3" />
                      <stop offset="1" stopColor="#C8FF3D" stopOpacity="1" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M 0 70 L 32 64 L 64 52 L 96 56 L 128 40 L 160 44 L 192 28 L 224 32 L 256 18 L 288 22 L 320 8"
                    fill="none"
                    stroke="url(#odlpLineGrad)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M 0 70 L 32 64 L 64 52 L 96 56 L 128 40 L 160 44 L 192 28 L 224 32 L 256 18 L 288 22 L 320 8 L 320 88 L 0 88 Z"
                    fill="#C8FF3D"
                    fillOpacity="0.08"
                  />
                </svg>
              </div>
              <div className="od-visual-row">
                <span>PIX</span>
                <span className="od-money">R$ 2.480</span>
              </div>
              <div className="od-visual-row">
                <span>Boleto</span>
                <span className="od-money">R$ 1.200</span>
              </div>
            </div>
            <div className="od-visual-card od-visual-card-small">
              <span className="od-visual-tag">Satisfação</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                <div style={{ fontSize: 36, fontFamily: 'var(--font-bricolage), system-ui', fontWeight: 800, color: '#FAFAFA', lineHeight: 1 }}>
                  98%
                </div>
                <div style={{ fontSize: 11, color: '#A1A1AA', lineHeight: 1.3 }}>dos pacientes</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Marquee de integrações ─────────────────────────── */}
      <div className="od-marquee" aria-hidden="true">
        <div className="od-marquee-track">
          {[...MARQUEE, ...MARQUEE].map((item, i) => (
            <span className="od-marquee-item" key={i}>
              <span className="od-marquee-item-dot" />
              {item}
            </span>
          ))}
        </div>
      </div>

      {/* ── Bento Grid de features ────────────────────────── */}
      <section className="od-section" id="features">
        <div className="od-container">
          <div className="od-section-header" data-reveal>
            <span className="od-eyebrow">Funcionalidades</span>
            <h2>Tudo que sua clínica precisa, sem firula.</h2>
            <p>
              WhatsApp, cobrança, agenda, prontuário e relatórios numa
              plataforma só — sem precisar costurar 5 ferramentas.
            </p>
          </div>

          <div className="od-bento">
            <div className="od-bento-item od-bento-big" data-reveal>
              <div className="od-bento-icon"><IcoChat /></div>
              <div>
                <h3 className="od-bento-title">WhatsApp + IA</h3>
                <p className="od-bento-desc">
                  Conecte seu número, atenda em equipe, transcreva áudios
                  e use IA pra responder primeiro. Conversas salvas no
                  prontuário do paciente automaticamente.
                </p>
              </div>
            </div>

            <div className="od-bento-item od-bento-med" data-reveal style={{ ['--od-delay' as string]: '60ms' }}>
              <div className="od-bento-icon"><IcoMoney /></div>
              <div>
                <h3 className="od-bento-title">Cobrança Asaas</h3>
                <p className="od-bento-desc">
                  PIX, boleto, cartão e Asaas Tap presencial. Webhook
                  automático: quando pagam, o status muda sozinho.
                </p>
              </div>
            </div>

            <div className="od-bento-item od-bento-med" data-reveal style={{ ['--od-delay' as string]: '120ms' }}>
              <div className="od-bento-icon"><IcoCal /></div>
              <div>
                <h3 className="od-bento-title">Agenda inteligente</h3>
                <p className="od-bento-desc">
                  Cadeiras, dentistas, recorrência e lembretes automáticos
                  por WhatsApp 24h antes da consulta.
                </p>
              </div>
            </div>

            <div className="od-bento-item od-bento-small" data-reveal style={{ ['--od-delay' as string]: '180ms' }}>
              <div className="od-bento-icon"><IcoDoc /></div>
              <h3 className="od-bento-title">Contratos ClickSign</h3>
              <p className="od-bento-desc">Assinatura digital com validade legal.</p>
            </div>

            <div className="od-bento-item od-bento-small" data-reveal style={{ ['--od-delay' as string]: '240ms' }}>
              <div className="od-bento-icon"><IcoHeart /></div>
              <h3 className="od-bento-title">Prontuário completo</h3>
              <p className="od-bento-desc">Anamnese, odontograma e histórico clínico.</p>
            </div>

            <div className="od-bento-item od-bento-small" data-reveal style={{ ['--od-delay' as string]: '300ms' }}>
              <div className="od-bento-icon"><IcoChart /></div>
              <h3 className="od-bento-title">Relatórios</h3>
              <p className="od-bento-desc">Faturamento, inadimplência e ROI por dentista.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats com contadores ──────────────────────────── */}
      <section className="od-section" style={{ paddingTop: 0 }}>
        <div className="od-container">
          <div className="od-stats" data-reveal>
            <div className="od-stat">
              <div className="od-stat-num" data-counter="10" data-counter-suffix="+">0</div>
              <div className="od-stat-label">Anos de mercado</div>
            </div>
            <div className="od-stat">
              <div className="od-stat-num" data-counter="3000" data-counter-suffix="+">0</div>
              <div className="od-stat-label">Pacientes atendidos</div>
            </div>
            <div className="od-stat">
              <div className="od-stat-num" data-counter="98" data-counter-suffix="%">0</div>
              <div className="od-stat-label">Satisfação</div>
            </div>
            <div className="od-stat">
              <div className="od-stat-num" data-counter="24" data-counter-suffix="/7">0</div>
              <div className="od-stat-label">Sistema online</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Planos ──────────────────────────────────────────── */}
      <section className="od-section" id="planos">
        <div className="od-container">
          <div className="od-section-header" data-reveal>
            <span className="od-eyebrow">Planos</span>
            <h2>Preço justo. Trial de 14 dias.</h2>
            <p>
              Comece grátis, sem cartão de crédito. Quando quiser, escolhe
              o plano que cabe no tamanho da sua clínica.
            </p>
          </div>

          <div className="od-plans">
            {PLANS.map((plan, i) => (
              <div
                key={plan.name}
                className={`od-plan ${plan.featured ? 'od-plan-featured' : ''}`}
                data-reveal
                style={{ ['--od-delay' as string]: `${i * 80}ms` }}
              >
                {plan.featured && <span className="od-plan-tag">Mais escolhido</span>}
                <div className="od-plan-name">{plan.name}</div>
                <div className="od-plan-desc">{plan.desc}</div>
                <div className="od-plan-price">
                  <span className="od-plan-price-amount">R$ {plan.price}</span>
                  <span className="od-plan-price-period">/mês</span>
                </div>
                <ul className="od-plan-features">
                  {plan.features.map((f) => (
                    <li key={f}>
                      <span className="od-plan-check"><IcoCheck /></span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link href="/cadastrar" className="od-plan-cta">
                  Começar com {plan.name}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────────────── */}
      <section className="od-section" id="faq">
        <div className="od-container">
          <div className="od-section-header" data-reveal>
            <span className="od-eyebrow">Perguntas frequentes</span>
            <h2>A gente já respondeu, é só clicar.</h2>
          </div>
          <div className="od-faq">
            {FAQ.map((item, i) => (
              <details
                key={i}
                className="od-faq-item"
                data-reveal
                style={{ ['--od-delay' as string]: `${i * 50}ms` }}
              >
                <summary className="od-faq-summary">{item.q}</summary>
                <div className="od-faq-answer">{item.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA final ──────────────────────────────────────── */}
      <section className="od-section">
        <div className="od-container">
          <div className="od-final-cta" data-reveal>
            <h2>Pronto pra modernizar sua clínica?</h2>
            <p>
              Comece em 2 minutos, sem cartão. Cancele quando quiser —
              seus dados são seus.
            </p>
            <div className="od-hero-ctas" style={{ justifyContent: 'center', marginBottom: 0 }}>
              <Link href="/cadastrar" className="od-btn od-btn-primary od-btn-large">
                Criar conta grátis <IcoArrow />
              </Link>
              <Link href="/atendimento/login" className="od-btn od-btn-ghost od-btn-large">
                Já sou cliente
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="od-footer">
        <div className="od-container">
          <div className="od-footer-grid">
            <div>
              <div className="od-logo">
                <span className="od-logo-dot" />
                <span>ODONTO SYSTEM</span>
              </div>
              <p className="od-footer-desc">
                Sistema de gestão odontológica multi-clínica.
                Feito pra simplificar o dia a dia da sua equipe.
              </p>
            </div>
            <div className="od-footer-col">
              <h4>Produto</h4>
              <ul>
                <li><a href="#features">Funcionalidades</a></li>
                <li><a href="#planos">Planos</a></li>
                <li><a href="#faq">FAQ</a></li>
              </ul>
            </div>
            <div className="od-footer-col">
              <h4>Acesso</h4>
              <ul>
                <li><Link href="/atendimento/login">Entrar</Link></li>
                <li><Link href="/cadastrar">Criar conta</Link></li>
                <li><Link href="/atendimento/billing">Assinatura</Link></li>
              </ul>
            </div>
            <div className="od-footer-col">
              <h4>Contato</h4>
              <ul>
                <li><a href="mailto:contato@institutoodontopassos.com.br">contato@…</a></li>
                <li><a href="https://wa.me/5582996390799" target="_blank" rel="noopener noreferrer">WhatsApp</a></li>
              </ul>
            </div>
          </div>
          <div className="od-footer-bottom">
            <span>© {new Date().getFullYear()} Odonto System. Todos os direitos reservados.</span>
            <span>Feito em Arapiraca/AL.</span>
          </div>
        </div>
      </footer>

      {/* Ilha client — anima reveal + contadores depois do mount */}
      <LandingInteractions />
    </div>
  );
}
