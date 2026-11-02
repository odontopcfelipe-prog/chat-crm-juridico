'use client';

/**
 * F8 do laboratório — ficha técnica do serviço na tabela de serviços
 * (settings/procedures/page.tsx): coluna Prazo na lista e bloco "Ficha técnica" no
 * modal de criar/editar.
 *
 * Só o laboratório usa: a página monta cada componente atrás de `lab && …` e só chama
 * gravarFichaLab com `lab`. Na clínica o hook não faz nenhuma requisição.
 *
 * Toda string nova da ficha mora aqui ou em lab-servicos-textos.ts, nunca na página
 * (ela tem pickBt: a trava 1 de scripts/ci/check-pick-literals.mjs não deixa entrar
 * string nova lá). Este arquivo não chama pickBt nem declara const LAB_.
 *
 * Rotas (LabFichasController, liberadas em ROTAS_DO_LABORATORIO):
 *   - GET /lab/procedure-specs → { fichas: { [procedure_id]: FichaTecnicaLab } }, uma
 *     leitura por tela (e outra depois de salvar);
 *   - PUT /procedures/:id/lab-spec com as 6 chaves de CAMPOS_DA_FICHA_TECNICA.
 * A mesma leitura existe em LabFichaDoCaso.tsx (caso), de propósito: os grupos não
 * importam um do outro.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  CAMPOS_DA_FICHA_TECNICA,
  GARANTIA_MAX_DIAS,
  LIMITES_DA_FICHA,
  PRAZO_MAX_DIAS,
  UNIDADES_DO_SERVICO,
  isLab,
  type FichaTecnicaLab,
  type FichaTecnicaLabResposta,
  type FichasTecnicasLabResposta,
  type UnidadeDoServico,
} from '@crm/shared';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { btAgora } from '@/lib/useBusinessType';
import { LAB_SERVICOS_FICHA as T } from './lab-servicos-textos';

type FichasPorServico = Record<string, FichaTecnicaLab>;

/** Sem ficha nenhuma (a clínica fica sempre aqui). Constante: não renderiza à toa. */
const SEM_FICHAS: FichasPorServico = Object.freeze({}) as FichasPorServico;

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * Fichas técnicas da conta, por id do serviço. Só lê com `lab` (e com o token dizendo
 * laboratório agora): na clínica, zero requisição e `recarregar` não faz nada.
 */
export function useFichasTecnicasLab(lab: boolean): {
  fichas: FichasPorServico;
  recarregar: () => void;
} {
  const [fichas, setFichas] = useState<FichasPorServico>(SEM_FICHAS);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    // `lab` vem do hook do tipo de conta, que no 1º quadro da hidratação ainda diz
    // clínica; quando vira laboratório o efeito roda de novo (uma leitura só). O
    // btAgora() confere o token na hora: conta de clínica nunca chega na chamada.
    if (!lab || !isLab(btAgora())) return;
    let vivo = true;
    api
      .get<FichasTecnicasLabResposta>('/lab/procedure-specs')
      .then(({ data }) => {
        if (vivo) setFichas(data?.fichas ?? SEM_FICHAS);
      })
      .catch(() => {
        if (vivo) showError(T.erros.carregar);
      });
    return () => {
      vivo = false;
    };
  }, [lab, versao]);

  const recarregar = useCallback(() => {
    if (lab) setVersao((v) => v + 1);
  }, [lab]);

  return { fichas: lab ? fichas : SEM_FICHAS, recarregar };
}

// ─── Lista ───────────────────────────────────────────────────────────────────

/** Cabeçalho da coluna Prazo (depois de Duração, que o laboratório não vê). */
export function LabPrazoCabecalho() {
  return <th className="text-right px-4 py-2 font-medium">{T.colunaPrazo}</th>;
}

/** 'Elemento · cor · prova · garantia 90 d' */
function resumoDaFicha(ficha: FichaTecnicaLab): string {
  const partes: string[] = [T.unidades[ficha.unit] ?? ficha.unit];
  if (ficha.needs_shade) partes.push(T.pedeCorCurto);
  if (ficha.has_tryin) partes.push(T.temProvaCurto);
  if (typeof ficha.warranty_days === 'number' && ficha.warranty_days > 0) partes.push(T.garantiaCurta(ficha.warranty_days));
  return partes.join(T.separador);
}

