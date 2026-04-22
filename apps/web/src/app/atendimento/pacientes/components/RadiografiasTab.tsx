'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Image as ImgIcon, Loader2, X, Calendar, FileText, Trash2, Download, Eye,
} from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Exam {
  id: string;
  exam_type: string;
  tooth_fdi: string | null;
  performed_at: string | null;
  received_at: string;
  source: string;
  status: string;
  report_text: string | null;
  report_html: string | null;
  notes: string | null;
  provider?: { id: string; name: string; source_slug: string } | null;
}

const TYPE_LABEL: Record<string, string> = {
  PANORAMIC:  'Panorâmica',
  PERIAPICAL: 'Periapical',
  BITEWING:   'Interproximal',
  OCCLUSAL:   'Oclusal',
  LATERAL:    'Lateral',
  PA:         'PA',
  CT:         'Tomografia',
  CBCT:       'CBCT (3D)',
  OTHER:      'Outro',
};

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  RECEIVED:  { label: 'Não vinculado', cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  LINKED:    { label: 'Vinculado',     cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  DISCARDED: { label: 'Descartado',    cls: 'bg-gray-500/10 text-gray-700 border-gray-500/20' },
};

function imgUrl(examId: string): string {
  return `${API_BASE_URL}/radiography-exams/${examId}/image`;
}

export default function RadiografiasTab({ patientId }: { patientId: string }) {
  const [loading, setLoading] = useState(true);
  const [exams, setExams] = useState<Exam[]>([]);
  const [viewing, setViewing] = useState<Exam | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Exam[]>(`/patients/${patientId}/radiography-exams`);
      setExams(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar radiografias');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  const discard = async (id: string) => {
    if (!confirm('Descartar esta radiografia? Ela continuara salva mas nao aparecera no prontuario.')) return;
    try {
      await api.post(`/radiography-exams/${id}/discard`);
      showSuccess('Descartada');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro');
    }
  };

  const visible = exams.filter((e) => e.status !== 'DISCARDED');

  return (
    <div>
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <ImgIcon size={16} className="text-primary" /> Radiografias / Imagens
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Exames recebidos automaticamente de centros radiologicos parceiros
            (Image2Doc, Proradis, etc.) ou enviados manualmente.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : visible.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground bg-card border border-border rounded-xl">
          <ImgIcon size={28} className="mx-auto mb-2 opacity-40" />
          <p>Nenhuma radiografia para este paciente.</p>
          <p className="text-xs mt-1">
            Configure parceiros radiologicos em Configuracoes &gt; Radiologia para receber automaticamente.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {visible.map((e) => {
            const cfg = STATUS_CFG[e.status] || STATUS_CFG.RECEIVED;
            return (
              <div key={e.id} className="bg-card border border-border rounded-xl overflow-hidden group">
                <button
                  onClick={() => setViewing(e)}
                  className="block w-full aspect-square bg-black relative"
                >
                  <img
                    src={imgUrl(e.id)}
                    alt={TYPE_LABEL[e.exam_type] || e.exam_type}
                    className="w-full h-full object-contain"
                    crossOrigin="use-credentials"
                  />
                  <span className="absolute top-1 left-1 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded">
                    {TYPE_LABEL[e.exam_type] || e.exam_type}
                    {e.tooth_fdi && ` · ${e.tooth_fdi}`}
                  </span>
                  <span className={`absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded border ${cfg.cls}`}>
                    {cfg.label}
                  </span>
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <Eye size={28} className="text-white" />
                  </div>
                </button>
                <div className="p-2 text-xs">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Calendar size={10} />
                    {new Date(e.performed_at || e.received_at).toLocaleDateString('pt-BR')}
                  </div>
                  {e.provider?.name && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      via {e.provider.name}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewing && (
        <ExamViewer
          exam={viewing}
          onClose={() => setViewing(null)}
          onDiscard={() => { discard(viewing.id); setViewing(null); }}
        />
      )}
    </div>
  );
}

function ExamViewer({
  exam, onClose, onDiscard,
}: { exam: Exam; onClose: () => void; onDiscard: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-4xl shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-3 border-b border-border">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              {TYPE_LABEL[exam.exam_type] || exam.exam_type}
              {exam.tooth_fdi && (
                <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">
                  Dente {exam.tooth_fdi}
                </span>
              )}
            </h2>
            <p className="text-xs text-muted-foreground">
              {new Date(exam.performed_at || exam.received_at).toLocaleString('pt-BR')}
              {exam.provider?.name && ` · via ${exam.provider.name}`}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <a
              href={imgUrl(exam.id)}
              download={`radiografia-${exam.id}.jpg`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded hover:bg-accent"
              title="Baixar"
            >
              <Download size={16} />
            </a>
            <button
              onClick={onDiscard}
              className="p-2 rounded hover:bg-destructive/10 text-destructive"
              title="Descartar"
            >
              <Trash2 size={16} />
            </button>
            <button onClick={onClose} className="p-2 rounded hover:bg-accent">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 bg-black overflow-auto flex items-center justify-center min-h-[400px]">
          <img
            src={imgUrl(exam.id)}
            alt={TYPE_LABEL[exam.exam_type] || exam.exam_type}
            className="max-w-full max-h-[70vh] object-contain"
            crossOrigin="use-credentials"
          />
        </div>

        {(exam.report_text || exam.report_html) && (
          <div className="p-3 border-t border-border max-h-[200px] overflow-y-auto">
            <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground mb-2">
              <FileText size={11} /> Laudo
            </div>
            {exam.report_html ? (
              <div className="prose prose-sm" dangerouslySetInnerHTML={{ __html: exam.report_html }} />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{exam.report_text}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
