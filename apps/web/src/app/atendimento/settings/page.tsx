'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { pickBt } from '@crm/shared';
import { btAgora } from '@/lib/useBusinessType';

export default function SettingsPage() {
  const router = useRouter();

  useEffect(() => {
    // btAgora (e não o hook): o efeito da hidratação roda com o tipo do servidor
    // (clínica) e mandaria o laboratório para Usuários, que fica fechado para ele.
    router.replace(pickBt(btAgora(), '/atendimento/settings/users', '/atendimento/settings/whatsapp'));
  }, [router]);

  return null;
}