/** Célula da coluna Prazo: '7 dias' e, embaixo, o resumo da ficha. Sem ficha: '—'. */
export function LabPrazoCelula({ ficha }: { ficha?: FichaTecnicaLab | null }) {
  if (!ficha) {
    return (
      <td className="px-4 py-2 text-right text-xs text-muted-foreground" title={T.semPrazoDica}>
        {T.semPrazo}
      </td>
    );
  }
  return (
    <td className="px-4 py-2 text-right text-xs">
      <div className="text-foreground">{T.prazoDias(ficha.lead_time_days)}</div>
      <div className="text-[10px] text-muted-foreground">{resumoDaFicha(ficha)}</div>
    </td>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

/** O que o formulário guarda enquanto o protético edita (texto cru dos números). */
export type RascunhoFicha = {
  prazo: string;
  garantia: string;
  unidade: UnidadeDoServico;
  material: string;
  pedeCor: boolean;
  temProva: boolean;
};

/** Rascunho a partir da ficha gravada; sem ficha: prazo e garantia vazios, Elemento, sem cor e sem prova. */
export function fichaInicial(ficha?: FichaTecnicaLab | null): RascunhoFicha {
  if (!ficha) {
    return { prazo: '', garantia: '', unidade: UNIDADES_DO_SERVICO[0], material: '', pedeCor: false, temProva: false };
  }
  return {
    prazo: String(ficha.lead_time_days),
    garantia: typeof ficha.warranty_days === 'number' ? String(ficha.warranty_days) : '',
    unidade: (UNIDADES_DO_SERVICO as readonly string[]).includes(ficha.unit) ? ficha.unit : UNIDADES_DO_SERVICO[0],
    material: ficha.default_material ?? '',
    pedeCor: !!ficha.needs_shade,
    temProva: !!ficha.has_tryin,
  };
}

/**
 * Ficha do serviço aberto no modal. No editar do laboratório, lê a ficha gravada
 * (GET /procedures/:id/lab-spec) ao abrir: enquanto não chega, o bloco fica travado;
 * se a leitura falhar, `pronta` fica false e o modal não confere nem grava a ficha
 * (a gravada fica como está). Serviço novo e clínica: pronta na hora, sem requisição.
 */
export function useFichaDoServico(
  lab: boolean,
  procedureId: string | null,
): { ficha: RascunhoFicha; setFicha: (r: RascunhoFicha) => void; pronta: boolean; carregando: boolean } {
  const ler = lab && !!procedureId;
  const [ficha, setFicha] = useState<RascunhoFicha>(() => fichaInicial(null));
  const [carregando, setCarregando] = useState(ler);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    if (!ler || !isLab(btAgora())) {
      setCarregando(false);
      return;
    }
    let vivo = true;
    setCarregando(true);
    setFalhou(false);
    api
      .get<FichaTecnicaLabResposta>(`/procedures/${procedureId}/lab-spec`)
      .then(({ data }) => {
        if (vivo) setFicha(fichaInicial(data?.ficha ?? null));
      })
      .catch(() => {
        if (vivo) setFalhou(true);
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [ler, procedureId]);

  return { ficha, setFicha, pronta: !carregando && !falhou, carregando };
}

/** Inteiro de 0 a max, escrito só com dígitos (sem sinal, vírgula ou ponto). */
function inteiroAte(texto: string, max: number): boolean {
  const t = texto.trim();
  return /^\d{1,5}$/.test(t) && Number(t) <= max;
}

/** Erro do rascunho ou null: prazo obrigatório (0 a 365); garantia vazia ou de 0 a 3650. */
export function validarFicha(r: RascunhoFicha): string | null {
  if (!inteiroAte(r.prazo, PRAZO_MAX_DIAS)) return T.erros.prazo(PRAZO_MAX_DIAS);
  if (r.garantia.trim() !== '' && !inteiroAte(r.garantia, GARANTIA_MAX_DIAS)) return T.erros.garantia(GARANTIA_MAX_DIAS);
  return null;
}

const CAMPO = 'w-full px-3 py-2 rounded-lg bg-background border border-border text-sm';

/** Bloco "Ficha técnica" do modal: prazo, garantia, unidade, material padrão, cor e prova. */
export function LabFichaTecnica({
  valor,
  onChange,
  carregando = false,
  pronta = true,
}: {
  valor: RascunhoFicha;
  onChange: (r: RascunhoFicha) => void;
  carregando?: boolean;
  pronta?: boolean;
}) {
  const mudar = <K extends keyof RascunhoFicha>(campo: K, v: RascunhoFicha[K]) => onChange({ ...valor, [campo]: v });
  if (carregando || !pronta) {
    return (
      <fieldset className="rounded-lg border border-border p-3 space-y-2">
        <legend className="px-1 text-xs font-semibold">{T.fichaTitulo}</legend>
        <p className="text-[11px] text-muted-foreground leading-snug">{carregando ? T.fichaCarregando : T.erros.carregarUma}</p>
      </fieldset>
    );
  }
  return (
    <fieldset className="rounded-lg border border-border p-3 space-y-3">
      <legend className="px-1 text-xs font-semibold">{T.fichaTitulo}</legend>
      <p className="text-[11px] text-muted-foreground leading-snug">{T.fichaDica}</p>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">{T.prazo}</label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={PRAZO_MAX_DIAS}
            step={1}
            required
            value={valor.prazo}
            onChange={(e) => mudar('prazo', e.target.value)}
            placeholder={T.prazoPlaceholder}
            className={CAMPO}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">{T.garantia}</label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={GARANTIA_MAX_DIAS}
            step={1}
            value={valor.garantia}
            onChange={(e) => mudar('garantia', e.target.value)}
            placeholder={T.garantiaPlaceholder}
            className={CAMPO}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">{T.unidade}</label>
          <select
            value={valor.unidade}
            onChange={(e) => mudar('unidade', e.target.value as UnidadeDoServico)}
            className={CAMPO}
          >
            {UNIDADES_DO_SERVICO.map((u) => (
              <option key={u} value={u}>{T.unidades[u]}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1">{T.materialPadrao}</label>
        <input
          value={valor.material}
          onChange={(e) => mudar('material', e.target.value)}
          maxLength={LIMITES_DA_FICHA.default_material}
          placeholder={T.materialPadraoPlaceholder}
          className={CAMPO}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={valor.pedeCor}
            onChange={(e) => mudar('pedeCor', e.target.checked)}
            className="w-4 h-4 rounded border-border"
          />
          {T.pedeCor}
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={valor.temProva}
            onChange={(e) => mudar('temProva', e.target.checked)}
            className="w-4 h-4 rounded border-border"
          />
          {T.temProva}
        </label>
      </div>
    </fieldset>
  );
}

// ─── Gravação ────────────────────────────────────────────────────────────────

/** Corpo do PUT: exatamente as chaves de CAMPOS_DA_FICHA_TECNICA (a API recusa campo a mais). */
type CorpoDaFicha = { [K in (typeof CAMPOS_DA_FICHA_TECNICA)[number]]: FichaTecnicaLab[K] };

/**
 * Grava a ficha técnica do serviço (PUT /procedures/:id/lab-spec). Chame depois de
 * validarFicha. NUNCA lança: se falhar, avisa (o serviço já foi salvo) e devolve false,
 * para o modal fechar sem criar o serviço de novo.
 */
export async function gravarFichaLab(id: string, r: RascunhoFicha): Promise<boolean> {
  const garantia = r.garantia.trim();
  const material = r.material.trim();
  const corpo: CorpoDaFicha = {
    lead_time_days: Number(r.prazo.trim()),
    warranty_days: garantia === '' ? null : Number(garantia),
    unit: r.unidade,
    default_material: material === '' ? null : material,
    needs_shade: r.pedeCor,
    has_tryin: r.temProva,
  };
  try {
    await api.put<FichaTecnicaLabResposta>(`/procedures/${id}/lab-spec`, corpo);
    return true;
  } catch {
    showError(T.erros.salvar);
    return false;
  }
}
