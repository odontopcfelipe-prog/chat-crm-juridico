/**
 * Página pública de documento legal (/termos e /privacidade): cabeçalho com a
 * marca, título, data da versão, resumo, sumário com âncoras e as seções
 * numeradas. Componente de servidor (sem 'use client'), sem login.
 */
import Link from 'next/link';
import { ArrowLeft, FileText, ShieldCheck } from 'lucide-react';
import { EMPRESA_DA_PLATAFORMA, type BlocoLegal, type DocumentoLegal } from './documento-legal';

export type QualDocumento = 'termos' | 'privacidade';

const DOCUMENTOS: ReadonlyArray<{ chave: QualDocumento; href: string; rotulo: string }> = [
  { chave: 'termos', href: '/termos', rotulo: 'Termos de uso' },
  { chave: 'privacidade', href: '/privacidade', rotulo: 'Política de privacidade' },
];

const EMAIL = EMPRESA_DA_PLATAFORMA.email;
const EMAIL_NA_BUSCA = EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINKAVEIS = new RegExp('(' + EMAIL_NA_BUSCA + '|Política de Privacidade)');

/** Troca o e-mail de contato e a menção à Política de Privacidade por links. */
function comLinks(texto: string) {
  return texto.split(LINKAVEIS).map((parte, i) => {
    if (parte === EMAIL) {
      return (
        <a key={i} href={`mailto:${EMAIL}`} className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
          {parte}
        </a>
      );
    }
    if (parte === 'Política de Privacidade') {
      return (
        <Link key={i} href="/privacidade" className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
          {parte}
        </Link>
      );
    }
    return parte;
  });
}

function Bloco({ bloco }: { bloco: BlocoLegal }) {
  if (typeof bloco === 'string') {
    return <p className="text-[15px] leading-relaxed text-foreground/85">{comLinks(bloco)}</p>;
  }
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-foreground/85 marker:text-violet-500">
      {bloco.lista.map((item) => (
        <li key={item}>{comLinks(item)}</li>
      ))}
    </ul>
  );
}

export function PaginaLegal({ documento, atual }: { documento: DocumentoLegal; atual: QualDocumento }) {
  const outro = DOCUMENTOS.find((d) => d.chave !== atual)!;
  const Icone = atual === 'termos' ? FileText : ShieldCheck;

  return (
    <div className="flex-1 bg-background text-foreground">
      <header className="border-b border-border/70 print:hidden">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link href="/" className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-violet-600" />
            <span className="text-sm font-black uppercase tracking-tight">{EMPRESA_DA_PLATAFORMA.marca}</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1 text-xs font-bold">
            {DOCUMENTOS.map((d) => (
              <Link
                key={d.chave}
                href={d.href}
                aria-current={d.chave === atual ? 'page' : undefined}
                className={
                  d.chave === atual
                    ? 'rounded-full bg-violet-500/10 px-3 py-1.5 text-violet-700 dark:text-violet-300'
                    : 'rounded-full px-3 py-1.5 text-muted-foreground hover:text-violet-700 dark:hover:text-violet-300'
                }
              >
                {d.rotulo}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <article className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
        <div className="mb-8">
          <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-violet-500/10 text-violet-700 dark:text-violet-300">
            <Icone size={22} />
          </div>
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">{documento.titulo}</h1>
          <p className="mt-2 text-sm text-muted-foreground">Última atualização: {documento.atualizadoEm}</p>
        </div>

        <section aria-labelledby="em-resumo" className="mb-8 rounded-2xl border border-violet-500/25 bg-violet-500/5 p-5 sm:p-6">
          <h2 id="em-resumo" className="mb-3 text-sm font-black uppercase tracking-wide text-violet-700 dark:text-violet-300">
            Em resumo
          </h2>
          <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed marker:text-violet-500">
            {documento.resumo.map((item) => (
              <li key={item}>{comLinks(item)}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">Este resumo ajuda a leitura e não substitui o texto completo abaixo.</p>
        </section>

        <nav aria-labelledby="sumario" className="mb-10 rounded-2xl border border-border/70 p-5 sm:p-6 print:hidden">
          <h2 id="sumario" className="mb-3 text-sm font-black uppercase tracking-wide text-muted-foreground">
            Sumário
          </h2>
          <ol className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            {documento.secoes.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-foreground/80 hover:text-violet-700 hover:underline dark:hover:text-violet-300">
                  {i + 1}. {s.titulo}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-9">
          {documento.secoes.map((s, i) => (
            <section key={s.id} id={s.id} className="scroll-mt-6">
              <h2 className="mb-3 text-lg font-bold tracking-tight sm:text-xl">
                {i + 1}. {s.titulo}
              </h2>
              <div className="space-y-3">
                {s.blocos.map((b, j) => (
                  <Bloco key={j} bloco={b} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-14 flex flex-col gap-3 border-t border-border/70 pt-6 text-sm sm:flex-row sm:items-center sm:justify-between print:hidden">
          <Link href="/" className="inline-flex items-center gap-1.5 font-bold text-muted-foreground hover:text-violet-700 dark:hover:text-violet-300">
            <ArrowLeft size={14} />
            Voltar para o início
          </Link>
          <Link href={outro.href} className="font-bold text-violet-700 hover:underline dark:text-violet-300">
            Ler também: {outro.rotulo} →
          </Link>
        </footer>
      </article>
    </div>
  );
}
