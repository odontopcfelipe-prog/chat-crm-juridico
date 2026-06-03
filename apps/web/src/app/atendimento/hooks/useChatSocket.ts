import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { Socket } from 'socket.io-client';
import api from '@/lib/api';
import { useSocket } from '@/lib/SocketProvider';
import { decodeUserId } from '@/lib/socketConfig';
import { showError } from '@/lib/toast';
import { swallow } from '@/lib/errors';

interface UseChatSocketResult {
  messages: any[];
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  lead: any;
  convoId: string | null;
  convoStatus: string;
  setConvoStatus: React.Dispatch<React.SetStateAction<string>>;
  aiMode: boolean;
  setAiMode: React.Dispatch<React.SetStateAction<boolean>>;
  specialty: string | null;
  setSpecialty: React.Dispatch<React.SetStateAction<string | null>>;
  assignedDentist: { id: string; name: string } | null;
  setAssignedDentist: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
  allSpecialists: { id: string; name: string; specialties: string[] }[];
  originAssignedUserId: string | null;
  contactPresence: string;
  currentUserId: string | null;
  socketRef: React.MutableRefObject<Socket | null>;
  loading: boolean;
}

/**
 * Hook que encapsula toda a logica de fetch de dados e eventos do socket.
 * Usa o socket compartilhado do SocketProvider (sem io() local).
 */
