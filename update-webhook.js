const axios = require('axios');

const URL = 'https://api.andrelustosaadvogados.com.br';
const KEY = '19a05742b587ef8e3e042d3ebe4197ae';
const INSTANCE = 'whatsapp';
// Path WITHOUT /api as per my audit of main.ts
const WEBHOOK_URL = 'https://atendimento.andrelustosaadvogados.com.br/api/webhooks/evolution';

async function update() {
  try {
    const resp = await axios({
      method: 'POST',
      url: `${URL}/webhook/set/${INSTANCE}`,
      headers: { apikey: KEY },
      data: {
        webhook: {
          url: WEBHOOK_URL,
          enabled: true,
          webhook_by_events: false,
          events: [
            "MESSAGES_UPSERT",
            "MESSAGES_UPDATE",
            "MESSAGES_DELETE",
            "CONTACTS_UPSERT",
            "CHATS_UPSERT",
            "CHATS_DELETE",
            "CONNECTION_UPDATE"
          ]
        }
      }
    });
    console.log('Update Result:', JSON.stringify(resp.data, null, 2));
  } catch (e) {
    console.log(`Failed: ${e.message} - ${e.response?.status} - ${JSON.stringify(e.response?.data)}`);
  }
}

update();
