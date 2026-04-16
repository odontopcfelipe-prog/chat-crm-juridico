const axios = require('axios');
const { PrismaClient } = require('./node_modules/.prisma/client');

const URL = 'https://api.andrelustosaadvogados.com.br';
const KEY = '19a05742b587ef8e3e042d3ebe4197ae';
const INSTANCE = 'whatsapp';
const TENANT_ID = '00000000-0000-0000-0000-000000000000';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Fixing Tenant IDs ---');
  const convFix = await prisma.conversation.updateMany({
    where: { tenant_id: null },
    data: { tenant_id: TENANT_ID }
  });
  console.log(`Updated ${convFix.count} conversations with tenant_id`);

  console.log('--- Fetching Chats for Message Injection ---');
  const resp = await axios({
    method: 'POST',
    url: `${URL}/chat/findChats/${INSTANCE}`,
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    data: { where: {}, limit: 1000 }
  });
  const chats = resp.data;
  console.log(`Found ${chats.length} chats in Evolution.`);

  let msgCount = 0;
  for (const chat of chats) {
    if (chat.lastMessage) {
      const jid = chat.remoteJidAlt || chat.remoteJid;
      const lm = chat.lastMessage;
      const msgId = lm.key?.id || lm.id;
      const msgText = lm.message?.conversation || 
                      lm.message?.extendedTextMessage?.text || 
                      lm.message?.imageMessage?.caption || 
                      (lm.messageType !== 'conversation' ? `[${lm.messageType}]` : '');

      if (!msgId || !msgText) continue;

      // Find conversation in DB
      let conv = await prisma.conversation.findFirst({
        where: { external_id: chat.remoteJid, instance_name: INSTANCE }
      });
      // Try alt JID if not found
      if (!conv && chat.remoteJidAlt) {
        conv = await prisma.conversation.findFirst({
          where: { external_id: chat.remoteJidAlt, instance_name: INSTANCE }
        });
      }

      if (conv) {
        await prisma.message.upsert({
          where: { external_message_id: msgId },
          update: { status: lm.status || 'recebido' },
          create: {
            conversation_id: conv.id,
            direction: lm.key?.fromMe ? 'out' : 'in',
            type: 'text',
            text: msgText,
            external_message_id: msgId,
            status: lm.status || 'recebido',
            created_at: lm.messageTimestamp ? new Date(lm.messageTimestamp * 1000) : new Date(),
          }
        });

        await prisma.conversation.update({
          where: { id: conv.id },
          data: { last_message_at: lm.messageTimestamp ? new Date(lm.messageTimestamp * 1000) : new Date() }
        });
        msgCount++;
      }
    }
  }
  console.log(`Injected ${msgCount} last messages into DB.`);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
