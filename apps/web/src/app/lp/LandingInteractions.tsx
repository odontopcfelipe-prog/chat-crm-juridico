'use client';

/**
 * Onda 17.32.90 — Ilha client da landing.
 *
 * Renderiza null (nao mexe no DOM no SSR) e so adiciona efeitos via
 * useEffect:
 *  1. Scroll reveal: classe odlp-revealed em [data-reveal]
 *  2. Contadores: anima 0 -> N nos [data-counter]
 *
 * Manter aqui pra preservar SEO: a marcacao da landing fica num Server
 * Component (OdontoLanding.tsx); so as interacoes precisam de browser.
 */
import { useEffect } from 'react';

export function LandingInteractions() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // ─── 1. Scroll reveal ───────────────────────────────────────
    const reveals = document.querySelectorAll<HTMLElement>('.odlp [data-reveal]');
    let revealIO: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window && reveals.length) {
      revealIO = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('odlp-revealed');
              revealIO?.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
      );
      reveals.forEach((el) => revealIO!.observe(el));
    } else {
      // Sem IO disponivel → revela tudo
      reveals.forEach((el) => el.classList.add('odlp-revealed'));
    }

    // ─── 2. Contadores ──────────────────────────────────────────
    const counters = document.querySelectorAll<HTMLElement>('.odlp [data-counter]');
    let counterIO: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window && counters.length) {
      counterIO = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const el = entry.target as HTMLElement;
            const target = parseInt(el.dataset.counter || '0', 10);
            const suffix = el.dataset.counterSuffix || '';
            const prefix = el.dataset.counterPrefix || '';
            const duration = 1800;
            const start = performance.now();
            const step = (now: number) => {
              const t = Math.min((now - start) / duration, 1);
              const eased = 1 - Math.pow(1 - t, 3);
              const value = Math.round(target * eased);
              el.textContent = `${prefix}${value.toLocaleString('pt-BR')}${suffix}`;
              if (t < 1) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
            counterIO?.unobserve(el);
          });
        },
        { threshold: 0.5 }
      );
      counters.forEach((el) => counterIO!.observe(el));
    } else {
      counters.forEach((el) => {
        const target = parseInt(el.dataset.counter || '0', 10);
        const suffix = el.dataset.counterSuffix || '';
        const prefix = el.dataset.counterPrefix || '';
        el.textContent = `${prefix}${target.toLocaleString('pt-BR')}${suffix}`;
      });
    }

    return () => {
      revealIO?.disconnect();
      counterIO?.disconnect();
    };
  }, []);

  return null;
}
