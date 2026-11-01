'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { labAllowsRoute, pickBt } from '@crm/shared';
import { btAgora } from '@/lib/useBusinessType';

export default function SettingsPage() {
  const router = useRouter();

  useEffect(() => {
    // btAgora (e não o hook): o efeito da hidratação roda com o tipo do servidor
    // (clínica). O laboratório vai para Usuários quando essa tela está liberada para ele.
    router.replace(
      pickBt(
        btAgora(),
        '/atendimento/settings/users',
        labAllowsRoute('/atendimento/settings/users') ? '/atendimento/settings/users' : '/atendimento/settings/whatsapp',
      ),
    );
  }, [router]);

  return null;
}
