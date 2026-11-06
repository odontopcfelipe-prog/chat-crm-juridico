'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, MonitorPlay } from 'lucide-react';
import { LAB_ROLE_LABELS, isLab } from '@crm/shared';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { decodeUserId } from '@/lib/socketConfig';

interface Usuario {
  id: string;
  name: string;
  email: string;
  roles: string[];
  online: boolean;
  ultimo_login: string | null;
}

interface Resposta {
  conta: { business_type: string | null };
  usuarios: Usuario[];
}

const ROTULOS: Record<string, string> = {
  SUPER_ADMIN: 'Adm master',
  ADMIN: 'Administrador',
  DENTIST: 'Dentista',
  OPERADOR: 'Atendimento',
  ASSISTANT: 'Assistente',
  FINANCEIRO: 'Financeiro',
  COLABORADOR: 'Colaborador',
};

/** Quem está online muda sozinho: confere de novo enquanto a lista estiver aberta. */
const ATUALIZAR_A_CADA_MS = 20_000;

export function UsuariosDaConta({ contaId }: { contaId: string }) {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [meuId, setMeuId] = useState<string | null>(null);

  const carregar = useCallback(async (mostrarErro: boolean) => {
    try {
      const { data } = await api.get<Resposta>(`/admin/contas/${contaId}/usuarios`);
      setDados(data);
    } catch (err: any) {
      if (mostrarErro) showError(err?.response?.data?.message || 'Erro ao carregar os usuários');
    } finally {
      setCarregando(false);
    }
  }, [contaId]);

  useEffect(() => {
    setMeuId(decodeUserId());
    void carregar(true);
    const relogio = setInterval(() => void carregar(false), ATUALIZAR_A_CADA_MS);
    return () => clearInterval(relogio);
  }, [carregar]);

  if (carregando) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" />
        Carregando usuários...
      </div>
    );
  }

  const usuarios = dados?.usuarios ?? [];
  if (usuarios.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Esta conta não tem usuários.</p>;
  }

  const lab = isLab(dados?.conta.business_type);
  const cargo = (u: Usuario) => {
    const papel = u.roles?.[0] ?? '';
    return (lab ? LAB_ROLE_LABELS[papel] : undefined) ?? ROTULOS[papel] ?? papel;
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        A tela ao vivo fica disponível para quem está online. A pessoa vê um aviso enquanto você acompanha, nada é gravado e cada acesso fica registrado.
      </p>
      <ul className="bg-card border border-border rounded-xl divide-y divide-border">
        {usuarios.map((u) => (
          <li key={u.id} className="p-3 flex items-center gap-3 flex-wrap">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${u.online ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-foreground truncate">{u.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {u.email}{cargo(u) ? ` · ${cargo(u)}` : ''}
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground shrink-0">
              {u.online
                ? <strong className="text-emerald-700">Online agora</strong>
                : u.ultimo_login
                  ? `Último login: ${new Date(u.ultimo_login).toLocaleString('pt-BR')}`
                  : 'Sem login registrado'}
            </p>
            {u.id === meuId ? (
              <span className="text-[11px] font-semibold text-muted-foreground px-3 py-1.5 shrink-0">Sua conta</span>
            ) : u.online ? (
              <Link
                href={`/admin/tenants/${contaId}/usuarios/${u.id}/tela`}
                className="text-xs font-bold px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center gap-1.5 shrink-0"
              >
                <MonitorPlay size={13} />
                Ver tela ao vivo
              </Link>
            ) : (
              <span
                className="text-xs font-bold px-3 py-1.5 rounded-md border border-border text-muted-foreground/60 inline-flex items-center gap-1.5 shrink-0 cursor-not-allowed"
                title="Disponível quando a pessoa estiver online"
              >
                <MonitorPlay size={13} />
                Ver tela ao vivo
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
