'use client';

import { ExternalLink, FileText, Edit3, Eye, FileCheck2 } from 'lucide-react';

interface GoogleDocsEmbedProps {
  docUrl: string;
  editable?: boolean;
  className?: string;
  fullHeight?: boolean;
  petitionId?: string;
}

/**
 * Card de acesso ao Google Docs.
 *
 * Google bloqueia embeds via iframe (cookies de terceiros + X-Frame-Options).
 * Em vez de tentar forçar um iframe que não funciona, mostra um card limpo
 * com botão de acesso direto ao Google Docs — igual Notion, Slack, etc.
 *
 * O usuário clica em "Editar no Google Docs" e abre em nova aba com
 * experiência completa (formatação, comentários, revisão, etc).
 */
export default function GoogleDocsEmbed({
  docUrl,
  editable = true,
  className = '',
  fullHeight = true,
}: GoogleDocsEmbedProps) {
  if (!docUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-64 bg-base-200/50 border border-base-300 rounded-xl text-base-content/50 gap-2">
        <FileText className="w-8 h-8 opacity-40" />
        <p className="text-sm">Google Doc nao disponivel</p>
      </div>
    );
  }

  // Extrair base URL do doc (sem /edit, /preview, query strings)
  const baseUrl = docUrl.replace(/\/(edit|preview|pub).*$/, '');
  const editUrl = baseUrl + '/edit';
  const previewUrl = baseUrl + '/preview';

  const containerStyle = fullHeight
    ? { minHeight: 'calc(100vh - 250px)' }
    : { minHeight: '400px' };

  return (
    <div className={`w-full flex flex-col ${className}`} style={containerStyle}>
      {/* Card principal */}
      <div className="flex-1 flex flex-col items-center justify-center bg-base-200/30 border border-base-300 rounded-xl p-8 gap-6">
        {/* Icone */}
        <div className="relative">
          <div className="w-20 h-20 rounded-2xl bg-blue-500/10 flex items-center justify-center">
            <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" stroke="currentColor" strokeWidth="1.5" className="text-blue-500" />
              <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" className="text-blue-500" />
              <path d="M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-blue-400" />
            </svg>
          </div>
          <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-emerald-500 flex items-center justify-center shadow-lg">
            <FileCheck2 className="w-4 h-4 text-white" />
          </div>
        </div>

        {/* Texto */}
        <div className="text-center space-y-2 max-w-sm">
          <h3 className="text-lg font-semibold text-base-content">
            Documento no Google Docs
          </h3>
          <p className="text-sm text-base-content/60">
            {editable
              ? 'Clique abaixo para abrir e editar no Google Docs. Todas as alteracoes sao salvas automaticamente.'
              : 'Clique abaixo para visualizar o documento no Google Docs.'}
          </p>
        </div>

        {/* Botoes */}
        <div className="flex flex-col sm:flex-row items-center gap-3">
          {editable && (
            <a
              href={editUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 hover:scale-[1.02] active:scale-[0.98]"
            >
              <Edit3 className="w-5 h-5" />
              Editar no Google Docs
              <ExternalLink className="w-4 h-4 opacity-70" />
            </a>
          )}

          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-5 py-2.5 bg-base-200 hover:bg-base-300 text-base-content/70 hover:text-base-content font-medium rounded-xl transition-colors border border-base-300"
          >
            <Eye className="w-4 h-4" />
            Visualizar
          </a>
        </div>

        {/* Info */}
        <div className="flex items-center gap-4 text-[11px] text-base-content/40 mt-2">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Salvamento automatico
          </span>
          <span>Formatacao completa</span>
          <span>Comentarios e revisao</span>
        </div>
      </div>
    </div>
  );
}
