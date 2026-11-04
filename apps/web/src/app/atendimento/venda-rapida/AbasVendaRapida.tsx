'use client';

/**
 * Abas do tópico Venda rápida, dentro da própria tela: o menu lateral mostra as mesmas
 * opções só quando está aberto, e parte da equipe não usa o menu lateral.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ABAS = [
  { href: '/atendimento/venda-rapida', label: 'Nova venda' },
  { href: '/atendimento/venda-rapida/vendas', label: 'Lista de vendas' },
  { href: '/atendimento/venda-rapida/produtos', label: 'Produtos' },
];

export default function AbasVendaRapida({ className = '' }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Venda rápida" className={`flex shrink-0 items-center gap-4 ${className}`}>
      {ABAS.map((aba) => {
        const ativa = pathname === aba.href;
        return (
          <Link
            key={aba.href}
            href={aba.href}
            aria-current={ativa ? 'page' : undefined}
            className={ativa ? 'font-semibold text-foreground underline underline-offset-4' : 'text-foreground/70 hover:text-foreground'}
          >
            {aba.label}
          </Link>
        );
      })}
    </nav>
  );
}
