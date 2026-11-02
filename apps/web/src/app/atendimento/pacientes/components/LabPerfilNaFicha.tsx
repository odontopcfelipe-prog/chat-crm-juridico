'use client';

/**
 * F8 do laboratório — linhas da ficha do cliente no card "Dados do cliente" da ficha
 * (pacientes/[id]/page.tsx): Tipo, CRO, Razão social (clínica) ou Clínica onde atende
 * (dentista), Dentistas que pedem trabalhos (clínica), Contato e Entrega.
 *
 * Só o laboratório monta (`{lab && <LabPerfilNaFicha cadastro={patient} />}`). Lê o
 * GET /patients/:id/lab-profile a cada carga da ficha (o objeto do cadastro muda, por
 * exemplo depois do Editar). Sem ficha gravada, a API devolve o tipo pelo documento;
 * enquanto carrega ou se a leitura falhar, o Tipo sai do documento (como antes da F8).
 * O telefone do contato já chega null para quem não vê contato.
 *
 * Cada linha é <div><dt/><dd/></div> com as classes do Field da ficha, para caber no
 * <dl> de lá. Textos de lab-dentistas-textos.ts.
 */
import { useEffect, useState } from 'react';
import { isLab, tipoDoCliente, type PerfilDoClienteLabResposta } from '@crm/shared';
import { btAgora } from '@/lib/useBusinessType';
import { formatPhone } from '@/lib/utils';
import { LAB_CADASTRO, LAB_FICHA } from '../lab-dentistas-textos';
import { carregarPerfil } from '../lab-perfil';

interface Props {
  /** O cadastro da ficha (o mesmo objeto que ela carregou). */
  cadastro: { id: string; cpf: string | null };
}

export default function LabPerfilNaFicha({ cadastro }: Props) {
  const [perfil, setPerfil] = useState<PerfilDoClienteLabResposta | null>(null);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    // Defesa: a ficha só monta este componente no laboratório.
    if (!isLab(btAgora())) return;
    let cancelado = false;
    carregarPerfil(cadastro.id, cadastro.cpf)
      .then((p) => {
        if (cancelado) return;
        setPerfil(p);
        setFalhou(false);
      })
      .catch(() => {
        if (!cancelado) setFalhou(true);
      });
    return () => {
      cancelado = true;
    };
  }, [cadastro]);

  // Só vale a ficha do cadastro aberto (troca de cliente sem desmontar).
  const p = perfil && perfil.patient_id === cadastro.id ? perfil : null;
  const tipo = tipoDoCliente(p?.kind ?? null, cadastro.cpf);
  const ehClinica = tipo === 'CLINICA';
  const contato = p
    ? [p.contact_name, p.contact_phone ? formatPhone(p.contact_phone) : null].filter(Boolean).join(' · ')
    : '';

  return (
    <>
      <Linha rotulo={LAB_FICHA.tipo} valor={LAB_CADASTRO.tipos[tipo]} />
      {p && (
        <>
          <Linha rotulo={LAB_FICHA.cro} valor={p.cro_number ? LAB_FICHA.croValor(p.cro_uf, p.cro_number) : null} />
          {ehClinica ? (
            <>
              <Linha rotulo={LAB_FICHA.razaoSocial} valor={p.legal_name} />
              <Linha rotulo={LAB_FICHA.dentistas} valor={p.requesting_dentists.join(', ')} />
            </>
          ) : (
            <Linha rotulo={LAB_FICHA.clinicaOndeAtende} valor={p.clinic_name} />
          )}
          {contato && <Linha rotulo={LAB_FICHA.contato} valor={contato} />}
          <Linha rotulo={LAB_FICHA.entrega} valor={p.delivery_notes} />
        </>
      )}
      {!p && falhou && <div className="text-[11px] text-muted-foreground text-right">{LAB_FICHA.perfilNaoCarregou}</div>}
    </>
  );
}

/** Mesmas classes do Field da ficha ([id]/page.tsx); vazio mostra o traço. */
function Linha({ rotulo, valor }: { rotulo: string; valor: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs font-medium text-muted-foreground shrink-0 pt-0.5">{rotulo}</dt>
      <dd className="text-sm text-foreground text-right break-words whitespace-pre-line">
        {valor || <span className="text-muted-foreground">—</span>}
      </dd>
    </div>
  );
}