export function useChatSocket(leadId: string): UseChatSocketResult {
  const router = useRouter();
  const [messages, setMessages] = useState<any[]>([]);
  const [lead, setLead] = useState<any>(null);
  const [convoId, setConvoId] = useState<string | null>(null);
  const [convoStatus, setConvoStatus] = useState<string>('ABERTO');
  const [aiMode, setAiMode] = useState(false);
  const [specialty, setSpecialty] = useState<string | null>(null);
  const [assignedDentist, setAssignedDentist] = useState<{ id: string; name: string } | null>(null);
  const [allSpecialists, setAllSpecialists] = useState<{ id: string; name: string; specialties: string[] }[]>([]);
  const [originAssignedUserId, setOriginAssignedUserId] = useState<string | null>(null);
  const [contactPresence, setContactPresence] = useState<string>('unavailable');
  const [loading, setLoading] = useState(true);
  const [currentUserId] = useState<string | null>(decodeUserId);

  const { socket: sharedSocket } = useSocket();
  const socketRef = useRef<Socket | null>(null);
  // Onda 17.24 — refs nomeados dos handlers pra cleanup remover SOMENTE
  // o handler desta instancia, nao todos os listeners do evento.
  // Sem isso, multiplos slots do split mantinham só o ultimo listener
  // funcionando — mensagens enviadas nao apareciam em outros slots.
  const reconnectHandlerRef = useRef<(() => void) | null>(null);
  const newMessageHandlerRef = useRef<((msg: any) => void) | null>(null);
  const messageUpdateHandlerRef = useRef<((msg: any) => void) | null>(null);
  const messageReactionHandlerRef = useRef<((data: any) => void) | null>(null);
  const contactPresenceHandlerRef = useRef<((data: any) => void) | null>(null);

  // Sincroniza ref para componentes que consomem socketRef
  useEffect(() => { socketRef.current = sharedSocket; }, [sharedSocket]);

  // Fetch de dados + listeners de conversa
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/atendimento/login'); return; }

    const fetchData = async () => {
      try {
        const convoRes = await api.get(`/conversations/lead/${leadId}`);
        if (convoRes.data && convoRes.data.length > 0) {
          const convo = convoRes.data[0];
          setLead(convo.lead);
          setConvoId(convo.id);
          setConvoStatus(convo.status || 'ABERTO');
          setAiMode(!!convo.ai_mode);
          // Onda 17.28 — Inicia com as ultimas 100 que vem na rota lead,
          // depois faz fetch separado de 500 (limite max do backend) em
          // ordem asc pra mostrar TODO o historico no chat. Antes mostrava
          // so 100 ultimas, faltando mensagens entre dias.
          setMessages(convo.messages || []);
          api.get(`/messages/conversation/${convo.id}?limit=500`)
            .then((r) => {
              const list = r.data?.data || r.data || [];
              if (Array.isArray(list) && list.length > 0) {
                // backend retorna desc (mais recente primeiro), revertemos
                // pra asc (cronologico) pra renderizar bottom-up
                const sorted = [...list].sort((a, b) => {
                  const ta = new Date(a.created_at || 0).getTime();
                  const tb = new Date(b.created_at || 0).getTime();
                  return ta - tb;
                });
                setMessages(sorted);
              }
            })
            .catch(swallow('full message history — fallback eh usar so as 100 ultimas'));
          setSpecialty(convo.specialty || null);
          setAssignedDentist(convo.assigned_dentist || null);
          setOriginAssignedUserId(convo.origin_assigned_user_id || null);

          api.get('/users/agents').then((r) => {
            setAllSpecialists(
              (r.data as any[]).filter((u) => u.specialties?.length > 0),
            );
          }).catch(swallow('lazy load specialists pra dropdown de transferencia'));

          api.post(`/conversations/${convo.id}/mark-read`).catch(swallow('mark-read inicial — SocketProvider tenta de novo'));

          api.post(`/messages/conversation/${convo.id}/sync-history`)
            .then(async (syncRes) => {
              if (syncRes.data?.imported > 0) {
                const msgRes = await api.get(`/messages/conversation/${convo.id}`);
                setMessages(msgRes.data || []);
              }
            })
            .catch(swallow('sync history Evolution — fallback eh ler so as msgs locais'));

          // Registrar listeners no socket compartilhado.
          // Onda 17.24 — CRITICO: handlers PRECISAM ser nomeados (refs)
          // pra que o cleanup remova so o NOSSO listener, nao o de outros
          // componentes (ex: outros slots do split, ChatClient standalone,
          // page.tsx principal). socket.off(evt) sem callback removia TODOS,
          // fazendo mensagens enviadas nao aparecerem no chat de outros slots.
          if (sharedSocket) {
            sharedSocket.emit('join_conversation', convo.id);

            // Re-join conversation room after reconnect when state recovery doesn't apply
            const reconnectHandler = () => {
              if (!(sharedSocket as any).recovered) {
                sharedSocket.emit('join_conversation', convo.id);
              }
            };
            reconnectHandlerRef.current = reconnectHandler;
            sharedSocket.on('connect', reconnectHandler);

            // Som NÃO toca aqui — SocketProvider já toca via incoming_message_notification

            const onNewMessage = (msg: any) => {
              // Filtra: so processa mensagens dESTA conversa (cada hook pode
              // ter o seu convoId distinto, mas socket eh global)
              if (msg.conversation_id && msg.conversation_id !== convo.id) return;

              const addMsg = () => setMessages(prev => {
                const exists = prev.some((m: any) => m.id === msg.id || (m.external_message_id && m.external_message_id === msg.external_message_id));
                if (exists) return prev;
                return [...prev, msg];
              });
              if (msg.direction === 'in') {
                api.post(`/conversations/${convo.id}/mark-read`).catch(swallow('mark-read em msg recebida — re-tenta no proximo ciclo'));
              }
              if (msg.type === 'audio' && msg.media?.s3_key) {
                import('@/components/AudioPlayer').then(({ preFetchAudio }) => {
                  const timeout = setTimeout(addMsg, 8000);
                  preFetchAudio(msg.id).finally(() => { clearTimeout(timeout); addMsg(); });
                });
              } else {
                addMsg();
              }
            };
            newMessageHandlerRef.current = onNewMessage;
            sharedSocket.on('newMessage', onNewMessage);

            const onMessageUpdate = (updatedMsg: any) => {
              if (updatedMsg.conversation_id && updatedMsg.conversation_id !== convo.id) return;
              setMessages(prev => prev.map((m: any) => m.id === updatedMsg.id ? { ...m, ...updatedMsg } : m));
            };
            messageUpdateHandlerRef.current = onMessageUpdate;
            sharedSocket.on('messageUpdate', onMessageUpdate);

            const onMessageReaction = (data: { messageId: string; reactions: any[]; conversation_id?: string }) => {
              if (data.conversation_id && data.conversation_id !== convo.id) return;
              setMessages(prev => prev.map((m: any) => m.id === data.messageId ? { ...m, reactions: data.reactions } : m));
            };
            messageReactionHandlerRef.current = onMessageReaction;
            sharedSocket.on('messageReaction', onMessageReaction);

            const onContactPresence = (data: { presence: string; conversation_id?: string }) => {
              if (data.conversation_id && data.conversation_id !== convo.id) return;
              setContactPresence(data.presence);
            };
            contactPresenceHandlerRef.current = onContactPresence;
            sharedSocket.on('contact_presence', onContactPresence);
          }
        }
      } catch (e: any) {
        console.error('Erro ao inicializar chat:', e);
        showError('Erro ao carregar conversa.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    return () => {
      // Onda 17.24 — Cleanup: remove SO o nosso handler, nao todos.
      if (sharedSocket) {
        if (reconnectHandlerRef.current) {
          sharedSocket.off('connect', reconnectHandlerRef.current);
          reconnectHandlerRef.current = null;
        }
        if (newMessageHandlerRef.current) {
          sharedSocket.off('newMessage', newMessageHandlerRef.current);
          newMessageHandlerRef.current = null;
        }
        if (messageUpdateHandlerRef.current) {
          sharedSocket.off('messageUpdate', messageUpdateHandlerRef.current);
          messageUpdateHandlerRef.current = null;
        }
        if (messageReactionHandlerRef.current) {
          sharedSocket.off('messageReaction', messageReactionHandlerRef.current);
          messageReactionHandlerRef.current = null;
        }
        if (contactPresenceHandlerRef.current) {
          sharedSocket.off('contact_presence', contactPresenceHandlerRef.current);
          contactPresenceHandlerRef.current = null;
        }
      }
    };
  }, [leadId, router, currentUserId, sharedSocket]);

  return {
    messages,
    setMessages,
    lead,
    convoId,
    convoStatus,
    setConvoStatus,
    aiMode,
    setAiMode,
    specialty,
    setSpecialty,
    assignedDentist,
    setAssignedDentist,
    allSpecialists,
    originAssignedUserId,
    contactPresence,
    currentUserId,
    socketRef,
    loading,
  };
}
