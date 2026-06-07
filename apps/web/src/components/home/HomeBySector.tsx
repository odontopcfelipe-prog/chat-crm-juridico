'use client';

/**
 * Onda 17.32.118 — Home dirigida por setor (skill home-por-setor).
 *
 * Recebe `sector` resolvido pelo SERVIDOR (lembre: UI nao eh seguranca)
 * + `userName` + slot opcional pra reaproveitar o <SkyBackdrop/> que
 * ja esta em producao (skill ceu-saudacao).
 *
 * HIDRATACAO: usa hora fixa inicial (meio-dia neutro) pra evitar
 * mismatch entre servidor e cliente. useEffect corrige depois.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSector, type Sector } from '@crm/shared';
import './home-por-setor.css';

interface Props {
  /** Setor do usuario logado (resolvido no servidor) */
  sector: Sector;
  /** Primeiro nome do usuario pra saudacao */
  userName?: string;
  /** Slot opcional pra reusar o <SkyBackdrop/> de producao */
  skySlot?: React.ReactNode;
}

const DEFAULT_HOUR = 12; // estado neutro pro SSR

function greetingFor(hour: number): string {
  if (hour >= 5  && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export default function HomeBySector({ sector, userName, skySlot }: Props) {
  // Hora fixa no boot pra SSR/CSR baterem (sem hydration mismatch)
  const [hour, setHour] = useState(DEFAULT_HOUR);

  useEffect(() => {
    setHour(new Date().getHours());
    const t = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(t);
  }, []);

  const meta = getSector(sector);
  const greeting = greetingFor(hour);
  const firstName = userName?.trim().split(' ')[0] || 'visitante';

  return (
    <div className="home-bs" data-sector={meta.id}>
      {/* Hero (banner) — usa <skySlot/> de producao como fundo */}
      <section className="hb-hero">
        {/* Slot do ceu (opcional). Se nao vier nada, o background do
            .hb-hero ja eh um fallback gradient. */}
        {skySlot}
        <div className="hb-hero-content">
          <span className="hb-persona-chip">
            <span style={{ fontSize: 13 }}>{meta.icon}</span>
            {meta.home.persona}
          </span>
          <h1 className="hb-greeting">
            {greeting}, <em>{firstName}</em> 👋
          </h1>
          <p className="hb-subtitle">{meta.home.subtitle}</p>
        </div>
      </section>

      {/* Grade de acoes do setor */}
      <div className="hb-actions">
        {meta.home.actions.map((a) => (
          <Link
            key={a.label}
            href={a.href}
            className="hb-action"
            data-tone={a.tone ?? 'violet'}
          >
            <span className="hb-action-icon">{a.icon}</span>
            <span className="hb-action-label">{a.label}</span>
          </Link>
        ))}
      </div>

      {/* Afazeres tipicos do setor */}
      <div className="hb-todos">
        <p className="hb-todos-title">Pra hoje</p>
        <ul className="hb-todo-list">
          {meta.home.todos.map((todo) => (
            <li className="hb-todo" key={todo}>
              <span className="hb-todo-dot" />
              {todo}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
