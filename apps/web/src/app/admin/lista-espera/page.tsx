'use client';

/**
 * Lista de espera do caminho "Laboratório de prótese" do /cadastrar (SUPER_ADMIN).
 * Cada linha é um laboratório que deixou o contato enquanto o cadastro de
 * laboratório não abre. O e-mail de aviso chega a cada inscrição nova.
 */
import { useEffect, useState } from 'react';
import { Loader2, FlaskConical, Phone, Mail, MapPin, MessageSquare } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface Inscricao {
  id: string;
  lab_name: string;
  contact_name: string;
  phone: string;
  email: string | null;
  city: string | null;
  created_at: string;
}

export default function AdminListaEsperaPage() {
  const [itens, setItens] = useState<Inscricao[] | null>(null);

  useEffect(() => {
    api
      .get<Inscricao[]>('/lab-waitlist')
      .then((r) => setItens(Array.isArray(r.data) ? r.data : []))
      .catch(() => {
        showError('Não foi possível carregar a lista de espera');
        setItens([]);
      });
  }, []);

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-xl font-extrabold text-foreground flex items-center gap-2">
          <FlaskConical size={18} className="text-violet-600" />
          Lista de espera — Laboratórios
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Quem escolheu &quot;Laboratório de prótese&quot; no /cadastrar. Ninguém aqui tem conta ainda.
        </p>
      </div>

      {itens === null ? (
        <div className="flex justify-center py-16">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : itens.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
          Nenhum laboratório na lista ainda.
        </div>
      ) : (
        <div className="space-y-2.5">
          <p className="text-xs font-semibold text-muted-foreground">
            {itens.length} {itens.length === 1 ? 'laboratório' : 'laboratórios'}
          </p>
          {itens.map((i) => (
            <div key={i.id} className="bg-card border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-foreground truncate">{i.lab_name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {i.contact_name} · {new Date(i.created_at).toLocaleDateString('pt-BR')}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Phone size={11} />{i.phone}</span>
                  {i.email && <span className="inline-flex items-center gap-1 break-all"><Mail size={11} />{i.email}</span>}
                  {i.city && <span className="inline-flex items-center gap-1"><MapPin size={11} />{i.city}</span>}
                </div>
              </div>
              <a
                href={`https://wa.me/${i.phone}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <MessageSquare size={12} />
                Chamar no WhatsApp
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
